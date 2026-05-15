#!/usr/bin/env node
/**
 * build.js — California road trip photo map pipeline.
 *
 * Reads every image in ./photos-source/ (recursively), extracts GPS + timestamp
 * from EXIF, converts/resizes each to a web thumbnail in ./photos/, and writes
 * ./data/photos.json (sorted chronologically) for the map site to consume.
 *
 * Image conversion uses macOS's built-in `sips` (no native npm deps to build).
 * Metadata is read with `exifr` (pure JS, handles HEIC + JPEG).
 *
 * Run: npm run build
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readdir,
  stat,
  readFile,
  writeFile,
  unlink,
  mkdir,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';

const execFileP = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Source defaults to ./photos-source, but an optional CLI arg lets you point
// the build at photos sitting anywhere (e.g. an export folder) without copying
// gigabytes into the project:  node build.js "/path/to/exported photos"
const SOURCE_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'photos-source');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const DATA_FILE = path.join(ROOT, 'data', 'photos.json');
const GEOCACHE_FILE = path.join(ROOT, 'data', 'geocache.json');

const IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.tif', '.tiff']);
const MAX_EDGE_PX = 1280; // longest side of generated thumbnail (web-optimal)
const JPEG_QUALITY = 70;

// Source files to drop from the map (by filename, case-insensitive), even
// though they have valid GPS. Keeps manual culls reproducible across rebuilds.
const EXCLUDE = new Set(
  [
    'IMG_0748.HEIC', // burst dupes, Dec 25 — removed on request (old stops 61-63)
    'IMG_0749.HEIC',
    'IMG_0750.HEIC',
    'IMG_0793.HEIC', // burst dupes, Joshua Tree, Dec 26 — removed on request
    'IMG_0794.HEIC',
    'IMG_0795.HEIC',
    'IMG_0796.HEIC',
    'IMG_0797.HEIC', // Joshua Tree, Dec 26 — removed on request (old stop 103)
    'IMG_0851.HEIC', // Dec 28 — removed on request (old stop 155)
  ].map((n) => n.toLowerCase())
);

/** Recursively collect image file paths under dir. */
async function collectImages(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectImages(full)));
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Read lat/lng + capture time via macOS Spotlight metadata (`mdls`).
 * This is far more reliable than JS EXIF parsers on iPhone HEIC files
 * (exifr reports "Unknown file format" on many of them despite valid GPS).
 */
async function readMetaMdls(file) {
  const { stdout } = await execFileP('mdls', [
    '-name', 'kMDItemLatitude',
    '-name', 'kMDItemLongitude',
    '-name', 'kMDItemContentCreationDate',
    file,
  ]);
  // Parse the self-describing "key = value" format. (Note: `mdls -raw` emits
  // values in a fixed canonical order regardless of -name order, so we avoid
  // positional parsing entirely.)
  const get = (key) => {
    const m = stdout.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    if (!m) return null;
    let v = m[1].trim();
    if (v === '(null)') return null;
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  };
  const num = (key) => {
    const v = get(key);
    return v == null ? NaN : Number(v);
  };
  return {
    lat: num('kMDItemLatitude'),
    lng: num('kMDItemLongitude'),
    when: toDate(get('kMDItemContentCreationDate')),
  };
}

/** exifr fallback for the rare file mdls can't read. */
async function readMetaExifr(file) {
  try {
    const x = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      reviveValues: true,
    });
    return {
      lat: Number(x?.latitude),
      lng: Number(x?.longitude),
      when:
        toDate(x?.DateTimeOriginal) ||
        toDate(x?.CreateDate) ||
        toDate(x?.ModifyDate),
    };
  } catch {
    return { lat: NaN, lng: NaN, when: null };
  }
}

/** Pull lat/lng + best-available timestamp; mdls primary, exifr fallback. */
async function readMeta(file) {
  let m;
  try {
    m = await readMetaMdls(file);
  } catch {
    m = { lat: NaN, lng: NaN, when: null };
  }

  const valid = (v) => Number.isFinite(v);
  if (!valid(m.lat) || !valid(m.lng)) {
    const e = await readMetaExifr(file);
    if (valid(e.lat) && valid(e.lng)) m = e;
    else if (!m.when && e.when) m.when = e.when;
  }

  const hasGps =
    Number.isFinite(m.lat) &&
    Number.isFinite(m.lng) &&
    !(m.lat === 0 && m.lng === 0);

  // Fall back to filesystem modified time so ordering still works.
  const when = m.when || new Date((await stat(file)).mtime);

  return { hasGps, lat: m.lat, lng: m.lng, when };
}

/** Stable thumbnail filename derived from the source (NOT the sequence
 *  number) so culls/reorders don't force every thumbnail to regenerate. */
function thumbName(src) {
  return src.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_') + '.jpg';
}

/** Convert + resize via sips, but only if the thumbnail is missing or older
 *  than the source. Returns 'built' or 'reused'. */
async function ensureThumbnail(srcFile, name) {
  const outFile = path.join(PHOTOS_DIR, name);
  try {
    const [s, t] = await Promise.all([stat(srcFile), stat(outFile)]);
    if (t.mtimeMs >= s.mtimeMs) return 'reused';
  } catch {
    /* thumbnail missing — fall through and build it */
  }
  await execFileP('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(JPEG_QUALITY),
    '-Z', String(MAX_EDGE_PX),
    srcFile,
    '--out', outFile,
  ]);
  return 'built';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE_ABBR = {
  California: 'CA', Nevada: 'NV', Arizona: 'AZ', Oregon: 'OR', Utah: 'UT',
};

// Iconic areas this route passed through that reverse-geocoding labels only
// as a bare county. Checked first (first match wins); boxes are
// [latMin, latMax, lngMin, lngMax], kept reasonably tight to avoid bleed.
const REGION_OVERRIDES = [
  ['Yosemite National Park', 37.5, 38.2, -120.0, -119.2],
  ['Sequoia & Kings Canyon', 36.35, 37.1, -118.95, -118.3],
  ['Death Valley National Park', 35.85, 37.05, -117.6, -116.35],
  ['Mojave National Preserve', 34.7, 35.5, -115.95, -115.3],
  ['Joshua Tree National Park', 33.6, 34.2, -116.4, -115.65],
  ['Big Sur', 35.85, 36.45, -121.97, -121.3],
];
function regionOverride(lat, lng) {
  for (const [name, a, b, c, d] of REGION_OVERRIDES) {
    if (lat >= a && lat <= b && lng >= c && lng <= d) return name;
  }
  return '';
}

/** Persistent reverse-geocode cache keyed by coarse (~100 m) coordinates so
 *  nearby photos share one lookup and reruns never refetch. */
async function loadGeocache() {
  try {
    return JSON.parse(await readFile(GEOCACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
const geoKey = (lat, lng) => `${lat.toFixed(3)},${lng.toFixed(3)}`;

/** One polite Nominatim reverse lookup -> short place label, or ''. */
async function reverseGeocode(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ca-road-trip-map/1.0 (personal trip map)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  const a = d.address || {};
  const name =
    a.tourism || a.leisure || a.attraction || a.national_park ||
    a.protected_area || a.park || a.village || a.town || a.city ||
    a.hamlet || a.suburb || a.county || (d.name || '').split(',')[0];
  if (!name) return '';
  const st = STATE_ABBR[a.state] || '';
  return st ? `${name}, ${st}` : name;
}

async function main() {
  console.log('Scanning photos-source/ …');
  const images = await collectImages(SOURCE_DIR);

  if (images.length === 0) {
    console.error(
      '\nNo images found in photos-source/.\n' +
        'Export your trip photos from the Apple Photos app\n' +
        '(File ▸ Export ▸ Export Unmodified Original) and drop them in:\n' +
        `  ${SOURCE_DIR}\n`
    );
    process.exit(1);
  }
  console.log(`Found ${images.length} image(s). Reading metadata …`);

  const located = [];
  const skippedNoGps = [];
  const excluded = [];
  const errored = [];

  for (const file of images) {
    try {
      const base = path.basename(file);
      if (EXCLUDE.has(base.toLowerCase())) {
        excluded.push(base);
        continue;
      }
      const meta = await readMeta(file);
      if (!meta.hasGps) {
        skippedNoGps.push(path.relative(SOURCE_DIR, file));
        continue;
      }
      located.push({
        file,
        src: base,
        lat: meta.lat,
        lng: meta.lng,
        when: meta.when,
      });
    } catch (err) {
      errored.push(`${path.relative(SOURCE_DIR, file)} — ${err.message}`);
    }
  }

  // Chronological order; tie-break on filename for stable output.
  located.sort(
    (a, b) => a.when - b.when || a.file.localeCompare(b.file)
  );

  await mkdir(PHOTOS_DIR, { recursive: true });
  const geocache = await loadGeocache();
  let built = 0;
  let reused = 0;
  let geocoded = 0;
  let geoFailed = 0;

  const records = [];
  for (let i = 0; i < located.length; i++) {
    const { file, src, lat, lng, when } = located[i];
    const id = String(i + 1).padStart(4, '0');
    try {
      const name = thumbName(src);
      if ((await ensureThumbnail(file, name)) === 'built') built++;
      else reused++;

      // Curated iconic-area name wins; otherwise reverse-geocode (cached;
      // one polite Nominatim call per ~100 m cell).
      let place = regionOverride(lat, lng);
      if (!place) {
        const key = geoKey(lat, lng);
        place = geocache[key];
        if (place === undefined) {
          try {
            await sleep(1100); // Nominatim: max ~1 req/sec
            place = await reverseGeocode(lat, lng);
            geocoded++;
          } catch {
            place = '';
            geoFailed++;
          }
          geocache[key] = place;
        }
      }

      records.push({
        id,
        src,
        file: `photos/${name}`,
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        timestamp: when.toISOString(),
        place: place || '',
        caption: '',
      });
      process.stdout.write(
        `\r  processed ${i + 1}/${located.length} (built ${built}, reused ${reused})`
      );
    } catch (err) {
      errored.push(
        `${path.relative(SOURCE_DIR, file)} — ${err.message}`
      );
    }
  }

  // Persist the geocode cache and prune orphan thumbnails (culled/renamed).
  await writeFile(GEOCACHE_FILE, JSON.stringify(geocache, null, 2) + '\n');
  const keep = new Set(records.map((r) => path.basename(r.file)));
  for (const f of await readdir(PHOTOS_DIR)) {
    if (f.endsWith('.jpg') && !keep.has(f)) {
      await unlink(path.join(PHOTOS_DIR, f));
    }
  }
  process.stdout.write('\n');

  await writeFile(DATA_FILE, JSON.stringify(records, null, 2) + '\n');

  // ---- Summary ----
  console.log('\n──────── Build summary ────────');
  console.log(`Mapped photos:        ${records.length}`);
  console.log(`Thumbnails:           ${built} built, ${reused} reused`);
  console.log(`Geocoded:             ${geocoded} new, ${geoFailed} failed`);
  console.log(`Skipped (no GPS):     ${skippedNoGps.length}`);
  console.log(`Excluded (cull list): ${excluded.length}`);
  console.log(`Errors:               ${errored.length}`);
  if (excluded.length) {
    console.log(`\nExcluded by cull list: ${excluded.sort().join(', ')}`);
  }
  if (records.length) {
    console.log(
      `Trip span:            ${records[0].timestamp.slice(0, 10)} → ` +
        `${records[records.length - 1].timestamp.slice(0, 10)}`
    );
  }
  if (skippedNoGps.length) {
    console.log('\nNo location data (not plotted):');
    for (const f of skippedNoGps) console.log(`  - ${f}`);
    console.log(
      '  → These were likely taken with Location Services off, or stripped\n' +
        '    on export. Re-export originals if you want them on the map.'
    );
  }
  if (errored.length) {
    console.log('\nErrors:');
    for (const e of errored) console.log(`  - ${e}`);
  }
  console.log('\nWrote data/photos.json. Preview with: npm run serve');
}

main().catch((err) => {
  console.error('\nBuild failed:', err);
  process.exit(1);
});

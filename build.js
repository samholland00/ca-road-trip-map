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
import { readdir, stat, writeFile, unlink, mkdir } from 'node:fs/promises';
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
    'IMG_0934.HEIC', // Dec 30 — removed on request (stops 234-235)
    'IMG_0935.HEIC',
    'IMG_0988.HEIC', // Dec 31 — removed on request (stop 261)
    'IMG_0999.HEIC', // Jan 1 — removed on request (stop 269)
    'IMG_1005.HEIC', // Jan 2 — removed on request (stop 273)
    'IMG_1007.HEIC', // Jan 2 — removed on request (stop 275)
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

/** Convert + resize one image to photos/<id>.jpg via sips. */
async function makeThumbnail(srcFile, id) {
  const outFile = path.join(PHOTOS_DIR, `${id}.jpg`);
  await execFileP('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(JPEG_QUALITY),
    '-Z', String(MAX_EDGE_PX),
    srcFile,
    '--out', outFile,
  ]);
  return path.basename(outFile);
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

  // Clear previously generated thumbnails so reruns are deterministic.
  // Only removes our own numbered output (e.g. 0007.jpg) — leaves .gitkeep
  // and anything else in the folder untouched.
  await mkdir(PHOTOS_DIR, { recursive: true });
  for (const name of await readdir(PHOTOS_DIR)) {
    if (/^\d+\.jpg$/.test(name)) await unlink(path.join(PHOTOS_DIR, name));
  }

  const records = [];
  for (let i = 0; i < located.length; i++) {
    const { file, src, lat, lng, when } = located[i];
    const id = String(i + 1).padStart(4, '0');
    try {
      const thumb = await makeThumbnail(file, id);
      records.push({
        id,
        src,
        file: `photos/${thumb}`,
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        timestamp: when.toISOString(),
        caption: '',
      });
      process.stdout.write(`\r  thumbnailed ${i + 1}/${located.length}`);
    } catch (err) {
      errored.push(
        `${path.relative(SOURCE_DIR, file)} — sips failed: ${err.message}`
      );
    }
  }
  process.stdout.write('\n');

  await writeFile(DATA_FILE, JSON.stringify(records, null, 2) + '\n');

  // ---- Summary ----
  console.log('\n──────── Build summary ────────');
  console.log(`Mapped photos:        ${records.length}`);
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

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
const SOURCE_DIR = path.join(ROOT, 'photos-source');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const DATA_FILE = path.join(ROOT, 'data', 'photos.json');

const IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.tif', '.tiff']);
const MAX_EDGE_PX = 1600; // longest side of generated thumbnail
const JPEG_QUALITY = 80;

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

/** Pull lat/lng + best-available timestamp from a file's EXIF. */
async function readMeta(file) {
  let exif = null;
  try {
    exif = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      reviveValues: true,
    });
  } catch {
    exif = null;
  }

  const lat = exif && Number(exif.latitude);
  const lng = exif && Number(exif.longitude);
  const hasGps =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0);

  const toDate = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  let when =
    toDate(exif?.DateTimeOriginal) ||
    toDate(exif?.CreateDate) ||
    toDate(exif?.ModifyDate);
  if (!when) {
    // Fall back to filesystem modified time so ordering still works.
    when = new Date((await stat(file)).mtime);
  }

  return { hasGps, lat, lng, when };
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
  const errored = [];

  for (const file of images) {
    try {
      const meta = await readMeta(file);
      if (!meta.hasGps) {
        skippedNoGps.push(path.relative(SOURCE_DIR, file));
        continue;
      }
      located.push({ file, lat: meta.lat, lng: meta.lng, when: meta.when });
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
    const { file, lat, lng, when } = located[i];
    const id = String(i + 1).padStart(4, '0');
    try {
      const thumb = await makeThumbnail(file, id);
      records.push({
        id,
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
  console.log(`Errors:               ${errored.length}`);
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

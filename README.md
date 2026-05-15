# California Road Trip Map

An interactive map of a two-week California road trip, built automatically from the
GPS metadata embedded in iPhone photos. Each photo becomes a pin at the spot it was
taken; a line connects them in chronological order to trace the route.

- **Map:** [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles (no API key, no billing)
- **Site:** plain HTML/CSS/JS — no build step for the site itself
- **Pipeline:** one Node script (`build.js`) that reads photo location metadata and makes web thumbnails

---

## 1. Export your photos from Apple Photos

iPhone photos store the GPS location and timestamp directly inside the file — **but
only if the export keeps the original metadata.**

**Check the photos actually have location first:** in the Photos app, open the
**Places** album (or press <kbd>⌘</kbd><kbd>I</kbd> on a photo). If your road-trip
photos show up on the Places map, the GPS is there.

**Export the right way (macOS Photos app):**

1. Select all the trip photos.
2. **File ▸ Export ▸ Export Unmodified Original…**
3. Save them into the `photos-source/` folder in this project.

> Use **Export Unmodified Original**, _not_ the regular "Export Photo" (that one
> strips location unless you tick the Location box). AirDropping the originals from
> the iPhone to your Mac also preserves the metadata.

`photos-source/` is git-ignored — your full-resolution originals are never committed.
HEIC, JPEG, and PNG are all handled; videos/Live Photo `.mov` files are ignored.

## 2. Build

```bash
npm install        # one-time (installs the exifr fallback reader)
npm run build      # reads photos-source/, writes photos/ + data/photos.json
```

**Don't want to copy gigabytes into the project?** Point the build straight at any
folder of photos — the originals stay where they are, only thumbnails are written:

```bash
node build.js "/path/to/your/exported photos"
```

The build:

- reads GPS + capture time from each photo using macOS Spotlight metadata
  (`mdls`) — reliable on iPhone HEIC, where JS EXIF parsers often fail;
  `exifr` is a fallback for anything `mdls` can't read,
- converts/resizes each to a ≤1280px web JPEG in `photos/` using macOS `sips`,
- ignores `.mov` videos (incl. Live Photo movies),
- sorts everything chronologically and writes `data/photos.json`,
- prints a summary, including any photos skipped for having **no location data**.

Photos without GPS (screenshots, saved/downloaded images) are listed in the
summary and simply left off the map.

## 3. Preview locally

```bash
npm run serve      # serves on http://localhost:8000
```

Open <http://localhost:8000> and confirm the pins, route line, start (green) / end
(red) markers, and that clicking a pin shows the photo, date, and stop number.

## 4. Deploy to GitHub Pages

```bash
git add -A
git commit -m "Add road trip photos"
git push
```

Then in the GitHub repo: **Settings ▸ Pages ▸ Build and deployment**, set
**Source: Deploy from a branch**, **Branch: `main` / `/ (root)`**, Save. The site
goes live at `https://samholland00.github.io/ca-road-trip-map/`.

> The repo is **public** and `data/photos.json` contains exact coordinates for every
> photo (including the trip's start point). That's intentional for sharing — but if
> any photo's location is sensitive, delete it from `photos-source/` and rebuild, or
> remove its entry from `data/photos.json` before pushing.

## Adding captions (optional)

`data/photos.json` has an empty `"caption": ""` field per photo. Fill any of them in
and they'll show in that photo's popup. Re-running `npm run build` regenerates the
file, so add captions after you've settled the photo set (or keep a note of them).

## Project layout

```
build.js            the photo pipeline (run with npm run build)
index.html          the map page
style.css  app.js    map rendering
photos-source/      drop exported originals here (git-ignored)
photos/             generated web thumbnails (committed)
data/photos.json    generated photo metadata (committed)
```

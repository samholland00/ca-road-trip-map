/* California road trip map — reads data/photos.json and renders the route. */

function showMessage(text) {
  const el = document.getElementById("message");
  el.textContent = text;
  el.hidden = false;
}

// Any uncaught error becomes a visible on-screen message instead of a blank page.
window.addEventListener("error", (e) => {
  showMessage("Something went wrong loading the map: " + e.message);
});

if (typeof L === "undefined") {
  showMessage(
    "The map library (vendor/leaflet/leaflet.js) didn't load. Make sure you're " +
      "viewing this through a local server (npm run serve), not opening the file directly."
  );
  throw new Error("Leaflet not loaded");
}

// Local (vendored) default-marker images. Deleting _getIconUrl stops Leaflet
// from auto-prepending its detected imagePath (which doubled the path -> 404s).
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "vendor/leaflet/images/marker-icon-2x.png",
  iconUrl: "vendor/leaflet/images/marker-icon.png",
  shadowUrl: "vendor/leaflet/images/marker-shadow.png",
});

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Full-trip photo carousel. Opens at any photo and walks the whole trip in
// chronological order — scales to clusters of any size (no spiderfy crowding).
function createCarousel(photos) {
  const el = document.getElementById("carousel");
  const img = document.getElementById("cz-img");
  const cap = document.getElementById("cz-cap");
  const prevB = document.getElementById("cz-prev");
  const nextB = document.getElementById("cz-next");
  const closeB = document.getElementById("cz-close");
  let idx = 0;

  const preload = (i) => {
    if (photos[i]) new Image().src = photos[i].file;
  };
  function render() {
    const p = photos[idx];
    img.src = p.file;
    img.alt = p.caption || `Trip photo ${idx + 1}`;
    cap.textContent =
      (p.caption ? p.caption + " · " : "") +
      `Stop ${idx + 1} of ${photos.length} · ${fmtDate(p.timestamp)}`;
    prevB.disabled = idx === 0;
    nextB.disabled = idx === photos.length - 1;
    preload(idx + 1);
    preload(idx - 1);
  }
  function open(i) {
    idx = Math.min(Math.max(i | 0, 0), photos.length - 1);
    render();
    el.hidden = false;
  }
  function close() {
    el.hidden = true;
    img.removeAttribute("src");
  }
  function go(d) {
    const n = idx + d;
    if (n >= 0 && n < photos.length) {
      idx = n;
      render();
    }
  }

  prevB.addEventListener("click", () => go(-1));
  nextB.addEventListener("click", () => go(1));
  closeB.addEventListener("click", close);
  el.addEventListener("click", (e) => {
    if (e.target === el) close(); // click backdrop to dismiss
  });
  let sx = null;
  el.addEventListener(
    "touchstart",
    (e) => (sx = e.touches[0].clientX),
    { passive: true }
  );
  el.addEventListener("touchend", (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
    sx = null;
  });

  return { open, close, go, isOpen: () => !el.hidden };
}

function endpointMarker(lat, lng, kind, label) {
  return L.marker([lat, lng], {
    zIndexOffset: 1000,
    icon: L.divIcon({
      className: "",
      html: `<div class="endpoint-pin ${kind}" title="${label}"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
  }).bindTooltip(label, { direction: "top" });
}

// Each pin is a photo thumbnail; clicking it opens the carousel at that photo.
function photoMarker(photo, index, carousel) {
  const marker = L.marker([photo.lat, photo.lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="thumb-marker"><img loading="lazy" src="${photo.file}" alt=""></div>`,
      iconSize: [46, 46],
      iconAnchor: [23, 23],
    }),
  });
  marker.photoIndex = index;
  marker.on("click", () => carousel.open(index));
  return marker;
}

// One-click "back to the whole trip" control — no repeated zooming out.
function addFullTripControl(map, routeBounds) {
  const Ctl = L.Control.extend({
    onAdd() {
      const b = L.DomUtil.create("button", "fulltrip-btn");
      b.type = "button";
      b.textContent = "⤢ Full trip";
      b.title = "Zoom back out to the whole route";
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", () =>
        map.flyToBounds(routeBounds.pad(0.12), { duration: 0.6 })
      );
      return b;
    },
  });
  map.addControl(new Ctl({ position: "topright" }));
}

async function init() {
  const map = L.map("map", { scrollWheelZoom: true }).setView(
    [37.0, -119.5], // California, until we fit to the real route
    6
  );

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let photos;
  try {
    const res = await fetch("data/photos.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    photos = await res.json();
  } catch (err) {
    showMessage(
      "Couldn't load data/photos.json. Run `npm run build` after adding " +
        "photos to photos-source/."
    );
    return;
  }

  const meta = document.getElementById("trip-meta");
  if (!Array.isArray(photos) || photos.length === 0) {
    meta.textContent = "No located photos yet.";
    showMessage(
      "No photos with location data yet. Add trip photos to " +
        "photos-source/ and run `npm run build`."
    );
    return;
  }

  const carousel = createCarousel(photos);

  // Photos are already sorted chronologically by the build script.
  const latlngs = photos.map((p) => [p.lat, p.lng]);
  const routeBounds = L.latLngBounds(latlngs);
  const routeColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--route")
    .trim();

  // Route line through every stop in order.
  const route = L.polyline(latlngs, {
    color: routeColor,
    weight: 4,
    opacity: 0.8,
  }).addTo(map);

  // Arrowheads along the route showing direction of travel.
  L.polylineDecorator(route, {
    patterns: [
      {
        offset: 30,
        repeat: 90,
        symbol: L.Symbol.arrowHead({
          pixelSize: 11,
          polygon: false,
          pathOptions: { stroke: true, color: routeColor, weight: 3, opacity: 0.9 },
        }),
      },
    ],
  }).addTo(map);

  // Clustered photo markers. Clicking a cluster (any size) opens the carousel
  // at that stop — no zoom loop, no spiderfy crowding. Map zoom/pan still work
  // for free exploration; "Full trip" jumps back to the overview.
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 100, // screen pixels (default 80); higher = more grouping
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,
    spiderfyOnMaxZoom: false,
  });
  photos.forEach((photo, i) => {
    photoMarker(photo, i, carousel).addTo(cluster);
  });
  cluster.on("clusterclick", (e) => {
    const earliest = e.layer
      .getAllChildMarkers()
      .reduce((min, m) => Math.min(min, m.photoIndex), Infinity);
    carousel.open(earliest);
  });
  map.addLayer(cluster);

  // Always-visible start / end pins (also open the carousel).
  const first = photos[0];
  const last = photos[photos.length - 1];
  endpointMarker(first.lat, first.lng, "start", "Trip start")
    .on("click", () => carousel.open(0))
    .addTo(map);
  endpointMarker(last.lat, last.lng, "end", "Trip end")
    .on("click", () => carousel.open(photos.length - 1))
    .addTo(map);

  map.fitBounds(routeBounds.pad(0.12));
  addFullTripControl(map, routeBounds);

  // Keyboard: arrows navigate the carousel, Esc closes it.
  document.addEventListener("keydown", (e) => {
    if (!carousel.isOpen()) return;
    if (e.key === "Escape") carousel.close();
    else if (e.key === "ArrowLeft") carousel.go(-1);
    else if (e.key === "ArrowRight") carousel.go(1);
  });

  const startDay = new Date(first.timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const endDay = new Date(last.timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  meta.textContent = `${photos.length} photos · ${startDay} – ${endDay}`;
}

function runApp() {
  init().catch((err) => {
    showMessage("Something went wrong rendering the map: " + err.message);
  });
}

// Cosmetic access gate. NOTE: this is a static site served from a PUBLIC
// repo — the password and all photos/coordinates are still directly
// fetchable. This only keeps casual visitors off the landing page.
(function gate() {
  const PASSWORD = "holland";
  const KEY = "catrip_unlocked";
  const el = document.getElementById("gate");

  if (localStorage.getItem(KEY) === "1") {
    el.hidden = true;
    runApp();
    return;
  }

  const form = document.getElementById("gate-form");
  const input = document.getElementById("gate-pw");
  const err = document.getElementById("gate-err");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value === PASSWORD) {
      localStorage.setItem(KEY, "1");
      el.hidden = true;
      runApp();
    } else {
      err.hidden = false;
      input.value = "";
      input.focus();
    }
  });
  input.focus();
})();

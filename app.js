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

// California is UTC-8 (no DST late Dec/early Jan) — group by that local date
// so a 9pm photo counts as that evening, not the next UTC day.
function pacificDay(iso) {
  return new Date(new Date(iso).getTime() - 8 * 3600000)
    .toISOString()
    .slice(0, 10);
}
function shortDay(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
const DAY_COLORS = [
  "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080",
  "#f032e6", "#9A6324", "#808000", "#000075", "#e67e22", "#1abc9c",
  "#c0392b", "#2c3e50",
];

function haversineMi(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function computeStats(photos) {
  let path = 0;
  let longest = { mi: 0 };
  const perDayMi = {};
  for (let i = 1; i < photos.length; i++) {
    const mi = haversineMi(photos[i - 1], photos[i]);
    path += mi;
    if (mi > longest.mi) longest = { mi, to: photos[i] };
    const d = pacificDay(photos[i].timestamp);
    perDayMi[d] = (perDayMi[d] || 0) + mi;
  }
  const days = [...new Set(photos.map((p) => pacificDay(p.timestamp)))].sort();
  const big = Object.entries(perDayMi).sort((a, b) => b[1] - a[1])[0] || [
    "",
    0,
  ];
  return {
    photos: photos.length,
    days: days.length,
    roadMi: Math.round((path * 1.25) / 10) * 10,
    longestMi: Math.round(longest.mi),
    longestTo: longest.to,
    bigDay: big[0],
    bigDayMi: Math.round(big[1]),
    span: `${shortDay(days[0])} – ${shortDay(days[days.length - 1])}`,
  };
}

// Collapsible panel: trip stats + the day→color legend for the route.
function addStatsPanel(map, stats, days, dayColor, photosByDay) {
  const Ctl = L.Control.extend({
    onAdd() {
      const wrap = L.DomUtil.create("div", "stats-wrap");
      const btn = L.DomUtil.create("button", "stats-toggle", wrap);
      btn.type = "button";
      btn.textContent = "📊 Trip stats";
      const panel = L.DomUtil.create("div", "stats-panel", wrap);
      panel.hidden = true;

      const legend = days
        .map(
          (d) =>
            `<div class="lg-row"><span class="lg-sw" style="background:${dayColor[d]}"></span>` +
            `${shortDay(d)} <span class="lg-n">${photosByDay[d]} photos</span></div>`
        )
        .join("");
      panel.innerHTML =
        `<div class="st-grid">` +
        `<b>${stats.photos}</b><span>photos</span>` +
        `<b>${stats.days}</b><span>days (${stats.span})</span>` +
        `<b>~${stats.roadMi.toLocaleString()}</b><span>est. road miles</span>` +
        `<b>~${stats.longestMi}</b><span>mi longest leg → ${
          stats.longestTo.place || "?"
        }</span>` +
        `<b>~${stats.bigDayMi}</b><span>mi biggest day (${shortDay(
          stats.bigDay
        )})</span>` +
        `</div><div class="lg-title">Route by day</div>${legend}`;

      btn.addEventListener("click", () => (panel.hidden = !panel.hidden));
      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.disableScrollPropagation(panel);
      return wrap;
    },
  });
  map.addControl(new Ctl({ position: "bottomleft" }));
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
    cap.textContent = [
      p.caption,
      p.place,
      `Stop ${idx + 1} of ${photos.length}`,
      fmtDate(p.timestamp),
    ]
      .filter(Boolean)
      .join("  ·  ");
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

  // Group the route by day; each day gets its own color + arrowheads, with
  // the previous day's last point carried over so the line stays continuous.
  const days = [];
  const dayColor = {};
  const dayCoords = {};
  const photosByDay = {};
  photos.forEach((p) => {
    const d = pacificDay(p.timestamp);
    if (!(d in dayColor)) {
      dayColor[d] = DAY_COLORS[days.length % DAY_COLORS.length];
      days.push(d);
      dayCoords[d] = [];
    }
    dayCoords[d].push([p.lat, p.lng]);
    photosByDay[d] = (photosByDay[d] || 0) + 1;
  });
  let prevLast = null;
  for (const d of days) {
    const coords = prevLast ? [prevLast, ...dayCoords[d]] : dayCoords[d];
    const seg = L.polyline(coords, {
      color: dayColor[d],
      weight: 4,
      opacity: 0.85,
    }).addTo(map);
    L.polylineDecorator(seg, {
      patterns: [
        {
          offset: 25,
          repeat: 100,
          symbol: L.Symbol.arrowHead({
            pixelSize: 10,
            polygon: false,
            pathOptions: {
              stroke: true,
              color: dayColor[d],
              weight: 3,
              opacity: 0.9,
            },
          }),
        },
      ],
    }).addTo(map);
    prevLast = dayCoords[d][dayCoords[d].length - 1];
  }

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
  addStatsPanel(map, computeStats(photos), days, dayColor, photosByDay);

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

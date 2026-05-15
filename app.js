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

function popupHtml(photo, index, total) {
  const caption = photo.caption
    ? `<div class="caption">${photo.caption}</div>`
    : "";
  return `
    <div class="photo-popup">
      <img loading="lazy" src="${photo.file}" alt="Trip photo ${index + 1}" />
      ${caption}
      <div class="meta">Stop ${index + 1} of ${total}</div>
      <div class="meta">${fmtDate(photo.timestamp)}</div>
    </div>`;
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

  // Photos are already sorted chronologically by the build script.
  const latlngs = photos.map((p) => [p.lat, p.lng]);

  // Route line through every stop in order.
  L.polyline(latlngs, {
    color: getComputedStyle(document.documentElement)
      .getPropertyValue("--route")
      .trim(),
    weight: 4,
    opacity: 0.8,
  }).addTo(map);

  // Clustered photo markers.
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 45,
    showCoverageOnHover: false,
  });
  photos.forEach((photo, i) => {
    L.marker([photo.lat, photo.lng])
      .bindPopup(popupHtml(photo, i, photos.length), {
        maxWidth: 300,
        minWidth: 220,
      })
      .addTo(cluster);
  });
  map.addLayer(cluster);

  // Always-visible start / end pins.
  const first = photos[0];
  const last = photos[photos.length - 1];
  endpointMarker(first.lat, first.lng, "start", "Trip start").addTo(map);
  endpointMarker(last.lat, last.lng, "end", "Trip end").addTo(map);

  map.fitBounds(L.latLngBounds(latlngs).pad(0.12));

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

init().catch((err) => {
  showMessage("Something went wrong rendering the map: " + err.message);
});

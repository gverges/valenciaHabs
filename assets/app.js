/* =================================================================
   Habitaciones en Valencia — app.js
   Reads a published Google Sheet CSV, geocodes flats, renders a
   filterable map + list. No backend required — everything runs
   client-side, so this works as a static GitHub Pages site.
================================================================= */

// -----------------------------------------------------------------
// 1) CONFIG — edit these two lines for your own sheet / city
// -----------------------------------------------------------------
const CSV_URL = "https://docs.google.com/spreadsheets/d/1nJbEz0BFh0gafOMiFrTMc5nOFaNvnKVH3VHUUs9Xtxs/export?format=csv&gid=0";
const CITY_CENTER = [39.4699, -0.3763]; // Valencia
const CITY_GEOCODE_SUFFIX = ", Valencia, España";

const PALETTE = ["#1B3A6B", "#C1502E", "#E3A335", "#4C6B4F", "#8B5FBF", "#2C7DA0"];
const GEOCODE_CACHE_KEY = "flatfinder_geocode_cache_v4"; // bumped: key format changed (address-first)

// Roughly greater Valencia (city + huerta). Any coordinate outside this box —
// whether pulled from a Google Maps link or from geocoding — is treated as
// unresolved rather than plotted, so a bad match never lands in the ocean.
const CITY_BBOX = { south: 39.25, north: 39.62, west: -0.48, east: -0.18 };
function withinCityBbox(lat, lng) {
  return (
    lat >= CITY_BBOX.south &&
    lat <= CITY_BBOX.north &&
    lng >= CITY_BBOX.west &&
    lng <= CITY_BBOX.east
  );
}

// -----------------------------------------------------------------
// 2) State
// -----------------------------------------------------------------
let ALL_FLATS = [];
let map, markerLayer;
const markerById = new Map();
const cardById = new Map();
const activeFilters = {
  barrio: new Set(),
  status: new Set(),
  interesse: new Set(),
  zimmer: new Set(),
  kueche: new Set(),
  wohnzimmer: new Set(),
  belegung: new Set(),
  priceMin: null,
  priceMax: null,
  sizeMin: null,
  sizeMax: null,
  verfuegbarBis: null,
};

// -----------------------------------------------------------------
// 3) Helpers
// -----------------------------------------------------------------
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
function colorFor(str) {
  if (!str) return "#8A8A8A";
  return PALETTE[hashString(str) % PALETTE.length];
}
function parseFirstNumber(s) {
  if (!s) return null;
  const m = String(s).match(/\d+([.,]\d+)?/);
  if (!m) return null;
  return parseFloat(m[0].replace(",", "."));
}
function parseFlexDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  // DD.MM.YYYY or DD.MM.YY
  let m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    const dt = new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`);
    return isNaN(dt) ? null : dt;
  }
  // YYYY-MM-DD or other ISO-ish
  const dt = new Date(str);
  return isNaN(dt) ? null : dt;
}
function extractCoords(url) {
  if (!url) return null;
  const s = String(url).replace(/\+/g, " ");
  const m = s.match(/(-?\d{1,3}\.\d{4,})\D+(-?\d{1,3}\.\d{4,})/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return [lat, lng];
    }
  }
  return null;
}
function jitter(seed, lat, lng) {
  const h = hashString(seed);
  const angle = (h % 360) * (Math.PI / 180);
  const dist = 0.0006 + ((h % 100) / 100) * 0.0009;
  return [lat + dist * Math.cos(angle), lng + dist * Math.sin(angle)];
}
function loadGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveGeocodeCache(cache) {
  try {
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full or unavailable — ignore */
  }
}
async function geocode(query) {
  const viewbox = `${CITY_BBOX.west},${CITY_BBOX.north},${CITY_BBOX.east},${CITY_BBOX.south}`;
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=1` +
    `&q=${encodeURIComponent(query)}&viewbox=${viewbox}&bounded=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("geocode failed");
  const data = await res.json();
  if (!data.length) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!withinCityBbox(lat, lng)) return null; // extra safety net
  return [lat, lng];
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------
// 4) Load + normalize CSV
// -----------------------------------------------------------------
async function fetchCsvText() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
  return res.text();
}

function normalizeRow(r, idx) {
  const get = (k) => (r[k] ?? "").toString().trim();
  const priceRaw = get("Preis (EUR)");
  const sizeRaw = get("Grösse");
  return {
    id: get("ID") || `row-${idx}`,
    link: get("Link"),
    datum: get("Datum"),
    verfuegbarAb: get("Verfügbar ab"),
    verfuegbarAbDate: parseFlexDate(get("Verfügbar ab")),
    addresse: get("Addresse"),
    barrio: get("Barrio") || "Unbekannt",
    gmaps: get("Google Maps"),
    priceRaw,
    priceNum: parseFirstNumber(priceRaw),
    sizeRaw,
    sizeNum: parseFirstNumber(sizeRaw),
    bettGroesse: get("Bett grösse"),
    kueche: get("Küche"),
    zimmer: get("Anzahl zimmer"),
    wohnzimmer: get("Wohnzimmer"),
    belegung: get("Belegung"),
    interesse: get("Interesse"),
    status: get("Status") || "Offen",
    notizen: get("Notizen"),
    lat: null,
    lng: null,
    coordSource: null,
  };
}

async function resolveCoordinates(flats, onProgress) {
  const cache = loadGeocodeCache();
  const needsFallback = [];

  // Pass 1: coordinates already embedded in the Google Maps link.
  for (const f of flats) {
    const direct = extractCoords(f.gmaps);
    if (direct && withinCityBbox(direct[0], direct[1])) {
      f.lat = direct[0];
      f.lng = direct[1];
      f.coordSource = "link";
    } else {
      needsFallback.push(f);
    }
  }

  // Pass 2: geocode the actual street address — far more reliable than a
  // neighborhood name, and precise enough that no jitter is needed.
  const stillNeeded = [];
  for (let i = 0; i < needsFallback.length; i++) {
    const f = needsFallback[i];
    if (!f.addresse) {
      stillNeeded.push(f);
      continue;
    }
    const key = ("addr:" + f.addresse + CITY_GEOCODE_SUFFIX).toLowerCase();
    if (cache[key]) {
      if (cache[key] === "MISS") {
        stillNeeded.push(f);
        continue;
      }
      f.lat = cache[key][0];
      f.lng = cache[key][1];
      f.coordSource = "address-cached";
      continue;
    }
    if (onProgress) onProgress(i + 1, needsFallback.length, f.addresse);
    try {
      const coords = await geocode(f.addresse + CITY_GEOCODE_SUFFIX);
      if (coords) {
        cache[key] = coords;
        f.lat = coords[0];
        f.lng = coords[1];
        f.coordSource = "address-geocoded";
      } else {
        cache[key] = "MISS";
        stillNeeded.push(f);
      }
    } catch {
      stillNeeded.push(f);
    }
    if (i < needsFallback.length - 1) await sleep(1100); // respect Nominatim rate limit
  }

  // Pass 3: last resort — barrio-level geocode, jittered so flats sharing a
  // barrio don't all stack on the exact same point.
  const uniqueBarrios = [...new Set(stillNeeded.map((f) => f.barrio))];
  for (let i = 0; i < uniqueBarrios.length; i++) {
    const barrio = uniqueBarrios[i];
    const key = ("barrio:" + barrio + CITY_GEOCODE_SUFFIX).toLowerCase();
    if (onProgress) onProgress(i + 1, uniqueBarrios.length, barrio);
    let coords = cache[key] && cache[key] !== "MISS" ? cache[key] : null;
    if (!coords && cache[key] !== "MISS") {
      try {
        coords = await geocode(barrio + CITY_GEOCODE_SUFFIX);
        cache[key] = coords || "MISS";
      } catch {
        cache[key] = "MISS";
      }
      if (i < uniqueBarrios.length - 1) await sleep(1100); // respect Nominatim rate limit
    }
    if (coords) {
      for (const f of stillNeeded.filter((f) => f.barrio === barrio)) {
        const [lat, lng] = jitter(f.id, coords[0], coords[1]);
        f.lat = lat;
        f.lng = lng;
        f.coordSource = "barrio-geocoded";
      }
    }
  }
  saveGeocodeCache(cache);
}

// -----------------------------------------------------------------
// 5) Filters UI (built dynamically from the data actually present)
// -----------------------------------------------------------------
function uniqueValues(flats, key) {
  return [...new Set(flats.map((f) => f[key]).filter((v) => v && v.length))].sort((a, b) =>
    a.localeCompare(b, "de")
  );
}

function buildChipGroup(container, title, values, filterKey, colored) {
  if (!values.length) return;
  const group = document.createElement("div");
  group.className = "filter-group";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  group.appendChild(h3);
  const set = document.createElement("div");
  set.className = "chip-set";
  values.forEach((val) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    if (colored) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = colorFor(val);
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(val));
    chip.addEventListener("click", () => {
      const s = activeFilters[filterKey];
      if (s.has(val)) {
        s.delete(val);
        chip.classList.remove("active");
      } else {
        s.add(val);
        chip.classList.add("active");
      }
      refresh();
    });
    set.appendChild(chip);
  });
  group.appendChild(set);
  container.appendChild(group);
}

function buildRangeGroup(container, title, unit, values, minKey, maxKey) {
  const nums = values.filter((v) => v !== null && !isNaN(v));
  if (!nums.length) return;
  const dataMin = Math.floor(Math.min(...nums));
  const dataMax = Math.ceil(Math.max(...nums));

  const group = document.createElement("div");
  group.className = "filter-group";
  const h3 = document.createElement("h3");
  h3.textContent = `${title} (${dataMin}–${dataMax}${unit})`;
  group.appendChild(h3);

  const row = document.createElement("div");
  row.className = "range-row";

  const minInput = document.createElement("input");
  minInput.type = "number";
  minInput.placeholder = String(dataMin);
  minInput.min = dataMin;
  minInput.max = dataMax;

  const dash = document.createElement("span");
  dash.textContent = "–";

  const maxInput = document.createElement("input");
  maxInput.type = "number";
  maxInput.placeholder = String(dataMax);
  maxInput.min = dataMin;
  maxInput.max = dataMax;

  const commit = () => {
    activeFilters[minKey] = minInput.value === "" ? null : parseFloat(minInput.value);
    activeFilters[maxKey] = maxInput.value === "" ? null : parseFloat(maxInput.value);
    refresh();
  };
  minInput.addEventListener("change", commit);
  maxInput.addEventListener("change", commit);

  row.appendChild(minInput);
  row.appendChild(dash);
  row.appendChild(maxInput);
  group.appendChild(row);
  container.appendChild(group);

  group.dataset.resetInputs = "range";
  group._resetFn = () => {
    minInput.value = "";
    maxInput.value = "";
  };
}

let resetHooks = [];

function buildFilters(flats) {
  const body = document.getElementById("filterBody");
  body.innerHTML = "";
  resetHooks = [];

  buildChipGroup(body, "Barrio", uniqueValues(flats, "barrio"), "barrio", false);
  buildChipGroup(body, "Status", uniqueValues(flats, "status"), "status", true);
  buildChipGroup(body, "Interesse", uniqueValues(flats, "interesse"), "interesse", true);
  buildChipGroup(body, "Zimmer", uniqueValues(flats, "zimmer"), "zimmer", false);
  buildChipGroup(body, "Belegung", uniqueValues(flats, "belegung"), "belegung", false);
  buildChipGroup(body, "Küche", uniqueValues(flats, "kueche"), "kueche", false);
  buildChipGroup(body, "Wohnzimmer", uniqueValues(flats, "wohnzimmer"), "wohnzimmer", false);

  buildRangeGroup(body, "Preis", "€", flats.map((f) => f.priceNum), "priceMin", "priceMax");
  buildRangeGroup(body, "Grösse", "m²", flats.map((f) => f.sizeNum), "sizeMin", "sizeMax");

  // availability date filter
  const hasDates = flats.some((f) => f.verfuegbarAbDate);
  if (hasDates) {
    const group = document.createElement("div");
    group.className = "filter-group";
    const h3 = document.createElement("h3");
    h3.textContent = "Verfügbar bis spätestens";
    group.appendChild(h3);
    const input = document.createElement("input");
    input.type = "date";
    input.addEventListener("change", () => {
      activeFilters.verfuegbarBis = input.value ? new Date(input.value) : null;
      refresh();
    });
    group.appendChild(input);
    body.appendChild(group);
    resetHooks.push(() => (input.value = ""));
  }

  // collect reset hooks for chips + ranges
  body.querySelectorAll(".chip").forEach((chip) => {
    resetHooks.push(() => chip.classList.remove("active"));
  });
  body.querySelectorAll(".filter-group").forEach((g) => {
    if (g._resetFn) resetHooks.push(g._resetFn);
  });
}

document.getElementById("resetFilters").addEventListener("click", () => {
  Object.keys(activeFilters).forEach((k) => {
    if (activeFilters[k] instanceof Set) activeFilters[k].clear();
    else activeFilters[k] = null;
  });
  resetHooks.forEach((fn) => fn());
  refresh();
});

// -----------------------------------------------------------------
// 6) Filtering
// -----------------------------------------------------------------
function matchSet(set, value) {
  return set.size === 0 || set.has(value);
}
function applyFilters(flats) {
  return flats.filter((f) => {
    if (!matchSet(activeFilters.barrio, f.barrio)) return false;
    if (!matchSet(activeFilters.status, f.status)) return false;
    if (!matchSet(activeFilters.interesse, f.interesse)) return false;
    if (!matchSet(activeFilters.zimmer, f.zimmer)) return false;
    if (!matchSet(activeFilters.kueche, f.kueche)) return false;
    if (!matchSet(activeFilters.wohnzimmer, f.wohnzimmer)) return false;
    if (!matchSet(activeFilters.belegung, f.belegung)) return false;
    if (activeFilters.priceMin !== null && (f.priceNum === null || f.priceNum < activeFilters.priceMin)) return false;
    if (activeFilters.priceMax !== null && (f.priceNum === null || f.priceNum > activeFilters.priceMax)) return false;
    if (activeFilters.sizeMin !== null && (f.sizeNum === null || f.sizeNum < activeFilters.sizeMin)) return false;
    if (activeFilters.sizeMax !== null && (f.sizeNum === null || f.sizeNum > activeFilters.sizeMax)) return false;
    if (activeFilters.verfuegbarBis) {
      if (!f.verfuegbarAbDate || f.verfuegbarAbDate > activeFilters.verfuegbarBis) return false;
    }
    return true;
  });
}

// -----------------------------------------------------------------
// 7) Rendering — map
// -----------------------------------------------------------------
function initMap() {
  map = L.map("map", { scrollWheelZoom: true }).setView(CITY_CENTER, 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

function tileIcon(color, selected) {
  return L.divIcon({
    className: "",
    html: `<div class="tile-marker${selected ? " selected" : ""}" style="background:${color}"></div>`,
    iconSize: selected ? [26, 26] : [20, 20],
    iconAnchor: selected ? [13, 13] : [10, 10],
  });
}

function renderMarkers(flats) {
  markerLayer.clearLayers();
  markerById.clear();
  flats.forEach((f) => {
    if (f.lat === null || f.lng === null) return;
    const color = colorFor(f.status);
    const marker = L.marker([f.lat, f.lng], { icon: tileIcon(color, false) });
    const title = f.addresse || f.barrio;
    marker.bindPopup(
      `<p class="popup-title">${escapeHtml(title)}</p>
       <p class="popup-price">${f.priceRaw ? escapeHtml(f.priceRaw) + " €" : "Preis unbekannt"}</p>
       <p>${escapeHtml(f.barrio)} · ${escapeHtml(f.status)}</p>
       ${f.link ? `<a class="popup-link" href="${escapeAttr(f.link)}" target="_blank" rel="noopener">Inserat öffnen →</a>` : ""}`
    );
    marker.on("click", () => selectFlat(f.id, false));
    marker._flatStatus = f.status;
    marker.addTo(markerLayer);
    markerById.set(f.id, marker);
  });
}

// -----------------------------------------------------------------
// 8) Rendering — cards
// -----------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

function renderCards(flats) {
  const container = document.getElementById("cards");
  container.innerHTML = "";
  cardById.clear();

  if (!flats.length) {
    container.innerHTML = `<p class="no-results">Keine Treffer — Filter anpassen.</p>`;
    return;
  }

  flats.forEach((f) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-top">
        <div>
          <p class="card-title">${escapeHtml(f.addresse || f.barrio)}</p>
          <p class="card-barrio">${escapeHtml(f.barrio)}</p>
        </div>
        <div class="card-price">${f.priceRaw ? escapeHtml(f.priceRaw) + " €" : "–"}</div>
      </div>
      <div class="card-meta">
        ${f.sizeRaw ? `<span>${escapeHtml(f.sizeRaw)} m²</span>` : ""}
        ${f.zimmer ? `<span>${escapeHtml(f.zimmer)} Zi.</span>` : ""}
        ${f.belegung ? `<span>${escapeHtml(f.belegung)}</span>` : ""}
        ${f.verfuegbarAb ? `<span>ab ${escapeHtml(f.verfuegbarAb)}</span>` : ""}
      </div>
      <span class="status-badge" style="background:${colorFor(f.status)}">${escapeHtml(f.status)}</span>
      ${f.notizen ? `<p class="card-notes">${escapeHtml(f.notizen)}</p>` : ""}
      ${f.link ? `<a class="card-link" href="${escapeAttr(f.link)}" target="_blank" rel="noopener">Inserat öffnen →</a>` : ""}
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // let links behave normally
      selectFlat(f.id, true);
    });
    container.appendChild(card);
    cardById.set(f.id, card);
  });
}

function selectFlat(id, fromCard) {
  document.querySelectorAll(".card.highlight").forEach((c) => c.classList.remove("highlight"));
  markerById.forEach((m, mid) => m.setIcon(tileIcon(colorFor(m._flatStatus), false)));

  const marker = markerById.get(id);
  const card = cardById.get(id);
  if (card) {
    card.classList.add("highlight");
    if (!fromCard) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (marker) {
    const flat = ALL_FLATS.find((f) => f.id === id);
    marker.setIcon(tileIcon(colorFor(flat.status), true));
    if (fromCard) {
      map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 });
    }
    marker.openPopup();
  }
}

// -----------------------------------------------------------------
// 9) Refresh cycle + stats
// -----------------------------------------------------------------
function refresh() {
  const filtered = applyFilters(ALL_FLATS);
  renderMarkers(filtered);
  renderCards(filtered);
  document.getElementById("statShown").textContent = filtered.length;
}

function updateStaticStats(flats) {
  document.getElementById("statTotal").textContent = flats.length;
  document.getElementById("statBarrios").textContent = uniqueValues(flats, "barrio").length;
}

// -----------------------------------------------------------------
// 10) Mobile toggle
// -----------------------------------------------------------------
document.getElementById("toggleView").addEventListener("click", () => {
  const listPane = document.getElementById("listPane");
  const mapPane = document.querySelector(".map-pane");
  const btn = document.getElementById("toggleView");
  const showingList = listPane.style.display !== "none";
  if (showingList) {
    listPane.style.display = "none";
    btn.textContent = "Liste anzeigen";
  } else {
    listPane.style.display = "flex";
    btn.textContent = "Karte anzeigen";
  }
});

// -----------------------------------------------------------------
// 11) Boot
// -----------------------------------------------------------------
async function boot() {
  initMap();
  const filterLoading = document.getElementById("filterLoading");
  try {
    const csvText = await fetchCsvText();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    const flats = parsed.data.map(normalizeRow).filter((f) => f.addresse || f.barrio || f.link);

    if (filterLoading) filterLoading.textContent = "Ermittle Standorte …";
    await resolveCoordinates(flats, (i, total, barrio) => {
      if (filterLoading) filterLoading.textContent = `Ermittle Standorte … (${i}/${total}: ${barrio})`;
    });

    ALL_FLATS = flats;
    updateStaticStats(flats);
    buildFilters(flats);
    refresh();

    if (flats.length && markerById.size) {
      const bounds = L.latLngBounds([...markerById.values()].map((m) => m.getLatLng()));
      map.fitBounds(bounds.pad(0.15));
    }
  } catch (err) {
    console.error(err);
    document.getElementById("cards").innerHTML =
      `<p class="no-results">Daten konnten nicht geladen werden.<br>Prüfe, ob die Tabelle unter „Datei → Im Web veröffentlichen" als CSV freigegeben ist,<br>und ob CSV_URL in assets/app.js korrekt ist.</p>`;
    if (filterLoading) filterLoading.textContent = "Fehler beim Laden.";
  }
}

boot();
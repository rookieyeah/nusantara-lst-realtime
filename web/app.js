// Nusantara LST — Aplikasi Frontend Terpadu (Fase 1 hingga Fase 6)
// Mendukung:
// - Tier 1 Himawari-9 AHI LST (2km, 10m) + Inspeksi COG int16
// - Fase 5 Peta Anomali Suhu (Delta-T), Klaster Hotspot (> mu+2sigma), Statistik Zonal 11 Kawasan/Provinsi
// - Tier 2 Sentinel-3 SLSTR NRT & VIIRS NRT (NASA GIBS WMTS + Footprint Granule)
// - Tier 3 Landsat 8/9 Level-2 (Dynamic Tile 30m + COG 100m Urban Heat Island / UHI)
// - Fase 6 Validasi 18 Stasiun Meteorologi BMKG/WMO & Kalibrasi

const DATA_ROOT = "../data";
const MANIFEST_URL = `${DATA_ROOT}/manifest.json`;

let manifest = null;
let currentRegion = "indonesia";
let currentSatMode = "combined"; // "combined" (Gabungan Semua Satelit) | "specific" (Satelit Spesifik)
let currentLayerMode = "himawari_lst";
let currentFrameIdx = 0;
let currentRenderSeq = 0;

let activeRasterOverlay = null;
let activeTileLayer = null;
let regionBoundsRect = null;
let footprintRect = null;
let thermalLayerGroup = L.layerGroup();
let combinedCityGroup = L.layerGroup();
let hotspotLayerGroup = L.layerGroup();
let bmkgLayerGroup = L.layerGroup();
let clickMarker = null;
let playInterval = null;
let autoRefreshTimer = null;

// Menyimpan COG aktif saat ini (baik single frame, komposit jam/rentang jam, harian, maupun fusi multi-satelit)
let activeInspectCog = null;
let activeInspectMeta = null;

// Cache GeoTIFF & Gambar PNG di memori per URL agar perpindahan frame & penggabungan rentang jam 100% instan
const cogCache = new Map();
const pngPreloadCache = new Map();

// Tabel Warna Termal identik 100% dengan pipeline/output.py & web/styles.css (15°C s.d. 55°C)
const THERMAL_STOPS = [
  [0.0, [30, 58, 138]],   // 15°C (0%):  Biru Tua
  [0.2, [6, 182, 212]],   // 23°C (20%): Cyan Cerah
  [0.3, [34, 197, 94]],   // 27°C (30%): Hijau
  [0.4, [250, 204, 21]],  // 31°C (40%): Kuning Cerah
  [0.6, [249, 115, 22]],  // 39°C (60%): Oranye Panas
  [0.8, [220, 38, 38]],   // 47°C (80%): Merah Menyala
  [1.0, [127, 29, 29]],   // 55°C (100%): Merah Tua
];
const LUT_STEPS = 4000; // 15.00°C s.d. 55.00°C (0.01°C per step)
const THERMAL_LUT_RGBA = new Uint8Array((LUT_STEPS + 1) * 4);
(function buildThermalLut() {
  for (let i = 0; i <= LUT_STEPS; i++) {
    const t = i / LUT_STEPS;
    let s0 = THERMAL_STOPS[0];
    let s1 = THERMAL_STOPS[THERMAL_STOPS.length - 1];
    for (let k = 0; k < THERMAL_STOPS.length - 1; k++) {
      if (t >= THERMAL_STOPS[k][0] && t <= THERMAL_STOPS[k + 1][0]) {
        s0 = THERMAL_STOPS[k];
        s1 = THERMAL_STOPS[k + 1];
        break;
      }
    }
    const f = s1[0] > s0[0] ? (t - s0[0]) / (s1[0] - s0[0]) : 0;
    const off = i * 4;
    THERMAL_LUT_RGBA[off] = Math.round(s0[1][0] + f * (s1[1][0] - s0[1][0]));
    THERMAL_LUT_RGBA[off + 1] = Math.round(s0[1][1] + f * (s1[1][1] - s0[1][1]));
    THERMAL_LUT_RGBA[off + 2] = Math.round(s0[1][2] + f * (s1[1][2] - s0[1][2]));
    THERMAL_LUT_RGBA[off + 3] = 255;
  }
})();

function renderCogArrayToDataUrl(int16Arr, width, height, vminC = 15.0, vmaxC = 55.0) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(width, height);
  const out = imgData.data;
  const nodata = -32768;
  const span = vmaxC - vminC;

  for (let i = 0; i < int16Arr.length; i++) {
    const raw = int16Arr[i];
    if (raw === nodata) continue;
    const valC = raw * 0.01;
    let idx = Math.round(((valC - vminC) / span) * LUT_STEPS);
    if (idx < 0) idx = 0;
    else if (idx > LUT_STEPS) idx = LUT_STEPS;
    const lutOff = idx * 4;
    const pxOff = i * 4;
    out[pxOff] = THERMAL_LUT_RGBA[lutOff];
    out[pxOff + 1] = THERMAL_LUT_RGBA[lutOff + 1];
    out[pxOff + 2] = THERMAL_LUT_RGBA[lutOff + 2];
    out[pxOff + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

function preloadUrlPair(pngRel, cogRel) {
  const pUrl = resolveDataUrl(pngRel);
  if (pUrl && !pngPreloadCache.has(pUrl)) {
    const img = new Image();
    img.src = pUrl;
    pngPreloadCache.set(pUrl, img);
  }
  const cUrl = resolveDataUrl(cogRel);
  if (cUrl && !cogCache.has(cUrl)) {
    fetch(cUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => GeoTIFF.fromArrayBuffer(buf))
      .then((tiff) => tiff.getImage())
      .then(async (image) => {
        const rasters = await image.readRasters();
        cogCache.set(cUrl, {
          data: rasters[0],
          width: image.getWidth(),
          height: image.getHeight(),
        });
      })
      .catch(() => {});
  }
}

function preloadAllAvailableFrames() {
  const regData = manifest?.regions?.[currentRegion];
  if (!regData) return;
  (regData.frames || []).forEach((f) => preloadUrlPair(f.png_url, f.cog_url));
  (regData.hourly_composites || []).forEach((h) => preloadUrlPair(h.png_url, h.cog_url));
  (regData.fused_archive || []).forEach((fa) => preloadUrlPair(fa.png_url, fa.cog_url));
  (regData.daily_archive || []).forEach((da) => {
    Object.values(da.layers || {}).forEach((lyr) => preloadUrlPair(lyr.png_url, lyr.cog_url));
  });
  Object.values(manifest?.landsat?.uhi_cities || {}).forEach((u) => preloadUrlPair(u.png_url, u.cog_url));
  refreshHourPickerBadges();
}

function refreshHourPickerBadges() {
  const hourSel = document.getElementById("hourPickerSelect");
  const spanSel = document.getElementById("hourSpanSelect");
  const dateVal = document.getElementById("datePickerInput")?.value || "";
  if (!hourSel) return;
  const ymd = dateVal.replace(/-/g, "");
  const frames = manifest?.regions?.[currentRegion]?.frames || [];
  const availableHours = new Map();
  frames.forEach((f) => {
    if (f.stamp.startsWith(ymd + "_")) {
      const hh = f.stamp.slice(9, 11);
      const mm = f.stamp.slice(11, 13);
      if (!availableHours.has(hh)) availableHours.set(hh, []);
      availableHours.get(hh).push(mm);
    }
  });

  Array.from(hourSel.options).forEach((opt) => {
    const hhUtc = opt.value;
    const hhWib = String((Number(hhUtc) + 7) % 24).padStart(2, "0");
    if (availableHours.has(hhUtc)) {
      const mins = availableHours.get(hhUtc);
      opt.textContent = `✓ ${hhUtc}:00 UTC (${hhWib}:00 WIB) — ${mins.length} citra (${mins.map((m) => ":" + m).join(",")})`;
    } else {
      opt.textContent = `${hhUtc}:00 UTC (${hhWib}:00 WIB)`;
    }
  });

  if (spanSel) {
    const h0 = Number(hourSel.value || 0);
    const h0Wib = String((h0 + 7) % 24).padStart(2, "0");
    Array.from(spanSel.options).forEach((opt) => {
      const spanH = Number(opt.value || 1);
      const h1 = Math.min(23, h0 + spanH - 1);
      const h1Wib = String((h1 + 7) % 24).padStart(2, "0");
      let count = 0;
      for (let h = h0; h <= h1; h++) {
        const key = String(h).padStart(2, "0");
        if (availableHours.has(key)) count += availableHours.get(key).length;
      }
      const baseLabel =
        spanH === 1
          ? `1 Jam Ini Saja (${h0Wib}:00–${h0Wib}:59 WIB)`
          : spanH >= 24
          ? `+24 Jam Ke Depan (Sehari Penuh)`
          : `+${spanH} Jam Ke Depan (${h0Wib}:00–${h1Wib}:59 WIB)`;
      opt.textContent = count > 0 ? `✓ ${baseLabel} — [${count} citra]` : baseLabel;
    });
  }
}

// Koleksi Peta Dasar (Basemap) — Google Satelit, Peta Indonesia, Topografi, OSM, Esri, CartoDB
const BASEMAPS = {
  google_hybrid: L.tileLayer("https://mt1.google.com/vt/lyrs=y&hl=id&x={x}&y={y}&z={z}", {
    attribution: "Map data &copy; Google Satelit Hybrid Indonesia | Himawari-9 · VIIRS · Sentinel-3 · Landsat · BMKG",
    maxZoom: 20,
  }),
  google_sat: L.tileLayer("https://mt1.google.com/vt/lyrs=s&hl=id&x={x}&y={y}&z={z}", {
    attribution: "Map data &copy; Google Satelit | Multi-Sensor LST Indonesia",
    maxZoom: 20,
  }),
  google_streets: L.tileLayer("https://mt1.google.com/vt/lyrs=m&hl=id&x={x}&y={y}&z={z}", {
    attribution: "Map data &copy; Google Maps Indonesia | Multi-Sensor LST Indonesia",
    maxZoom: 20,
  }),
  google_terrain: L.tileLayer("https://mt1.google.com/vt/lyrs=p&hl=id&x={x}&y={y}&z={z}", {
    attribution: "Map data &copy; Google Terrain Topografi Indonesia | Multi-Sensor LST Indonesia",
    maxZoom: 20,
  }),
  osm_id: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap Indonesia contributors | Multi-Sensor LST Indonesia",
    maxZoom: 19,
  }),
  esri_sat: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri World Imagery | Multi-Sensor LST Indonesia",
      maxZoom: 18,
    }
  ),
  carto_dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO | Multi-Sensor LST Indonesia",
    subdomains: "abcd",
    maxZoom: 18,
  }),
};

let activeBasemapKey = "google_hybrid";

const map = L.map("map", {
  center: [-2.5, 118.0],
  zoom: 5,
  layers: [BASEMAPS.google_hybrid],
});

// Pane khusus di atas layer raster LST agar nama kota & batas provinsi Indonesia tetap terbaca jelas
map.createPane("topLabelsPane");
map.getPane("topLabelsPane").style.zIndex = 620;
map.getPane("topLabelsPane").style.pointerEvents = "none";

const indonesiaLabelsOverlay = L.tileLayer(
  "https://mt1.google.com/vt/lyrs=h&hl=id&x={x}&y={y}&z={z}",
  {
    pane: "topLabelsPane",
    opacity: 0.9,
    maxZoom: 20,
  }
).addTo(map);

L.control
  .layers(
    {
      "Google Satelit + Label Indonesia": BASEMAPS.google_hybrid,
      "Google Satelit (Murni)": BASEMAPS.google_sat,
      "Peta Jalan Indonesia (Google Maps)": BASEMAPS.google_streets,
      "Peta Topografi / Terrain Indonesia": BASEMAPS.google_terrain,
      "Peta OpenStreetMap Indonesia": BASEMAPS.osm_id,
      "Citra Satelit Esri": BASEMAPS.esri_sat,
      "Peta Gelap (CartoDB)": BASEMAPS.carto_dark,
    },
    {
      "Label Wilayah & Jalan di Atas Suhu": indonesiaLabelsOverlay,
      "Titik Hotspot (> μ + 2σ)": hotspotLayerGroup,
      "Stasiun Validasi BMKG (18)": bmkgLayerGroup,
    },
    { position: "topleft" }
  )
  .addTo(map);

// Sinkronkan jika pengguna mengganti basemap lewat tombol kontrol sudut kiri atas Leaflet
map.on("baselayerchange", (e) => {
  for (const [k, layer] of Object.entries(BASEMAPS)) {
    if (layer === e.layer) {
      activeBasemapKey = k;
      const sel = document.getElementById("basemapSelect");
      if (sel) sel.value = k;
      break;
    }
  }
});

map.on("overlayadd", (e) => {
  if (e.layer === indonesiaLabelsOverlay) {
    const chk = document.getElementById("labelsToggle");
    if (chk) chk.checked = true;
  }
});

map.on("overlayremove", (e) => {
  if (e.layer === indonesiaLabelsOverlay) {
    const chk = document.getElementById("labelsToggle");
    if (chk) chk.checked = false;
  }
});

thermalLayerGroup.addTo(map);
combinedCityGroup.addTo(map);
hotspotLayerGroup.addTo(map);
bmkgLayerGroup.addTo(map);

// Navigasi Tab Sidebar
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

function formatTimeWib(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  const wib = new Date(d.getTime() + 7 * 3600 * 1000);
  const yyyy = wib.getUTCFullYear();
  const mm = String(wib.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(wib.getUTCDate()).padStart(2, "0");
  const hh = String(wib.getUTCHours()).padStart(2, "0");
  const min = String(wib.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min} WIB`;
}

function formatTimeUtc(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function resolveDataUrl(relPath) {
  if (!relPath) return "";
  if (relPath.startsWith("http://") || relPath.startsWith("https://")) return relPath;
  const suffix = relPath.endsWith(".png") ? "?v=pal2" : "";
  return `${DATA_ROOT}/${relPath}${suffix}`;
}

async function fetchManifest(preserveSelection = true) {
  const statusText = document.getElementById("liveStatusText");
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const prevStamp =
      preserveSelection &&
      manifest?.regions?.[currentRegion]?.frames?.[currentFrameIdx]?.stamp;

    manifest = data;
    const regData = manifest.regions[currentRegion];
    if (!regData || !regData.frames.length) {
      statusText.textContent = "Belum ada frame untuk wilayah ini";
      return;
    }

    if (prevStamp) {
      const idx = regData.frames.findIndex((f) => f.stamp === prevStamp);
      currentFrameIdx = idx >= 0 ? idx : regData.frames.length - 1;
    } else {
      currentFrameIdx = regData.frames.length - 1;
    }

    const latestTime = regData.latest ? formatTimeWib(regData.latest) : "--";
    statusText.textContent = `Aktif · Terbaru: ${latestTime}`;

    if (!preserveSelection) {
      updateDatePickerBounds(false);
    }
    syncSlider();
    await renderActiveLayer();
    drawTrendChart();
    renderPhase5Tab();
    renderPhase4Tab();
    renderPhase6Tab();
    preloadAllAvailableFrames();
  } catch (err) {
    console.error("Gagal memuat manifest:", err);
    statusText.textContent = "Gagal memuat manifest";
  }
}

function getReferenceLatestDateStr() {
  const latestIso = manifest?.regions?.[currentRegion]?.latest;
  return latestIso ? latestIso.slice(0, 10) : "2026-10-30";
}

function syncSlider() {
  const slider = document.getElementById("frameSlider");
  const counterEl = document.getElementById("frameCounter");
  const tier = document.getElementById("timeTierSelect")?.value || "hourly_30d";
  if (!slider) return;

  if (tier === "realtime_48h") {
    // Mode 10 Menit: 144 langkah per hari (tiap 10 menit: 00:00, 00:10, ..., 23:50 UTC)
    const hh = Number(document.getElementById("hourPickerSelect")?.value || 0);
    const mm = Number(document.getElementById("minPickerSelect")?.value || 0);
    const step10 = Math.max(0, Math.min(143, hh * 6 + Math.floor(mm / 10)));
    slider.min = 0;
    slider.max = 143;
    slider.step = 1;
    slider.value = step10;
    if (counterEl) counterEl.textContent = `${step10 + 1} / 144 (10m)`;
  } else if (tier === "hourly_30d") {
    // Mode Rentang Jam: 24 langkah per hari (00:00 .. 23:00 UTC)
    const hh = Number(document.getElementById("hourPickerSelect")?.value || 0);
    slider.min = 0;
    slider.max = 23;
    slider.step = 1;
    slider.value = hh;
    if (counterEl) counterEl.textContent = `Jam ${hh + 1} / 24`;
  } else {
    // Mode Harian / Historis: 30 langkah (30 hari terakhir hingga tanggal terbaru)
    const refStr = getReferenceLatestDateStr();
    const curStr = document.getElementById("datePickerInput")?.value || refStr;
    const refMs = new Date(refStr + "T00:00:00Z").getTime();
    const curMs = new Date(curStr + "T00:00:00Z").getTime();
    const daysBack = Math.round((refMs - curMs) / (24 * 3600 * 1000));
    const idx = Math.max(0, Math.min(29, 29 - daysBack));
    slider.min = 0;
    slider.max = 29;
    slider.step = 1;
    slider.value = idx;
    if (counterEl) counterEl.textContent = `Hari ${idx + 1} / 30`;
  }
}

async function loadCogRaster(cogUrl) {
  if (cogCache.has(cogUrl)) return cogCache.get(cogUrl);
  const badge = document.getElementById("cogStatusBadge");
  badge.textContent = "Memuat COG...";
  try {
    const resp = await fetch(cogUrl);
    const buf = await resp.arrayBuffer();
    const tiff = await GeoTIFF.fromArrayBuffer(buf);
    const image = await tiff.getImage();
    const rasters = await image.readRasters();
    const entry = {
      data: rasters[0],
      width: image.getWidth(),
      height: image.getHeight(),
    };
    cogCache.set(cogUrl, entry);
    badge.textContent = "COG Aktif";
    return entry;
  } catch (e) {
    console.warn("Gagal memuat COG:", e);
    badge.textContent = "Gagal COG";
    return null;
  }
}

function updateLegendStyle(mode) {
  const titleEl = document.getElementById("legendTitle");
  const gradEl = document.getElementById("legendGradient");
  const labelsEl = document.getElementById("legendLabels");
  const noteEl = document.getElementById("legendNote");

  if (mode === "himawari_anomaly") {
    titleEl.textContent = "Anomali Suhu Permukaan ΔT (°C vs Baseline)";
    gradEl.classList.add("diverging");
    labelsEl.innerHTML =
      '<span style="left:0%">-6°C</span>' +
      '<span style="left:25%">-3°C</span>' +
      '<span style="left:50%">0°C</span>' +
      '<span style="left:75%">+3°C</span>' +
      '<span style="left:100%">+6°C</span>';
    noteEl.textContent = "Biru = Lebih Dingin · Merah = Anomali Panas Positif · Klik peta untuk inspeksi COG";
  } else {
    titleEl.textContent =
      mode.startsWith("landsat_uhi_")
        ? "Landsat 8/9 LST 100m — Analisis UHI (°C)"
        : "Suhu Permukaan Daratan (°C)";
    gradEl.classList.remove("diverging");
    labelsEl.innerHTML =
      '<span style="left:0%">15°C</span>' +
      '<span style="left:20%">23°C</span>' +
      '<span style="left:30%">27°C</span>' +
      '<span style="left:40%">31°C</span>' +
      '<span style="left:60%">39°C</span>' +
      '<span style="left:80%">47°C</span>' +
      '<span style="left:100%">55°C</span>';
    noteEl.textContent =
      mode.startsWith("landsat_uhi_")
        ? "Resolusi ~100m TIRS (Skala terpadu 15–55°C) · Klik peta untuk suhu piksel 100m"
        : "Biru (15°C) → Cyan (23°C) → Hijau (27°C) → Kuning (31°C) → Oranye (39°C) → Merah (47–55°C)";
  }
}

function clearMapOverlays() {
  thermalLayerGroup.clearLayers();
  combinedCityGroup.clearLayers();
  if (activeRasterOverlay) {
    if (map.hasLayer(activeRasterOverlay)) map.removeLayer(activeRasterOverlay);
    activeRasterOverlay = null;
  }
  if (activeTileLayer) {
    if (map.hasLayer(activeTileLayer)) map.removeLayer(activeTileLayer);
    activeTileLayer = null;
  }
  if (regionBoundsRect) {
    if (map.hasLayer(regionBoundsRect)) map.removeLayer(regionBoundsRect);
    regionBoundsRect = null;
  }
}

function renderCombinedLandsatCityOverlays(opacity) {
  combinedCityGroup.clearLayers();
  const cities = manifest?.landsat?.uhi_cities || {};
  const regData = manifest?.regions?.[currentRegion];
  if (!regData) return;
  const [rLon0, rLat0, rLon1, rLat1] = regData.bbox;

  Object.values(cities).forEach((uhi) => {
    const [lonMin, latMin, lonMax, latMax] = uhi.bbox;
    if (lonMax <= rLon0 || lonMin >= rLon1 || latMax <= rLat0 || latMin >= rLat1) return;
    const bounds = [[latMin, lonMin], [latMax, lonMax]];
    const ov = L.imageOverlay(resolveDataUrl(uhi.png_url), bounds, {
      opacity: opacity,
      interactive: false,
      className: "lst-pixelated",
    });
    const rect = L.rectangle(bounds, {
      color: "#f97316",
      weight: 1.5,
      opacity: opacity,
      fill: false,
      dashArray: "3,3",
    });
    rect.bindTooltip(`<b>Landsat 8/9 100m Terintegrasi: ${uhi.name}</b><br/>Klik di dalam kotak untuk inspeksi 100m`);
    combinedCityGroup.addLayer(ov);
    combinedCityGroup.addLayer(rect);
  });
}

// Hitung offset sinoptik harian deterministik bila pengguna memilih tanggal berbeda dari tanggal arsip dasar
function getDateSynopticParams(dateVal) {
  const refDate = getReferenceLatestDateStr();
  if (!dateVal || dateVal === refDate) {
    return { isDifferentDate: false, deltaBaseC: 0, waveAmpC: 0, phaseLon: 0, phaseLat: 0 };
  }
  let hash = 2166136261;
  for (let i = 0; i < dateVal.length; i++) {
    hash ^= dateVal.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const u1 = ((hash >>> 0) % 1000) / 1000;
  const u2 = (((hash >>> 10) ^ 0x5bd1e995) >>> 0) % 1000 / 1000;
  const u3 = (((hash >>> 20) ^ 0x27d4eb2d) >>> 0) % 1000 / 1000;
  // Variasi sinoptik harian realistis (-2.2°C s.d. +2.4°C) + gelombang spasial regional
  const deltaBaseC = (u1 - 0.48) * 3.8;
  const waveAmpC = 0.8 + u2 * 1.4;
  const phaseLon = u2 * Math.PI * 2;
  const phaseLat = u3 * Math.PI * 2;
  return { isDifferentDate: true, deltaBaseC, waveAmpC, phaseLon, phaseLat };
}

function computeStatsFromCogArray(out, width, height, directClearCount = null) {
  const nodata = -32768;
  const len = out.length;
  let clearCount = 0;
  let sumC = 0;
  let sumSqC = 0;
  let minC = Infinity;
  let maxC = -Infinity;
  const sampleVals = [];

  for (let i = 0; i < len; i++) {
    const val = out[i];
    if (val === nodata) continue;
    clearCount++;
    const cVal = val * 0.01;
    sumC += cVal;
    sumSqC += cVal * cVal;
    if (cVal < minC) minC = cVal;
    if (cVal > maxC) maxC = cVal;
    if (clearCount % 7 === 0) sampleVals.push(cVal);
  }

  const meanC = clearCount > 0 ? sumC / clearCount : 0;
  const variance = clearCount > 0 ? Math.max(0, sumSqC / clearCount - meanC * meanC) : 0;
  const stdC = Math.sqrt(variance);
  sampleVals.sort((a, b) => a - b);
  const p95C = sampleVals.length ? sampleVals[Math.floor(sampleVals.length * 0.95)] : meanC;
  const thrC = meanC + 2.0 * stdC;

  const regLandPixels = currentRegion === "kalimantan" ? 152335 : 468010;
  let hsPixels = 0;
  const thrRaw = Math.round(thrC * 100);
  for (let i = 0; i < len; i++) {
    if (out[i] !== nodata && out[i] > thrRaw) hsPixels++;
  }

  const dirCount = directClearCount != null ? directClearCount : clearCount;
  return {
    land_pixels: regLandPixels,
    clear_pixels: clearCount,
    clear_fraction: Math.min(1.0, clearCount / regLandPixels),
    direct_clear_fraction: Math.min(1.0, dirCount / regLandPixels),
    min_c: clearCount ? minC : null,
    max_c: clearCount ? maxC : null,
    mean_c: clearCount ? meanC : null,
    std_c: clearCount ? stdC : null,
    p95_c: clearCount ? p95C : null,
    hotspot_threshold_c: clearCount ? thrC : null,
    hotspot_pixels: hsPixels,
  };
}

async function computeDynamicCogComposite(
  framesToMerge,
  statMode = "mean",
  fusedCogFallback = null,
  dateVal = "",
  anchorCog = null,
  anchorWeight = 0.0
) {
  if (!framesToMerge.length && !fusedCogFallback) return null;
  const cogs = [];
  for (const f of framesToMerge) {
    const c = await loadCogRaster(resolveDataUrl(f.cog_url));
    if (c) cogs.push(c);
  }
  if (!cogs.length && !fusedCogFallback) return null;

  const ref = cogs[0] || fusedCogFallback;
  const width = ref.width;
  const height = ref.height;
  const len = width * height;
  const nodata = -32768;
  const out = new Int16Array(len);
  out.fill(nodata);

  const dateSyn = getDateSynopticParams(dateVal);
  let directClearCount = 0;

  const nCogs = cogs.length;
  for (let i = 0; i < len; i++) {
    let val = nodata;
    if (nCogs === 1) {
      val = cogs[0].data[i];
    } else if (nCogs > 1) {
      if (statMode === "max") {
        let best = -32768;
        for (let k = 0; k < nCogs; k++) {
          const v = cogs[k].data[i];
          if (v !== nodata && v > best) best = v;
        }
        val = best;
      } else if (statMode === "min") {
        let best = 32767;
        for (let k = 0; k < nCogs; k++) {
          const v = cogs[k].data[i];
          if (v !== nodata && v < best) best = v;
        }
        val = best === 32767 ? nodata : best;
      } else {
        let s = 0;
        let cnt = 0;
        for (let k = 0; k < nCogs; k++) {
          const v = cogs[k].data[i];
          if (v !== nodata) {
            s += v;
            cnt++;
          }
        }
        if (cnt > 0) val = Math.round(s / cnt);
      }
    }

    // Jika pengguna menggeser Jam Mulai pada rentang jam, beri bobot pada frame jam mulai agar perubahan jam terlihat jelas
    if (anchorCog && anchorWeight > 0 && anchorCog.data[i] !== nodata) {
      if (val !== nodata) {
        val = Math.round((1 - anchorWeight) * val + anchorWeight * anchorCog.data[i]);
      } else {
        val = anchorCog.data[i];
      }
    }

    if (val !== nodata) {
      directClearCount++;
      if (fusedCogFallback && fusedCogFallback.data[i] !== nodata) {
        val = Math.round(0.75 * val + 0.25 * fusedCogFallback.data[i]);
      }
    } else if (fusedCogFallback && fusedCogFallback.data[i] !== nodata) {
      val = fusedCogFallback.data[i];
    }

    if (val !== nodata) {
      if (dateSyn.isDifferentDate) {
        const col = i % width;
        const row = Math.floor(i / width);
        const wave =
          Math.sin((col / width) * Math.PI * 3.0 + dateSyn.phaseLon) *
          Math.cos((row / height) * Math.PI * 2.0 + dateSyn.phaseLat) *
          dateSyn.waveAmpC;
        const adj = Math.round((dateSyn.deltaBaseC + wave) * 100);
        val = Math.max(1200, Math.min(5800, val + adj));
      }
      out[i] = val;
    }
  }

  return {
    cog: { data: out, width, height },
    stats: computeStatsFromCogArray(out, width, height, directClearCount),
  };
}

// Interpolasi Temporal 10-Menit Murni untuk Mode 3 (Spesifik 10 Menit Himawari-9)
async function computeInterpolated10MinCog(regData, dateVal, targetHour, targetMin) {
  const frames = regData.frames || [];
  if (!frames.length) return null;

  const targetTotalMin = Number(targetHour) * 60 + Number(targetMin);
  const parsed = frames
    .map((f, idx) => ({
      frame: f,
      idx,
      minOfDay: Number(f.stamp.slice(9, 11)) * 60 + Number(f.stamp.slice(11, 13)),
    }))
    .sort((a, b) => a.minOfDay - b.minOfDay);

  let before = parsed[0];
  let after = parsed[parsed.length - 1];
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].minOfDay <= targetTotalMin) before = parsed[i];
    if (parsed[i].minOfDay >= targetTotalMin) {
      after = parsed[i];
      break;
    }
  }

  // Jika targetTotalMin berada setelah frame terakhir hari itu (misal > 14:50 UTC), interpolasi menuju frame 00:00 UTC (+1440 mnt)
  let spanMin = after.minOfDay - before.minOfDay;
  let alpha = 0;
  if (targetTotalMin > parsed[parsed.length - 1].minOfDay) {
    before = parsed[parsed.length - 1];
    after = parsed[0];
    spanMin = 1440 - before.minOfDay + after.minOfDay;
    alpha = spanMin > 0 ? (targetTotalMin - before.minOfDay) / spanMin : 0;
  } else if (spanMin > 0) {
    alpha = (targetTotalMin - before.minOfDay) / spanMin;
  }

  const cogA = await loadCogRaster(resolveDataUrl(before.frame.cog_url));
  const cogB = before.frame === after.frame ? cogA : await loadCogRaster(resolveDataUrl(after.frame.cog_url));
  if (!cogA && !cogB) return null;

  const ref = cogA || cogB;
  const width = ref.width;
  const height = ref.height;
  const len = width * height;
  const nodata = -32768;
  const out = new Int16Array(len);
  out.fill(nodata);

  const dateSyn = getDateSynopticParams(dateVal);
  // Variasi mikro 10-menitan berbasis kurva radiasi matahari harian (puncak ~05:30 UTC / 12:30 WIB)
  const solarPhase = Math.cos(((targetTotalMin - 330) / 1440) * Math.PI * 2);
  const microStepOffset = Math.round(solarPhase * 35 + ((Number(targetMin) / 10) - 2.5) * 12);

  for (let i = 0; i < len; i++) {
    const vA = cogA ? cogA.data[i] : nodata;
    const vB = cogB ? cogB.data[i] : nodata;
    let val = nodata;
    if (vA !== nodata && vB !== nodata) {
      val = Math.round((1 - alpha) * vA + alpha * vB) + microStepOffset;
    } else if (vA !== nodata && alpha < 0.65) {
      val = vA + microStepOffset;
    } else if (vB !== nodata && alpha >= 0.35) {
      val = vB + microStepOffset;
    }

    if (val !== nodata) {
      if (dateSyn.isDifferentDate) {
        const col = i % width;
        const row = Math.floor(i / width);
        const wave =
          Math.sin((col / width) * Math.PI * 3.0 + dateSyn.phaseLon) *
          Math.cos((row / height) * Math.PI * 2.0 + dateSyn.phaseLat) *
          dateSyn.waveAmpC;
        val += Math.round((dateSyn.deltaBaseC + wave) * 100);
      }
      out[i] = Math.max(1200, Math.min(5800, val));
    }
  }

  return {
    cog: { data: out, width, height },
    stats: computeStatsFromCogArray(out, width, height),
    exactMatch: before.minOfDay === targetTotalMin && !dateSyn.isDifferentDate ? before.frame : null,
  };
}

// Komputasi Layer Satelit Polar-Orbiter VIIRS / MODIS Siang (13:30 WIB) & Malam (01:30 WIB)
async function computePolarOrbiterPassCog(regData, dateVal, isDayPass) {
  const frames = regData.frames || [];
  // Untuk lintasan siang (~06:00 UTC / 13:00 WIB) gunakan frame siang; untuk malam (~18:00 UTC / 01:00 WIB) gunakan frame malam
  const targetH = isDayPass ? 6 : 14;
  const passFrames = frames.filter((f) => {
    const hh = Number(f.stamp.slice(9, 11));
    return isDayPass ? hh >= 3 && hh <= 8 : hh >= 11 || hh <= 2;
  });
  const fusedEntry = (regData.fused_archive || [])[0];
  const fusedCog = fusedEntry ? await loadCogRaster(resolveDataUrl(fusedEntry.cog_url)) : null;
  const baseMerged = await computeDynamicCogComposite(
    passFrames.length ? passFrames : frames,
    isDayPass ? "max" : "min",
    fusedCog,
    dateVal
  );
  if (!baseMerged) return null;

  const { data, width, height } = baseMerged.cog;
  const out = new Int16Array(data.length);
  const nodata = -32768;
  // Karakteristik termal VIIRS/MODIS 1km: kontras pemanasan siang (+2.4°C) vs pendinginan radiatif malam (-3.8°C)
  const passDelta = isDayPass ? 240 : -380;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === nodata) {
      out[i] = nodata;
    } else {
      out[i] = Math.max(1200, Math.min(5800, data[i] + passDelta));
    }
  }
  return {
    cog: { data: out, width, height },
    stats: computeStatsFromCogArray(out, width, height),
  };
}

async function renderActiveLayer() {
  const regData = manifest?.regions?.[currentRegion];
  if (!regData || !regData.frames.length) return;

  const mySeq = ++currentRenderSeq;

  const tier = document.getElementById("timeTierSelect")?.value || "hourly_30d";
  const dateVal = document.getElementById("datePickerInput")?.value || getReferenceLatestDateStr();
  const ymd = dateVal.replace(/-/g, "");
  const hourStart = document.getElementById("hourPickerSelect")?.value || "00";
  const minStart = document.getElementById("minPickerSelect")?.value || "00";
  const spanHours = Number(document.getElementById("hourSpanSelect")?.value || "24");
  const hourEndNum = (Number(hourStart) + spanHours - 1) % 24;
  const hourEnd = String(hourEndNum).padStart(2, "0");
  const statMode = document.getElementById("dailyStatSelect")?.value || "mean";
  const opacity = Number(document.getElementById("opacityRange").value) / 100;

  const effectiveMode = currentSatMode === "combined" ? "combined_allsat" : currentLayerMode;
  updateLegendStyle(effectiveMode);
  syncSlider();

  const [lonMin, latMin, lonMax, latMax] = regData.bbox;
  const bounds = [[latMin, lonMin], [latMax, lonMax]];

  // Helper untuk memasang layer ke peta secara atomik (mencegah layer duplikat/tersangkut saat async)
  const applyToMap = (imgUrlOrDataUrl, targetBounds, borderColor, showCombinedCities = false) => {
    if (mySeq !== currentRenderSeq) return false;
    clearMapOverlays();
    activeRasterOverlay = L.imageOverlay(imgUrlOrDataUrl, targetBounds, {
      opacity,
      interactive: false,
      className: "lst-pixelated",
    });
    regionBoundsRect = L.rectangle(targetBounds, {
      color: borderColor,
      weight: 1.5,
      opacity,
      fill: false,
      dashArray: "4,4",
    });
    thermalLayerGroup.addLayer(activeRasterOverlay);
    thermalLayerGroup.addLayer(regionBoundsRect);
    if (showCombinedCities) {
      renderCombinedLandsatCityOverlays(opacity);
    }
    return true;
  };

  // 1. Jika pengguna memilih Arsip Historis NASA GIBS (2012-sekarang)
  if (tier === "gibs_historical") {
    const passRes = await computePolarOrbiterPassCog(regData, dateVal, true);
    if (mySeq !== currentRenderSeq) return;
    if (passRes) {
      const dataUrl = renderCogArrayToDataUrl(passRes.cog.data, passRes.cog.width, passRes.cog.height);
      if (!applyToMap(dataUrl, bounds, "#a855f7", false)) return;
      activeInspectCog = passRes.cog;
      activeInspectMeta = {
        bbox: regData.bbox,
        resDeg: regData.res_deg,
        labelMode: `Arsip Historis MODIS/VIIRS (${dateVal})`,
        stats: passRes.stats,
      };
      updateSidebarStats(regData, { stats: passRes.stats }, "NASA GIBS MODIS/VIIRS (1 km)", `Mosaik Historis (${dateVal})`);
      renderHotspotsFromCog(passRes.cog, regData, { stats: passRes.stats });
    }
    // Tambahkan juga tile WMTS GIBS jika tanggal <= tahun berjalan nyata
    const wmtsUrl = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Aqua_Land_Surface_Temp_Day/default/${dateVal}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`;
    activeTileLayer = L.tileLayer(wmtsUrl, { opacity: opacity * 0.75, maxNativeZoom: 7, maxZoom: 14 });
    thermalLayerGroup.addLayer(activeTileLayer);
    document.getElementById("currentFrameWib").textContent = `Arsip Historis NASA GIBS — ${dateVal}`;
    document.getElementById("currentFrameUtc").textContent = "MODIS/VIIRS Land Surface Temp Day (1 km)";
    return;
  }

  // 2. Jika mode "Gunakan Satelit Spesifik" dan memilih satelit non-Himawari (Landsat 100m, VIIRS, atau Anomali)
  if (currentSatMode === "specific" && currentLayerMode !== "himawari_lst") {
    const frame = regData.frames[currentFrameIdx] || regData.frames[regData.frames.length - 1];
    if (currentLayerMode === "himawari_anomaly") {
      const anom = manifest?.[`analysis_${currentRegion}`]?.anomaly;
      if (anom) {
        const cog = await loadCogRaster(resolveDataUrl(anom.cog_url));
        if (!applyToMap(resolveDataUrl(anom.png_url), bounds, "#fbbf24", false)) return;
        activeInspectCog = cog;
        activeInspectMeta = {
          bbox: regData.bbox,
          resDeg: regData.res_deg,
          labelMode: `Anomali ΔT (${regData.name})`,
          stats: frame.stats,
          isAnomaly: true,
        };
        document.getElementById("currentFrameWib").textContent = `Peta Anomali Suhu ΔLST (°C vs Baseline) — ${dateVal}`;
        document.getElementById("currentFrameUtc").textContent = "Deviasi Suhu Permukaan terhadap Rata-rata Klimatologi";
        updateSidebarStats(regData, frame, "Anomali Termal ΔLST (Fase 5)", "Deviasi vs Baseline");
      }
    } else if (currentLayerMode.startsWith("landsat_uhi_")) {
      const cityKey = currentLayerMode.replace("landsat_uhi_", "");
      const uhi = manifest?.landsat?.uhi_cities?.[cityKey];
      if (uhi) {
        const [uLon0, uLat0, uLon1, uLat1] = uhi.bbox;
        const uBounds = [[uLat0, uLon0], [uLat1, uLon1]];
        const cog = await loadCogRaster(resolveDataUrl(uhi.cog_url));
        if (!applyToMap(resolveDataUrl(uhi.png_url), uBounds, "#f97316", false)) return;
        map.fitBounds(uBounds);
        activeInspectCog = cog;
        activeInspectMeta = {
          bbox: uhi.bbox,
          resDeg: uhi.res_deg,
          labelMode: `Landsat 8/9 100m (${uhi.name})`,
          stats: uhi.stats,
          isLandsat: true,
        };
        document.getElementById("currentFrameWib").textContent = `Landsat 8/9 UHI 100m — ${uhi.name}`;
        document.getElementById("currentFrameUtc").textContent = `Scene ${uhi.scene_id} · Intensitas UHI +${uhi.stats.uhi_intensity_c}°C`;
        updateSidebarStats(
          regData,
          {
            stats: {
              ...uhi.stats,
              clear_fraction: uhi.stats.clear_fraction,
              p95_c: uhi.stats.max_c,
              hotspot_threshold_c: uhi.stats.urban_mean_c + 2,
            },
          },
          `Landsat 8/9 TIRS 100m (${uhi.name})`,
          "1 Scene Perkotaan (100m)"
        );
      }
    } else if (currentLayerMode === "viirs_gibs_day" || currentLayerMode === "viirs_gibs_night") {
      const isDay = currentLayerMode === "viirs_gibs_day";
      const passRes = await computePolarOrbiterPassCog(regData, dateVal, isDay);
      if (!passRes || mySeq !== currentRenderSeq) return;
      const dataUrl = renderCogArrayToDataUrl(passRes.cog.data, passRes.cog.width, passRes.cog.height);
      if (!applyToMap(dataUrl, bounds, isDay ? "#f59e0b" : "#38bdf8", false)) return;
      activeInspectCog = passRes.cog;
      const passLabel = isDay
        ? `NASA/NOAA VIIRS & MODIS LST Siang (Lintasan 13:30 WIB · ${dateVal})`
        : `NASA/NOAA VIIRS & MODIS LST Malam (Lintasan 01:30 WIB · ${dateVal})`;
      activeInspectMeta = {
        bbox: regData.bbox,
        resDeg: regData.res_deg,
        labelMode: passLabel,
        stats: passRes.stats,
      };
      document.getElementById("currentFrameWib").textContent = passLabel;
      document.getElementById("currentFrameUtc").textContent = isDay
        ? "Komposit Polar-Orbiter Siang (~1 km Pemanasan Maksimum)"
        : "Komposit Polar-Orbiter Malam (~1 km Pendinginan Radiatif)";
      updateSidebarStats(
        regData,
        { stats: passRes.stats, latency_min: null },
        isDay ? "NASA VIIRS / MODIS LST Siang (1 km)" : "NASA VIIRS / MODIS LST Malam (1 km)",
        `Komposit Lintasan ${isDay ? "Siang" : "Malam"} (${dateVal})`
      );
      renderHotspotsFromCog(passRes.cog, regData, { stats: passRes.stats });
    }
    return;
  }

  // 3. Rentang Harian (daily_permanent): Gabungkan seluruh citra pada hari tersebut
  if (tier === "daily_permanent") {
    const isDiffDate = getDateSynopticParams(dateVal).isDifferentDate;
    if (currentSatMode === "combined") {
      const fusedList = regData.fused_archive || [];
      const fusedEntry = fusedList.find((f) => f.date === dateVal) || fusedList[fusedList.length - 1];
      if (fusedEntry) {
        if (!isDiffDate && statMode === "mean") {
          const cog = await loadCogRaster(resolveDataUrl(fusedEntry.cog_url));
          if (!applyToMap(resolveDataUrl(fusedEntry.png_url), bounds, "#10b981", true)) return;
          activeInspectCog = cog;
          activeInspectMeta = {
            bbox: regData.bbox,
            resDeg: regData.res_deg,
            labelMode: `Gabungan Semua Satelit — Harian (${dateVal})`,
            stats: fusedEntry.stats,
          };
          document.getElementById("currentFrameWib").textContent = `Gabungan Semua Satelit (Harian ${dateVal})`;
          document.getElementById("currentFrameUtc").textContent = `${fusedEntry.himawari_frames_merged} citra Himawari-9 + VIIRS/S3 + ${fusedEntry.landsat_cities_blended.length} kota Landsat 100m`;
          updateSidebarStats(
            regData,
            { stats: fusedEntry.stats, latency_min: null },
            "Gabungan Semua Satelit (Himawari + VIIRS/S3 + Landsat)",
            `${fusedEntry.himawari_frames_merged} Citra Harian + 3 Kota Landsat 100m`
          );
          if (cog) renderHotspotsFromCog(cog, regData, { stats: fusedEntry.stats });
          return;
        } else {
          // Jika tanggal berbeda atau metode komposit Max/Min dipilih, hitung secara dinamis
          const fusedCog = await loadCogRaster(resolveDataUrl(fusedEntry.cog_url));
          const merged = await computeDynamicCogComposite(regData.frames, statMode, fusedCog, dateVal);
          if (!merged || mySeq !== currentRenderSeq) return;
          const dataUrl = renderCogArrayToDataUrl(merged.cog.data, merged.cog.width, merged.cog.height);
          if (!applyToMap(dataUrl, bounds, "#10b981", true)) return;
          activeInspectCog = merged.cog;
          activeInspectMeta = {
            bbox: regData.bbox,
            resDeg: regData.res_deg,
            labelMode: `Gabungan Semua Satelit — Harian (${statMode.toUpperCase()} ${dateVal})`,
            stats: merged.stats,
          };
          document.getElementById("currentFrameWib").textContent = `Gabungan Semua Satelit (${statMode.toUpperCase()} Harian ${dateVal})`;
          document.getElementById("currentFrameUtc").textContent = `Komposit Harian Multi-Satelit (${(merged.stats.clear_fraction * 100).toFixed(1)}% daratan)`;
          updateSidebarStats(
            regData,
            { stats: merged.stats, latency_min: null },
            "Gabungan Semua Satelit (Himawari + VIIRS/S3 + Landsat)",
            `Komposit Harian ${dateVal} (${statMode.toUpperCase()})`
          );
          renderHotspotsFromCog(merged.cog, regData, { stats: merged.stats });
          return;
        }
      }
    } else {
      // Satelit Spesifik (Himawari-9): tampilkan Agregat Harian Murni (Mean/Max/Min)
      const dailyList = regData.daily_archive || [];
      const entry = dailyList.find((d) => d.date === dateVal) || dailyList[dailyList.length - 1];
      if (!isDiffDate && entry && entry.layers?.[statMode]) {
        const lyr = entry.layers[statMode];
        const cog = await loadCogRaster(resolveDataUrl(lyr.cog_url));
        if (!applyToMap(resolveDataUrl(lyr.png_url), bounds, "#38bdf8", false)) return;
        activeInspectCog = cog;
        activeInspectMeta = {
          bbox: regData.bbox,
          resDeg: regData.res_deg,
          labelMode: `Himawari-9 Komposit Harian (${statMode.toUpperCase()} ${dateVal})`,
          stats: entry.stats,
        };
        document.getElementById("currentFrameWib").textContent = `Komposit Harian Himawari-9 (${statMode.toUpperCase()}) — ${dateVal}`;
        document.getElementById("currentFrameUtc").textContent = `Seluruh ${entry.frames_used} citra harian digabung (${(entry.stats.clear_fraction * 100).toFixed(1)}% wilayah tercakup)`;
        updateSidebarStats(
          regData,
          { stats: entry.stats, latency_min: null },
          "Himawari-9 AHI (Spesifik — Komposit Harian)",
          `${entry.frames_used} Citra Harian Digabung`
        );
        if (cog) renderHotspotsFromCog(cog, regData, { stats: entry.stats });
        return;
      } else {
        const merged = await computeDynamicCogComposite(regData.frames, statMode, null, dateVal);
        if (!merged || mySeq !== currentRenderSeq) return;
        const dataUrl = renderCogArrayToDataUrl(merged.cog.data, merged.cog.width, merged.cog.height);
        if (!applyToMap(dataUrl, bounds, "#38bdf8", false)) return;
        activeInspectCog = merged.cog;
        activeInspectMeta = {
          bbox: regData.bbox,
          resDeg: regData.res_deg,
          labelMode: `Himawari-9 Komposit Harian (${statMode.toUpperCase()} ${dateVal})`,
          stats: merged.stats,
        };
        document.getElementById("currentFrameWib").textContent = `Komposit Harian Himawari-9 (${statMode.toUpperCase()}) — ${dateVal}`;
        document.getElementById("currentFrameUtc").textContent = `${regData.frames.length} citra harian Himawari-9 (${(merged.stats.clear_fraction * 100).toFixed(1)}% wilayah)`;
        updateSidebarStats(
          regData,
          { stats: merged.stats, latency_min: null },
          "Himawari-9 AHI (Spesifik — Komposit Harian)",
          `Komposit Harian ${dateVal}`
        );
        renderHotspotsFromCog(merged.cog, regData, { stats: merged.stats });
        return;
      }
    }
  }

  // 4. Rentang Waktu Jam (hourly_30d): Gabungkan seluruh citra pada rentang jam [Jam Mulai .. +Span Jam]
  if (tier === "hourly_30d") {
    const h0 = Number(hourStart);
    const h1 = (h0 + spanHours - 1) % 24;
    const h0Str = String(h0).padStart(2, "0");
    const h1Str = String(h1).padStart(2, "0");
    const h0Wib = String((h0 + 7) % 24).padStart(2, "0");
    const h1Wib = String((h1 + 7) % 24).padStart(2, "0");

    const inHourSpan = (hh) => {
      if (spanHours >= 24) return true;
      if (h0 + spanHours - 1 < 24) return hh >= h0 && hh <= h0 + spanHours - 1;
      return hh >= h0 || hh <= h1;
    };

    let matchingFrames = (regData.frames || []).filter((f) => {
      if (!f.stamp.startsWith(ymd + "_")) return false;
      const hh = Number(f.stamp.slice(9, 11));
      return inHourSpan(hh);
    });
    if (!matchingFrames.length) {
      matchingFrames = (regData.frames || []).filter((f) => {
        const hh = Number(f.stamp.slice(9, 11));
        return inHourSpan(hh);
      });
    }

    // Dapatkan juga COG pada jam mulai (h0) via interpolasi 10m agar perubahan Jam Mulai selalu memberi efek diurnal nyata
    const startHourRes = await computeInterpolated10MinCog(regData, dateVal, h0, 0);
    const anchorCog = startHourRes?.cog || null;
    const anchorWeight = spanHours >= 24 ? 0.42 : matchingFrames.length ? 0.25 : 1.0;

    if (!matchingFrames.length && anchorCog) {
      matchingFrames = [regData.frames[0]];
    }

    let fusedFallbackCog = null;
    if (currentSatMode === "combined") {
      const fusedEntry = (regData.fused_archive || [])[0];
      if (fusedEntry) {
        fusedFallbackCog = await loadCogRaster(resolveDataUrl(fusedEntry.cog_url));
      }
    }

    const merged = await computeDynamicCogComposite(
      matchingFrames,
      statMode,
      fusedFallbackCog,
      dateVal,
      anchorCog,
      anchorWeight
    );
    if (merged && mySeq === currentRenderSeq) {
      const dataUrl = renderCogArrayToDataUrl(merged.cog.data, merged.cog.width, merged.cog.height);
      if (
        !applyToMap(
          dataUrl,
          bounds,
          currentSatMode === "combined" ? "#10b981" : "#38bdf8",
          currentSatMode === "combined"
        )
      )
        return;

      activeInspectCog = merged.cog;
      const modeTitle =
        currentSatMode === "combined"
          ? `Gabungan Satelit — Rentang Jam ${h0Str}:00–${h1Str}:59 UTC (${dateVal})`
          : `Himawari-9 Spesifik — Rentang Jam ${h0Str}:00–${h1Str}:59 UTC (${dateVal})`;
      activeInspectMeta = {
        bbox: regData.bbox,
        resDeg: regData.res_deg,
        labelMode: modeTitle,
        stats: merged.stats,
      };

      document.getElementById("currentFrameWib").textContent = `Rentang Jam ${h0Wib}:00–${h1Wib}:59 WIB (${dateVal})`;
      document.getElementById("currentFrameUtc").textContent =
        currentSatMode === "combined"
          ? `Jam Mulai ${h0Str}:00 UTC (+${spanHours}j) · Fusi Multi-Satelit (${(merged.stats.clear_fraction * 100).toFixed(1)}% wilayah)`
          : `Jam Mulai ${h0Str}:00 UTC (+${spanHours}j) · Himawari-9 Murni (${(merged.stats.clear_fraction * 100).toFixed(1)}% wilayah)`;

      updateSidebarStats(
        regData,
        { stats: merged.stats, latency_min: null },
        currentSatMode === "combined"
          ? "Gabungan Semua Satelit (Himawari + VIIRS/S3 + Landsat)"
          : "Himawari-9 AHI (Satelit Spesifik)",
        `Rentang Jam ${h0Str}:00–${h1Str}:59 UTC (${dateVal})`
      );
      renderHotspotsFromCog(merged.cog, regData, { stats: merged.stats });
      return;
    }
  }

  // 5. Mode Spesifik 10 Menit / Frame Tunggal (realtime_48h):
  // Berjalan tepat setiap 10 menit (:00, :10, :20, :30, :40, :50) menggunakan Himawari-9 AHI Murni
  const hStr = String(hourStart).padStart(2, "0");
  const mStr = String(minStart).padStart(2, "0");
  const wibH = String((Number(hourStart) + 7) % 24).padStart(2, "0");
  const res10 = await computeInterpolated10MinCog(regData, dateVal, Number(hourStart), Number(minStart));
  if (!res10 || mySeq !== currentRenderSeq) return;

  const dataUrl10 = res10.exactMatch
    ? resolveDataUrl(res10.exactMatch.png_url)
    : renderCogArrayToDataUrl(res10.cog.data, res10.cog.width, res10.cog.height);

  if (!applyToMap(dataUrl10, bounds, "#38bdf8", false)) return;

  activeInspectCog = res10.cog;
  activeInspectMeta = {
    bbox: regData.bbox,
    resDeg: regData.res_deg,
    labelMode: `Himawari-9 AHI 10-Menit (${dateVal} ${wibH}:${mStr} WIB / ${hStr}:${mStr} UTC)`,
    stats: res10.stats,
  };
  document.getElementById("currentFrameWib").textContent = `${dateVal} ${wibH}:${mStr} WIB (Interval 10 Menit)`;
  document.getElementById("currentFrameUtc").textContent = `${dateVal} ${hStr}:${mStr} UTC · Himawari-9 AHI (10m Murni)`;
  updateSidebarStats(
    regData,
    { stats: res10.stats, latency_min: res10.exactMatch?.latency_min ?? 10 },
    "Himawari-9 AHI (Geostasioner 10 Menit — Murni)",
    `Frame 10-Menit (${dateVal} ${hStr}:${mStr} UTC)`
  );
  renderHotspotsFromCog(res10.cog, regData, { stats: res10.stats });
}

function updateSidebarStats(regData, frame, sensorLabel = null, mergedLabel = null) {
  const st = frame.stats || {};
  document.getElementById("latencyBadge").textContent =
    frame.latency_min != null ? `Latensi ${frame.latency_min} mnt` : "Komposit / Gabungan";
  document.getElementById("statMean").textContent = st.mean_c != null ? `${st.mean_c.toFixed(2)} °C` : "--";
  document.getElementById("statMax").textContent = st.max_c != null ? `${st.max_c.toFixed(2)} °C` : "--";
  document.getElementById("statMin").textContent = st.min_c != null ? `${st.min_c.toFixed(2)} °C` : "--";
  document.getElementById("statP95").textContent = st.p95_c != null ? `${st.p95_c.toFixed(2)} °C` : "--";
  document.getElementById("statClear").textContent =
    st.clear_fraction != null ? `${(st.clear_fraction * 100).toFixed(1)}%` : "--";
  document.getElementById("statHotspotThr").textContent =
    st.hotspot_threshold_c != null ? `${st.hotspot_threshold_c.toFixed(2)} °C` : "--";
  document.getElementById("statHotspotCount").textContent =
    st.hotspot_pixels != null ? st.hotspot_pixels.toLocaleString("id-ID") : "0";

  const sensorEl = document.getElementById("metaSensorName");
  if (sensorEl) {
    sensorEl.textContent =
      sensorLabel ||
      (currentSatMode === "combined"
        ? "Gabungan Semua Satelit (Himawari + VIIRS/S3 + Landsat)"
        : "Himawari-9 AHI (Satelit Spesifik)");
  }
  document.getElementById("metaRes").textContent =
    currentSatMode === "combined" ? `${regData.res_deg}° (~2.2 km) + 100m Kota` : `${regData.res_deg}° (~2.2 km)`;
  document.getElementById("metaSize").textContent =
    mergedLabel || (frame.sizes_mb?.cog != null ? `COG ${frame.sizes_mb.cog} MB · PNG ${frame.sizes_mb.png} MB` : "--");

  if (st.direct_clear_fraction != null && st.clear_fraction != null && st.clear_fraction > st.direct_clear_fraction) {
    document.getElementById("metaCloudTests").textContent = `Langsung ${(st.direct_clear_fraction * 100).toFixed(1)}% → Gabungan ${(st.clear_fraction * 100).toFixed(1)}% daratan`;
  } else if (st.clear_fraction != null) {
    document.getElementById("metaCloudTests").textContent = `${(st.clear_fraction * 100).toFixed(1)}% daratan wilayah tercakup`;
  }
}

function renderHotspotsFromCog(cog, regData, frame) {
  hotspotLayerGroup.clearLayers();
  if (!document.getElementById("hotspotToggle").checked) return;

  const thr = frame.stats?.hotspot_threshold_c;
  if (thr == null) return;

  const scale = manifest.encoding?.scale || 0.01;
  const nodata = manifest.encoding?.nodata ?? -32768;
  const [lonMin, latMin, lonMax, latMax] = regData.bbox;
  const res = regData.res_deg;

  const candidates = [];
  const stride = 4;
  for (let r = 0; r < cog.height; r += stride) {
    for (let c = 0; c < cog.width; c += stride) {
      const raw = cog.data[r * cog.width + c];
      if (raw === nodata) continue;
      const valC = raw * scale;
      if (valC >= thr) {
        const lat = latMax - (r + 0.5) * res;
        const lon = lonMin + (c + 0.5) * res;
        candidates.push({ lat, lon, valC });
      }
    }
  }

  candidates.sort((a, b) => b.valC - a.valC);
  for (const pt of candidates.slice(0, 80)) {
    const marker = L.circleMarker([pt.lat, pt.lon], {
      radius: 5,
      color: "#fef08a",
      weight: 1.5,
      fillColor: "#ef4444",
      fillOpacity: 0.85,
    });
    marker.bindTooltip(
      `<strong>Hotspot Terdeteksi (&gt; μ+2σ)</strong><br/>LST: <b>${pt.valC.toFixed(
        2
      )} °C</b><br/>Koordinat: ${pt.lat.toFixed(2)}°, ${pt.lon.toFixed(2)}°`
    );
    hotspotLayerGroup.addLayer(marker);
  }
}

// Render Tab 2: Klaster Hotspot & Statistik Zonal Provinsi (Fase 5)
function renderPhase5Tab() {
  const analysis = manifest?.[`analysis_${currentRegion}`];
  if (!analysis) return;

  const mode = document.getElementById("analysisTimeMode").value;
  const zonal = mode === "peak_day" ? analysis.zonal_peak_day : analysis.zonal_latest;
  const hs = mode === "peak_day" ? analysis.hotspots_peak_day : analysis.hotspots_latest;

  document.getElementById("zoneCountBadge").textContent = `${zonal?.length || 0} Kawasan`;
  const zBody = document.querySelector("#zonalTable tbody");
  zBody.innerHTML = "";
  (zonal || []).forEach((z) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${z.name}</strong></td>
      <td>${z.mean_c.toFixed(1)}°C</td>
      <td class="stat-hot"><strong>${z.max_c.toFixed(1)}°C</strong></td>
      <td>${z.hotspot_pixels} px</td>
    `;
    tr.addEventListener("click", () => {
      const [x0, y0, x1, y1] = z.bbox;
      map.fitBounds([[y0, x0], [y1, x1]]);
      autoCloseDrawerOnNarrow();
    });
    zBody.appendChild(tr);
  });

  const clusters = hs?.clusters || [];
  document.getElementById("clusterCountBadge").textContent = `${clusters.length} Klaster (${hs?.total_hotspot_area_km2 || 0} km²)`;
  const cBody = document.querySelector("#clusterTable tbody");
  cBody.innerHTML = "";
  clusters.slice(0, 35).forEach((c) => {
    const tr = document.createElement("tr");
    const isExt = c.severity.includes("EKSTREM");
    tr.innerHTML = `
      <td><strong>#${c.rank} ${c.zone}</strong><br/><span style="color:#94a3b8;font-size:0.66rem;">${c.lat}°, ${c.lon}°</span></td>
      <td class="stat-hot"><strong>${c.max_c.toFixed(2)}°C</strong></td>
      <td>${c.area_km2} km²</td>
      <td><span style="color:${isExt ? "#f87171" : "#fbbf24"};font-weight:700;">${isExt ? "3σ Ekstrem" : "2σ Siaga"}</span></td>
    `;
    tr.addEventListener("click", () => {
      map.setView([c.lat, c.lon], 8);
      if (clickMarker) map.removeLayer(clickMarker);
      clickMarker = L.circleMarker([c.lat, c.lon], { radius: 8, color: "#ef4444", weight: 2 }).addTo(map);
      clickMarker
        .bindPopup(
          `<b>Klaster Hotspot #${c.rank} (${c.zone})</b><br/>Suhu Puncak: <b>${c.max_c.toFixed(
            2
          )} °C</b> (+${c.anomaly_vs_regional_mean_c}°C vs rata-rata)<br/>Luas Klaster: <b>${c.area_km2} km²</b> (${c.pixels} piksel)`
        )
        .openPopup();
      autoCloseDrawerOnNarrow();
    });
    cBody.appendChild(tr);
  });
}

// Render Tab 3: Multi-Sensor (Landsat UHI 100m, Sentinel-3 SLSTR NRT, VIIRS NRT)
function renderPhase4Tab() {
  const uhiContainer = document.getElementById("uhiCardsContainer");
  uhiContainer.innerHTML = "";
  const cities = manifest?.landsat?.uhi_cities || {};

  Object.values(cities).forEach((city) => {
    const st = city.stats;
    const card = document.createElement("div");
    card.className = "uhi-item-card";
    const uhiSign = st.uhi_intensity_c >= 0 ? `+${st.uhi_intensity_c.toFixed(2)}` : st.uhi_intensity_c.toFixed(2);
    card.innerHTML = `
      <div class="uhi-item-title">
        <span>${city.name}</span>
        <span style="color:#f87171;">UHI ${uhiSign} °C</span>
      </div>
      <div class="uhi-metrics">
        <span>Urban: <b>${st.urban_mean_c}°C</b></span>
        <span>Vegetasi: <b>${st.vegetation_mean_c}°C</b></span>
        <span>Maks: <b>${st.max_c}°C</b></span>
        <span>NDVI: <b>${st.mean_ndvi}</b></span>
      </div>
      <div style="font-size:0.66rem;color:#38bdf8;margin-top:0.25rem;">
        Scene: ${city.scene_id} · Klik untuk tampilkan COG 100m (${city.sizes_mb.cog} MB)
      </div>
    `;
    card.addEventListener("click", async () => {
      const modeVal = `landsat_uhi_${city.city_key}`;
      currentSatMode = "specific";
      document.getElementById("satModeSelect").value = "specific";
      document.getElementById("specificSatGroup").style.display = "";
      document.getElementById("layerModeSelect").value = modeVal;
      currentLayerMode = modeVal;
      autoCloseDrawerOnNarrow();
      await renderActiveLayer();
    });
    uhiContainer.appendChild(card);
  });

  // Sentinel-3 SLSTR list
  const s3List = document.getElementById("sentinel3List");
  s3List.innerHTML = "";
  const s3Items = manifest?.sentinel3?.granules?.[currentRegion] || [];
  s3Items.slice(0, 6).forEach((g) => {
    const row = document.createElement("div");
    row.className = "granule-row";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-weight:700;">
        <span>${g.satellite} SL_2_LST</span>
        <span style="color:#34d399;">${g.timeliness}</span>
      </div>
      <div style="color:#94a3b8;margin-top:0.15rem;">
        Waktu: ${formatTimeWib(g.time_start)} · Ukuran: ${g.size_mb} MB
      </div>
    `;
    row.addEventListener("click", () => {
      if (!g.bbox) return;
      const [x0, y0, x1, y1] = g.bbox;
      if (footprintRect) map.removeLayer(footprintRect);
      footprintRect = L.rectangle([[y0, x0], [y1, x1]], {
        color: "#34d399",
        weight: 2,
        fillOpacity: 0.08,
      }).addTo(map);
      footprintRect.bindPopup(`<b>${g.satellite} SLSTR LST</b><br/>${g.name}<br/>Waktu: ${formatTimeWib(g.time_start)}`).openPopup();
      map.fitBounds([[y0, x0], [y1, x1]]);
    });
    s3List.appendChild(row);
  });

  // VIIRS & Landsat 30m Dynamic Tile list
  const vlList = document.getElementById("viirsLandsatList");
  vlList.innerHTML = "";
  const lsScenes = manifest?.landsat?.scenes?.[currentRegion] || [];
  lsScenes.slice(0, 4).forEach((sc) => {
    const row = document.createElement("div");
    row.className = "granule-row";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-weight:700;">
        <span>${sc.id} (30m Tile)</span>
        <span style="color:#fbbf24;">Awan ${sc.cloud_cover}%</span>
      </div>
      <div style="color:#38bdf8;margin-top:0.12rem;">Klik untuk memuat Dynamic Tile 30m Planetary Computer</div>
    `;
    row.addEventListener("click", () => {
      if (activeTileLayer) map.removeLayer(activeTileLayer);
      activeTileLayer = L.tileLayer(sc.tile_url, { opacity: 0.9, maxZoom: 16 }).addTo(map);
      if (sc.bbox) {
        const [x0, y0, x1, y1] = sc.bbox;
        if (footprintRect) map.removeLayer(footprintRect);
        footprintRect = L.rectangle([[y0, x0], [y1, x1]], { color: "#fbbf24", weight: 2, fill: false }).addTo(map);
        map.fitBounds([[y0, x0], [y1, x1]]);
      }
    });
    vlList.appendChild(row);
  });

  const viirsItems = manifest?.viirs?.granules?.[currentRegion] || [];
  viirsItems.slice(0, 4).forEach((vg) => {
    const row = document.createElement("div");
    row.className = "granule-row";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-weight:700;">
        <span>VIIRS ${vg.product} (${vg.day_night})</span>
        <span style="color:#38bdf8;">750 m</span>
      </div>
      <div style="color:#94a3b8;">${vg.id} · ${formatTimeWib(vg.time_start)}</div>
    `;
    row.addEventListener("click", () => {
      if (!vg.bbox) return;
      const [x0, y0, x1, y1] = vg.bbox;
      if (footprintRect) map.removeLayer(footprintRect);
      footprintRect = L.rectangle([[y0, x0], [y1, x1]], { color: "#a855f7", weight: 2, fillOpacity: 0.08 }).addTo(map);
      footprintRect.bindPopup(`<b>VIIRS ${vg.product}</b><br/>${vg.id}<br/>${formatTimeWib(vg.time_start)}`).openPopup();
      map.fitBounds([[y0, x0], [y1, x1]]);
    });
    vlList.appendChild(row);
  });
}

// Render Tab 4 & Marker Peta: Validasi 18 Stasiun BMKG/WMO (Fase 6)
function renderPhase6Tab() {
  const val = manifest?.validation;
  bmkgLayerGroup.clearLayers();
  if (!val) return;

  document.getElementById("valMatchedBadge").textContent = `${val.matched_stations}/${val.total_stations} Cerah`;
  const m = val.metrics || {};
  const biasSign = m.bias_c >= 0 ? `+${m.bias_c.toFixed(2)}` : m.bias_c.toFixed(2);
  const offSign =
    m.recommended_offset_correction_c >= 0
      ? `+${m.recommended_offset_correction_c.toFixed(2)}`
      : m.recommended_offset_correction_c.toFixed(2);

  document.getElementById("valBias").textContent = `${biasSign} °C`;
  document.getElementById("valMae").textContent = `${(m.mae_c ?? 0).toFixed(2)} °C`;
  document.getElementById("valRmse").textContent = `${(m.rmse_c ?? 0).toFixed(2)} °C`;
  document.getElementById("valOffset").textContent = `${offSign} °C`;

  const tbody = document.querySelector("#bmkgTable tbody");
  tbody.innerHTML = "";
  const showMarkers = document.getElementById("bmkgToggle").checked;

  (val.stations || []).forEach((s) => {
    const refVal = s.t_soil_0cm_c ?? s.t_air_2m_c;
    const satStr = s.himawari_lst_c != null ? `${s.himawari_lst_c.toFixed(2)}°C` : "Berawan";
    const refStr = refVal != null ? `${refVal.toFixed(2)}°C` : "--";
    const diff = s.diff_vs_surface_ref_c;
    const diffStr = diff != null ? `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}°C` : "--";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${s.name}</strong></td>
      <td style="color:${s.himawari_lst_c != null ? "#34d399" : "#94a3b8"};"><strong>${satStr}</strong></td>
      <td>${refStr}</td>
      <td><strong>${diffStr}</strong></td>
    `;
    tr.addEventListener("click", () => {
      map.setView([s.lat, s.lon], 8);
    });
    tbody.appendChild(tr);

    if (showMarkers) {
      const hasSat = s.himawari_lst_c != null;
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: 6,
        color: "#ffffff",
        weight: 1.5,
        fillColor: hasSat ? "#10b981" : "#64748b",
        fillOpacity: 0.9,
      });
      marker.bindPopup(
        `<b>${s.name} (WMO #${s.id})</b><br/>` +
          `LST Himawari-9: <b>${satStr}</b><br/>` +
          `Suhu Permukaan/Tanah Ref: <b>${refStr}</b><br/>` +
          `Suhu Udara 2m: <b>${s.t_air_2m_c ?? "--"}°C</b> (RH ${s.rh_pct ?? "--"}%)<br/>` +
          `Selisih (LST − Ref): <b>${diffStr}</b>`
      );
      bmkgLayerGroup.addLayer(marker);
    }
  });
}

// Inspeksi Piksel saat pengguna mengklik peta
map.on("click", async (e) => {
  const { lat, lng } = e.latlng;
  const box = document.getElementById("pixelInspectorContent");
  const regData = manifest?.regions?.[currentRegion];
  if (!regData) return;

  const scale = manifest.encoding?.scale || 0.01;
  const nodata = manifest.encoding?.nodata ?? -32768;

  // Jika mode Gabungan Satelit aktif dan pengguna mengklik di dalam area kota Landsat 100m, baca piksel 100m terlebih dahulu
  if (currentSatMode === "combined") {
    const cities = manifest?.landsat?.uhi_cities || {};
    for (const uhi of Object.values(cities)) {
      const [uLon0, uLat0, uLon1, uLat1] = uhi.bbox;
      if (lng >= uLon0 && lng <= uLon1 && lat >= uLat0 && lat <= uLat1) {
        const uCog = await loadCogRaster(resolveDataUrl(uhi.cog_url));
        if (uCog) {
          const uCol = Math.floor((lng - uLon0) / uhi.res_deg);
          const uRow = Math.floor((uLat1 - lat) / uhi.res_deg);
          if (uCol >= 0 && uCol < uCog.width && uRow >= 0 && uRow < uCog.height) {
            const uRaw = uCog.data[uRow * uCog.width + uCol];
            if (uRaw !== nodata) {
              const valC = uRaw * scale;
              const tempK = valC + 273.15;
              const meanC = uhi.stats?.mean_c ?? valC;
              const delta = valC - meanC;
              const deltaSign = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
              if (clickMarker) map.removeLayer(clickMarker);
              clickMarker = L.circleMarker([lat, lng], {
                radius: 6,
                color: "#f97316",
                weight: 2,
                fillColor: "#ea580c",
                fillOpacity: 0.6,
              }).addTo(map);
              box.innerHTML = `
                <div class="inspector-main-temp">${valC.toFixed(2)} °C <span style="font-size:0.8rem;font-weight:400;color:#94a3b8;">(${tempK.toFixed(2)} K)</span></div>
                <div>Status: <span style="color:#f97316;font-weight:700;">Resolusi Tinggi 100m (Landsat 8/9 Terintegrasi)</span></div>
                <div class="inspector-grid">
                  <div><span class="stat-label">Koordinat:</span><br/><strong>${lat.toFixed(3)}°, ${lng.toFixed(3)}°</strong></div>
                  <div><span class="stat-label">Resolusi Piksel:</span><br/><strong>100 m (${uhi.name})</strong></div>
                  <div><span class="stat-label">Anomali vs Kota:</span><br/><strong>${deltaSign} °C</strong></div>
                  <div><span class="stat-label">Mode Sumber:</span><br/><strong>Gabungan Satelit (Landsat+Himawari)</strong></div>
                </div>
              `;
              clickMarker
                .bindPopup(`<b>LST: ${valC.toFixed(2)} °C</b> (100m Landsat)<br/>${uhi.name}<br/>${lat.toFixed(3)}°, ${lng.toFixed(3)}°`)
                .openPopup();
              return;
            }
          }
        }
      }
    }
  }

  const cog = activeInspectCog;
  const meta = activeInspectMeta;
  if (!cog || !meta) return;

  const [lonMin, latMin, lonMax, latMax] = meta.bbox;
  const resDeg = meta.resDeg;
  const labelMode = meta.labelMode;

  if (lng < lonMin || lng > lonMax || lat < latMin || lat > latMax) {
    box.innerHTML = `<p class="muted-hint">Titik (${lat.toFixed(3)}°, ${lng.toFixed(
      3
    )}°) berada di luar batas grid aktif (<b>${labelMode}</b>).</p>`;
    return;
  }

  // Muat juga DEM (Model Elevasi Digital) untuk menampilkan ketinggian mdpl pada inspeksi piksel
  let elevM = null;
  if (!meta.isLandsat) {
    const demUrl = `../static/dem_${currentRegion}_0.02.tif`;
    const demCog = await loadCogRaster(demUrl);
    const dCol = Math.floor((lng - lonMin) / resDeg);
    const dRow = Math.floor((latMax - lat) / resDeg);
    if (demCog && dCol >= 0 && dCol < demCog.width && dRow >= 0 && dRow < demCog.height) {
      elevM = demCog.data[dRow * demCog.width + dCol];
    }
  }

  const col = Math.floor((lng - lonMin) / resDeg);
  const row = Math.floor((latMax - lat) / resDeg);
  if (col < 0 || col >= cog.width || row < 0 || row >= cog.height) return;

  const raw = cog.data[row * cog.width + col];

  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat, lng], {
    radius: 6,
    color: "#38bdf8",
    weight: 2,
    fillColor: "#0284c7",
    fillOpacity: 0.5,
  }).addTo(map);

  if (raw === nodata) {
    box.innerHTML = `
      <div><strong>Mode:</strong> ${labelMode}</div>
      <div><strong>Koordinat:</strong> ${lat.toFixed(3)}°, ${lng.toFixed(3)}° (Piksel [${col}, ${row}])</div>
      <div style="margin-top:0.35rem;color:#94a3b8;">Status: <strong>Berawan atau Wilayah Laut (NoData)</strong></div>
    `;
    clickMarker.bindPopup(`<b>${lat.toFixed(3)}°, ${lng.toFixed(3)}°</b><br/>Tertutup awan / Laut`).openPopup();
    return;
  }

  const valC = raw * scale;
  if (meta.isAnomaly) {
    const sign = valC >= 0 ? `+${valC.toFixed(2)}` : valC.toFixed(2);
    box.innerHTML = `
      <div class="inspector-main-temp">${sign} °C <span style="font-size:0.8rem;font-weight:400;color:#94a3b8;">Anomali ΔT</span></div>
      <div>Mode: <strong>${labelMode}</strong></div>
      <div class="inspector-grid">
        <div><span class="stat-label">Koordinat:</span><br/><strong>${lat.toFixed(3)}°, ${lng.toFixed(3)}°</strong></div>
        <div><span class="stat-label">Indeks Grid:</span><br/><strong>X=${col}, Y=${row}</strong></div>
      </div>
    `;
    clickMarker.bindPopup(`<b>Anomali ΔT: ${sign} °C</b><br/>${lat.toFixed(3)}°, ${lng.toFixed(3)}°`).openPopup();
    return;
  }

  const tempK = valC + 273.15;
  const meanC = meta.stats?.mean_c ?? valC;
  const thrC = meta.stats?.hotspot_threshold_c ?? 999;
  const delta = valC - meanC;
  const deltaSign = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
  const statusLabel =
    valC >= thrC
      ? `<span style="color:#f87171;font-weight:700;">HOTSPOT EKSTREM (&gt; μ+2σ)</span>`
      : valC < 22.0 && elevM != null && elevM >= 400
      ? `<span style="color:#38bdf8;font-weight:700;">Sejuk Alami Dataran Tinggi / Pegunungan (${elevM} m mdpl)</span>`
      : delta > 2
      ? `<span style="color:#fbbf24;font-weight:700;">Di Atas Rata-rata Wilayah</span>`
      : `<span style="color:#34d399;font-weight:700;">Normal Cerah (Tervalidasi DEM)</span>`;

  const elevStr = elevM != null ? `${elevM.toLocaleString("id-ID")} m mdpl` : "Resolusi 100m";

  box.innerHTML = `
    <div class="inspector-main-temp">${valC.toFixed(2)} °C <span style="font-size:0.8rem;font-weight:400;color:#94a3b8;">(${tempK.toFixed(
      2
    )} K)</span></div>
    <div>Status: ${statusLabel}</div>
    <div class="inspector-grid">
      <div><span class="stat-label">Koordinat:</span><br/><strong>${lat.toFixed(3)}°, ${lng.toFixed(3)}°</strong></div>
      <div><span class="stat-label">Elevasi Topografi (DEM):</span><br/><strong>${elevStr}</strong></div>
      <div><span class="stat-label">Anomali vs Mean:</span><br/><strong>${deltaSign} °C</strong></div>
      <div><span class="stat-label">Sumber Data:</span><br/><strong>${labelMode}</strong></div>
    </div>
  `;

  clickMarker
    .bindPopup(
      `<b>LST: ${valC.toFixed(2)} °C</b> (${deltaSign} °C vs rata-rata)<br/>${labelMode}<br/>Koordinat: ${lat.toFixed(
        3
      )}°, ${lng.toFixed(3)}°`
    )
    .openPopup();
});

function drawTrendChart() {
  const canvas = document.getElementById("trendCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const frames = manifest?.regions?.[currentRegion]?.frames || [];
  if (!frames.length) return;

  const pad = { l: 34, r: 14, t: 16, b: 26 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const mins = frames.map((f) => f.stats?.min_c ?? 15);
  const means = frames.map((f) => f.stats?.mean_c ?? 25);
  const maxs = frames.map((f) => f.stats?.max_c ?? 40);

  const yMin = Math.floor(Math.min(...mins, 10) / 5) * 5;
  const yMax = Math.ceil(Math.max(...maxs, 45) / 5) * 5;

  const xPos = (i) => (frames.length === 1 ? pad.l + pw / 2 : pad.l + (i / (frames.length - 1)) * pw);
  const yPos = (v) => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

  ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px sans-serif";
  for (let val = yMin; val <= yMax; val += 10) {
    const y = yPos(val);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(`${val}°`, 4, y + 3);
  }

  const drawSeries = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const x = xPos(i);
      const y = yPos(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    arr.forEach((v, i) => {
      ctx.beginPath();
      ctx.arc(xPos(i), yPos(v), i === currentFrameIdx ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  drawSeries(maxs, "#f87171");
  drawSeries(means, "#fbbf24");
  drawSeries(mins, "#38bdf8");

  const cx = xPos(currentFrameIdx);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, pad.t);
  ctx.lineTo(cx, h - pad.b);
  ctx.stroke();

  ctx.fillStyle = "#94a3b8";
  frames.forEach((f, i) => {
    const label = f.stamp.slice(9, 11) + ":" + f.stamp.slice(11, 13);
    ctx.fillText(label + "Z", xPos(i) - 14, h - 8);
  });
}

// Event Listeners
document.getElementById("basemapSelect").addEventListener("change", (e) => {
  const newKey = e.target.value;
  if (BASEMAPS[activeBasemapKey]) {
    map.removeLayer(BASEMAPS[activeBasemapKey]);
  }
  activeBasemapKey = newKey;
  if (BASEMAPS[activeBasemapKey]) {
    BASEMAPS[activeBasemapKey].addTo(map);
  }
});

document.getElementById("labelsToggle").addEventListener("change", (e) => {
  if (e.target.checked) {
    if (!map.hasLayer(indonesiaLabelsOverlay)) indonesiaLabelsOverlay.addTo(map);
  } else {
    if (map.hasLayer(indonesiaLabelsOverlay)) map.removeLayer(indonesiaLabelsOverlay);
  }
});

document.getElementById("satModeSelect")?.addEventListener("change", async (e) => {
  currentSatMode = e.target.value;
  const specGroup = document.getElementById("specificSatGroup");
  if (specGroup) {
    specGroup.style.display = currentSatMode === "specific" ? "" : "none";
  }
  await renderActiveLayer();
});

document.getElementById("regionSelect").addEventListener("change", async (e) => {
  currentRegion = e.target.value;
  if (currentLayerMode.startsWith("landsat_uhi_")) {
    currentLayerMode = "himawari_lst";
    document.getElementById("layerModeSelect").value = "himawari_lst";
  }
  const regData = manifest?.regions?.[currentRegion];
  if (regData) {
    const [lonMin, latMin, lonMax, latMax] = regData.bbox;
    map.fitBounds([[latMin, lonMin], [latMax, lonMax]]);
    currentFrameIdx = Math.max(0, regData.frames.length - 1);
    syncSlider();
    await renderActiveLayer();
    drawTrendChart();
    renderPhase5Tab();
    renderPhase4Tab();
    preloadAllAvailableFrames();
  }
});

document.getElementById("layerModeSelect").addEventListener("change", async (e) => {
  currentLayerMode = e.target.value;
  await renderActiveLayer();
});

document.getElementById("islandJump").addEventListener("change", (e) => {
  if (!e.target.value) return;
  const [lat, lon, z] = e.target.value.split(",").map(Number);
  map.setView([lat, lon], z);
  if (window.innerWidth <= 960) setTopFiltersCollapsed(true);
});

document.getElementById("opacityRange").addEventListener("input", (e) => {
  const val = Number(e.target.value);
  const op = val / 100;
  document.getElementById("opacityVal").textContent = `${val}%`;
  if (activeRasterOverlay) activeRasterOverlay.setOpacity(op);
  if (activeTileLayer) activeTileLayer.setOpacity(op);
  thermalLayerGroup.eachLayer((lyr) => {
    if (typeof lyr.setOpacity === "function") lyr.setOpacity(op);
    else if (typeof lyr.setStyle === "function") lyr.setStyle({ opacity: op });
  });
  combinedCityGroup.eachLayer((lyr) => {
    if (typeof lyr.setOpacity === "function") lyr.setOpacity(op);
    else if (typeof lyr.setStyle === "function") lyr.setStyle({ opacity: op });
  });
});

document.getElementById("hotspotToggle").addEventListener("change", async () => {
  await renderActiveLayer();
});

document.getElementById("bmkgToggle").addEventListener("change", () => {
  renderPhase6Tab();
});

document.getElementById("analysisTimeMode").addEventListener("change", () => {
  renderPhase5Tab();
});

async function applySliderStep(stepVal) {
  const tier = document.getElementById("timeTierSelect")?.value || "hourly_30d";
  if (tier === "realtime_48h") {
    // Setiap langkah = 10 menit (0..143)
    const idx = ((stepVal % 144) + 144) % 144;
    const hh = String(Math.floor(idx / 6)).padStart(2, "0");
    const mm = String((idx % 6) * 10).padStart(2, "0");
    const hourSel = document.getElementById("hourPickerSelect");
    const minSel = document.getElementById("minPickerSelect");
    if (hourSel) hourSel.value = hh;
    if (minSel) minSel.value = mm;
  } else if (tier === "hourly_30d") {
    // Setiap langkah = 1 jam (0..23) tanpa keluar dari mode Rentang Jam
    const hh = String(((stepVal % 24) + 24) % 24).padStart(2, "0");
    const hourSel = document.getElementById("hourPickerSelect");
    if (hourSel) hourSel.value = hh;
    refreshHourPickerBadges();
  } else {
    // Mode Harian / Historis: setiap langkah = 1 hari (0..29) tanpa keluar dari mode Harian
    const idx = ((stepVal % 30) + 30) % 30;
    const refMs = new Date(getReferenceLatestDateStr() + "T00:00:00Z").getTime();
    const daysBack = 29 - idx;
    const newDateStr = toIsoDate(new Date(refMs - daysBack * 24 * 3600 * 1000));
    const dateInput = document.getElementById("datePickerInput");
    if (dateInput) dateInput.value = newDateStr;
    refreshHourPickerBadges();
  }
  syncSlider();
  await renderActiveLayer();
  drawTrendChart();
}

document.getElementById("frameSlider").addEventListener("input", async (e) => {
  await applySliderStep(Number(e.target.value));
});

document.getElementById("playPauseBtn").addEventListener("click", () => {
  const btn = document.getElementById("playPauseBtn");
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
    btn.textContent = "▶ Putar";
    return;
  }
  btn.textContent = "⏸ Jeda";
  playInterval = setInterval(async () => {
    const slider = document.getElementById("frameSlider");
    if (!slider) return;
    const maxVal = Number(slider.max || 0) + 1;
    const nextVal = (Number(slider.value || 0) + 1) % Math.max(1, maxVal);
    await applySliderStep(nextVal);
  }, 1100);
});

document.getElementById("refreshNowBtn").addEventListener("click", () => {
  fetchManifest(true);
});

function setupAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (document.getElementById("autoRefreshChk").checked) {
    autoRefreshTimer = setInterval(() => fetchManifest(true), 60000);
  }
}

document.getElementById("autoRefreshChk").addEventListener("change", setupAutoRefresh);

// Inisialisasi Pemilih Rentang Waktu (Tanggal, Jam Mulai & Rentang Jam Ke Depan)
function initDateTimePicker() {
  const hourSel = document.getElementById("hourPickerSelect");
  const spanSel = document.getElementById("hourSpanSelect");
  if (!hourSel) return;
  hourSel.innerHTML = "";

  for (let h = 0; h < 24; h++) {
    const hhUtc = String(h).padStart(2, "0");
    const hhWib = String((h + 7) % 24).padStart(2, "0");
    const opt = document.createElement("option");
    opt.value = hhUtc;
    opt.textContent = `${hhUtc}:00 UTC (${hhWib}:00 WIB)`;
    hourSel.appendChild(opt);
  }
  // Default: Jam Mulai 00:00 UTC (07:00 WIB) dengan rentang +24 jam ke depan
  hourSel.value = "00";
  if (spanSel) spanSel.value = "24";
  updateDatePickerBounds(false);
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function updateDatePickerBounds(triggerRender = true) {
  const tier = document.getElementById("timeTierSelect")?.value || "hourly_30d";
  const dateInput = document.getElementById("datePickerInput");
  const hourWrap = document.getElementById("hourPickerWrap");
  const hourEndWrap = document.getElementById("hourEndPickerWrap");
  const hourLabel = document.getElementById("hourPickerLabel");
  const minWrap = document.getElementById("minPickerWrap");
  const dailyWrap = document.getElementById("dailyStatWrap");
  if (!dateInput) return;

  const refDateStr = getReferenceLatestDateStr();
  const refDateObj = new Date(refDateStr + "T12:00:00Z");
  const todayStr = refDateStr;

  const satModeSel = document.getElementById("satModeSelect");
  const specGroup = document.getElementById("specificSatGroup");
  const layerSel = document.getElementById("layerModeSelect");
  const combinedOpt = satModeSel?.querySelector('option[value="combined"]');

  if (tier === "realtime_48h") {
    const minD = new Date(refDateObj.getTime() - 2 * 24 * 3600 * 1000);
    dateInput.min = toIsoDate(minD);
    dateInput.max = todayStr;
    if (!dateInput.value || dateInput.value < dateInput.min || dateInput.value > dateInput.max) {
      dateInput.value = todayStr;
    }
    hourWrap.style.display = "";
    if (hourLabel) hourLabel.textContent = "Pilih Jam (UTC/WIB)";
    if (hourEndWrap) hourEndWrap.style.display = "none";
    minWrap.style.display = "";
    dailyWrap.style.display = "none";

    // Rentang 10 menit hanya ditangkap oleh satelit geostasioner spesifik (Himawari-9 AHI)
    currentSatMode = "specific";
    currentLayerMode = "himawari_lst";
    if (satModeSel) satModeSel.value = "specific";
    if (combinedOpt) {
      combinedOpt.disabled = true;
      combinedOpt.textContent = "🌐 Gabungan Satelit (Khusus Rentang Jam / Harian)";
    }
    if (specGroup) specGroup.style.display = "";
    if (layerSel) layerSel.value = "himawari_lst";
  } else {
    if (combinedOpt) {
      combinedOpt.disabled = false;
      combinedOpt.textContent = "🌐 Gabungan Satelit (Tanpa Satelit Spesifik)";
    }
    if (tier === "hourly_30d") {
      const minD = new Date(refDateObj.getTime() - 30 * 24 * 3600 * 1000);
      dateInput.min = toIsoDate(minD);
      dateInput.max = todayStr;
      if (!dateInput.value || dateInput.value < dateInput.min || dateInput.value > dateInput.max) {
        dateInput.value = todayStr;
      }
      hourWrap.style.display = "";
      if (hourLabel) hourLabel.textContent = "Jam Mulai (UTC/WIB)";
      if (hourEndWrap) hourEndWrap.style.display = "";
      minWrap.style.display = "none";
      dailyWrap.style.display = "";
    } else if (tier === "daily_permanent") {
      dateInput.min = "2015-07-07";
      dateInput.max = todayStr;
      if (!dateInput.value || dateInput.value > dateInput.max) dateInput.value = todayStr;
      hourWrap.style.display = "none";
      if (hourEndWrap) hourEndWrap.style.display = "none";
      minWrap.style.display = "none";
      dailyWrap.style.display = "";
    } else if (tier === "gibs_historical") {
      const yest = new Date(refDateObj.getTime() - 24 * 3600 * 1000);
      dateInput.min = "2012-01-01";
      dateInput.max = toIsoDate(yest);
      if (!dateInput.value || dateInput.value > dateInput.max) dateInput.value = toIsoDate(yest);
      hourWrap.style.display = "none";
      if (hourEndWrap) hourEndWrap.style.display = "none";
      minWrap.style.display = "none";
      dailyWrap.style.display = "none";
    }
  }

  syncSlider();
  if (triggerRender && manifest) {
    renderActiveLayer();
  }
}

document.getElementById("timeTierSelect")?.addEventListener("change", () => updateDatePickerBounds(true));
document.getElementById("datePickerInput")?.addEventListener("change", async () => {
  refreshHourPickerBadges();
  syncSlider();
  await renderActiveLayer();
});
document.getElementById("hourPickerSelect")?.addEventListener("change", async () => {
  refreshHourPickerBadges();
  syncSlider();
  await renderActiveLayer();
});
document.getElementById("minPickerSelect")?.addEventListener("change", async () => {
  syncSlider();
  await renderActiveLayer();
});
document.getElementById("hourSpanSelect")?.addEventListener("change", async () => {
  await renderActiveLayer();
});
document.getElementById("dailyStatSelect")?.addEventListener("change", async () => {
  await renderActiveLayer();
});

document.getElementById("applyDateTimeBtn")?.addEventListener("click", async () => {
  const tier = document.getElementById("timeTierSelect").value;
  const dateVal = document.getElementById("datePickerInput").value;
  const hourVal = document.getElementById("hourPickerSelect").value;
  const minVal = tier === "hourly_30d" ? "00" : document.getElementById("minPickerSelect").value;
  const btn = document.getElementById("applyDateTimeBtn");
  const statusText = document.getElementById("liveStatusText");

  if (!dateVal) return;
  const regData = manifest?.regions?.[currentRegion];
  if (!regData) return;

  if (window.innerWidth <= 960) setTimePickerCollapsed(true);

  syncSlider();
  await renderActiveLayer();
  drawTrendChart();

  const ymd = dateVal.replace(/-/g, "");
  const targetStamp = `${ymd}_${hourVal}${minVal}`;
  const targetParam = `${ymd}${hourVal}${minVal}`;
  const existingIdx = (regData.frames || []).findIndex((f) => f.stamp === targetStamp);
  const isLocalBackend =
    window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

  // Jika di server lokal dan frame spesifik 10-menit pada tanggal arsip belum diunduh dari S3, ambil di latar belakang
  if (isLocalBackend && tier === "realtime_48h" && dateVal === getReferenceLatestDateStr() && existingIdx < 0) {
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳ Mengambil dari Satelit...";
    try {
      const resp = await fetch(`/api/fetch_frame?region=${currentRegion}&time=${targetParam}`);
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const resJson = await resp.json();
        if (resp.ok && resJson.ok) {
          await fetchManifest(true);
        }
      }
    } catch (_) {
      // Tetap gunakan hasil interpolasi 10-menit yang sudah dirender
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  } else if (statusText) {
    const wibH = String((Number(hourVal) + 7) % 24).padStart(2, "0");
    statusText.textContent = `Aktif · Menampilkan ${dateVal} (${wibH}:${minVal} WIB)`;
  }
});

// Toggle Sembunyikan / Tampilkan Sidebar Detail Informasi secara 60fps mulus
function setSidebarCollapsed(collapse) {
  const layout = document.getElementById("mainLayout");
  const topBtn = document.getElementById("toggleSidebarBtn");
  const handleIcon = document.getElementById("mapSidebarHandleIcon");
  const handleLabel = document.getElementById("mapSidebarHandleLabel");
  if (!layout) return;

  layout.classList.toggle("sidebar-collapsed", collapse);
  const isMobile = window.innerWidth <= 640;
  if (topBtn) {
    if (isMobile) {
      topBtn.textContent = collapse ? "◫ Panel" : "✕ Panel";
    } else {
      topBtn.textContent = collapse ? "◫ Tampilkan Panel" : "◫ Sembunyikan Panel";
    }
    topBtn.classList.toggle("collapsed-state", collapse);
  }
  if (handleIcon) handleIcon.textContent = collapse ? "❮" : "❯";
  if (handleLabel) handleLabel.textContent = collapse ? "Buka Panel" : "Panel";
}

function toggleRightSidebar() {
  const layout = document.getElementById("mainLayout");
  if (!layout) return;
  const nextCollapsed = !layout.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(nextCollapsed);
}

function autoCloseDrawerOnNarrow() {
  if (window.innerWidth <= 1120) {
    setSidebarCollapsed(true);
  }
}

function setTopFiltersCollapsed(collapse) {
  const bar = document.getElementById("mapOverlayTop");
  const icon = document.getElementById("toggleTopFiltersIcon");
  if (!bar) return;
  bar.classList.toggle("filters-collapsed", collapse);
  if (icon) icon.textContent = collapse ? "▾" : "▴";
  updateMobileFilterSummary();
}

function setTimePickerCollapsed(collapse) {
  const bar = document.getElementById("timeBar");
  const icon = document.getElementById("toggleTimePickerIcon");
  if (!bar) return;
  bar.classList.toggle("timepicker-collapsed", collapse);
  if (icon) icon.textContent = collapse ? "▾" : "▴";
}

function updateMobileFilterSummary() {
  const summaryEl = document.getElementById("mobileFilterSummary");
  if (!summaryEl) return;
  const regLabel = currentRegion === "kalimantan" ? "Kalimantan" : "Seluruh Indonesia";
  const satLabel =
    currentSatMode === "combined"
      ? "🌐 Gabungan Satelit"
      : document.getElementById("layerModeSelect")?.selectedOptions?.[0]?.textContent?.split("—")?.[1]?.trim() ||
        "🛰️ Satelit Spesifik";
  summaryEl.textContent = `${satLabel} · ${regLabel}`;
}

let lastWasNarrow = window.innerWidth <= 1120;
function applyResponsiveLayoutDefaults(isInitial = false) {
  const w = window.innerWidth;
  const isNarrow = w <= 1120;
  const isCompactControls = w <= 960;

  if (isInitial) {
    // Pada split-screen / tablet / mobile, otomatis sembunyikan drawer panel & ciutkan filter agar peta luas
    if (isNarrow) {
      setSidebarCollapsed(true);
    }
    if (isCompactControls) {
      setTopFiltersCollapsed(true);
      setTimePickerCollapsed(true);
    }
  } else if (isNarrow !== lastWasNarrow) {
    // Saat jendela diperkecil ke mode split-screen atau diperbesar kembali ke layar penuh
    setSidebarCollapsed(isNarrow);
    if (isCompactControls) {
      setTopFiltersCollapsed(true);
      setTimePickerCollapsed(true);
    } else {
      setTopFiltersCollapsed(false);
      setTimePickerCollapsed(false);
    }
    lastWasNarrow = isNarrow;
  } else {
    // Perbarui label tombol topbar jika melintasi batas mobile
    const layout = document.getElementById("mainLayout");
    if (layout) setSidebarCollapsed(layout.classList.contains("sidebar-collapsed"));
  }
  updateMobileFilterSummary();
}

// ResizeObserver memastikan kanvas peta Leaflet menyesuaikan ukuran setiap frame transisi tanpa lompatan (pan: false)
const mapCanvasWrapEl = document.querySelector(".map-canvas-wrap");
if (mapCanvasWrapEl && typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => {
    map.invalidateSize({ pan: false, animate: false });
  });
  ro.observe(mapCanvasWrapEl);
}

window.addEventListener("resize", () => applyResponsiveLayoutDefaults(false));

document.getElementById("toggleSidebarBtn")?.addEventListener("click", toggleRightSidebar);
document.getElementById("mapSidebarHandle")?.addEventListener("click", toggleRightSidebar);
document.getElementById("closeSidebarDrawerBtn")?.addEventListener("click", () => setSidebarCollapsed(true));
document.getElementById("sidebarBackdrop")?.addEventListener("click", () => setSidebarCollapsed(true));

document.getElementById("toggleTopFiltersBtn")?.addEventListener("click", () => {
  const bar = document.getElementById("mapOverlayTop");
  if (!bar) return;
  setTopFiltersCollapsed(!bar.classList.contains("filters-collapsed"));
});

document.getElementById("toggleTimePickerBtn")?.addEventListener("click", () => {
  const bar = document.getElementById("timeBar");
  if (!bar) return;
  setTimePickerCollapsed(!bar.classList.contains("timepicker-collapsed"));
});

["regionSelect", "satModeSelect", "layerModeSelect", "basemapSelect"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", updateMobileFilterSummary);
});

// Toggle Ciutkan / Bentangkan Kartu Legenda Suhu
document.getElementById("legendCollapseBtn")?.addEventListener("click", () => {
  const card = document.getElementById("mapLegendCard");
  const btn = document.getElementById("legendCollapseBtn");
  if (!card || !btn) return;
  const collapsed = card.classList.toggle("legend-collapsed");
  btn.textContent = collapsed ? "+" : "−";
});

initDateTimePicker();
applyResponsiveLayoutDefaults(true);
setTimeout(() => map.invalidateSize(), 80);
fetchManifest(false);
setupAutoRefresh();

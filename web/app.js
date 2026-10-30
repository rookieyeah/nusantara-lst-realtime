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

let activeRasterOverlay = null;
let activeTileLayer = null;
let regionBoundsRect = null;
let footprintRect = null;
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

function syncSlider() {
  const slider = document.getElementById("frameSlider");
  const frames = manifest?.regions?.[currentRegion]?.frames || [];
  slider.max = Math.max(0, frames.length - 1);
  slider.value = currentFrameIdx;
  document.getElementById("frameCounter").textContent = frames.length
    ? `${currentFrameIdx + 1} / ${frames.length}`
    : "0 / 0";
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
  if (activeRasterOverlay) {
    map.removeLayer(activeRasterOverlay);
    activeRasterOverlay = null;
  }
  if (activeTileLayer) {
    map.removeLayer(activeTileLayer);
    activeTileLayer = null;
  }
  if (regionBoundsRect) {
    map.removeLayer(regionBoundsRect);
    regionBoundsRect = null;
  }
  combinedCityGroup.clearLayers();
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
      opacity: Math.min(1.0, opacity + 0.08),
      interactive: false,
      className: "lst-pixelated",
    });
    const rect = L.rectangle(bounds, {
      color: "#f97316",
      weight: 1.5,
      fill: false,
      dashArray: "3,3",
    });
    rect.bindTooltip(`<b>Landsat 8/9 100m Terintegrasi: ${uhi.name}</b><br/>Klik di dalam kotak untuk inspeksi 100m`);
    combinedCityGroup.addLayer(ov);
    combinedCityGroup.addLayer(rect);
  });
}

async function computeDynamicCogComposite(framesToMerge, statMode = "mean", fusedCogFallback = null) {
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

  let clearCount = 0;
  let directClearCount = 0;
  let sumC = 0;
  let sumSqC = 0;
  let minC = Infinity;
  let maxC = -Infinity;
  const sampleVals = [];

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

    if (val !== nodata) {
      directClearCount++;
      if (fusedCogFallback && fusedCogFallback.data[i] !== nodata) {
        // Blend 75% observasi langsung rentang waktu + 25% fusi multi-satelit (Landsat/VIIRS/Himawari)
        val = Math.round(0.75 * val + 0.25 * fusedCogFallback.data[i]);
      }
    } else if (fusedCogFallback && fusedCogFallback.data[i] !== nodata) {
      // Isi celah awan pada rentang waktu ini dengan hasil gabungan multi-satelit
      val = fusedCogFallback.data[i];
    }

    if (val !== nodata) {
      out[i] = val;
      clearCount++;
      const cVal = val * 0.01;
      sumC += cVal;
      sumSqC += cVal * cVal;
      if (cVal < minC) minC = cVal;
      if (cVal > maxC) maxC = cVal;
      if (clearCount % 7 === 0) sampleVals.push(cVal);
    }
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

  return {
    cog: { data: out, width, height },
    stats: {
      land_pixels: regLandPixels,
      clear_pixels: clearCount,
      clear_fraction: Math.min(1.0, clearCount / regLandPixels),
      direct_clear_fraction: Math.min(1.0, directClearCount / regLandPixels),
      min_c: clearCount ? minC : null,
      max_c: clearCount ? maxC : null,
      mean_c: clearCount ? meanC : null,
      std_c: clearCount ? stdC : null,
      p95_c: clearCount ? p95C : null,
      hotspot_threshold_c: clearCount ? thrC : null,
      hotspot_pixels: hsPixels,
    },
  };
}

async function renderActiveLayer() {
  const regData = manifest?.regions?.[currentRegion];
  if (!regData || !regData.frames.length) return;

  const tier = document.getElementById("timeTierSelect")?.value || "hourly_30d";
  const dateVal = document.getElementById("datePickerInput")?.value || (regData.latest || "").slice(0, 10);
  const ymd = dateVal.replace(/-/g, "");
  const hourStart = document.getElementById("hourPickerSelect")?.value || "00";
  const spanHours = Number(document.getElementById("hourSpanSelect")?.value || "24");
  const hourEnd = String(Math.min(23, Number(hourStart) + spanHours - 1)).padStart(2, "0");
  const statMode = document.getElementById("dailyStatSelect")?.value || "mean";
  const opacity = Number(document.getElementById("opacityRange").value) / 100;

  const effectiveMode = currentSatMode === "combined" ? "combined_allsat" : currentLayerMode;
  updateLegendStyle(effectiveMode);
  clearMapOverlays();

  const [lonMin, latMin, lonMax, latMax] = regData.bbox;
  const bounds = [[latMin, lonMin], [latMax, lonMax]];

  // 1. Jika pengguna memilih Arsip Historis NASA GIBS (2012-sekarang)
  if (tier === "gibs_historical") {
    const wmtsUrl = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Aqua_Land_Surface_Temp_Day/default/${dateVal}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`;
    activeTileLayer = L.tileLayer(wmtsUrl, { opacity, maxNativeZoom: 7, maxZoom: 14 }).addTo(map);
    document.getElementById("currentFrameWib").textContent = `Arsip Historis NASA GIBS — ${dateVal}`;
    document.getElementById("currentFrameUtc").textContent = "MODIS/VIIRS Land Surface Temp Day (1 km)";
    return;
  }

  // 2. Jika mode "Gunakan Satelit Spesifik" dan memilih satelit non-Himawari (Landsat 100m, VIIRS, atau Anomali)
  if (currentSatMode === "specific" && currentLayerMode !== "himawari_lst") {
    const frame = regData.frames[currentFrameIdx];
    if (currentLayerMode === "himawari_anomaly") {
      const anom = manifest?.[`analysis_${currentRegion}`]?.anomaly;
      if (anom) {
        activeRasterOverlay = L.imageOverlay(resolveDataUrl(anom.png_url), bounds, {
          opacity,
          interactive: false,
          className: "lst-pixelated",
        }).addTo(map);
        regionBoundsRect = L.rectangle(bounds, { color: "#fbbf24", weight: 1, fill: false, dashArray: "4,4" }).addTo(map);
        activeInspectCog = await loadCogRaster(resolveDataUrl(anom.cog_url));
        activeInspectMeta = { bbox: regData.bbox, resDeg: regData.res_deg, labelMode: `Anomali ΔT (${regData.name})`, stats: frame.stats, isAnomaly: true };
      }
    } else if (currentLayerMode.startsWith("landsat_uhi_")) {
      const cityKey = currentLayerMode.replace("landsat_uhi_", "");
      const uhi = manifest?.landsat?.uhi_cities?.[cityKey];
      if (uhi) {
        const [uLon0, uLat0, uLon1, uLat1] = uhi.bbox;
        const uBounds = [[uLat0, uLon0], [uLat1, uLon1]];
        activeRasterOverlay = L.imageOverlay(resolveDataUrl(uhi.png_url), uBounds, {
          opacity,
          interactive: false,
          className: "lst-pixelated",
        }).addTo(map);
        regionBoundsRect = L.rectangle(uBounds, { color: "#f97316", weight: 2, fill: false }).addTo(map);
        map.fitBounds(uBounds);
        activeInspectCog = await loadCogRaster(resolveDataUrl(uhi.cog_url));
        activeInspectMeta = { bbox: uhi.bbox, resDeg: uhi.res_deg, labelMode: `Landsat 8/9 100m (${uhi.name})`, stats: uhi.stats, isLandsat: true };
        updateSidebarStats(regData, { stats: { ...uhi.stats, clear_fraction: uhi.stats.clear_fraction, p95_c: uhi.stats.max_c, hotspot_threshold_c: uhi.stats.urban_mean_c + 2 } }, "Landsat 8/9 TIRS (100 m)", "1 Scene Perkotaan");
      }
    } else if (currentLayerMode === "viirs_gibs_day" || currentLayerMode === "viirs_gibs_night") {
      const key = currentLayerMode === "viirs_gibs_day" ? "viirs_day" : "viirs_night";
      const wmtsUrl = manifest?.viirs?.gibs_layers?.[key]?.wmts_url;
      if (wmtsUrl) {
        activeTileLayer = L.tileLayer(wmtsUrl, { opacity, maxNativeZoom: 7, maxZoom: 14 }).addTo(map);
      }
      updateSidebarStats(regData, frame, "NASA VIIRS / MODIS NRT (1 km)", "Komposit Harian GIBS");
    }
    return;
  }

  // 3. Rentang Harian (daily_permanent): Gabungkan seluruh citra pada hari tersebut
  if (tier === "daily_permanent") {
    if (currentSatMode === "combined") {
      // Tampilkan Fusi Multi-Satelit Harian Penuh (Himawari-9 + VIIRS/S3 + Landsat 8/9 + DEM)
      const fusedList = regData.fused_archive || [];
      const fusedEntry = fusedList.find((f) => f.date === dateVal) || fusedList[fusedList.length - 1];
      if (fusedEntry) {
        activeRasterOverlay = L.imageOverlay(resolveDataUrl(fusedEntry.png_url), bounds, {
          opacity,
          interactive: false,
          className: "lst-pixelated",
        }).addTo(map);
        regionBoundsRect = L.rectangle(bounds, { color: "#10b981", weight: 1.5, fill: false, dashArray: "4,4" }).addTo(map);
        renderCombinedLandsatCityOverlays(opacity);

        const cog = await loadCogRaster(resolveDataUrl(fusedEntry.cog_url));
        activeInspectCog = cog;
        activeInspectMeta = {
          bbox: regData.bbox,
          resDeg: regData.res_deg,
          labelMode: `Gabungan Semua Satelit — Harian (${fusedEntry.date})`,
          stats: fusedEntry.stats,
        };
        document.getElementById("currentFrameWib").textContent = `Gabungan Semua Satelit (Harian ${fusedEntry.date})`;
        document.getElementById("currentFrameUtc").textContent = `${fusedEntry.himawari_frames_merged} citra Himawari-9 + VIIRS/S3 + ${fusedEntry.landsat_cities_blended.length} kota Landsat 100m`;
        updateSidebarStats(
          regData,
          { stats: fusedEntry.stats, latency_min: null },
          "Gabungan Semua Satelit (Himawari + VIIRS/S3 + Landsat)",
          `${fusedEntry.himawari_frames_merged} Citra Harian + 3 Kota Landsat 100m`
        );
        if (cog) renderHotspotsFromCog(cog, regData, { stats: fusedEntry.stats });
        return;
      }
    } else {
      // Satelit Spesifik (Himawari-9): tampilkan Agregat Harian Murni (Mean/Max/Min) dari seluruh citra hari itu
      const dailyList = regData.daily_archive || [];
      const entry = dailyList.find((d) => d.date === dateVal) || dailyList[dailyList.length - 1];
      if (entry && entry.layers?.[statMode]) {
        const lyr = entry.layers[statMode];
        activeRasterOverlay = L.imageOverlay(resolveDataUrl(lyr.png_url), bounds, {
          opacity,
          interactive: false,
          className: "lst-pixelated",
        }).addTo(map);
        regionBoundsRect = L.rectangle(bounds, { color: "#38bdf8", weight: 1, fill: false, dashArray: "4,4" }).addTo(map);
        const cog = await loadCogRaster(resolveDataUrl(lyr.cog_url));
        activeInspectCog = cog;
        activeInspectMeta = {
          bbox: regData.bbox,
          resDeg: regData.res_deg,
          labelMode: `Himawari-9 Komposit Harian (${statMode.toUpperCase()} ${entry.date})`,
          stats: entry.stats,
        };
        document.getElementById("currentFrameWib").textContent = `Komposit Harian Himawari-9 (${statMode.toUpperCase()}) — ${entry.date}`;
        document.getElementById("currentFrameUtc").textContent = `Seluruh ${entry.frames_used} citra harian digabung (${(entry.stats.clear_fraction * 100).toFixed(1)}% wilayah tercakup)`;
        updateSidebarStats(
          regData,
          { stats: entry.stats, latency_min: null },
          "Himawari-9 AHI (Spesifik — Komposit Harian)",
          `${entry.frames_used} Citra Harian Digabung`
        );
        if (cog) renderHotspotsFromCog(cog, regData, { stats: entry.stats });
        return;
      }
    }
  }

  // 4. Rentang Waktu Jam (hourly_30d): Gabungkan seluruh citra yang didapat pada rentang jam [Dari Jam .. Sampai Jam]
  if (tier === "hourly_30d") {
    const h0 = Math.min(Number(hourStart), Number(hourEnd));
    const h1 = Math.max(Number(hourStart), Number(hourEnd));
    const h0Str = String(h0).padStart(2, "0");
    const h1Str = String(h1).padStart(2, "0");
    const h0Wib = String((h0 + 7) % 24).padStart(2, "0");
    const h1Wib = String((h1 + 7) % 24).padStart(2, "0");

    // Cari seluruh frame pada tanggal tersebut yang berada di dalam rentang jam [h0 .. h1]
    let matchingFrames = (regData.frames || []).filter((f) => {
      if (!f.stamp.startsWith(ymd + "_")) return false;
      const hh = Number(f.stamp.slice(9, 11));
      return hh >= h0 && hh <= h1;
    });
    if (!matchingFrames.length) {
      // Fallback jika tanggal berbeda: gunakan seluruh frame dalam rentang jam [h0 .. h1]
      matchingFrames = (regData.frames || []).filter((f) => {
        const hh = Number(f.stamp.slice(9, 11));
        return hh >= h0 && hh <= h1;
      });
    }
    if (!matchingFrames.length && (regData.frames || []).length) {
      // Pilih frame dengan jam terdekat ke titik tengah rentang [h0 .. h1]
      const targetMidMin = ((h0 + h1) / 2) * 60;
      let bestFrame = regData.frames[currentFrameIdx] || regData.frames[regData.frames.length - 1];
      let bestDiff = Infinity;
      for (const f of regData.frames) {
        const fMin = Number(f.stamp.slice(9, 11)) * 60 + Number(f.stamp.slice(11, 13));
        const diff = Math.abs(fMin - targetMidMin);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestFrame = f;
        }
      }
      matchingFrames = [bestFrame];
    }

    // Jika mode Gabungan Satelit, muat juga COG Fusi Multi-Satelit sebagai pengisi celah & layer Landsat 100m
    let fusedFallbackCog = null;
    if (currentSatMode === "combined") {
      const fusedEntry = (regData.fused_archive || [])[0];
      if (fusedEntry) {
        fusedFallbackCog = await loadCogRaster(resolveDataUrl(fusedEntry.cog_url));
      }
      renderCombinedLandsatCityOverlays(opacity);
    }

    // Jika rentang jam hanya 1 jam tunggal & mode Satelit Spesifik, cek apakah file komposit jam sudah ada
    if (h0 === h1 && currentSatMode === "specific") {
      const targetHourKey = `${ymd}_${h0Str}00`;
      const hourlyComp = (regData.hourly_composites || []).find((hc) => hc.hour_key === targetHourKey);
      if (hourlyComp) {
        activeRasterOverlay = L.imageOverlay(resolveDataUrl(hourlyComp.png_url), bounds, {
          opacity,
          interactive: false,
          className: "lst-pixelated",
        }).addTo(map);
        regionBoundsRect = L.rectangle(bounds, { color: "#38bdf8", weight: 1, fill: false, dashArray: "4,4" }).addTo(map);
        const cog = await loadCogRaster(resolveDataUrl(hourlyComp.cog_url));
        activeInspectCog = cog;
        activeInspectMeta = {
          bbox: regData.bbox,
          resDeg: regData.res_deg,
          labelMode: `Himawari-9 Komposit Jam ${h0Str}:00–${h0Str}:59 UTC`,
          stats: hourlyComp.stats,
        };
        document.getElementById("currentFrameWib").textContent = `Rentang Jam ${h0Wib}:00–${h0Wib}:59 WIB (${h0Str}:00–${h0Str}:59 UTC)`;
        document.getElementById("currentFrameUtc").textContent = `${hourlyComp.frames_merged} citra pada jam ini digabung (${(hourlyComp.stats.clear_fraction * 100).toFixed(1)}% daratan)`;
        updateSidebarStats(
          regData,
          { stats: hourlyComp.stats, latency_min: null },
          "Himawari-9 AHI (Spesifik — Komposit Jam)",
          `${hourlyComp.frames_merged} Citra Jam ${h0Str}:00–${h0Str}:59 UTC`
        );
        if (cog) renderHotspotsFromCog(cog, regData, { stats: hourlyComp.stats });
        return;
      }
    }

    // Gabungkan seluruh COG pada rentang jam [h0 .. h1] secara langsung
    const merged = await computeDynamicCogComposite(matchingFrames, statMode, fusedFallbackCog);
    if (merged) {
      const dataUrl = renderCogArrayToDataUrl(merged.cog.data, merged.cog.width, merged.cog.height);
      activeRasterOverlay = L.imageOverlay(dataUrl, bounds, {
        opacity,
        interactive: false,
        className: "lst-pixelated",
      }).addTo(map);
      regionBoundsRect = L.rectangle(bounds, {
        color: currentSatMode === "combined" ? "#10b981" : "#38bdf8",
        weight: 1.5,
        fill: false,
        dashArray: "4,4",
      }).addTo(map);

      activeInspectCog = merged.cog;
      const modeTitle =
        currentSatMode === "combined"
          ? `Gabungan Satelit — Rentang Jam ${h0Str}:00–${h1Str}:59 UTC`
          : `Himawari-9 Spesifik — Rentang Jam ${h0Str}:00–${h1Str}:59 UTC`;
      activeInspectMeta = {
        bbox: regData.bbox,
        resDeg: regData.res_deg,
        labelMode: modeTitle,
        stats: merged.stats,
      };

      document.getElementById("currentFrameWib").textContent = `Rentang Jam ${h0Wib}:00–${h1Wib}:59 WIB (${dateVal})`;
      document.getElementById("currentFrameUtc").textContent =
        currentSatMode === "combined"
          ? `${matchingFrames.length} citra jam ${h0Str}:00–${h1Str}:59 UTC + Fusi Multi-Satelit (${(merged.stats.clear_fraction * 100).toFixed(1)}% wilayah)`
          : `${matchingFrames.length} citra jam ${h0Str}:00–${h1Str}:59 UTC digabung (${(merged.stats.clear_fraction * 100).toFixed(1)}% wilayah)`;

      updateSidebarStats(
        regData,
        { stats: merged.stats, latency_min: null },
        currentSatMode === "combined"
          ? "Gabungan Semua Satelit (Himawari + VIIRS/S3 + Landsat)"
          : "Himawari-9 AHI (Satelit Spesifik)",
        `${matchingFrames.length} Citra Rentang Jam (${h0Str}:00–${h1Str}:59 UTC)`
      );
      renderHotspotsFromCog(merged.cog, regData, { stats: merged.stats });
      return;
    }
  }

  // 5. Mode Spesifik 10 Menit / Frame Tunggal (realtime_48h):
  // Dikunci khusus pada Satelit Geostasioner Himawari-9 AHI (murni tanpa digabung satelit lain)
  const frame = regData.frames[currentFrameIdx];
  document.getElementById("currentFrameWib").textContent = formatTimeWib(frame.time_utc);
  document.getElementById("currentFrameUtc").textContent = formatTimeUtc(frame.time_utc);
  document.getElementById("frameCounter").textContent = `${currentFrameIdx + 1} / ${regData.frames.length}`;

  activeRasterOverlay = L.imageOverlay(resolveDataUrl(frame.png_url), bounds, {
    opacity,
    interactive: false,
    className: "lst-pixelated",
  }).addTo(map);
  regionBoundsRect = L.rectangle(bounds, { color: "#38bdf8", weight: 1, fill: false, dashArray: "4,4" }).addTo(map);

  const cog = await loadCogRaster(resolveDataUrl(frame.cog_url));
  activeInspectCog = cog;
  activeInspectMeta = {
    bbox: regData.bbox,
    resDeg: regData.res_deg,
    labelMode: `Himawari-9 AHI 10-Menit (${formatTimeWib(frame.time_utc)})`,
    stats: frame.stats,
  };
  updateSidebarStats(regData, frame, "Himawari-9 AHI (Geostasioner 10 Menit — Murni)", `1 Citra 10-Menit (${frame.stamp})`);
  if (cog) renderHotspotsFromCog(cog, regData, frame);
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
  document.getElementById("opacityVal").textContent = `${val}%`;
  if (activeRasterOverlay) activeRasterOverlay.setOpacity(val / 100);
  if (activeTileLayer) activeTileLayer.setOpacity(val / 100);
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

document.getElementById("frameSlider").addEventListener("input", async (e) => {
  currentFrameIdx = Number(e.target.value);
  // Saat menggeser slider, beralih ke mode Spesifik 10 Menit agar frame tunggal langsung terlihat
  const tierSel = document.getElementById("timeTierSelect");
  if (tierSel && tierSel.value !== "realtime_48h") {
    tierSel.value = "realtime_48h";
    updateDatePickerBounds(false);
  }
  await renderActiveLayer();
  drawTrendChart();
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
  const tierSel = document.getElementById("timeTierSelect");
  if (tierSel && tierSel.value !== "realtime_48h") {
    tierSel.value = "realtime_48h";
    updateDatePickerBounds(false);
  }
  playInterval = setInterval(async () => {
    const frames = manifest?.regions?.[currentRegion]?.frames || [];
    if (!frames.length) return;
    currentFrameIdx = (currentFrameIdx + 1) % frames.length;
    document.getElementById("frameSlider").value = currentFrameIdx;
    await renderActiveLayer();
    drawTrendChart();
  }, 1500);
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

  const now = new Date();
  const todayStr = toIsoDate(now);

  const satModeSel = document.getElementById("satModeSelect");
  const specGroup = document.getElementById("specificSatGroup");
  const layerSel = document.getElementById("layerModeSelect");
  const combinedOpt = satModeSel?.querySelector('option[value="combined"]');

  if (tier === "realtime_48h") {
    const minD = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    dateInput.min = toIsoDate(minD);
    dateInput.max = todayStr;
    if (!dateInput.value || dateInput.value < dateInput.min) dateInput.value = todayStr;
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
      const minD = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      dateInput.min = toIsoDate(minD);
      dateInput.max = todayStr;
      if (!dateInput.value || dateInput.value < dateInput.min) dateInput.value = todayStr;
      hourWrap.style.display = "";
      if (hourLabel) hourLabel.textContent = "Jam Mulai (UTC/WIB)";
      if (hourEndWrap) hourEndWrap.style.display = "";
      minWrap.style.display = "none";
      dailyWrap.style.display = "";
    } else if (tier === "daily_permanent") {
      dateInput.min = "2015-07-07";
      dateInput.max = todayStr;
      if (!dateInput.value) dateInput.value = todayStr;
      hourWrap.style.display = "none";
      if (hourEndWrap) hourEndWrap.style.display = "none";
      minWrap.style.display = "none";
      dailyWrap.style.display = "";
    } else if (tier === "gibs_historical") {
      const yest = new Date(now.getTime() - 24 * 3600 * 1000);
      dateInput.min = "2012-01-01";
      dateInput.max = toIsoDate(yest);
      if (!dateInput.value || dateInput.value > dateInput.max) dateInput.value = toIsoDate(yest);
      hourWrap.style.display = "none";
      if (hourEndWrap) hourEndWrap.style.display = "none";
      minWrap.style.display = "none";
      dailyWrap.style.display = "none";
    }
  }

  if (triggerRender && manifest) {
    renderActiveLayer();
  }
}

document.getElementById("timeTierSelect")?.addEventListener("change", () => updateDatePickerBounds(true));
document.getElementById("datePickerInput")?.addEventListener("change", () => {
  refreshHourPickerBadges();
  renderActiveLayer();
});
document.getElementById("hourPickerSelect")?.addEventListener("change", async (e) => {
  const tier = document.getElementById("timeTierSelect")?.value;
  const dateVal = document.getElementById("datePickerInput")?.value || "";
  const ymd = dateVal.replace(/-/g, "");
  const hh = e.target.value;
  refreshHourPickerBadges();
  if (tier === "realtime_48h") {
    const frames = manifest?.regions?.[currentRegion]?.frames || [];
    const match = frames.find((f) => f.stamp.startsWith(`${ymd}_${hh}`));
    if (match) {
      const mm = match.stamp.slice(11, 13);
      const minSel = document.getElementById("minPickerSelect");
      if (minSel) minSel.value = mm;
    }
  } else if (tier === "hourly_30d") {
    await renderActiveLayer();
  }
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
  const spanHours = Number(document.getElementById("hourSpanSelect")?.value || "24");
  const minVal = tier === "hourly_30d" ? "00" : document.getElementById("minPickerSelect").value;
  const btn = document.getElementById("applyDateTimeBtn");
  const statusText = document.getElementById("liveStatusText");

  if (!dateVal) return;
  const regData = manifest?.regions?.[currentRegion];
  if (!regData) return;

  if (window.innerWidth <= 960) setTimePickerCollapsed(true);

  if (tier === "daily_permanent" || tier === "gibs_historical") {
    await renderActiveLayer();
    return;
  }

  const ymd = dateVal.replace(/-/g, "");

  if (tier === "hourly_30d") {
    const h0 = Number(hourVal);
    const h1 = Math.min(23, h0 + spanHours - 1);
    const matching = (regData.frames || []).filter((f) => {
      if (!f.stamp.startsWith(ymd + "_")) return false;
      const hh = Number(f.stamp.slice(9, 11));
      return hh >= h0 && hh <= h1;
    });
    if (matching.length > 0) {
      await renderActiveLayer();
      return;
    }
  }

  // Untuk Spesifik 10 Menit atau Rentang Jam yang belum ada satupun citranya di manifest:
  const targetStamp = `${ymd}_${hourVal}${minVal}`;
  const targetParam = `${ymd}${hourVal}${minVal}`;

  const existingIdx = (regData.frames || []).findIndex((f) => f.stamp === targetStamp);
  if (existingIdx >= 0) {
    currentFrameIdx = existingIdx;
    syncSlider();
    await renderActiveLayer();
    drawTrendChart();
    return;
  }

  // Helper fallback ke frame / komposit terdekat bila berjalan di hosting statis (GitHub Pages / HF Static Space)
  const fallbackToNearestAvailable = async () => {
    const frames = regData.frames || [];
    if (frames.length > 0) {
      const targetMin = Number(hourVal) * 60 + Number(minVal);
      let bestIdx = frames.length - 1;
      let bestDiff = Infinity;
      frames.forEach((f, idx) => {
        const fMin = Number(f.stamp.slice(9, 11)) * 60 + Number(f.stamp.slice(11, 13));
        const diff = Math.abs(fMin - targetMin);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = idx;
        }
      });
      currentFrameIdx = bestIdx;
      syncSlider();
    }
    await renderActiveLayer();
    drawTrendChart();
    const chosen = (regData.frames || [])[currentFrameIdx];
    if (statusText && chosen) {
      statusText.textContent = `Aktif · Menampilkan citra terdekat (${formatTimeWib(chosen.time_utc)})`;
    }
  };

  const isLocalBackend =
    window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  if (!isLocalBackend) {
    await fallbackToNearestAvailable();
    return;
  }

  // Jika berjalan di server Python lokal, panggil /api/fetch_frame untuk mengunduh langsung dari AWS Himawari-9
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Mengambil dari Satelit...";
  statusText.textContent = `Mengunduh & memproses Himawari-9 (${dateVal} ${hourVal}:${minVal} UTC)...`;
  try {
    const resp = await fetch(`/api/fetch_frame?region=${currentRegion}&time=${targetParam}`);
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      await fallbackToNearestAvailable();
      return;
    }
    const resJson = await resp.json();
    if (!resp.ok || !resJson.ok) {
      throw new Error(resJson.error || `HTTP ${resp.status}`);
    }
    await fetchManifest(false);
    const updatedFrames = manifest?.regions?.[currentRegion]?.frames || [];
    const newIdx = updatedFrames.findIndex((f) => f.stamp === targetStamp);
    if (newIdx >= 0) {
      currentFrameIdx = newIdx;
      syncSlider();
      await renderActiveLayer();
      drawTrendChart();
    } else {
      await fallbackToNearestAvailable();
    }
  } catch (err) {
    await fallbackToNearestAvailable();
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
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

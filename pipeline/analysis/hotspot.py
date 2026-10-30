"""Deteksi klaster Hotspot spasial (LST > mean + 2 sigma & > mean + 3 sigma) dan Statistik Zonal.

Mengelompokkan piksel panas yang bersebelahan menggunakan connected-components (`scipy.ndimage.label`),
menghitung luas area terdampak (km2), suhu puncak, dan memetakan ke kawasan/provinsi di Indonesia
(dengan rincian khusus 5 provinsi di Pulau Kalimantan).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import rasterio
from scipy import ndimage

from ..config import DATA_DIR, RegionGrid, load_settings, region_grid
from ..output import write_json

log = logging.getLogger(__name__)

# Daftar kawasan & provinsi (termasuk 5 provinsi di Pulau Kalimantan) untuk analisis zonal & lokasi hotspot
INDONESIA_ZONES = [
    {"id": "kalbar", "name": "Kalimantan Barat", "island": "Kalimantan", "bbox": [108.5, -3.1, 114.2, 2.1]},
    {"id": "kalteng", "name": "Kalimantan Tengah", "island": "Kalimantan", "bbox": [110.7, -3.5, 115.8, 0.8]},
    {"id": "kalsel", "name": "Kalimantan Selatan", "island": "Kalimantan", "bbox": [114.3, -4.2, 116.6, -1.3]},
    {"id": "kaltim", "name": "Kalimantan Timur (IKN)", "island": "Kalimantan", "bbox": [113.8, -2.5, 119.0, 2.6]},
    {"id": "kaltara", "name": "Kalimantan Utara", "island": "Kalimantan", "bbox": [114.5, 1.5, 118.0, 4.5]},
    {"id": "sumatera", "name": "Pulau Sumatera", "island": "Sumatera", "bbox": [95.0, -6.0, 106.2, 5.9]},
    {"id": "jawa", "name": "Pulau Jawa & Madura", "island": "Jawa", "bbox": [105.1, -8.8, 114.6, -5.8]},
    {"id": "bali_nusra", "name": "Bali & Nusa Tenggara", "island": "Bali-Nusra", "bbox": [114.4, -11.0, 125.2, -8.0]},
    {"id": "sulawesi", "name": "Pulau Sulawesi", "island": "Sulawesi", "bbox": [118.8, -5.8, 125.3, 1.8]},
    {"id": "maluku", "name": "Kepulauan Maluku", "island": "Maluku", "bbox": [124.3, -8.3, 134.9, 2.7]},
    {"id": "papua", "name": "Tanah Papua", "island": "Papua", "bbox": [130.0, -9.2, 141.1, -0.3]},
]


def locate_zone(lat: float, lon: float) -> str:
    for z in INDONESIA_ZONES:
        x0, y0, x1, y1 = z["bbox"]
        if x0 <= lon <= x1 and y0 <= lat <= y1:
            return z["name"]
    return "Kepulauan Indonesia Lainnya"


def read_cog_celsius(cog_path: Path) -> np.ndarray:
    with rasterio.open(cog_path) as src:
        raw = src.read(1)
        nodata = src.nodata if src.nodata is not None else -32768
        scale = src.scales[0] if src.scales else 0.01
    return np.where(raw == nodata, np.nan, raw.astype(np.float32) * scale)


def detect_hotspot_clusters(
    lst_c: np.ndarray,
    grid: RegionGrid,
    min_pixels: int = 2,
    max_clusters: int = 60,
) -> dict:
    """Deteksi klaster spasial piksel hotspot (> mean + 2*std) dan ekstrem (> mean + 3*std)."""
    valid = np.isfinite(lst_c)
    if not valid.any():
        return {"threshold_2sigma_c": None, "threshold_3sigma_c": None, "clusters": []}

    vals = lst_c[valid]
    mean_c = float(vals.mean())
    std_c = float(vals.std())
    thr2 = mean_c + 2.0 * std_c
    thr3 = mean_c + 3.0 * std_c

    hot_mask = valid & (lst_c >= thr2)
    labeled, num_features = ndimage.label(hot_mask, structure=np.ones((3, 3), dtype=int))

    # Luas 1 piksel di ekuator (~0.02 deg = 2.22 km -> ~4.93 km2)
    px_area_km2 = (grid.res * 111.132) ** 2

    clusters = []
    slices = ndimage.find_objects(labeled)
    for idx, slc in enumerate(slices, start=1):
        if slc is None:
            continue
        sub_lbl = labeled[slc] == idx
        n_px = int(sub_lbl.sum())
        if n_px < min_pixels:
            continue

        sub_lst = lst_c[slc][sub_lbl]
        max_val = float(sub_lst.max())
        mean_val = float(sub_lst.mean())

        # Koordinat piksel terpanas di dalam klaster
        local_rows, local_cols = np.where(sub_lbl)
        peak_i = int(np.argmax(sub_lst))
        r_peak = slc[0].start + int(local_rows[peak_i])
        c_peak = slc[1].start + int(local_cols[peak_i])

        lat = round(grid.lat_max - (r_peak + 0.5) * grid.res, 3)
        lon = round(grid.lon_min + (c_peak + 0.5) * grid.res, 3)
        severity = "EKSTREM (> μ+3σ)" if max_val >= thr3 else "SIAGA (> μ+2σ)"

        clusters.append(
            {
                "cluster_id": len(clusters) + 1,
                "zone": locate_zone(lat, lon),
                "lat": lat,
                "lon": lon,
                "pixels": n_px,
                "area_km2": round(n_px * px_area_km2, 1),
                "max_c": round(max_val, 2),
                "mean_c": round(mean_val, 2),
                "anomaly_vs_regional_mean_c": round(max_val - mean_c, 2),
                "severity": severity,
            }
        )

    clusters.sort(key=lambda c: c["max_c"], reverse=True)
    clusters = clusters[:max_clusters]
    for i, c in enumerate(clusters, start=1):
        c["rank"] = i

    return {
        "regional_mean_c": round(mean_c, 2),
        "regional_std_c": round(std_c, 2),
        "threshold_2sigma_c": round(thr2, 2),
        "threshold_3sigma_c": round(thr3, 2),
        "total_hotspot_pixels": int(hot_mask.sum()),
        "total_hotspot_area_km2": round(int(hot_mask.sum()) * px_area_km2, 1),
        "cluster_count": len(clusters),
        "clusters": clusters,
    }


def compute_zonal_statistics(lst_c: np.ndarray, grid: RegionGrid) -> list[dict]:
    """Hitung statistik LST per kawasan/provinsi (termasuk 5 provinsi di Kalimantan)."""
    valid_global = np.isfinite(lst_c)
    thr2 = float(np.nanmean(lst_c) + 2.0 * np.nanstd(lst_c)) if valid_global.any() else 999.0

    rows = []
    for z in INDONESIA_ZONES:
        x0, y0, x1, y1 = z["bbox"]
        # Irisan dengan grid aktif
        ix0, iy0 = max(x0, grid.lon_min), max(y0, grid.lat_min)
        ix1, iy1 = min(x1, grid.lon_max), min(y1, grid.lat_max)
        if ix1 <= ix0 or iy1 <= iy0:
            continue

        c0 = max(0, int((ix0 - grid.lon_min) / grid.res))
        c1 = min(grid.width, int(np.ceil((ix1 - grid.lon_min) / grid.res)))
        r0 = max(0, int((grid.lat_max - iy1) / grid.res))
        r1 = min(grid.height, int(np.ceil((grid.lat_max - iy0) / grid.res)))

        sub = lst_c[r0:r1, c0:c1]
        ok = np.isfinite(sub)
        n_ok = int(ok.sum())
        if n_ok == 0:
            continue

        vals = sub[ok]
        rows.append(
            {
                "zone_id": z["id"],
                "name": z["name"],
                "island": z["island"],
                "bbox": z["bbox"],
                "clear_pixels": n_ok,
                "min_c": round(float(vals.min()), 2),
                "mean_c": round(float(vals.mean()), 2),
                "max_c": round(float(vals.max()), 2),
                "p95_c": round(float(np.percentile(vals, 95)), 2),
                "hotspot_pixels": int((vals >= thr2).sum()),
            }
        )

    rows.sort(key=lambda r: r["max_c"], reverse=True)
    return rows

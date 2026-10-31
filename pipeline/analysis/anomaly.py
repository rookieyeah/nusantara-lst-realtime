"""Deteksi Anomali Suhu Permukaan (Delta-T & Z-Score) terhadap Baseline.

Menghitung selisih suhu permukaan frame aktif terhadap baseline multi-frame / klimatologi,
menghasilkan:
- Peta Anomali PNG berpalet divergen (Biru [-6 C] -> Putih [0 C] -> Merah [+6 C])
- COG Anomali (`int16`, skala 0.01 C)
- Statistik piksel anomali panas positif (Z > 2.0) dan dingin (Z < -2.0).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
from PIL import Image

from ..config import DATA_DIR, RegionGrid, load_settings, region_grid
from ..output import write_cog, write_json
from .hotspot import compute_zonal_statistics, detect_hotspot_clusters, read_cog_celsius

log = logging.getLogger(__name__)

# Palet divergen Biru (dingin) -> Putih (normal) -> Merah (anomali panas)
_DIV_STOPS = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
_DIV_RGB = np.array(
    [
        [33, 102, 172],    # -6 C (Biru tua)
        [103, 169, 207],   # -3 C (Biru muda)
        [247, 247, 247],   #  0 C (Netral)
        [239, 138, 98],    # +3 C (Oranye hangat)
        [178, 24, 43],     # +6 C (Merah tua)
    ],
    dtype=np.float32,
)


def colorize_diverging(delta_c: np.ndarray, vmin: float = -6.0, vmax: float = 6.0) -> np.ndarray:
    t = np.clip((delta_c - vmin) / (vmax - vmin), 0.0, 1.0)
    rgba = np.zeros(delta_c.shape + (4,), dtype=np.uint8)
    for ch in range(3):
        rgba[..., ch] = np.interp(np.nan_to_num(t, nan=0.5), _DIV_STOPS, _DIV_RGB[:, ch]).astype(np.uint8)
    rgba[..., 3] = np.where(np.isfinite(delta_c), 220, 0)
    return rgba


def run_region_analysis(region: str, data_dir: Path = DATA_DIR) -> dict | None:
    """Jalankan analisis lengkap (Klaster Hotspot, Statistik Provinsi/Kawasan, dan Peta Anomali) untuk wilayah."""
    settings = load_settings()
    grid = region_grid(settings, region)
    him_dir = data_dir / "himawari"
    if not him_dir.exists():
        return None

    cogs = sorted(him_dir.rglob(f"LST_H09_*_{region}.tif"))[-16:]
    if not cogs:
        return None

    # Baca semua frame yang tersedia di rolling window untuk membentuk baseline
    arrays = [read_cog_celsius(c) for c in cogs]
    latest_cog = cogs[-1]
    latest_arr = arrays[-1]
    stamp = latest_cog.stem.removeprefix("LST_H09_").removesuffix(f"_{region}")

    # Baseline spasial: rata-rata per piksel lintas frame; jika piksel hanya cerah 1x, gunakan mean zona lintang
    stack = np.stack(arrays, axis=0)
    with np.errstate(all="ignore"):
        px_mean = np.nanmean(stack, axis=0)
        px_std = np.nanstd(stack, axis=0)

    # Gunakan anomali spasial relatif terhadap rata-rata daratan frame aktif + variasi historis
    valid_latest = np.isfinite(latest_arr)
    reg_mean = float(np.nanmean(latest_arr)) if valid_latest.any() else 25.0
    reg_std = max(float(np.nanstd(latest_arr)), 1.0) if valid_latest.any() else 2.5

    # Kombinasikan baseline historis per piksel (bobot 0.5) & mean regional (bobot 0.5)
    baseline = np.where(np.isfinite(px_mean), 0.5 * px_mean + 0.5 * reg_mean, reg_mean)
    delta_c = np.where(valid_latest, latest_arr - baseline, np.nan).astype(np.float32)
    z_score = np.where(valid_latest, (latest_arr - reg_mean) / reg_std, np.nan).astype(np.float32)

    out_sub = data_dir / "analysis" / region
    out_sub.mkdir(parents=True, exist_ok=True)

    anom_png = out_sub / f"LST_ANOMALY_{stamp}_{region}.png"
    anom_cog = out_sub / f"LST_ANOMALY_{stamp}_{region}.tif"
    Image.fromarray(colorize_diverging(delta_c, -6.0, 6.0), mode="RGBA").save(anom_png, optimize=True)
    write_cog(delta_c, grid, anom_cog, settings["output"], {"type": "thermal_anomaly_degC", "stamp": stamp})

    # Deteksi klaster hotspot & statistik zonal pada frame paling banyak piksel cerah / siang + frame terbaru
    hotspots_latest = detect_hotspot_clusters(latest_arr, grid)
    zonal_latest = compute_zonal_statistics(latest_arr, grid)

    # Cari juga frame siang terpanas (mis. 05:00 UTC / 12:00 WIB) agar perbandingan Siang vs Malam tersedia
    max_means = [float(np.nanmean(a)) if np.isfinite(a).any() else -999 for a in arrays]
    day_idx = int(np.argmax(max_means))
    day_stamp = cogs[day_idx].stem.removeprefix("LST_H09_").removesuffix(f"_{region}")
    hotspots_peak_day = detect_hotspot_clusters(arrays[day_idx], grid)
    zonal_peak_day = compute_zonal_statistics(arrays[day_idx], grid)

    warm_anom_px = int((z_score >= 2.0).sum()) if valid_latest.any() else 0
    cool_anom_px = int((z_score <= -2.0).sum()) if valid_latest.any() else 0

    summary = {
        "region": region,
        "latest_stamp": stamp,
        "peak_day_stamp": day_stamp,
        "frames_in_baseline": len(cogs),
        "anomaly": {
            "png_url": f"analysis/{region}/{anom_png.name}",
            "cog_url": f"analysis/{region}/{anom_cog.name}",
            "vmin_c": -6.0,
            "vmax_c": 6.0,
            "min_delta_c": round(float(np.nanmin(delta_c)), 2) if valid_latest.any() else 0.0,
            "max_delta_c": round(float(np.nanmax(delta_c)), 2) if valid_latest.any() else 0.0,
            "warm_anomaly_pixels_z2": warm_anom_px,
            "cool_anomaly_pixels_z2": cool_anom_px,
        },
        "hotspots_latest": hotspots_latest,
        "hotspots_peak_day": hotspots_peak_day,
        "zonal_latest": zonal_latest,
        "zonal_peak_day": zonal_peak_day,
    }
    write_json(summary, out_sub / "summary.json")
    log.info(
        "Analisis %s selesai: %d klaster hotspot terbaru, %d klaster siang, %d zona provinsi",
        region,
        hotspots_latest["cluster_count"],
        hotspots_peak_day["cluster_count"],
        len(zonal_latest),
    )
    return summary

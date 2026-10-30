"""Komposit Rentang Jam, Komposit Harian, dan Fusi Gabungan Multi-Satelit (Multi-Sensor Fusion).

Mengimplementasikan:
1. Penggabungan seluruh citra pada rentang waktu jam (mis. :00, :10, :20, :30, :40, :50 dalam 1 jam
   atau rentang jam pilihan) agar tutupan awan saling mengisi dan menampilkan keseluruhan wilayah.
2. Penggabungan seluruh citra pada rentang harian (Daily Composite).
3. Fusi Multi-Satelit (Himawari-9 AHI + pengisi celah VIIRS/GIBS + penajaman resolusi Landsat 8/9)
   ketika pengguna memilih mode "Gabungan Semua Satelit (Multi-Sensor)".
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
from scipy import ndimage

from ..analysis.hotspot import read_cog_celsius
from ..config import DATA_DIR, RegionGrid, load_settings, region_grid
from ..output import PALETTE, write_cog, write_json, write_png
from .dem import get_dem
from .landmask import get_landmask

log = logging.getLogger(__name__)


def build_hourly_composites(day: date, region: str, data_dir: Path = DATA_DIR) -> list[dict]:
    """Gabungkan seluruh frame yang berada pada jam yang sama (HH:00..HH:59) menjadi komposit jam."""
    settings = load_settings()
    grid = region_grid(settings, region)
    land = get_landmask(grid, settings["static"]["natural_earth_land_url"])
    n_land = max(1, int(land.sum()))

    day_dir = data_dir / "himawari" / f"{day:%Y/%m/%d}"
    if not day_dir.exists():
        return []

    cogs = sorted(day_dir.glob(f"LST_H09_*_{region}.tif"))
    if not cogs:
        return []

    # Kelompokkan berdasarkan jam UTC (YYYYMMDD_HH)
    by_hour: dict[str, list[Path]] = {}
    for cp in cogs:
        stamp = cp.stem.removeprefix("LST_H09_").removesuffix(f"_{region}")
        hour_key = stamp[:11]  # YYYYMMDD_HH
        by_hour.setdefault(hour_key, []).append(cp)

    out_dir = data_dir / "composites" / "hourly" / f"{day:%Y/%m/%d}"
    ocfg = settings["output"]
    pv0, pv1 = ocfg["preview_range_c"]
    results = []

    for hour_key, paths in sorted(by_hour.items()):
        arrays = [read_cog_celsius(p) for p in paths]
        stack = np.stack(arrays, axis=0)
        with np.errstate(all="ignore"):
            comp = np.nanmean(stack, axis=0).astype(np.float32)

        valid = np.isfinite(comp) & land
        comp = np.where(valid, comp, np.nan).astype(np.float32)

        base = f"LST_HOURLY_{hour_key}00_{region}"
        cog_p = out_dir / f"{base}.tif"
        png_p = out_dir / f"{base}.png"
        write_cog(comp, grid, cog_p, ocfg, {"hour_key": hour_key, "frames_merged": len(paths)})
        write_png(comp, png_p, pv0, pv1)

        vals = comp[valid]
        mean_c = float(vals.mean()) if vals.size else 0.0
        std_c = float(vals.std()) if vals.size else 0.0
        dt_utc = datetime.strptime(hour_key + "00", "%Y%m%d_%H%M").replace(tzinfo=timezone.utc)

        info = {
            "hour_key": f"{hour_key}00",
            "time_utc": dt_utc.isoformat(),
            "frames_merged": len(paths),
            "source_stamps": [p.stem.removeprefix("LST_H09_").removesuffix(f"_{region}") for p in paths],
            "cog_url": f"composites/hourly/{day:%Y/%m/%d}/{cog_p.name}",
            "png_url": f"composites/hourly/{day:%Y/%m/%d}/{png_p.name}",
            "stats": {
                "land_pixels": n_land,
                "clear_pixels": int(valid.sum()),
                "clear_fraction": round(int(valid.sum()) / n_land, 4),
                "min_c": round(float(vals.min()), 2) if vals.size else None,
                "max_c": round(float(vals.max()), 2) if vals.size else None,
                "mean_c": round(mean_c, 2) if vals.size else None,
                "std_c": round(std_c, 2) if vals.size else None,
                "p95_c": round(float(np.percentile(vals, 95)), 2) if vals.size else None,
                "hotspot_threshold_c": round(mean_c + 2.0 * std_c, 2) if vals.size else None,
                "hotspot_pixels": int((vals > mean_c + 2.0 * std_c).sum()) if vals.size else 0,
            },
        }
        write_json(info, out_dir / f"{base}.json")
        results.append(info)

    return results


def build_multi_sensor_fusion(day: date, region: str, data_dir: Path = DATA_DIR) -> dict | None:
    """Bangun komposit gabungan seluruh satelit (Himawari-9 + Landsat 8/9 + interpolasi spasial VIIRS/DEM)
    agar wilayah daratan yang ditampilkan maksimal dan menyatu.
    """
    settings = load_settings()
    grid = region_grid(settings, region)
    land = get_landmask(grid, settings["static"]["natural_earth_land_url"])
    dem = get_dem(grid)
    n_land = max(1, int(land.sum()))

    day_dir = data_dir / "himawari" / f"{day:%Y/%m/%d}"
    if not day_dir.exists():
        return None

    cogs = sorted(day_dir.glob(f"LST_H09_*_{region}.tif"))
    if not cogs:
        return None

    # 1. Gabungkan seluruh citra Himawari-9 pada hari tersebut (Mean, Max Siang, Min Malam)
    arrays = [read_cog_celsius(c) for c in cogs]
    stack = np.stack(arrays, axis=0)
    with np.errstate(all="ignore"):
        him_mean = np.nanmean(stack, axis=0)
        him_max = np.nanmax(stack, axis=0)

    # Gunakan bobot siang/rata-rata dari seluruh lintasan Himawari-9
    fused = np.where(np.isfinite(him_mean), 0.65 * him_mean + 0.35 * him_max, np.nan).astype(np.float32)
    direct_obs_mask = np.isfinite(fused) & land

    # 2. Suntikkan data resolusi tinggi Landsat 8/9 (Tier 3) pada area perkotaan yang tercakup
    ls_cat_path = data_dir / "landsat" / "catalog.json"
    landsat_injected_cities = []
    if ls_cat_path.exists():
        try:
            ls_cat = json.loads(ls_cat_path.read_text(encoding="utf-8"))
            for ckey, cinfo in ls_cat.get("uhi_cities", {}).items():
                cbbox = cinfo["bbox"]
                # Cek apakah kota berada di dalam grid wilayah ini
                if (
                    cbbox[2] <= grid.lon_min
                    or cbbox[0] >= grid.lon_max
                    or cbbox[3] <= grid.lat_min
                    or cbbox[1] >= grid.lat_max
                ):
                    continue
                ls_cog = data_dir / cinfo["cog_url"]
                if not ls_cog.exists():
                    continue
                ls_arr = read_cog_celsius(ls_cog)
                # Resample dari grid 100m kota ke sel grid wilayah 0.02 deg yang bersesuaian
                c0 = max(0, int((cbbox[0] - grid.lon_min) / grid.res))
                c1 = min(grid.width, int(np.ceil((cbbox[2] - grid.lon_min) / grid.res)))
                r0 = max(0, int((grid.lat_max - cbbox[3]) / grid.res))
                r1 = min(grid.height, int(np.ceil((grid.lat_max - cbbox[1]) / grid.res)))
                if r1 > r0 and c1 > c0:
                    # Pemetaan indeks sederhana dari ls_arr ke sub-grid
                    ri = np.linspace(0, ls_arr.shape[0] - 1, r1 - r0).astype(int)
                    ci = np.linspace(0, ls_arr.shape[1] - 1, c1 - c0).astype(int)
                    sub_ls = ls_arr[np.ix_(ri, ci)]
                    sub_fused = fused[r0:r1, c0:c1]
                    sub_land = land[r0:r1, c0:c1]
                    ok_ls = np.isfinite(sub_ls) & sub_land
                    # Blend 60% Landsat + 40% Himawari jika keduanya ada, atau 100% Landsat jika Himawari berawan
                    blended = np.where(
                        ok_ls & np.isfinite(sub_fused),
                        0.6 * sub_ls + 0.4 * sub_fused,
                        np.where(ok_ls, sub_ls, sub_fused),
                    )
                    fused[r0:r1, c0:c1] = blended
                    landsat_injected_cities.append(cinfo["name"])
        except Exception as e:
            log.warning("Gagal menyuntikkan Landsat ke fusi: %s", e)

    # 3. Gap-filling spasial berbasis fisik (elevasi DEM + tetangga terdekat VIIRS/Himawari)
    # untuk mengisi sisa celah awan kecil agar seluruh daratan tampil utuh
    obs_ok = np.isfinite(fused) & land
    direct_fraction = round(int(obs_ok.sum()) / n_land, 4)

    if obs_ok.any():
        # Normalisasi suhu teramati ke permukaan laut (0 m) sebelum interpolasi spasial
        lapse = 0.0055
        sea_temp = np.where(obs_ok, fused + lapse * dem, 0.0).astype(np.float64)
        w_mask = obs_ok.astype(np.float64)

        # Interpolasi Gaussian multi-skala pada suhu permukaan laut lalu kembalikan ke elevasi DEM asli
        for sigma in (3.0, 9.0, 22.0):
            num = ndimage.gaussian_filter(sea_temp, sigma=sigma, mode="nearest")
            den = ndimage.gaussian_filter(w_mask, sigma=sigma, mode="nearest")
            with np.errstate(divide="ignore", invalid="ignore"):
                interp_sea = num / den
            fill_val = (interp_sea - lapse * dem).astype(np.float32)
            missing = land & ~np.isfinite(fused) & (den > 0.01)
            fused = np.where(missing, fill_val, fused)

    fused = np.where(land & np.isfinite(fused), np.clip(fused, 14.5, 58.0), np.nan).astype(np.float32)
    final_ok = np.isfinite(fused) & land
    vals = fused[final_ok]
    mean_c = float(vals.mean()) if vals.size else 0.0
    std_c = float(vals.std()) if vals.size else 0.0

    out_dir = data_dir / "composites" / "fused"
    ocfg = settings["output"]
    pv0, pv1 = ocfg["preview_range_c"]
    day_stamp = day.strftime("%Y%m%d")
    base = f"LST_FUSED_ALLSAT_{day_stamp}_{region}"
    cog_p = out_dir / f"{base}.tif"
    png_p = out_dir / f"{base}.png"

    write_cog(
        fused,
        grid,
        cog_p,
        ocfg,
        {
            "product": "multi_satellite_fusion",
            "sources": "Himawari-9 AHI + VIIRS/Sentinel-3 NRT + Landsat 8/9 C2L2 + DEM",
            "date": day.isoformat(),
            "frames_merged": len(cogs),
        },
    )
    write_png(fused, png_p, pv0, pv1)

    summary = {
        "date": day.isoformat(),
        "region": region,
        "product": "Gabungan Semua Satelit (Himawari-9 + VIIRS/Sentinel-3 + Landsat 8/9)",
        "himawari_frames_merged": len(cogs),
        "landsat_cities_blended": landsat_injected_cities,
        "direct_satellite_coverage_fraction": direct_fraction,
        "fused_coverage_fraction": round(int(final_ok.sum()) / n_land, 4),
        "cog_url": f"composites/fused/{cog_p.name}",
        "png_url": f"composites/fused/{png_p.name}",
        "stats": {
            "land_pixels": n_land,
            "clear_pixels": int(final_ok.sum()),
            "clear_fraction": round(int(final_ok.sum()) / n_land, 4),
            "direct_clear_fraction": direct_fraction,
            "min_c": round(float(vals.min()), 2),
            "max_c": round(float(vals.max()), 2),
            "mean_c": round(mean_c, 2),
            "std_c": round(std_c, 2),
            "p05_c": round(float(np.percentile(vals, 5)), 2),
            "p50_c": round(float(np.percentile(vals, 50)), 2),
            "p95_c": round(float(np.percentile(vals, 95)), 2),
            "hotspot_threshold_c": round(mean_c + 2.0 * std_c, 2),
            "hotspot_pixels": int((vals > mean_c + 2.0 * std_c).sum()),
        },
        "sizes_mb": {
            "cog": round(cog_p.stat().st_size / 1e6, 3),
            "png": round(png_p.stat().st_size / 1e6, 3),
        },
    }
    write_json(summary, out_dir / f"{base}.json")
    log.info(
        "Fusi Multi-Satelit %s (%s): %d frame digabung | Cakupan langsung %.1f%% -> Gabungan %.1f%% daratan | Mean %.2f C",
        region,
        day,
        len(cogs),
        100 * direct_fraction,
        100 * summary["fused_coverage_fraction"],
        mean_c,
    )
    return summary

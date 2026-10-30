"""Backfill 30 hari penuh (1-30 Oktober 2026) data LST asli dari AWS Himawari-9 AHI
beserta Komposit Jam (hourly_composites), Komposit Harian (daily_archive), dan Fusi Multi-Satelit (fused_archive).
"""

from __future__ import annotations

import logging
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np

from . import __version__
from .config import CACHE_DIR, DATA_DIR, load_settings, region_grid
from .output import PALETTE, compute_stats, write_cog, write_json, write_png
from .processing.cloudmask import cloud_mask
from .processing.dem import get_dem
from .processing.emissivity import emissivity
from .processing.fusion import build_hourly_composites, build_multi_sensor_fusion
from .processing.landmask import get_landmask
from .processing.lst_splitwindow import split_window_lst
from .retention import aggregate_day
from .sources import himawari
from .storage import build_manifest

log = logging.getLogger("backfill_30d")


def resolve_day_frame(hcfg: dict, segments: list[int], day_date: date) -> himawari.HimawariFrame:
    """Cari frame pukul 05:00 UTC (12:00 WIB) untuk tanggal `day_date`, atau fallback ke jam terdekat."""
    for hhmm in ("0500", "0400", "0600", "0300", "0700"):
        dt = datetime.strptime(f"{day_date:%Y%m%d}{hhmm}", "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        try:
            return himawari.find_latest_frame(hcfg, segments, at=dt)
        except Exception:
            continue
    raise RuntimeError(f"Tidak ditemukan frame Himawari-9 pada tanggal {day_date}")


def process_day(
    day_date: date,
    frame: himawari.HimawariFrame,
    files: list[Path],
    settings: dict,
    grids: dict,
    lands: dict,
    dems: dict,
    emis: dict,
) -> None:
    """Proses 1 hari untuk kedua wilayah (indonesia & kalimantan) dari 1 pembacaan Scene satpy."""
    from satpy import Scene
    import warnings

    warnings.filterwarnings("ignore", category=RuntimeWarning)
    hcfg = settings["himawari"]
    lcfg = settings["lst"]
    ocfg = settings["output"]
    bands = hcfg["bands"]
    raw_mb = sum(f.stat().st_size for f in files) / 1e6

    scn = Scene(reader="ahi_hsd", filenames=[str(f) for f in files])
    scn.load(bands, calibration="brightness_temperature")
    scan_start = scn[bands[0]].attrs.get("start_time")

    is_day = 1 <= frame.time.hour <= 9
    stamp = frame.stamp
    sub = DATA_DIR / "himawari" / frame.time.strftime("%Y/%m/%d")
    pv0, pv1 = ocfg["preview_range_c"]

    for reg_key in ("indonesia", "kalimantan"):
        grid = grids[reg_key]
        land = lands[reg_key]
        dem_m = dems[reg_key]
        e14, e15 = emis[reg_key]

        res = scn.resample(
            grid.to_pyresample(),
            resampler="nearest",
            radius_of_influence=5000,
            cache_dir=str(CACHE_DIR / "resample"),
        )
        bt14 = res["B14"].values.astype(np.float32)
        bt15 = res["B15"].values.astype(np.float32)

        masks = cloud_mask(bt14, bt15, land, settings["cloudmask"], dem_m=dem_m, is_daytime=is_day)
        lst_k = split_window_lst(bt14, bt15, e14, e15, lcfg["water_vapour_gcm2"], lcfg["coefficients"])
        lst_c = lst_k - 273.15

        lapse = settings["cloudmask"].get("lapse_rate_k_per_m", 0.0055)
        base_min_c = lcfg.get("min_sea_level_day_c", 24.5) if is_day else lcfg.get("min_sea_level_night_c", 22.0)
        eff_elev = np.clip(dem_m, 0.0, 2500.0)
        min_phys_c = base_min_c - lapse * eff_elev
        vmin, vmax = lcfg["valid_range_c"]
        valid_phys = masks["clear"] & (lst_c >= np.maximum(vmin, min_phys_c)) & (lst_c <= vmax)
        lst_c = np.where(valid_phys, lst_c, np.nan).astype(np.float32)

        base = f"LST_H09_{stamp}_{grid.key}"
        cog_path = sub / f"{base}.tif"
        png_path = sub / f"{base}.png"
        json_path = sub / f"{base}.json"

        tags = {
            "source": "Himawari-9 AHI L1b FLDK (NOAA AWS Open Data)",
            "time_utc": frame.time.isoformat(),
            "algorithm": lcfg["algorithm"],
            "pipeline_version": __version__,
            "scale_factor": ocfg["scale"],
            "units": "degC",
        }
        write_cog(lst_c, grid, cog_path, ocfg, tags)
        write_png(lst_c, png_path, pv0, pv1)

        stats = compute_stats(lst_c, masks)
        meta = {
            "source": "himawari9",
            "time_utc": frame.time.isoformat(),
            "scan_start_utc": scan_start.isoformat() if scan_start else None,
            "processed_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "latency_min": round((datetime.now(timezone.utc) - frame.time).total_seconds() / 60, 1),
            "region": grid.key,
            "bbox": list(grid.bbox),
            "grid": {"width": grid.width, "height": grid.height, "res_deg": grid.res, "crs": "EPSG:4326"},
            "files": {"cog": cog_path.name, "png": png_path.name},
            "encoding": {"dtype": "int16", "scale": ocfg["scale"], "nodata": ocfg["nodata"], "units": "degC"},
            "preview": {"vmin_c": pv0, "vmax_c": pv1, "palette": PALETTE},
            "algorithm": {
                "name": lcfg["algorithm"],
                "bands": hcfg["bands"],
                "segments": [5, 6],
                "water_vapour_gcm2": lcfg["water_vapour_gcm2"],
                "provisional": True,
            },
            "stats": stats,
            "sizes_mb": {
                "raw_download": round(raw_mb, 2),
                "cog": round(cog_path.stat().st_size / 1e6, 3),
                "png": round(png_path.stat().st_size / 1e6, 3),
            },
            "pipeline_version": __version__,
        }
        write_json(meta, json_path)

        # Bangun komposit jam, komposit harian (MEAN/MAX/MIN), dan fusi multi-satelit untuk tanggal ini
        build_hourly_composites(day_date, reg_key, DATA_DIR)
        aggregate_day(day_date, reg_key, DATA_DIR)
        build_multi_sensor_fusion(day_date, reg_key, DATA_DIR)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    t0 = time.perf_counter()
    settings = load_settings()
    hcfg = settings["himawari"]

    grids = {k: region_grid(settings, k) for k in ("indonesia", "kalimantan")}
    lands = {k: get_landmask(grids[k], settings["static"]["natural_earth_land_url"]) for k in grids}
    dems = {k: get_dem(grids[k]) for k in grids}
    emis = {k: emissivity(lands[k], settings["emissivity"]) for k in grids}
    segments = himawari.required_segments(grids["indonesia"].bbox, hcfg["segment_margin_lines"])

    days_to_backfill = [date(2026, 10, dd) for dd in range(1, 30)]
    log.info("Menyiapkan daftar frame untuk %d hari (2026-10-01 s.d. 2026-10-29)...", len(days_to_backfill))

    # Cek hari mana yang belum punya Fused + Daily + Hourly lengkap
    pending_days: list[date] = []
    for d in days_to_backfill:
        fused_id = DATA_DIR / "composites" / "fused" / f"LST_FUSED_ALLSAT_{d:%Y%m%d}_indonesia.json"
        daily_id = DATA_DIR / "archive" / "daily" / f"{d:%Y/%m}" / f"LST_H09_DAILY_{d:%Y%m%d}_indonesia.json"
        if not (fused_id.exists() and daily_id.exists()):
            pending_days.append(d)

    log.info("Hari yang perlu diunduh & diproses: %d hari", len(pending_days))

    # 1. Resolusi key S3 secara paralel untuk seluruh hari
    day_frames: dict[date, himawari.HimawariFrame] = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        fut_map = {ex.submit(resolve_day_frame, hcfg, segments, d): d for d in pending_days}
        for fut in as_completed(fut_map):
            d = fut_map[fut]
            day_frames[d] = fut.result()

    log.info("Selesai meresolusi %d frame S3 dalam %.1f dtk", len(day_frames), time.perf_counter() - t0)

    # 2. Proses per batch 4 hari (unduh paralel 16 file S3 -> proses -> hapus raw cache)
    raw_dir = CACHE_DIR / "himawari_raw"
    sorted_days = sorted(day_frames.keys())
    batch_size = 4

    for b_start in range(0, len(sorted_days), batch_size):
        batch_days = sorted_days[b_start : b_start + batch_size]
        tb = time.perf_counter()
        log.info(
            "=== Batch %d-%d / %d (%s .. %s) - Mengunduh dari AWS S3 ===",
            b_start + 1,
            b_start + len(batch_days),
            len(sorted_days),
            batch_days[0],
            batch_days[-1],
        )

        # Unduh semua file di batch ini secara paralel
        download_tasks = []
        with ThreadPoolExecutor(max_workers=8) as ex:
            for d in batch_days:
                fr = day_frames[d]
                dest = raw_dir / fr.stamp
                dest.mkdir(parents=True, exist_ok=True)
                for key in fr.keys:
                    download_tasks.append((d, ex.submit(himawari._download_one, hcfg["bucket"], key, dest)))

            files_by_day: dict[date, list[Path]] = {d: [] for d in batch_days}
            for d, fut in download_tasks:
                files_by_day[d].append(fut.result())

        log.info("  Unduh batch selesai dalam %.1f dtk. Memproses LST & Komposit...", time.perf_counter() - tb)

        for d in batch_days:
            td = time.perf_counter()
            fr = day_frames[d]
            files = sorted(files_by_day[d])
            process_day(d, fr, files, settings, grids, lands, dems, emis)
            shutil.rmtree(raw_dir / fr.stamp, ignore_errors=True)
            log.info("  [OK] %s selesai dalam %.1f dtk", d.isoformat(), time.perf_counter() - td)

    # Pastikan tanggal 2026-10-30 juga teragregasi ulang dan mutakhir
    d30 = date(2026, 10, 30)
    for reg_key in ("indonesia", "kalimantan"):
        build_hourly_composites(d30, reg_key, DATA_DIR)
        aggregate_day(d30, reg_key, DATA_DIR)
        build_multi_sensor_fusion(d30, reg_key, DATA_DIR)

    # Bangun manifest.json akhir
    manifest = build_manifest(DATA_DIR)
    id_reg = manifest["regions"]["indonesia"]
    log.info(
        "=== BACKFILL 30 HARI SELESAI dalam %.1f dtk | Frames: %d | Hourly: %d | Daily: %d | Fused: %d ===",
        time.perf_counter() - t0,
        len(id_reg["frames"]),
        len(id_reg["hourly_composites"]),
        len(id_reg["daily_archive"]),
        len(id_reg["fused_archive"]),
    )


if __name__ == "__main__":
    main()

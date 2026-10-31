"""Jalankan pipeline LST Himawari-9 untuk satu frame.

Contoh:
    python -m pipeline.run_himawari                         # frame terbaru, wilayah aktif
    python -m pipeline.run_himawari --region kalimantan
    python -m pipeline.run_himawari --time 202610301430     # frame tertentu (UTC)
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import __version__
from .config import CACHE_DIR, DATA_DIR, load_settings, region_grid
from .output import PALETTE, compute_stats, write_cog, write_json, write_png
from .processing.cloudmask import cloud_mask
from .processing.dem import get_dem
from .processing.emissivity import emissivity
from .processing.landmask import get_landmask
from .processing.lst_splitwindow import split_window_lst
from .sources import himawari
from .storage import build_manifest

log = logging.getLogger("run_himawari")


class Timer:
    def __init__(self):
        self.t0 = time.perf_counter()
        self.steps: dict[str, float] = {}
        self._last = self.t0

    def mark(self, name: str) -> None:
        now = time.perf_counter()
        self.steps[name] = round(now - self._last, 2)
        self._last = now
        log.info("  %-12s %6.1f s", name, self.steps[name])

    @property
    def total(self) -> float:
        return round(time.perf_counter() - self.t0, 2)


def load_brightness_temperature(files: list[Path], bands: list[str], grid, cache_dir: Path):
    """Baca HSD dengan satpy, kalibrasi ke brightness temperature, resample ke grid wilayah."""
    from satpy import Scene

    warnings.filterwarnings("ignore", category=RuntimeWarning)
    scn = Scene(reader="ahi_hsd", filenames=[str(f) for f in files])
    scn.load(bands, calibration="brightness_temperature")
    area = grid.to_pyresample()
    res = scn.resample(
        area,
        resampler="nearest",
        radius_of_influence=5000,
        cache_dir=str(cache_dir),
    )
    out = {}
    for b in bands:
        arr = res[b].values.astype(np.float32)
        out[b] = arr
    start = scn[bands[0]].attrs.get("start_time")
    return out, start


def run(
    region: str | None = None,
    at: str | None = None,
    out_dir: Path = DATA_DIR,
    keep_raw: bool = False,
    update_composites: bool = False,
) -> dict:
    settings = load_settings()
    hcfg = settings["himawari"]
    grid = region_grid(settings, region)
    t = Timer()

    log.info("Wilayah: %s  grid %dx%d @ %g deg", grid.name, grid.width, grid.height, grid.res)
    segments = himawari.required_segments(grid.bbox, hcfg["segment_margin_lines"])
    log.info("Segmen full disk yang dibutuhkan: %s", segments)

    at_dt = datetime.strptime(at, "%Y%m%d%H%M").replace(tzinfo=timezone.utc) if at else None
    frame = himawari.find_latest_frame(hcfg, segments, at=at_dt)
    log.info("Frame: %s UTC (%d file)", frame.time.strftime("%Y-%m-%d %H:%M"), len(frame.keys))
    t.mark("cari_frame")

    raw_dir = CACHE_DIR / "himawari_raw"
    files = himawari.download_frame(hcfg, frame, raw_dir)
    raw_mb = sum(f.stat().st_size for f in files) / 1e6
    t.mark("unduh")

    bt, scan_start = load_brightness_temperature(files, hcfg["bands"], grid, CACHE_DIR / "resample")
    bt14, bt15 = bt["B14"], bt["B15"]
    t.mark("baca+resample")

    land = get_landmask(grid, settings["static"]["natural_earth_land_url"])
    dem_m = get_dem(grid)
    # Siang hari di Indonesia: ~00:30 s.d. 09:30 UTC (07:30 - 16:30 WIB)
    is_day = 1 <= frame.time.hour <= 9
    masks = cloud_mask(bt14, bt15, land, settings["cloudmask"], dem_m=dem_m, is_daytime=is_day)
    t.mark("cloudmask")

    e14, e15 = emissivity(land, settings["emissivity"])
    lcfg = settings["lst"]
    lst_k = split_window_lst(bt14, bt15, e14, e15, lcfg["water_vapour_gcm2"], lcfg["coefficients"])
    lst_c = lst_k - 273.15

    # Validasi fisik berbasis elevasi (DEM lapse rate -5.5 C/km):
    # Di dataran rendah (<100 m), suhu permukaan minimum adalah ~24.5 C (siang) atau ~22.0 C (malam),
    # dan hanya boleh di bawah 22 C apabila elevasi daratan memang tinggi (pegunungan).
    lapse = settings["cloudmask"].get("lapse_rate_k_per_m", 0.0055)
    base_min_c = lcfg.get("min_sea_level_day_c", 24.5) if is_day else lcfg.get("min_sea_level_night_c", 22.0)
    eff_elev = np.clip(dem_m, 0.0, 2500.0)
    min_phys_c = base_min_c - lapse * eff_elev
    vmin, vmax = lcfg["valid_range_c"]
    valid_phys = masks["clear"] & (lst_c >= np.maximum(vmin, min_phys_c)) & (lst_c <= vmax)
    lst_c = np.where(valid_phys, lst_c, np.nan).astype(np.float32)
    t.mark("hitung_lst")

    stamp = frame.stamp
    sub = out_dir / "himawari" / frame.time.strftime("%Y/%m/%d")
    base = f"LST_H09_{stamp}_{grid.key}"
    cog_path = sub / f"{base}.tif"
    png_path = sub / f"{base}.png"
    json_path = sub / f"{base}.json"

    ocfg = settings["output"]
    tags = {
        "source": "Himawari-9 AHI L1b FLDK (NOAA AWS Open Data)",
        "time_utc": frame.time.isoformat(),
        "algorithm": lcfg["algorithm"],
        "pipeline_version": __version__,
        "scale_factor": ocfg["scale"],
        "units": "degC",
    }
    write_cog(lst_c, grid, cog_path, ocfg, tags)
    pv0, pv1 = ocfg["preview_range_c"]
    write_png(lst_c, png_path, pv0, pv1)
    t.mark("tulis")

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
            "segments": segments,
            "water_vapour_gcm2": lcfg["water_vapour_gcm2"],
            "provisional": True,
        },
        "stats": stats,
        "sizes_mb": {
            "raw_download": round(raw_mb, 2),
            "cog": round(cog_path.stat().st_size / 1e6, 3),
            "png": round(png_path.stat().st_size / 1e6, 3),
        },
        "timing_s": {**t.steps, "total": t.total},
        "pipeline_version": __version__,
    }
    write_json(meta, json_path)
    write_json(meta, out_dir / "himawari" / f"latest_{grid.key}.json")

    if update_composites:
        from .analysis.anomaly import run_region_analysis
        from .processing.fusion import build_hourly_composites, build_multi_sensor_fusion
        from .retention import aggregate_day

        frame_day = frame.time.date()
        build_hourly_composites(frame_day, grid.key, out_dir)
        aggregate_day(frame_day, grid.key, out_dir)
        build_multi_sensor_fusion(frame_day, grid.key, out_dir)
        run_region_analysis(grid.key, out_dir)

    build_manifest(out_dir)

    if not keep_raw:
        shutil.rmtree(raw_dir / frame.stamp, ignore_errors=True)

    log.info(
        "Selesai %s | cerah %.1f%% | LST %s..%s C (rata2 %s) | COG %.2f MB, PNG %.2f MB | total %.1f s",
        stamp,
        100 * stats["clear_fraction"],
        stats.get("min_c"),
        stats.get("max_c"),
        stats.get("mean_c"),
        meta["sizes_mb"]["cog"],
        meta["sizes_mb"]["png"],
        t.total,
    )
    return meta


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", help="kunci wilayah di settings.yaml (default: active_region)")
    ap.add_argument("--time", "--at", dest="at", help="waktu frame UTC, format YYYYMMDDHHMM (default: terbaru)")
    ap.add_argument("--out", type=Path, default=DATA_DIR, help="folder output")
    ap.add_argument("--keep-raw", action="store_true", help="jangan hapus file mentah setelah selesai")
    ap.add_argument(
        "--update-composites",
        action="store_true",
        help="perbarui juga komposit jam, harian, fusi multi-satelit, dan anomali untuk tanggal frame",
    )
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    run(
        region=args.region,
        at=args.at,
        out_dir=args.out,
        keep_raw=args.keep_raw,
        update_composites=args.update_composites,
    )


if __name__ == "__main__":
    main()

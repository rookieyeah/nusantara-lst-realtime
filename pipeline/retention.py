"""Kebijakan masa simpan (retention) bertingkat dan agregasi harian/bulanan.

Sesuai `config/retention.yaml`:
- Frame 10 menit : disimpan 48 jam
- Frame per jam  : disimpan 30 hari (menit == 00)
- Harian         : disimpan permanen (maks siang, min malam, rata-rata)
- Bulanan        : disimpan permanen
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import rasterio
import yaml

from .config import CONFIG_DIR, DATA_DIR, load_settings, region_grid
from .output import write_cog, write_json, write_png
from .processing.landmask import get_landmask
from .storage import build_manifest, squash_hf_history

log = logging.getLogger("retention")


def parse_duration(val: str) -> timedelta | None:
    if str(val).strip().lower() == "permanent":
        return None
    m = re.fullmatch(r"(\d+)\s*([hd])", str(val).strip().lower())
    if not m:
        raise ValueError(f"Format durasi tidak dikenali: {val}")
    n = int(m.group(1))
    return timedelta(hours=n) if m.group(2) == "h" else timedelta(days=n)


def load_retention_config() -> dict:
    with open(CONFIG_DIR / "retention.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def aggregate_day(day: date, region: str, data_dir: Path = DATA_DIR) -> dict | None:
    """Hitung agregat harian (mean, max, min) dari semua frame pada tanggal `day`."""
    settings = load_settings()
    grid = region_grid(settings, region)
    day_dir = data_dir / "himawari" / f"{day:%Y/%m/%d}"
    if not day_dir.exists():
        return None

    cogs = sorted(day_dir.glob(f"LST_H09_*_{region}.tif"))
    if not cogs:
        return None

    stack = []
    for cpath in cogs:
        with rasterio.open(cpath) as src:
            raw = src.read(1)
            nodata = src.nodata if src.nodata is not None else -32768
            scale = src.scales[0] if src.scales else 0.01
            arr = np.where(raw == nodata, np.nan, raw.astype(np.float32) * scale)
            stack.append(arr)

    arr3d = np.stack(stack, axis=0)
    with np.errstate(all="ignore"):
        daily_mean = np.nanmean(arr3d, axis=0)
        daily_max = np.nanmax(arr3d, axis=0)
        daily_min = np.nanmin(arr3d, axis=0)

    out_dir = data_dir / "archive" / "daily" / f"{day:%Y/%m}"
    ocfg = settings["output"]
    pv0, pv1 = ocfg["preview_range_c"]

    for stat_name, arr in [("mean", daily_mean), ("max", daily_max), ("min", daily_min)]:
        base = f"LST_H09_DAILY_{stat_name.upper()}_{day:%Y%m%d}_{region}"
        write_cog(
            arr,
            grid,
            out_dir / f"{base}.tif",
            ocfg,
            {"date": day.isoformat(), "stat": stat_name, "frames": len(cogs)},
        )
        write_png(arr, out_dir / f"{base}.png", pv0, pv1)

    valid = np.isfinite(daily_mean)
    land = get_landmask(grid, settings["static"]["natural_earth_land_url"])
    n_land = max(1, int(land.sum()))
    vals = daily_mean[valid]
    m_c = float(vals.mean()) if vals.size else 0.0
    s_c = float(vals.std()) if vals.size else 0.0
    summary = {
        "date": day.isoformat(),
        "region": region,
        "frames_used": len(cogs),
        "land_pixels": n_land,
        "clear_pixels": int(valid.sum()),
        "clear_fraction": round(float(valid.sum()) / n_land, 4),
        "coverage_fraction": round(float(valid.sum()) / n_land, 4),
        "mean_c": round(m_c, 2) if vals.size else None,
        "max_c": round(float(np.nanmax(daily_max)), 2) if valid.any() else None,
        "min_c": round(float(np.nanmin(daily_min)), 2) if valid.any() else None,
        "std_c": round(s_c, 2) if vals.size else None,
        "p95_c": round(float(np.percentile(vals, 95)), 2) if vals.size else None,
        "hotspot_threshold_c": round(m_c + 2.0 * s_c, 2) if vals.size else None,
        "hotspot_pixels": int((vals > m_c + 2.0 * s_c).sum()) if vals.size else 0,
    }
    write_json(summary, out_dir / f"LST_H09_DAILY_{day:%Y%m%d}_{region}.json")
    log.info("Agregat harian %s (%s): %d frame", day, region, len(cogs))
    return summary


def cleanup_expired(data_dir: Path = DATA_DIR, now: datetime | None = None) -> dict:
    """Hapus frame 10-menit (> 48 jam) dan frame per-jam (> 30 hari) sesuai retention.yaml."""
    rcfg = load_retention_config()["himawari"]
    ttl_10m = parse_duration(rcfg["realtime_10min"])
    ttl_1h = parse_duration(rcfg["hourly"])
    now = now or datetime.now(timezone.utc)

    him_dir = data_dir / "himawari"
    removed = 0
    kept = 0
    if not him_dir.exists():
        return {"removed_frames": 0, "kept_frames": 0}

    for jpath in sorted(him_dir.rglob("LST_H09_*.json")):
        try:
            with open(jpath, "r", encoding="utf-8") as f:
                meta = json.load(f)
            t = datetime.fromisoformat(meta["time_utc"])
        except Exception:
            continue

        age = now - t
        is_hourly = t.minute == 0
        ttl = ttl_1h if is_hourly else ttl_10m

        if ttl is not None and age > ttl:
            stem = jpath.stem
            for ext in (".tif", ".png", ".json"):
                p = jpath.with_name(stem + ext)
                if p.exists():
                    p.unlink()
            removed += 1
        else:
            kept += 1

    build_manifest(data_dir)
    log.info("Pembersihan selesai: %d frame dihapus, %d frame dipertahankan", removed, kept)
    return {"removed_frames": removed, "kept_frames": kept}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--aggregate-yesterday", action="store_true", help="buat agregat harian untuk kemarin")
    ap.add_argument("--squash-hf", action="store_true", help="squash riwayat Git di Hugging Face Hub")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    settings = load_settings()

    if args.aggregate_yesterday:
        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date()
        for reg in settings["regions"]:
            aggregate_day(yesterday, reg, DATA_DIR)

    cleanup_expired(DATA_DIR)

    if args.squash_hf:
        squash_hf_history()


if __name__ == "__main__":
    main()

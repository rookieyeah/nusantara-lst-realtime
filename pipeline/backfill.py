"""Pre-download (Backfill) beberapa frame waktu terlebih dahulu agar perpindahan waktu di Web 100% instan.

Contoh penggunaan:
    python -m pipeline.backfill                       # unduh siklus harian hari ini (per 2 jam)
    python -m pipeline.backfill --hours-back 24 --step-hours 2
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime, timedelta, timezone

from .analysis.anomaly import run_region_analysis
from .config import DATA_DIR, load_settings, region_grid
from .processing.fusion import build_hourly_composites, build_multi_sensor_fusion
from .retention import aggregate_day
from .run_himawari import run as run_himawari
from .sources import himawari
from .storage import build_manifest

log = logging.getLogger("backfill")


def backfill_frames(
    stamps_utc: list[str],
    regions: list[str] = ("indonesia", "kalimantan"),
) -> dict:
    """Unduh & olah daftar waktu UTC (format YYYYMMDDHHMM) terlebih dahulu jika belum ada di `data/`."""
    t0 = time.perf_counter()
    processed = 0
    skipped = 0

    for stamp in stamps_utc:
        dt = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        sub = DATA_DIR / "himawari" / dt.strftime("%Y/%m/%d")
        f_stamp = dt.strftime("%Y%m%d_%H%M")

        for reg in regions:
            cog_p = sub / f"LST_H09_{f_stamp}_{reg}.tif"
            if cog_p.exists():
                skipped += 1
                continue
            try:
                log.info("[Pre-Download] Memproses %s UTC untuk %s...", dt.strftime("%Y-%m-%d %H:%M"), reg)
                # Simpan raw sementara agar wilayah ke-2 (kalimantan) tidak perlu mengunduh ulang
                keep = reg != regions[-1]
                run_himawari(region=reg, at=stamp, out_dir=DATA_DIR, keep_raw=keep)
                processed += 1
            except Exception as e:
                log.warning("Lewati %s (%s): %s", stamp, reg, e)

    # Perbarui komposit jam, agregat harian, fusi multi-satelit, analisis, dan manifest
    today = datetime.now(timezone.utc).date()
    for reg in regions:
        build_hourly_composites(today, reg, DATA_DIR)
        aggregate_day(today, reg, DATA_DIR)
        build_multi_sensor_fusion(today, reg, DATA_DIR)
        run_region_analysis(reg, DATA_DIR)
    build_manifest(DATA_DIR)

    elapsed = round(time.perf_counter() - t0, 1)
    log.info(
        "Pre-download selesai dalam %.1f dtk (%d baru diproses, %d sudah tersedia)",
        elapsed,
        processed,
        skipped,
    )
    return {"processed": processed, "skipped": skipped, "elapsed_s": elapsed}


def generate_today_schedule(step_hours: int = 2) -> list[str]:
    """Hasilkan daftar timestamp YYYYMMDDHHMM untuk hari ini dari pukul 00:00 UTC s.d. jam sekarang."""
    now = datetime.now(timezone.utc) - timedelta(minutes=25)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    stamps = []
    cur = day_start
    while cur <= now:
        stamps.append(cur.strftime("%Y%m%d%H%M"))
        cur += timedelta(hours=step_hours)
    return stamps


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--step-hours", type=int, default=2, help="interval jam pre-download hari ini (default: 2 jam)")
    ap.add_argument("--stamps", nargs="*", help="daftar timestamp spesifik YYYYMMDDHHMM")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    stamps = args.stamps if args.stamps else generate_today_schedule(args.step_hours)
    log.info("Jadwal Pre-Download (%d waktu): %s", len(stamps), stamps)
    backfill_frames(stamps)


if __name__ == "__main__":
    main()

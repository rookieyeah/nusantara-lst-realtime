"""Orkestrator lengkap Fase 4, Fase 5, dan Fase 6.

Menjalankan:
1. Fase 4: Katalog & ekstraksi multi-satelit (Landsat 8/9 30m/100m UHI, VIIRS NRT 750m, Sentinel-3 SLSTR NRT 1km)
2. Fase 5: Deteksi klaster Hotspot (> mu+2sigma & > mu+3sigma), Peta Anomali Suhu (Delta-T & Z-Score),
           dan Statistik Zonal 11 Kawasan/Provinsi (termasuk 5 Provinsi Kalimantan)
3. Fase 6: Kalibrasi & Validasi terhadap 18 Stasiun Meteorologi BMKG/WMO di Indonesia
4. Pembaruan manifest.json terpadu untuk aplikasi web.
"""

from __future__ import annotations

import logging
import sys
import time

from datetime import datetime, timezone

from .analysis.anomaly import run_region_analysis
from .calibration import run_validation_and_calibration
from .config import DATA_DIR
from .processing.fusion import build_hourly_composites, build_multi_sensor_fusion
from .retention import aggregate_day
from .sources.landsat import build_landsat_catalog
from .sources.sentinel3 import build_sentinel3_catalog
from .sources.viirs import build_viirs_catalog
from .storage import build_manifest

log = logging.getLogger("run_all")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    t0 = time.perf_counter()

    log.info("=== [Fase 5] Menjalankan Analisis Klaster Hotspot, Zonal Provinsi & Peta Anomali ===")
    run_region_analysis("indonesia", DATA_DIR)
    run_region_analysis("kalimantan", DATA_DIR)

    log.info("=== [Fase 4A] Mengambil Katalog Sentinel-3 SLSTR NRT (Copernicus CDSE) ===")
    s3_cat = build_sentinel3_catalog(DATA_DIR)
    log.info(
        "Sentinel-3 SL_2_LST: %d granule Indonesia, %d granule Kalimantan",
        len(s3_cat["granules"]["indonesia"]),
        len(s3_cat["granules"]["kalimantan"]),
    )

    log.info("=== [Fase 4B] Mengambil Katalog VIIRS NRT (NASA CMR & GIBS) ===")
    viirs_cat = build_viirs_catalog(DATA_DIR)
    log.info(
        "VIIRS LST: %d granule Indonesia, %d granule Kalimantan",
        len(viirs_cat["granules"]["indonesia"]),
        len(viirs_cat["granules"]["kalimantan"]),
    )

    log.info("=== [Fase 4C & 5] Mengambil Katalog Landsat 8/9 & Ekstraksi Urban Heat Island (UHI) 100m ===")
    ls_cat = build_landsat_catalog(DATA_DIR)
    log.info(
        "Landsat 8/9: %d scene Indonesia, %d scene Kalimantan, %d kota UHI diekstrak",
        len(ls_cat["scenes"]["indonesia"]),
        len(ls_cat["scenes"]["kalimantan"]),
        len(ls_cat["uhi_cities"]),
    )

    log.info("=== [Fase 6] Menjalankan Validasi 18 Stasiun Cuaca BMKG/WMO & Kalibrasi ===")
    run_validation_and_calibration(DATA_DIR)

    log.info("=== [Komposit & Fusi] Membangun Komposit Rentang Jam, Harian, & Fusi Multi-Satelit ===")
    today = datetime.now(timezone.utc).date()
    for reg in ("indonesia", "kalimantan"):
        build_hourly_composites(today, reg, DATA_DIR)
        aggregate_day(today, reg, DATA_DIR)
        build_multi_sensor_fusion(today, reg, DATA_DIR)

    build_manifest(DATA_DIR)
    log.info("=== Seluruh Fase (4-6) selesai dalam %.1f detik ===", time.perf_counter() - t0)


if __name__ == "__main__":
    main()

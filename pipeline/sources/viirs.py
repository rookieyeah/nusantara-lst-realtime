"""Integrasi Tier-2 Near-Realtime Polar Orbiter: VIIRS (Suomi-NPP, NOAA-20, NOAA-21).

Menyediakan:
1. Pencarian granule terbaru VIIRS Land Surface Temperature (VNP21_NRT / VJ121_NRT / VNP21A1D)
   di atas wilayah Indonesia & Kalimantan melalui NASA Common Metadata Repository (CMR) API
   (100% gratis, tanpa autentikasi untuk pencarian katalog & jejak lintasan).
2. Konfigurasi layer WMTS Near-Realtime NASA GIBS (Global Imagery Browse Services) untuk
   visualisasi langsung VIIRS/Terra-Aqua LST Siang & Malam di aplikasi web tanpa server.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from ..config import DATA_DIR, load_settings
from ..output import write_json

log = logging.getLogger(__name__)

CMR_GRANULES_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"

# Koleksi VIIRS LST di NASA CMR (NRT & Standard)
VIIRS_COLLECTIONS = ["VNP21_NRT", "VJ121_NRT", "VNP21A1D", "VNP21A1N"]


def search_viirs_granules(
    bbox: list[float] | tuple[float, float, float, float],
    days_back: int = 7,
    limit: int = 12,
) -> list[dict]:
    """Cari granule VIIRS LST terbaru di atas bbox [lon_min, lat_min, lon_max, lat_max]."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days_back)
    bbox_str = ",".join(str(x) for x in bbox)

    granules: list[dict] = []
    for short_name in VIIRS_COLLECTIONS:
        try:
            params = {
                "short_name": short_name,
                "bounding_box": bbox_str,
                "temporal": f"{start:%Y-%m-%dT%H:%M:%SZ},{now:%Y-%m-%dT%H:%M:%SZ}",
                "sort_key": "-start_date",
                "page_size": limit,
            }
            r = requests.get(CMR_GRANULES_URL, params=params, timeout=20)
            if not r.ok:
                continue
            entries = r.json().get("feed", {}).get("entry", [])
            for e in entries:
                boxes = e.get("boxes", [])
                gbbox = None
                if boxes:
                    # format CMR box: "lat_min lon_min lat_max lon_max"
                    parts = [float(v) for v in boxes[0].split()]
                    if len(parts) == 4:
                        gbbox = [parts[1], parts[0], parts[3], parts[2]]

                links = [lnk.get("href") for lnk in e.get("links", []) if lnk.get("href", "").endswith(".h5") or lnk.get("href", "").endswith(".nc")]
                granules.append(
                    {
                        "id": e.get("title") or e.get("id"),
                        "product": short_name,
                        "time_start": e.get("time_start"),
                        "time_end": e.get("time_end"),
                        "updated": e.get("updated"),
                        "day_night": e.get("day_night_flag", "UNSPECIFIED"),
                        "bbox": gbbox,
                        "data_url": links[0] if links else None,
                    }
                )
            if len(granules) >= limit:
                break
        except Exception as exc:
            log.warning("Gagal kueri CMR %s: %s", short_name, exc)

    granules.sort(key=lambda x: x.get("time_start") or "", reverse=True)
    return granules[:limit]


def build_viirs_catalog(out_dir: Path = DATA_DIR) -> dict:
    """Bangun katalog lintasan VIIRS LST terbaru + endpoint layer NASA GIBS WMTS."""
    settings = load_settings()
    indo_bbox = settings["regions"]["indonesia"]["bbox"]
    kali_bbox = settings["regions"]["kalimantan"]["bbox"]

    indo_granules = search_viirs_granules(indo_bbox, days_back=10, limit=12)
    kali_granules = search_viirs_granules(kali_bbox, days_back=10, limit=8)

    # Tanggal default GIBS (H-1 UTC agar mosaik global lengkap tersedia)
    gibs_date = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")

    catalog = {
        "updated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "NASA/NOAA Suomi-NPP & NOAA-20/21 VIIRS Land Surface Temperature (~750 m)",
        "gibs_date": gibs_date,
        "gibs_layers": {
            "viirs_day": {
                "name": "VIIRS / Terra-Aqua LST Siang (NASA GIBS 1 km)",
                "wmts_url": f"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Aqua_Land_Surface_Temp_Day/default/{gibs_date}/GoogleMapsCompatible_Level7/{{z}}/{{y}}/{{x}}.png",
            },
            "viirs_night": {
                "name": "VIIRS / Terra-Aqua LST Malam (NASA GIBS 1 km)",
                "wmts_url": f"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Aqua_Land_Surface_Temp_Night/default/{gibs_date}/GoogleMapsCompatible_Level7/{{z}}/{{y}}/{{x}}.png",
            },
        },
        "granules": {
            "indonesia": indo_granules,
            "kalimantan": kali_granules,
        },
    }
    write_json(catalog, out_dir / "viirs" / "catalog.json")
    return catalog

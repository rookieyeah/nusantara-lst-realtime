"""Integrasi Tier-2 Near-Realtime Polar Orbiter: Sentinel-3A/B SLSTR (SL_2_LST___).

Mengakses Copernicus Data Space Ecosystem (CDSE) OData API secara publik untuk
mendapatkan daftar granule Sentinel-3 SLSTR Level-2 Land Surface Temperature (~1 km,
latensi NRT < 3 jam) yang melintasi Indonesia dan Pulau Kalimantan.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from ..config import DATA_DIR, load_settings
from ..output import write_json

log = logging.getLogger(__name__)

CDSE_ODATA_URL = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"


def _bbox_to_wkt(bbox: list[float] | tuple[float, float, float, float]) -> str:
    x0, y0, x1, y1 = bbox
    return f"POLYGON(({x0} {y0},{x1} {y0},{x1} {y1},{x0} {y1},{x0} {y0}))"


def search_sentinel3_lst(
    bbox: list[float] | tuple[float, float, float, float],
    limit: int = 10,
) -> list[dict]:
    """Cari produk Sentinel-3 SL_2_LST___ terbaru di Copernicus Data Space Ecosystem."""
    wkt = _bbox_to_wkt(bbox)
    since = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT00:00:00.000Z")
    odata_filter = (
        "Collection/Name eq 'SENTINEL-3' "
        "and contains(Name,'SL_2_LST___') "
        f"and ContentDate/Start gt {since} "
        f"and OData.CSC.Intersects(area=geography'SRID=4326;{wkt}')"
    )
    params = {
        "$filter": odata_filter,
        "$orderby": "ContentDate/Start desc",
        "$top": str(limit),
    }
    try:
        r = requests.get(CDSE_ODATA_URL, params=params, timeout=25)
        r.raise_for_status()
        items = r.json().get("value", [])
    except Exception as e:
        log.warning("Gagal kueri Copernicus CDSE Sentinel-3: %s", e)
        return []

    results = []
    for it in items:
        fp = it.get("GeoFootprint", {})
        coords = fp.get("coordinates", [])
        gbbox = None
        if coords:
            # Ambil semua titik [lon, lat] untuk menghitung bounding box granule
            pts = []
            def _collect(node):
                if isinstance(node, (list, tuple)):
                    if len(node) == 2 and isinstance(node[0], (int, float)):
                        pts.append(node)
                    else:
                        for sub in node:
                            _collect(sub)
            _collect(coords)
            if pts:
                lons = [p[0] for p in pts]
                lats = [p[1] for p in pts]
                gbbox = [round(min(lons), 3), round(min(lats), 3), round(max(lons), 3), round(max(lats), 3)]

        name = it.get("Name", "")
        timeliness = "NRT (< 3 jam)" if "_NR_" in name else "NTC (Arsip Standar)"
        results.append(
            {
                "id": it.get("Id"),
                "name": name,
                "satellite": "Sentinel-3A" if name.startswith("S3A") else "Sentinel-3B",
                "timeliness": timeliness,
                "time_start": it.get("ContentDate", {}).get("Start"),
                "time_end": it.get("ContentDate", {}).get("End"),
                "published": it.get("PublicationDate"),
                "size_mb": round(int(it.get("ContentLength", 0)) / 1e6, 1),
                "bbox": gbbox,
                "footprint": fp if fp.get("type") in ("Polygon", "MultiPolygon") else None,
            }
        )
    return results


def build_sentinel3_catalog(out_dir: Path = DATA_DIR) -> dict:
    """Bangun katalog lintasan Sentinel-3 SLSTR LST terbaru untuk Indonesia & Kalimantan."""
    settings = load_settings()
    indo_items = search_sentinel3_lst(settings["regions"]["indonesia"]["bbox"], limit=10)
    kali_items = search_sentinel3_lst(settings["regions"]["kalimantan"]["bbox"], limit=8)

    catalog = {
        "updated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "ESA Copernicus Sentinel-3A/B SLSTR Level-2 Land Surface Temperature (SL_2_LST___, ~1 km)",
        "granules": {
            "indonesia": indo_items,
            "kalimantan": kali_items,
        },
    }
    write_json(catalog, out_dir / "sentinel3" / "catalog.json")
    return catalog

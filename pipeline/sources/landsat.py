"""Integrasi Landsat 8/9 Collection 2 Level-2 (ST_B10) via Microsoft Planetary Computer.

Mendukung dua fungsi sesuai rencana:
1. Katalog scene terbaru untuk Seluruh Indonesia & Pulau Kalimantan beserta URL Dynamic Tile
   (Planetary Computer Data API, 30 m, langsung ditampilkan di web tanpa perlu menyimpan file GB).
2. Ekstraksi potongan COG (~100 m, resolusi asli sensor TIRS) untuk analisis detail
   Suhu Permukaan (LST), indeks vegetasi (NDVI), dan Urban Heat Island (UHI).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

from ..config import DATA_DIR, RegionGrid, load_settings
from ..output import write_cog, write_json, write_png

log = logging.getLogger(__name__)

STAC_SEARCH_URL = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SAS_TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token/landsat-c2-l2"
DATA_API_TILE_URL = (
    "https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x"
    "?collection=landsat-c2-l2&item={item_id}&assets=lwir11&colormap_name=rdylbu_r&rescale=290,322"
)

# Faktor skala resmi USGS Landsat Collection 2 Level-2
ST_SCALE = 0.00341802
ST_OFFSET = 149.0
SR_SCALE = 0.0000275
SR_OFFSET = -0.2

# Fokus area perkotaan utama (prioritas Kalimantan + kota besar Indonesia) untuk analisis UHI 100 m
UHI_FOCUS_AREAS = {
    "balikpapan_ikn": {
        "name": "Balikpapan & IKN Nusantara (Kalimantan Timur)",
        "island": "Kalimantan",
        "bbox": [116.65, -1.35, 117.05, -0.85],
    },
    "banjarmasin": {
        "name": "Banjarmasin & Banjarbaru (Kalimantan Selatan)",
        "island": "Kalimantan",
        "bbox": [114.50, -3.52, 114.90, -3.20],
    },
    "pontianak": {
        "name": "Pontianak & Kubu Raya (Kalimantan Barat)",
        "island": "Kalimantan",
        "bbox": [109.22, -0.18, 109.50, 0.12],
    },
    "jakarta": {
        "name": "DKI Jakarta & Jabodetabek (Jawa)",
        "island": "Jawa",
        "bbox": [106.68, -6.38, 107.02, -6.08],
    },
    "surabaya": {
        "name": "Surabaya & Sidoarjo (Jawa Timur)",
        "island": "Jawa",
        "bbox": [112.60, -7.45, 112.85, -7.18],
    },
}


def _get_sas_token() -> str:
    r = requests.get(SAS_TOKEN_URL, timeout=20)
    r.raise_for_status()
    return r.json()["token"]


def sign_url(href: str, token: str) -> str:
    sep = "&" if "?" in href else "?"
    return f"{href}{sep}{token}"


def search_landsat_scenes(
    bbox: list[float] | tuple[float, float, float, float],
    max_cloud: float = 40.0,
    limit: int = 12,
) -> list[dict]:
    """Cari scene Landsat 8/9 C2 L2 terbaru yang memiliki kanal termal lwir11 (ST_B10)."""
    payload = {
        "collections": ["landsat-c2-l2"],
        "bbox": list(bbox),
        "query": {
            "eo:cloud_cover": {"lt": max_cloud},
            "platform": {"in": ["landsat-8", "landsat-9"]},
        },
        "limit": limit,
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    r = requests.post(STAC_SEARCH_URL, json=payload, timeout=30)
    r.raise_for_status()
    features = r.json().get("features", [])
    scenes = []
    for f in features:
        assets = f.get("assets", {})
        if "lwir11" not in assets:
            continue
        props = f["properties"]
        item_id = f["id"]
        scenes.append(
            {
                "id": item_id,
                "platform": props.get("platform"),
                "datetime": props.get("datetime"),
                "cloud_cover": round(float(props.get("eo:cloud_cover", 0.0)), 1),
                "path": props.get("landsat:wrs_path"),
                "row": props.get("landsat:wrs_row"),
                "bbox": f.get("bbox"),
                "tile_url": DATA_API_TILE_URL.format(
                    z="{z}", x="{x}", y="{y}", item_id=item_id
                ),
                "assets": {
                    "lwir11": assets["lwir11"]["href"],
                    "red": assets.get("red", {}).get("href"),
                    "nir08": assets.get("nir08", {}).get("href"),
                    "qa_pixel": assets.get("qa_pixel", {}).get("href"),
                },
            }
        )
    return scenes


def extract_city_lst_and_uhi(
    city_key: str,
    city_cfg: dict,
    out_dir: Path = DATA_DIR,
    res_deg: float = 0.001,
) -> dict | None:
    """Ambil potongan Landsat ~100m untuk area fokus perkotaan, hitung LST, NDVI, dan UHI."""
    bbox = city_cfg["bbox"]
    scenes = search_landsat_scenes(bbox, max_cloud=50.0, limit=15)
    if not scenes:
        log.warning("Tidak ada scene Landsat untuk %s", city_key)
        return None

    token = _get_sas_token()
    lon_min, lat_min, lon_max, lat_max = bbox
    grid = RegionGrid(
        key=f"landsat_{city_key}",
        name=city_cfg["name"],
        lon_min=lon_min,
        lat_min=lat_min,
        lon_max=lon_max,
        lat_max=lat_max,
        res=res_deg,
    )

    # Pilih scene pertama yang mencakup >= 35% piksel valid di dalam bbox kota
    chosen = None
    lst_c = None
    ndvi = None

    for sc in scenes:
        sb = sc["bbox"]
        # Pastikan bbox scene beririsan cukup besar dengan bbox kota
        ix0, iy0 = max(lon_min, sb[0]), max(lat_min, sb[1])
        ix1, iy1 = min(lon_max, sb[2]), min(lat_max, sb[3])
        if ix1 <= ix0 or iy1 <= iy0:
            continue
        overlap = ((ix1 - ix0) * (iy1 - iy0)) / ((lon_max - lon_min) * (lat_max - lat_min))
        if overlap < 0.5:
            continue

        try:
            url_st = sign_url(sc["assets"]["lwir11"], token)
            url_red = sign_url(sc["assets"]["red"], token)
            url_nir = sign_url(sc["assets"]["nir08"], token)
            url_qa = sign_url(sc["assets"]["qa_pixel"], token)

            with (
                rasterio.open(url_st) as src_st,
                rasterio.open(url_red) as src_red,
                rasterio.open(url_nir) as src_nir,
                rasterio.open(url_qa) as src_qa,
            ):
                proj_bounds = transform_bounds("EPSG:4326", src_st.crs, *bbox, densify_pts=21)
                win = from_bounds(*proj_bounds, transform=src_st.transform)
                out_shape = (grid.height, grid.width)

                raw_st = src_st.read(1, window=win, out_shape=out_shape, boundless=True, fill_value=0)
                raw_red = src_red.read(1, window=win, out_shape=out_shape, boundless=True, fill_value=0)
                raw_nir = src_nir.read(1, window=win, out_shape=out_shape, boundless=True, fill_value=0)
                raw_qa = src_qa.read(1, window=win, out_shape=out_shape, boundless=True, fill_value=1)

            # QA_PIXEL bitmask: bit 0=fill, 1=dilated cloud, 2=cirrus, 3=cloud, 4=cloud shadow, 7=water
            cloud_or_water = (raw_qa & ((1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 7))) != 0
            # Piksel darat terbangun/terbuka memiliki reflektansi merah > 0.04 (membuang bayangan awan/air keruh)
            valid = (raw_st > 0) & ~cloud_or_water & (raw_red * SR_SCALE + SR_OFFSET > 0.03)
            clear_frac = float(valid.mean())
            if clear_frac < 0.20:
                continue

            temp_k = raw_st.astype(np.float32) * ST_SCALE + ST_OFFSET
            temp_c = np.where(valid, temp_k - 273.15, np.nan).astype(np.float32)
            # Filter tambahan untuk membuang sisa tepi awan dingin (< 22 C pada siang hari pukul 10:00 waktu lokal)
            p10 = float(np.nanpercentile(temp_c, 10)) if np.isfinite(temp_c).any() else 22.0
            low_cut = max(22.0, p10 - 1.0)
            temp_c = np.where((temp_c >= low_cut) & (temp_c <= 60.0), temp_c, np.nan)
            valid = np.isfinite(temp_c)

            red = raw_red.astype(np.float32) * SR_SCALE + SR_OFFSET
            nir = raw_nir.astype(np.float32) * SR_SCALE + SR_OFFSET
            with np.errstate(divide="ignore", invalid="ignore"):
                nd = np.where(valid & ((nir + red) > 0.02), (nir - red) / (nir + red), np.nan)
                nd = np.clip(nd, -1.0, 1.0).astype(np.float32)

            chosen = sc
            lst_c = temp_c
            ndvi = nd
            break
        except Exception as e:
            log.warning("Gagal membaca scene %s untuk %s: %s", sc["id"], city_key, e)
            continue

    if chosen is None or lst_c is None:
        return None

    # Klasifikasi Urban/Terbangun vs Hutan/Vegetasi Rapat berdasarkan NDVI
    valid_px = np.isfinite(lst_c) & np.isfinite(ndvi)
    urban_mask = valid_px & (ndvi >= 0.05) & (ndvi <= 0.30)
    veg_mask = valid_px & (ndvi >= 0.55)

    urban_mean = float(np.nanmean(lst_c[urban_mask])) if urban_mask.sum() > 20 else float(np.nanpercentile(lst_c[valid_px], 85))
    veg_mean = float(np.nanmean(lst_c[veg_mask])) if veg_mask.sum() > 20 else float(np.nanpercentile(lst_c[valid_px], 20))
    uhi_intensity = round(urban_mean - veg_mean, 2)

    # Simpan COG dan PNG
    settings = load_settings()
    ocfg = settings["output"]
    sub = out_dir / "landsat" / city_key
    base = f"LST_L89_{city_key}"
    cog_path = sub / f"{base}.tif"
    png_path = sub / f"{base}.png"

    write_cog(
        lst_c,
        grid,
        cog_path,
        ocfg,
        {"scene_id": chosen["id"], "datetime": chosen["datetime"], "uhi_c": uhi_intensity},
    )
    pv0, pv1 = ocfg["preview_range_c"]
    write_png(lst_c, png_path, pv0, pv1)

    # Hitung titik-titik UHI terpanas di area terbangun
    hot_thr = veg_mean + max(3.0, uhi_intensity + 1.5)
    hot_mask = valid_px & (lst_c >= hot_thr)

    result = {
        "city_key": city_key,
        "name": city_cfg["name"],
        "island": city_cfg["island"],
        "bbox": bbox,
        "res_deg": res_deg,
        "scene_id": chosen["id"],
        "platform": chosen["platform"],
        "datetime": chosen["datetime"],
        "scene_cloud_cover_pct": chosen["cloud_cover"],
        "tile_url": chosen["tile_url"],
        "cog_url": f"landsat/{city_key}/{cog_path.name}",
        "png_url": f"landsat/{city_key}/{png_path.name}",
        "stats": {
            "clear_fraction": round(float(valid_px.mean()), 3),
            "min_c": round(float(np.nanmin(lst_c)), 2),
            "mean_c": round(float(np.nanmean(lst_c)), 2),
            "max_c": round(float(np.nanmax(lst_c)), 2),
            "p95_c": round(float(np.nanpercentile(lst_c[valid_px], 95)), 2),
            "urban_mean_c": round(urban_mean, 2),
            "vegetation_mean_c": round(veg_mean, 2),
            "uhi_intensity_c": uhi_intensity,
            "uhi_hot_threshold_c": round(hot_thr, 2),
            "uhi_hot_pixels": int(hot_mask.sum()),
            "mean_ndvi": round(float(np.nanmean(ndvi[valid_px])), 3),
        },
        "sizes_mb": {
            "cog": round(cog_path.stat().st_size / 1e6, 3),
            "png": round(png_path.stat().st_size / 1e6, 3),
        },
    }
    write_json(result, sub / f"{base}.json")
    log.info(
        "Landsat UHI %s (%s): LST rata2 %.2f C | Urban %.2f C vs Vegetasi %.2f C -> UHI +%.2f C",
        city_cfg["name"],
        chosen["id"],
        result["stats"]["mean_c"],
        urban_mean,
        veg_mean,
        uhi_intensity,
    )
    return result


def build_landsat_catalog(out_dir: Path = DATA_DIR) -> dict:
    """Bangun katalog scene Landsat terbaru (Indonesia & Kalimantan) + analisis UHI 100 m."""
    settings = load_settings()
    indo_scenes = search_landsat_scenes(settings["regions"]["indonesia"]["bbox"], max_cloud=35.0, limit=10)
    kali_scenes = search_landsat_scenes(settings["regions"]["kalimantan"]["bbox"], max_cloud=40.0, limit=8)

    uhi_cities = {}
    # Ekstrak fokus Kalimantan (Balikpapan-IKN & Banjarmasin) + Jawa (Jakarta)
    for key in ("balikpapan_ikn", "banjarmasin", "jakarta"):
        info = extract_city_lst_and_uhi(key, UHI_FOCUS_AREAS[key], out_dir=out_dir)
        if info:
            uhi_cities[key] = info

    catalog = {
        "updated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "USGS Landsat 8/9 Collection 2 Level-2 (Microsoft Planetary Computer STAC)",
        "scenes": {
            "indonesia": indo_scenes,
            "kalimantan": kali_scenes,
        },
        "uhi_cities": uhi_cities,
    }
    write_json(catalog, out_dir / "landsat" / "catalog.json")
    return catalog

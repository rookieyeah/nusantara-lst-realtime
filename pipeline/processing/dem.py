"""Model Elevasi Digital (DEM) dari AWS Open Data Terrarium Tiles (tanpa akun).

Mengunduh tile elevasi zoom-6 (~2 km di ekuator), mendekode:
    elevasi (m) = (R * 256 + G + B / 256) - 32768
dan menyimpan hasilnya ke `static/dem_<region>_<res>.tif`.
Digunakan untuk membedakan suhu dingin alami pegunungan (lapse rate -6,5 C/km)
dari kontaminasi awan sub-piksel / tepi awan di dataran rendah.
"""

from __future__ import annotations

import io
import logging
import math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image

from ..config import STATIC_DIR, RegionGrid

log = logging.getLogger(__name__)

TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def _lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    lat_rad = math.radians(max(-85.0, min(85.0, lat)))
    n = 1 << z
    xtile = int((lon + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, xtile)), max(0, min(n - 1, ytile))


def _fetch_tile(z: int, x: int, y: int) -> np.ndarray:
    url = TERRARIUM_URL.format(z=z, x=x, y=y)
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    img = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.float32)
    elev = (img[..., 0] * 256.0 + img[..., 1] + img[..., 2] / 256.0) - 32768.0
    return elev


def get_dem(grid: RegionGrid, zoom: int = 6) -> np.ndarray:
    """Kembalikan array float32 (height, width) berisi elevasi daratan dalam meter (>= 0)."""
    path = STATIC_DIR / f"dem_{grid.key}_{grid.res:g}.tif"
    if path.exists():
        with rasterio.open(path) as src:
            return src.read(1).astype(np.float32)

    x0, y0 = _lonlat_to_tile(grid.lon_min, grid.lat_max, zoom)
    x1, y1 = _lonlat_to_tile(grid.lon_max, grid.lat_min, zoom)

    nx = x1 - x0 + 1
    ny = y1 - y0 + 1
    mosaic = np.zeros((ny * 256, nx * 256), dtype=np.float32)

    coords = [(ix, iy) for iy in range(y0, y1 + 1) for ix in range(x0, x1 + 1)]
    log.info("Mengunduh %d tile DEM Terrarium (zoom %d) untuk %s...", len(coords), zoom, grid.name)

    with ThreadPoolExecutor(max_workers=6) as ex:
        tiles = list(ex.map(lambda c: _fetch_tile(zoom, c[0], c[1]), coords))

    for (ix, iy), arr in zip(coords, tiles):
        r_off = (iy - y0) * 256
        c_off = (ix - x0) * 256
        mosaic[r_off : r_off + 256, c_off : c_off + 256] = arr

    # Petakan setiap baris/kolom grid EPSG:4326 ke koordinat piksel mosaik WebMercator
    n = 1 << zoom
    lons = grid.lon_min + (np.arange(grid.width) + 0.5) * grid.res
    lats = grid.lat_max - (np.arange(grid.height) + 0.5) * grid.res
    lat_rads = np.radians(np.clip(lats, -85.0, 85.0))

    col_f = ((lons + 180.0) / 360.0 * n - x0) * 256.0
    row_f = ((1.0 - np.arcsinh(np.tan(lat_rads)) / np.pi) / 2.0 * n - y0) * 256.0

    ci = np.clip(np.floor(col_f).astype(int), 0, mosaic.shape[1] - 1)
    ri = np.clip(np.floor(row_f).astype(int), 0, mosaic.shape[0] - 1)

    dem = np.maximum(0.0, mosaic[np.ix_(ri, ci)]).astype(np.float32)

    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=grid.width,
        height=grid.height,
        count=1,
        dtype="int16",
        crs="EPSG:4326",
        transform=grid.transform,
        compress="deflate",
    ) as dst:
        dst.write(np.round(dem).astype(np.int16), 1)
    log.info("DEM disimpan: %s (maks %.0f m)", path, float(dem.max()))
    return dem

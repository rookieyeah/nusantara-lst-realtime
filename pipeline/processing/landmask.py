"""Mask daratan dari Natural Earth 10m (domain publik), dirasterisasi ke grid wilayah.

Hasil disimpan di static/ agar tidak perlu diunduh ulang setiap run.
"""

from __future__ import annotations

import io
import logging
import zipfile
from pathlib import Path

import numpy as np
import rasterio
import requests
import shapefile  # pyshp
from rasterio.features import rasterize

from ..config import STATIC_DIR, RegionGrid

log = logging.getLogger(__name__)


def _landmask_path(grid: RegionGrid) -> Path:
    return STATIC_DIR / f"landmask_{grid.key}_{grid.res:g}.tif"


def _load_land_shapes(url: str, bbox: tuple[float, float, float, float]):
    log.info("Mengunduh Natural Earth land: %s", url)
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    z = zipfile.ZipFile(io.BytesIO(r.content))
    base = next(n[:-4] for n in z.namelist() if n.endswith(".shp"))
    reader = shapefile.Reader(
        shp=io.BytesIO(z.read(base + ".shp")),
        shx=io.BytesIO(z.read(base + ".shx")),
        dbf=io.BytesIO(z.read(base + ".dbf")),
    )
    lon_min, lat_min, lon_max, lat_max = bbox
    for shp in reader.iterShapes():
        x0, y0, x1, y1 = shp.bbox
        if x1 < lon_min or x0 > lon_max or y1 < lat_min or y0 > lat_max:
            continue
        yield shp.__geo_interface__


def get_landmask(grid: RegionGrid, url: str) -> np.ndarray:
    """Array bool (height, width): True = daratan."""
    path = _landmask_path(grid)
    if path.exists():
        with rasterio.open(path) as src:
            return src.read(1).astype(bool)

    shapes = [(g, 1) for g in _load_land_shapes(url, grid.bbox)]
    # all_touched=False: piksel dihitung darat jika pusatnya di darat
    mask = rasterize(
        shapes,
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=0,
        dtype="uint8",
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=grid.width,
        height=grid.height,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=grid.transform,
        compress="deflate",
        nbits=1,
    ) as dst:
        dst.write(mask, 1)
    log.info("Landmask disimpan: %s (%.1f%% daratan)", path, 100 * mask.mean())
    return mask.astype(bool)

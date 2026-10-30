"""Pemuatan konfigurasi dan definisi grid wilayah."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml
from affine import Affine

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
STATIC_DIR = ROOT / "static"
CACHE_DIR = ROOT / "cache"
DATA_DIR = ROOT / "data"


def load_settings(path: Path | None = None) -> dict:
    path = path or CONFIG_DIR / "settings.yaml"
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


@dataclass(frozen=True)
class RegionGrid:
    """Grid lintang/bujur reguler (EPSG:4326) untuk sebuah wilayah."""

    key: str
    name: str
    lon_min: float
    lat_min: float
    lon_max: float
    lat_max: float
    res: float

    @property
    def width(self) -> int:
        return int(round((self.lon_max - self.lon_min) / self.res))

    @property
    def height(self) -> int:
        return int(round((self.lat_max - self.lat_min) / self.res))

    @property
    def transform(self) -> Affine:
        return Affine(self.res, 0.0, self.lon_min, 0.0, -self.res, self.lat_max)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.lon_min, self.lat_min, self.lon_max, self.lat_max)

    def to_pyresample(self):
        from pyresample.geometry import AreaDefinition

        return AreaDefinition(
            f"{self.key}_{self.res}",
            f"{self.name} {self.res} deg",
            "longlat",
            {"proj": "longlat", "datum": "WGS84", "no_defs": None},
            self.width,
            self.height,
            (self.lon_min, self.lat_min, self.lon_max, self.lat_max),
        )


def region_grid(settings: dict, region: str | None = None, res: float | None = None) -> RegionGrid:
    key = region or settings["active_region"]
    r = settings["regions"][key]
    lon_min, lat_min, lon_max, lat_max = r["bbox"]
    return RegionGrid(
        key=key,
        name=r["name"],
        lon_min=lon_min,
        lat_min=lat_min,
        lon_max=lon_max,
        lat_max=lat_max,
        res=res or settings["himawari"]["grid_resolution_deg"],
    )

"""Penulisan output: COG int16 (nilai suhu), pratinjau PNG berwarna, dan JSON statistik."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

from .config import RegionGrid

# Palet warna suhu terpadu (15°C s.d. 55°C):
# 0.00 (15°C): Biru Tua       rgb(30, 58, 138)
# 0.20 (23°C): Cyan Cerah     rgb(6, 182, 212)
# 0.30 (27°C): Hijau          rgb(34, 197, 94)
# 0.40 (31°C): Kuning Cerah   rgb(250, 204, 21)
# 0.60 (39°C): Oranye Panas   rgb(249, 115, 22)
# 0.80 (47°C): Merah Menyala  rgb(220, 38, 38)
# 1.00 (55°C): Merah Tua      rgb(127, 29, 29)
_PALETTE_STOPS = np.array([0.0, 0.20, 0.30, 0.40, 0.60, 0.80, 1.0])
_PALETTE_RGB = np.array(
    [
        [30, 58, 138],
        [6, 182, 212],
        [34, 197, 94],
        [250, 204, 21],
        [249, 115, 22],
        [220, 38, 38],
        [127, 29, 29],
    ],
    dtype=np.float32,
)

PALETTE = {"stops": _PALETTE_STOPS.tolist(), "colors": _PALETTE_RGB.astype(int).tolist()}


def write_cog(lst_c: np.ndarray, grid: RegionGrid, path: Path, cfg_out: dict, tags: dict) -> None:
    """Simpan LST (deg C, NaN = nodata) sebagai Cloud Optimized GeoTIFF int16."""
    scale = cfg_out["scale"]
    nodata = cfg_out["nodata"]
    data = np.full(lst_c.shape, nodata, dtype=np.int16)
    ok = np.isfinite(lst_c)
    data[ok] = np.clip(np.round(lst_c[ok] / scale), -32767, 32767).astype(np.int16)

    path.parent.mkdir(parents=True, exist_ok=True)
    profile = dict(
        driver="COG",
        width=grid.width,
        height=grid.height,
        count=1,
        dtype="int16",
        crs="EPSG:4326",
        transform=grid.transform,
        nodata=nodata,
        compress="DEFLATE",
        predictor=2,
        blocksize=512,
        overview_resampling=Resampling.average.name,
    )
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(data, 1)
        dst.scales = (scale,)
        dst.offsets = (0.0,)
        dst.units = ("degC",)
        dst.set_band_description(1, "Land Surface Temperature")
        dst.update_tags(**{k: str(v) for k, v in tags.items()})


def colorize(lst_c: np.ndarray, vmin: float, vmax: float) -> np.ndarray:
    """LST -> RGBA uint8; nodata transparan."""
    t = np.clip((lst_c - vmin) / (vmax - vmin), 0, 1)
    rgba = np.zeros(lst_c.shape + (4,), dtype=np.uint8)
    for ch in range(3):
        rgba[..., ch] = np.interp(np.nan_to_num(t), _PALETTE_STOPS, _PALETTE_RGB[:, ch]).astype(np.uint8)
    rgba[..., 3] = np.where(np.isfinite(lst_c), 255, 0)
    return rgba


def write_png(lst_c: np.ndarray, path: Path, vmin: float, vmax: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(colorize(lst_c, vmin, vmax), mode="RGBA").save(path, optimize=True)


def compute_stats(lst_c: np.ndarray, masks: dict[str, np.ndarray]) -> dict:
    valid = masks["valid"]
    clear = np.isfinite(lst_c)
    n_valid = int(valid.sum())
    n_clear = int(clear.sum())
    out = {
        "land_pixels": n_valid,
        "clear_pixels": n_clear,
        "clear_fraction": round(n_clear / n_valid, 4) if n_valid else 0.0,
        "cloud_tests_fraction": {
            k: round(float((masks[k]).sum()) / n_valid, 4) if n_valid else 0.0
            for k in masks
            if k not in ("valid", "clear")
        },
    }
    if n_clear:
        v = lst_c[clear]
        mean, std = float(v.mean()), float(v.std())
        out.update(
            {
                "min_c": round(float(v.min()), 2),
                "max_c": round(float(v.max()), 2),
                "mean_c": round(mean, 2),
                "std_c": round(std, 2),
                "p05_c": round(float(np.percentile(v, 5)), 2),
                "p50_c": round(float(np.percentile(v, 50)), 2),
                "p95_c": round(float(np.percentile(v, 95)), 2),
                # Hotspot sederhana: > mean + 2 sigma (dikembangkan di Fase 5)
                "hotspot_threshold_c": round(mean + 2 * std, 2),
                "hotspot_pixels": int((v > mean + 2 * std).sum()),
            }
        )
    return out


def write_json(obj: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)

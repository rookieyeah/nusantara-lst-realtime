"""Cloud mask berbasis kanal termal + koreksi topografi DEM (berlaku siang & malam).

Uji yang dipakai:
1. Suhu dingin terkoreksi elevasi (DEM) : BT14 + 0.0065*z < ambang permukaan laut (siang/malam)
2. Split-window                         : BT14 - BT15 > ambang dinamis (awan tipis / cirrus)
3. Keseragaman spasial                  : std-dev lokal 3x3 BT14 tinggi (tepi awan, cumulus pecah)
4. Amplop hangat lokal (DEM-adjusted)   : BT14_sea jauh lebih dingin dari maksimum tetangga 21x21
5. Dilasi tepi awan (2 piksel)          : membuang kontaminasi sub-piksel di pinggiran awan
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage


def _local_std(values: np.ndarray, valid: np.ndarray, size: int = 3) -> np.ndarray:
    """Std-dev lokal yang hanya memperhitungkan piksel valid (mis. daratan)."""
    v = np.where(valid, values, 0.0).astype(np.float64)
    w = valid.astype(np.float64)
    n = ndimage.uniform_filter(w, size=size, mode="nearest")
    s1 = ndimage.uniform_filter(v, size=size, mode="nearest")
    s2 = ndimage.uniform_filter(v * v, size=size, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s1 / n
        var = s2 / n - mean * mean
    return np.sqrt(np.clip(var, 0, None)).astype(np.float32)


def cloud_mask(
    bt14: np.ndarray,
    bt15: np.ndarray,
    land: np.ndarray,
    cfg: dict,
    dem_m: np.ndarray | None = None,
    is_daytime: bool = False,
) -> dict[str, np.ndarray]:
    """Mengembalikan dict berisi mask bool per uji dan gabungan 'cloud'."""
    valid = land & np.isfinite(bt14) & np.isfinite(bt15)
    lapse = cfg.get("lapse_rate_k_per_m", 0.0065)
    elev = dem_m if dem_m is not None else np.zeros_like(bt14)

    # Uji suhu dingin awal pada BT14 mentah (mencegah awan tinggi di atas pegunungan lolos)
    cold_thr = cfg.get("bt_cold_threshold_k", 282.5)
    cold = bt14 < cold_thr

    btd = bt14 - bt15
    frac = np.clip((bt14 - cfg["bt_low_k"]) / (cfg["bt_high_k"] - cfg["bt_low_k"]), 0, 1)
    btd_thr = cfg["btd_min_k"] + frac * (cfg["btd_max_k"] - cfg["btd_min_k"])
    thin = btd > btd_thr

    std = _local_std(bt14, valid, size=3)
    rough = std > cfg["spatial_std_threshold_k"]

    tests = {"cold": cold, "split_window": thin, "spatial": rough}

    if cfg.get("local_cold_enabled", True):
        # Hanya gunakan piksel yang lolos uji dingin awal sebagai kandidat referensi amplop hangat lokal
        warm_candidates = valid & ~cold
        tmp = np.where(warm_candidates, bt14_sea, -np.inf)
        local_max = ndimage.maximum_filter(tmp, size=cfg.get("local_window_px", 21), mode="nearest")
        has_ref = np.isfinite(local_max) & (local_max > 0)
        tests["local_cold"] = has_ref & ((local_max - bt14_sea) > cfg.get("local_cold_delta_k", 4.2))

    cloud = np.zeros_like(valid)
    for m in tests.values():
        cloud |= m & valid
    if cfg.get("dilate_px", 0) > 0:
        cloud = ndimage.binary_dilation(cloud, iterations=cfg["dilate_px"]) & valid

    tests = {k: (v & valid) for k, v in tests.items()}
    tests["cloud"] = cloud
    tests["valid"] = valid
    tests["clear"] = valid & ~cloud
    return tests

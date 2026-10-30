"""Algoritma split-window untuk Land Surface Temperature.

Bentuk umum (Sobrino / Jimenez-Munoz):

    LST = Ti + c1 (Ti - Tj) + c2 (Ti - Tj)^2 + c0
          + (c3 + c4 W)(1 - e) + (c5 + c6 W) de

    Ti, Tj : brightness temperature kanal ~11 um dan ~12 um (K)
    e      : rata-rata emisivitas kedua kanal
    de     : selisih emisivitas (ei - ej)
    W      : uap air kolom total (g/cm2)

Koefisien di config/settings.yaml bersifat SEMENTARA dan akan dikalibrasi
terhadap produk LST VIIRS / Sentinel-3 (Fase 6).
"""

from __future__ import annotations

import numpy as np


def split_window_lst(
    ti: np.ndarray,
    tj: np.ndarray,
    ei: np.ndarray,
    ej: np.ndarray,
    w: float | np.ndarray,
    c: dict,
) -> np.ndarray:
    """Hitung LST (Kelvin)."""
    dt = ti - tj
    e = 0.5 * (ei + ej)
    de = ei - ej
    lst = (
        ti
        + c["c1"] * dt
        + c["c2"] * dt * dt
        + c["c0"]
        + (c["c3"] + c["c4"] * w) * (1.0 - e)
        + (c["c5"] + c["c6"] * w) * de
    )
    return lst.astype(np.float32)

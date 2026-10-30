"""Emisivitas permukaan untuk kanal B14 (11.2 um) dan B15 (12.4 um).

Versi prototipe: konstanta untuk daratan. Fase 6 akan menggantinya dengan
emisivitas per piksel dari tutupan lahan / NDVI.
"""

from __future__ import annotations

import numpy as np


def emissivity(land: np.ndarray, cfg: dict) -> tuple[np.ndarray, np.ndarray]:
    e14 = np.where(land, cfg["land_b14"], np.nan).astype(np.float32)
    e15 = np.where(land, cfg["land_b15"], np.nan).astype(np.float32)
    return e14, e15

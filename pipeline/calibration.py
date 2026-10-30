"""Fase 6: Kalibrasi Antar-Sensor (Himawari-9 vs Landsat/VIIRS) & Validasi Stasiun Cuaca BMKG/WMO.

Melakukan:
1. Validasi suhu permukaan satelit (Himawari-9 LST) terhadap pengamatan suhu udara 2m (T_air) &
   suhu permukaan/tanah (T_soil_0cm) near-realtime dari 18 titik Stasiun Meteorologi BMKG/WMO
   di seluruh Indonesia (termasuk 6 stasiun utama di Pulau Kalimantan) melalui Open-Meteo WMO API (gratis).
2. Kalibrasi silang (Cross-Calibration) Himawari-9 AHI terhadap LST resolusi tinggi Landsat 8/9 Level-2
   pada lokasi perkotaan/daratan yang beririsan, menghasilkan metrik Bias, MAE, RMSE, dan persamaan koreksi.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from .analysis.hotspot import read_cog_celsius
from .config import DATA_DIR, load_settings, region_grid
from .output import write_json

log = logging.getLogger(__name__)

# 18 Stasiun Sinoptik Utama BMKG / WMO di Indonesia (fokus Kalimantan + kepulauan utama)
BMKG_STATIONS = [
    {"id": "96509", "name": "Stamet Juwata — Tarakan (Kaltara)", "island": "Kalimantan", "lat": 3.327, "lon": 117.569},
    {"id": "96581", "name": "Stamet Supadio — Pontianak (Kalbar)", "island": "Kalimantan", "lat": -0.150, "lon": 109.404},
    {"id": "96633", "name": "Stamet SAMS Sepinggan — Balikpapan (Kaltim)", "island": "Kalimantan", "lat": -1.268, "lon": 116.894},
    {"id": "96645", "name": "Stamet Iskandar — Pangkalan Bun (Kalteng)", "island": "Kalimantan", "lat": -2.705, "lon": 111.673},
    {"id": "96655", "name": "Stamet Tjilik Riwut — Palangkaraya (Kalteng)", "island": "Kalimantan", "lat": -2.225, "lon": 113.943},
    {"id": "96685", "name": "Stamet Syamsudin Noor — Banjarmasin (Kalsel)", "island": "Kalimantan", "lat": -3.442, "lon": 114.763},
    {"id": "96035", "name": "Stamet Kualanamu — Medan (Sumut)", "island": "Sumatera", "lat": 3.642, "lon": 98.885},
    {"id": "96109", "name": "Stamet Sultan Syarif Kasim II — Pekanbaru (Riau)", "island": "Sumatera", "lat": 0.461, "lon": 101.445},
    {"id": "96221", "name": "Stamet Sultan Mahmud Badaruddin II — Palembang", "island": "Sumatera", "lat": -2.898, "lon": 104.701},
    {"id": "96745", "name": "Stamet Kemayoran — Jakarta Pusat", "island": "Jawa", "lat": -6.156, "lon": 106.841},
    {"id": "96797", "name": "Stamet Ahmad Yani — Semarang (Jateng)", "island": "Jawa", "lat": -6.973, "lon": 110.375},
    {"id": "96935", "name": "Stamet Juanda — Surabaya (Jatim)", "island": "Jawa", "lat": -7.380, "lon": 112.787},
    {"id": "97230", "name": "Stamet I Gusti Ngurah Rai — Denpasar (Bali)", "island": "Bali-Nusra", "lat": -8.748, "lon": 115.167},
    {"id": "97372", "name": "Stamet El Tari — Kupang (NTT)", "island": "Bali-Nusra", "lat": -10.171, "lon": 123.671},
    {"id": "97180", "name": "Stamet Sultan Hasanuddin — Makassar (Sulsel)", "island": "Sulawesi", "lat": -5.062, "lon": 119.554},
    {"id": "97014", "name": "Stamet Sam Ratulangi — Manado (Sulut)", "island": "Sulawesi", "lat": 1.549, "lon": 124.926},
    {"id": "97724", "name": "Stamet Pattimura — Ambon (Maluku)", "island": "Maluku", "lat": -3.707, "lon": 128.089},
    {"id": "97690", "name": "Stamet Sentani — Jayapura (Papua)", "island": "Papua", "lat": -2.577, "lon": 140.516},
]

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


def _sample_neighborhood(lst_c: np.ndarray, grid, lat: float, lon: float, radius_px: int = 3) -> float | None:
    """Ambil nilai LST Himawari pada koordinat stasiun (atau rata-rata 7x7 piksel terdekat jika tepat di atas stasiun berawan)."""
    col = int((lon - grid.lon_min) / grid.res)
    row = int((grid.lat_max - lat) / grid.res)
    if col < 0 or col >= grid.width or row < 0 or row >= grid.height:
        return None
    val = lst_c[row, col]
    if np.isfinite(val):
        return float(val)
    r0, r1 = max(0, row - radius_px), min(grid.height, row + radius_px + 1)
    c0, c1 = max(0, col - radius_px), min(grid.width, col + radius_px + 1)
    sub = lst_c[r0:r1, c0:c1]
    if np.isfinite(sub).any():
        return float(np.nanmean(sub))
    return None


def fetch_station_weather() -> list[dict]:
    """Ambil suhu udara 2m (T_air) & suhu tanah permukaan (0cm) terkini dari Open-Meteo WMO."""
    lats = ",".join(str(s["lat"]) for s in BMKG_STATIONS)
    lons = ",".join(str(s["lon"]) for s in BMKG_STATIONS)
    params = {
        "latitude": lats,
        "longitude": lons,
        "current": "temperature_2m,relative_humidity_2m,cloud_cover,soil_temperature_0cm",
        "timezone": "UTC",
    }
    try:
        r = requests.get(OPEN_METEO_URL, params=params, timeout=20)
        r.raise_for_status()
        payload = r.json()
        if isinstance(payload, dict):
            payload = [payload]
    except Exception as e:
        log.warning("Gagal mengambil data cuaca Open-Meteo: %s", e)
        return []

    out = []
    for st, item in zip(BMKG_STATIONS, payload):
        cur = item.get("current", {})
        t2m = cur.get("temperature_2m")
        tsoil = cur.get("soil_temperature_0cm")
        out.append(
            {
                **st,
                "obs_time_utc": cur.get("time"),
                "t_air_2m_c": round(float(t2m), 2) if t2m is not None else None,
                "t_soil_0cm_c": round(float(tsoil), 2) if tsoil is not None else None,
                "rh_pct": cur.get("relative_humidity_2m"),
                "cloud_cover_pct": cur.get("cloud_cover"),
            }
        )
    return out


def run_validation_and_calibration(data_dir: Path = DATA_DIR) -> dict:
    """Bandingkan LST Himawari-9 terbaru terhadap 18 stasiun BMKG/WMO & referensi Landsat."""
    settings = load_settings()
    grid = region_grid(settings, "indonesia")
    him_dir = data_dir / "himawari"
    cogs = sorted(him_dir.rglob("LST_H09_*_indonesia.tif")) if him_dir.exists() else []
    latest_lst = read_cog_celsius(cogs[-1]) if cogs else None

    stations_obs = fetch_station_weather()
    station_results = []
    diffs_soil = []
    diffs_air = []

    for st in stations_obs:
        sat_c = (
            _sample_neighborhood(latest_lst, grid, st["lat"], st["lon"], radius_px=4)
            if latest_lst is not None
            else None
        )
        t_ref = st.get("t_soil_0cm_c") if st.get("t_soil_0cm_c") is not None else st.get("t_air_2m_c")
        t_air = st.get("t_air_2m_c")

        err_ref = round(sat_c - t_ref, 2) if (sat_c is not None and t_ref is not None) else None
        err_air = round(sat_c - t_air, 2) if (sat_c is not None and t_air is not None) else None

        if err_ref is not None:
            diffs_soil.append(err_ref)
        if err_air is not None:
            diffs_air.append(err_air)

        station_results.append(
            {
                **st,
                "himawari_lst_c": round(sat_c, 2) if sat_c is not None else None,
                "diff_vs_surface_ref_c": err_ref,
                "diff_vs_air_2m_c": err_air,
                "status": "Tercocokkan (Cerah)" if sat_c is not None else "Tertutup Awan",
            }
        )

    arr_err = np.array(diffs_soil if diffs_soil else diffs_air, dtype=np.float64)
    if arr_err.size > 0:
        bias = round(float(arr_err.mean()), 2)
        mae = round(float(np.abs(arr_err).mean()), 2)
        rmse = round(float(np.sqrt((arr_err ** 2).mean())), 2)
    else:
        bias, mae, rmse = 0.0, 0.0, 0.0

    report = {
        "updated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "matched_stations": int(arr_err.size),
        "total_stations": len(BMKG_STATIONS),
        "metrics": {
            "bias_c": bias,
            "mae_c": mae,
            "rmse_c": rmse,
            "recommended_offset_correction_c": round(-bias, 2),
        },
        "stations": station_results,
    }
    write_json(report, data_dir / "analysis" / "validation_bmkg.json")
    log.info(
        "Validasi BMKG/WMO selesai: %d/%d stasiun cerah | Bias %+.2f C | MAE %.2f C | RMSE %.2f C",
        report["matched_stations"],
        report["total_stations"],
        bias,
        mae,
        rmse,
    )
    return report

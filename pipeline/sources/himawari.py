"""Akses data Himawari-9 AHI L1b Full Disk dari AWS Open Data (tanpa akun).

Struktur bucket:
    s3://noaa-himawari9/AHI-L1b-FLDK/YYYY/MM/DD/HHMM/
        HS_H09_YYYYMMDD_HHMM_Bnn_FLDK_R20_Sss10.DAT.bz2

Full disk 2 km = 5500 baris, dibagi 10 segmen @ 550 baris (segmen 1 = paling utara).
Hanya segmen yang mencakup wilayah yang diunduh.
"""

from __future__ import annotations

import bz2
import logging
import os
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
from pyproj import Proj

log = logging.getLogger(__name__)

S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}

# Parameter proyeksi geostasioner Himawari-9 (posisi nominal 140.7 BT)
AHI_SUB_LON = 140.7
AHI_H = 35785863.0
AHI_A = 6378137.0
AHI_B = 6356752.3
FLDK_LINES_2KM = 5500
SEGMENT_LINES_2KM = 550
FLDK_HALF_EXTENT_M = 5500000.0  # +- tepi full disk dalam meter proyeksi geos
PIXEL_M_2KM = 2.0 * FLDK_HALF_EXTENT_M / FLDK_LINES_2KM

_session = requests.Session()


@dataclass(frozen=True)
class HimawariFrame:
    time: datetime  # waktu nominal frame (UTC), mis. 14:30
    keys: tuple[str, ...]  # kunci objek S3 yang dibutuhkan

    @property
    def stamp(self) -> str:
        return self.time.strftime("%Y%m%d_%H%M")


def bucket_url(bucket: str) -> str:
    return f"https://{bucket}.s3.amazonaws.com"


def _list(bucket: str, prefix: str, delimiter: str | None = None) -> tuple[list[str], list[tuple[str, int]]]:
    """ListObjectsV2 via HTTPS. Mengembalikan (common_prefixes, [(key, size)])."""
    prefixes: list[str] = []
    objects: list[tuple[str, int]] = []
    token = None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if delimiter:
            params["delimiter"] = delimiter
        if token:
            params["continuation-token"] = token
        r = _session.get(bucket_url(bucket) + "/", params=params, timeout=30)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        for cp in root.findall("s3:CommonPrefixes/s3:Prefix", S3_NS):
            prefixes.append(cp.text)
        for c in root.findall("s3:Contents", S3_NS):
            objects.append((c.find("s3:Key", S3_NS).text, int(c.find("s3:Size", S3_NS).text)))
        if root.findtext("s3:IsTruncated", default="false", namespaces=S3_NS) == "true":
            token = root.findtext("s3:NextContinuationToken", namespaces=S3_NS)
        else:
            break
    return prefixes, objects


def required_segments(bbox: tuple[float, float, float, float], margin_lines: int = 20) -> list[int]:
    """Tentukan nomor segmen full disk (1..10) yang mencakup bbox [lon_min, lat_min, lon_max, lat_max]."""
    p = Proj(proj="geos", lon_0=AHI_SUB_LON, h=AHI_H, a=AHI_A, b=AHI_B, units="m")
    lon_min, lat_min, lon_max, lat_max = bbox
    lons, lats = np.meshgrid(np.linspace(lon_min, lon_max, 200), np.linspace(lat_min, lat_max, 200))
    x, y = p(lons, lats)
    y = np.asarray(y, dtype=float)
    y = y[np.isfinite(y) & (np.abs(y) < 1e20)]
    if y.size == 0:
        raise ValueError("Wilayah di luar cakupan Himawari")
    # proyeksi geos memakai h dari permukaan; konversi ke indeks baris (0 = utara)
    lines = (FLDK_HALF_EXTENT_M - y) / PIXEL_M_2KM
    l0 = max(0, int(np.floor(lines.min())) - margin_lines)
    l1 = min(FLDK_LINES_2KM - 1, int(np.ceil(lines.max())) + margin_lines)
    return list(range(l0 // SEGMENT_LINES_2KM + 1, l1 // SEGMENT_LINES_2KM + 2))


def _wanted_names(stamp_date: str, hhmm: str, sat: str, bands: list[str], segments: list[int]) -> set[str]:
    return {
        f"HS_{sat}_{stamp_date}_{hhmm}_{b}_FLDK_R20_S{s:02d}10.DAT.bz2" for b in bands for s in segments
    }


def find_latest_frame(
    cfg: dict, segments: list[int], now: datetime | None = None, at: datetime | None = None
) -> HimawariFrame:
    """Cari frame terbaru (atau frame pada waktu `at`) yang semua file-nya sudah tersedia."""
    bucket = cfg["bucket"]
    prefix0 = cfg["product_prefix"]
    sat = cfg["satellite_tag"]
    bands = cfg["bands"]

    if at is not None:
        candidates = [at]
    else:
        now = now or datetime.now(timezone.utc)
        oldest = now - timedelta(hours=cfg.get("search_back_hours", 3))
        candidates = []
        day = now.date()
        while day >= oldest.date():
            pre = f"{prefix0}/{day:%Y/%m/%d}/"
            folders, _ = _list(bucket, pre, delimiter="/")
            for f in folders:
                m = re.search(r"/(\d{4})/$", f)
                if not m:
                    continue
                t = datetime.strptime(f"{day:%Y%m%d}{m.group(1)}", "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                if oldest <= t <= now:
                    candidates.append(t)
            day -= timedelta(days=1)
        candidates.sort(reverse=True)

    for t in candidates:
        pre = f"{prefix0}/{t:%Y/%m/%d/%H%M}/"
        _, objs = _list(bucket, pre)
        names = {k.rsplit("/", 1)[-1]: k for k, _ in objs}
        wanted = _wanted_names(f"{t:%Y%m%d}", f"{t:%H%M}", sat, bands, segments)
        if wanted.issubset(names):
            return HimawariFrame(time=t, keys=tuple(sorted(names[w] for w in wanted)))
        log.info("Frame %s belum lengkap (%d/%d file)", t, len(wanted & names.keys()), len(wanted))
    raise RuntimeError("Tidak ada frame Himawari lengkap dalam rentang pencarian")


def _download_one(bucket: str, key: str, dest_dir: Path) -> Path:
    name = key.rsplit("/", 1)[-1]
    out = dest_dir / name.removesuffix(".bz2")
    if out.exists() and out.stat().st_size > 0:
        return out
    tmp = out.with_suffix(f"{out.suffix}.{os.getpid()}.part")
    url = f"{bucket_url(bucket)}/{key}"
    last_err = None
    for attempt in range(1, 4):
        try:
            chunks = []
            with requests.get(url, stream=True, timeout=(5, 8)) as r:
                r.raise_for_status()
                for ch in r.iter_content(chunk_size=262144):
                    if ch:
                        chunks.append(ch)
            raw_bz2 = b"".join(chunks)
            with open(tmp, "wb") as f:
                f.write(bz2.decompress(raw_bz2))
            if not out.exists():
                tmp.replace(out)
            elif tmp.exists():
                tmp.unlink(missing_ok=True)
            return out
        except Exception as e:
            last_err = e
            log.warning("Gagal unduh %s (percobaan %d/3): %s", name, attempt, e)
    raise RuntimeError(f"Gagal mengunduh {name}: {last_err}")


def download_frame(cfg: dict, frame: HimawariFrame, cache_dir: Path, workers: int = 3) -> list[Path]:
    """Unduh & dekompresi file frame ke cache_dir/<stamp>/. Mengembalikan path file .DAT."""
    dest = cache_dir / frame.stamp
    dest.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        paths = list(ex.map(lambda k: _download_one(cfg["bucket"], k, dest), frame.keys))
    return paths

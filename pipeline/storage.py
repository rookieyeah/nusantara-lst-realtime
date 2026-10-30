"""Manajemen manifest.json dan sinkronisasi ke Hugging Face Hub (Dataset Repo).

Mendukung dua mode:
1. Mode lokal / statis: membangun `data/manifest.json` dengan path relatif.
2. Mode Hugging Face Hub: mengunggah file COG, PNG, JSON, dan `manifest.json`
   ke repo dataset publik (`HF_REPO_REALTIME` & `HF_REPO_ARCHIVE`) menggunakan
   token `HF_TOKEN`, serta mendukung `super_squash_history()` agar ukuran Git
   tidak membengkak saat file lama dihapus.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from .config import DATA_DIR, load_settings

log = logging.getLogger(__name__)


def build_manifest(data_dir: Path = DATA_DIR, base_url: str = "") -> dict:
    """Pindai semua metadata frame di `data_dir/himawari` dan bangun `manifest.json`."""
    settings = load_settings()
    him_dir = data_dir / "himawari"
    prefix = base_url.rstrip("/") + "/" if base_url else ""

    by_region: dict[str, list[dict]] = {k: [] for k in settings["regions"]}

    if him_dir.exists():
        for jpath in sorted(him_dir.rglob("LST_H09_*.json")):
            try:
                with open(jpath, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception as e:
                log.warning("Gagal membaca %s: %s", jpath, e)
                continue

            reg = meta.get("region")
            if reg not in by_region:
                continue

            rel_dir = jpath.parent.relative_to(data_dir).as_posix()
            cog_name = meta["files"]["cog"]
            png_name = meta["files"]["png"]
            stamp = cog_name.removeprefix("LST_H09_").removesuffix(f"_{reg}.tif")

            by_region[reg].append(
                {
                    "stamp": stamp,
                    "time_utc": meta["time_utc"],
                    "latency_min": meta.get("latency_min"),
                    "cog_url": f"{prefix}{rel_dir}/{cog_name}",
                    "png_url": f"{prefix}{rel_dir}/{png_name}",
                    "json_url": f"{prefix}{rel_dir}/{jpath.name}",
                    "stats": meta.get("stats", {}),
                    "sizes_mb": meta.get("sizes_mb", {}),
                }
            )

    regions_out = {}
    for key, rcfg in settings["regions"].items():
        frames = sorted(by_region.get(key, []), key=lambda x: x["time_utc"])
        # Kumpulkan juga arsip agregat harian (MEAN, MAX, MIN) jika ada
        daily_list = []
        daily_root = data_dir / "archive" / "daily"
        if daily_root.exists():
            for dj in sorted(daily_root.rglob(f"LST_H09_DAILY_*_{key}.json")):
                # lewati jika nama file adalah stat spesifik (tidak ada, karena hanya 1 json per hari)
                try:
                    with open(dj, "r", encoding="utf-8") as f:
                        dmeta = json.load(f)
                    rel_d = dj.parent.relative_to(data_dir).as_posix()
                    day_stamp = dmeta["date"].replace("-", "")
                    daily_list.append(
                        {
                            "date": dmeta["date"],
                            "frames_used": dmeta.get("frames_used", 0),
                            "stats": dmeta,
                            "layers": {
                                st: {
                                    "cog_url": f"{prefix}{rel_d}/LST_H09_DAILY_{st.upper()}_{day_stamp}_{key}.tif",
                                    "png_url": f"{prefix}{rel_d}/LST_H09_DAILY_{st.upper()}_{day_stamp}_{key}.png",
                                }
                                for st in ("mean", "max", "min")
                            },
                        }
                    )
                except Exception as e:
                    log.warning("Gagal memuat arsip harian %s: %s", dj, e)

        # Kumpulkan juga komposit jam (hourly_composites) dan fusi gabungan multi-satelit (fused_archive)
        hourly_list = []
        hourly_root = data_dir / "composites" / "hourly"
        if hourly_root.exists():
            for hj in sorted(hourly_root.rglob(f"LST_HOURLY_*_{key}.json")):
                try:
                    with open(hj, "r", encoding="utf-8") as f:
                        hourly_list.append(json.load(f))
                except Exception as e:
                    log.warning("Gagal memuat komposit jam %s: %s", hj, e)

        fused_list = []
        fused_root = data_dir / "composites" / "fused"
        if fused_root.exists():
            for fj in sorted(fused_root.rglob(f"LST_FUSED_ALLSAT_*_{key}.json")):
                try:
                    with open(fj, "r", encoding="utf-8") as f:
                        fused_list.append(json.load(f))
                except Exception as e:
                    log.warning("Gagal memuat fusi %s: %s", fj, e)

        regions_out[key] = {
            "name": rcfg["name"],
            "bbox": rcfg["bbox"],
            "res_deg": settings["himawari"]["grid_resolution_deg"],
            "frame_count": len(frames),
            "latest": frames[-1]["time_utc"] if frames else None,
            "frames": frames,
            "hourly_composites": hourly_list,
            "daily_archive": daily_list,
            "fused_archive": fused_list,
        }

    # Sertakan metadata analisis lanjutan, multi-satelit (Fase 4-6), dan validasi BMKG bila tersedia
    extra: dict = {}
    for key_name, rel_file in [
        ("landsat", "landsat/catalog.json"),
        ("viirs", "viirs/catalog.json"),
        ("sentinel3", "sentinel3/catalog.json"),
        ("validation", "analysis/validation_bmkg.json"),
        ("analysis_indonesia", "analysis/indonesia/summary.json"),
        ("analysis_kalimantan", "analysis/kalimantan/summary.json"),
    ]:
        p = data_dir / rel_file
        if p.exists():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    extra[key_name] = json.load(f)
            except Exception as e:
                log.warning("Gagal memuat %s: %s", p, e)

    manifest = {
        "updated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "active_region": settings["active_region"],
        "time_Select_policy": {
            "realtime_10min_max_hours": 48,
            "hourly_max_days": 30,
            "daily_archive": "permanent",
            "monthly_archive": "permanent",
            "gibs_historical_min_date": "2012-01-01",
            "himawari_aws_min_date": "2015-07-07",
        },
        "preview": {
            "vmin_c": settings["output"]["preview_range_c"][0],
            "vmax_c": settings["output"]["preview_range_c"][1],
        },
        "encoding": {
            "scale": settings["output"]["scale"],
            "nodata": settings["output"]["nodata"],
            "units": "degC",
        },
        "regions": regions_out,
        **extra,
    }

    out_path = data_dir / "manifest.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    log.info("Manifest diperbarui: %s", out_path)
    return manifest


def upload_to_hf(
    data_dir: Path = DATA_DIR,
    repo_id: str | None = None,
    token: str | None = None,
) -> bool:
    """Unggah folder `data_dir` ke Hugging Face Hub dataset repository jika kredensial tersedia."""
    repo_id = repo_id or os.environ.get("HF_REPO_REALTIME")
    token = token or os.environ.get("HF_TOKEN")
    if not repo_id or not token:
        log.info("HF_REPO_REALTIME / HF_TOKEN belum diset; lewati unggah Hugging Face Hub.")
        return False

    try:
        from huggingface_hub import HfApi
    except ImportError:
        log.warning("Paket huggingface_hub belum terpasang; jalankan `pip install huggingface_hub`.")
        return False

    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="dataset", exist_ok=True, private=False)
    base_url = f"https://huggingface.co/datasets/{repo_id}/resolve/main"
    build_manifest(data_dir=data_dir, base_url=base_url)

    api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(data_dir),
        commit_message=f"Auto-update LST {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}",
    )
    log.info("Berhasil mengunggah data ke Hugging Face Hub: %s", repo_id)
    return True


def squash_hf_history(repo_id: str | None = None, token: str | None = None) -> bool:
    """Squash riwayat commit Git di repo realtime agar file terhapus tidak memakan kuota."""
    repo_id = repo_id or os.environ.get("HF_REPO_REALTIME")
    token = token or os.environ.get("HF_TOKEN")
    if not repo_id or not token:
        return False

    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.super_squash_history(
        repo_id=repo_id,
        repo_type="dataset",
        commit_message=f"Daily history squash {datetime.now(timezone.utc):%Y-%m-%d}",
    )
    log.info("Riwayat Git Hugging Face Hub berhasil di-squash: %s", repo_id)
    return True

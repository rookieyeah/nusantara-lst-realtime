"""Skrip Deployment Otomatis Tanpa Ketergantungan Git CLI (Hugging Face Hub & GitHub Pages).

Mendukung:
1. Deployment 1-Langkah ke Hugging Face Hub (Dataset Repo + Static Web Space Publik Gratis):
       python -m pipeline.deploy --hf-token hf_xxxxx

2. Deployment ke GitHub Repository + GitHub Actions (Cron 15m) + GitHub Pages via REST API:
       python -m pipeline.deploy --github-token ghp_xxxxx [--hf-token hf_xxxxx]
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

from .config import DATA_DIR, ROOT
from .storage import build_manifest

log = logging.getLogger("deploy")

SPACE_README_HEADER = """---
title: Nusantara LST — Sistem Pemantauan Suhu Permukaan Bumi Indonesia
emoji: 🛰️
colorFrom: yellow
colorTo: red
sdk: static
pinned: false
license: mit
---

# Nusantara Thermal & Surface Intelligence (Fase 1–6)
Sistem pemantauan & deteksi Suhu Permukaan Daratan (*Land Surface Temperature* / LST) multi-satelit untuk **Seluruh Indonesia** & **Pulau Kalimantan**.
"""


def deploy_to_huggingface(
    hf_token: str,
    dataset_name: str = "nusantara-lst-realtime",
    space_name: str = "nusantara-lst",
    sync_only: bool = False,
) -> dict:
    """Unggah data ke Hugging Face Dataset Repo dan publikasikan Web App ke Hugging Face Static Space."""
    from huggingface_hub import HfApi

    api = HfApi(token=hf_token)
    user_info = api.whoami()
    username = user_info["name"]
    log.info("Terautentikasi di Hugging Face Hub sebagai: %s", username)

    dataset_id = os.environ.get("HF_REPO_REALTIME") or f"{username}/{dataset_name}"
    space_id = os.environ.get("HF_SPACE_ID") or f"{username}/{space_name}"

    # 1. Buat & unggah ke Dataset Repository (penyimpanan berjenjang COG/PNG/JSON)
    log.info("Membuat / memeriksa Dataset Repo: %s ...", dataset_id)
    api.create_repo(repo_id=dataset_id, repo_type="dataset", exist_ok=True, private=False)

    # Bangun manifest dengan path relatif agar kompatibel di Space maupun lokal
    build_manifest(data_dir=DATA_DIR, base_url="")

    log.info("Mengunggah folder data/ ke Dataset Repo %s ...", dataset_id)
    api.upload_folder(
        repo_id=dataset_id,
        repo_type="dataset",
        folder_path=str(DATA_DIR),
        commit_message=f"Update LST data {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}",
    )
    dataset_url = f"https://huggingface.co/datasets/{dataset_id}"
    log.info("Dataset Repo aktif di: %s", dataset_url)

    # 2. Buat & unggah Web App Statis ke Hugging Face Space (sdk="static")
    log.info("Membuat / memeriksa Static Web Space: %s ...", space_id)
    api.create_repo(
        repo_id=space_id,
        repo_type="space",
        space_sdk="static",
        exist_ok=True,
        private=False,
    )

    readme_path = ROOT / "README.md"
    if not readme_path.exists() or not readme_path.read_text(encoding="utf-8").startswith("---"):
        readme_path.write_text(SPACE_README_HEADER, encoding="utf-8")

    log.info("Mengunggah aplikasi web, static DEM/landmask, & data ke Space %s ...", space_id)
    api.upload_folder(
        repo_id=space_id,
        repo_type="space",
        folder_path=str(ROOT),
        ignore_patterns=[
            ".venv/**",
            ".venv/*",
            "__pycache__/**",
            "*.pyc",
            "data/raw/**",
            ".git/**",
        ],
        commit_message=f"Deploy Nusantara LST Web App {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}",
    )

    space_host = f"{username}-{space_name}".lower().replace("_", "-")
    live_web_url = f"https://{space_host}.hf.space/web/index.html"
    space_page_url = f"https://huggingface.co/spaces/{space_id}"

    log.info("=== DEPLOYMENT HUGGING FACE SELESAI ===")
    log.info("URL Web App Langsung : %s", live_web_url)
    log.info("Halaman Space HF     : %s", space_page_url)
    log.info("Halaman Dataset HF   : %s", dataset_url)

    return {
        "username": username,
        "dataset_id": dataset_id,
        "dataset_url": dataset_url,
        "space_id": space_id,
        "space_page_url": space_page_url,
        "live_web_url": live_web_url,
    }


def deploy_to_github_api(
    github_token: str,
    repo_name: str = "nusantara-lst-realtime",
) -> dict:
    """Unggah seluruh proyek + GitHub Actions & aktifkan GitHub Pages menggunakan GitHub REST API (tanpa git CLI)."""
    headers = {
        "Authorization": f"Bearer {github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    r_user = requests.get("https://api.github.com/user", headers=headers, timeout=20)
    r_user.raise_for_status()
    owner = r_user.json()["login"]
    full_repo = f"{owner}/{repo_name}"
    log.info("Terautentikasi di GitHub sebagai: %s", owner)

    # Buat repo jika belum ada
    r_check = requests.get(f"https://api.github.com/repos/{full_repo}", headers=headers, timeout=20)
    if r_check.status_code == 404:
        log.info("Membuat repository publik GitHub baru: %s ...", full_repo)
        r_create = requests.post(
            "https://api.github.com/user/repos",
            headers=headers,
            json={
                "name": repo_name,
                "description": "Nusantara LST — Pemantauan Suhu Permukaan Bumi Near-Realtime Multi-Satelit Indonesia",
                "private": False,
                "auto_init": True,
            },
            timeout=30,
        )
        r_create.raise_for_status()

    # Dapatkan SHA branch main (dengan retry singkat jika repo baru saja dibuat)
    import time
    base_commit_sha = None
    for attempt in range(5):
        r_ref = requests.get(f"https://api.github.com/repos/{full_repo}/git/ref/heads/main", headers=headers, timeout=20)
        if r_ref.status_code == 200:
            base_commit_sha = r_ref.json()["object"]["sha"]
            break
        time.sleep(2)
    if not base_commit_sha:
        r_ref.raise_for_status()

    # Kumpulkan file proyek untuk diunggah
    tree_items = []
    skip_dirs = {".venv", "__pycache__", ".git"}
    for p in sorted(ROOT.rglob("*")):
        if p.is_dir():
            continue
        rel_parts = p.relative_to(ROOT).parts
        if any(part in skip_dirs for part in rel_parts):
            continue
        if rel_parts[:2] == ("data", "raw"):
            continue
        rel_posix = p.relative_to(ROOT).as_posix()
        raw_bytes = p.read_bytes()
        # Buat blob
        r_blob = requests.post(
            f"https://api.github.com/repos/{full_repo}/git/blobs",
            headers=headers,
            json={"content": base64.b64encode(raw_bytes).decode("ascii"), "encoding": "base64"},
            timeout=60,
        )
        r_blob.raise_for_status()
        tree_items.append(
            {
                "path": rel_posix,
                "mode": "100644",
                "type": "blob",
                "sha": r_blob.json()["sha"],
            }
        )

    log.info("Membuat Git Tree (%d file) di %s ...", len(tree_items), full_repo)
    r_tree = requests.post(
        f"https://api.github.com/repos/{full_repo}/git/trees",
        headers=headers,
        json={"base_tree": base_commit_sha, "tree": tree_items},
        timeout=60,
    )
    r_tree.raise_for_status()

    r_commit = requests.post(
        f"https://api.github.com/repos/{full_repo}/git/commits",
        headers=headers,
        json={
            "message": f"Deploy Nusantara LST Fase 1-6 ({datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC})",
            "tree": r_tree.json()["sha"],
            "parents": [base_commit_sha],
        },
        timeout=30,
    )
    r_commit.raise_for_status()
    new_sha = r_commit.json()["sha"]

    requests.patch(
        f"https://api.github.com/repos/{full_repo}/git/refs/heads/main",
        headers=headers,
        json={"sha": new_sha, "force": True},
        timeout=20,
    ).raise_for_status()

    # Aktifkan GitHub Pages (build_type: workflow)
    requests.post(
        f"https://api.github.com/repos/{full_repo}/pages",
        headers=headers,
        json={"build_type": "workflow", "source": {"branch": "main", "path": "/"}},
        timeout=20,
    )

    pages_url = f"https://{owner}.github.io/{repo_name}/web/index.html"
    repo_url = f"https://github.com/{full_repo}"
    log.info("=== DEPLOYMENT GITHUB SELESAI ===")
    log.info("Repository GitHub : %s", repo_url)
    log.info("URL GitHub Pages  : %s", pages_url)
    return {"owner": owner, "repo": full_repo, "repo_url": repo_url, "pages_url": pages_url}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN"), help="Token Write Hugging Face Hub (hf_...)")
    ap.add_argument("--github-token", default=os.environ.get("GITHUB_TOKEN"), help="Token GitHub PAT (ghp_...)")
    ap.add_argument("--dataset-name", default="nusantara-lst-realtime", help="Nama repo dataset HF")
    ap.add_argument("--space-name", default="nusantara-lst", help="Nama repo Space HF")
    ap.add_argument("--github-repo", default="nusantara-lst-realtime", help="Nama repo GitHub")
    ap.add_argument("--sync-only", action="store_true", help="Sinkronisasi data dari GitHub Actions")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)

    if not args.hf_token and not args.github_token:
        log.error("Harap berikan --hf-token <hf_...> dan/atau --github-token <ghp_...>.")
        sys.exit(1)

    results = {}
    if args.hf_token:
        results["huggingface"] = deploy_to_huggingface(
            hf_token=args.hf_token,
            dataset_name=args.dataset_name,
            space_name=args.space_name,
            sync_only=args.sync_only,
        )
    if args.github_token:
        results["github"] = deploy_to_github_api(
            github_token=args.github_token,
            repo_name=args.github_repo,
        )
    print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

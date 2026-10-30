"""Server HTTP lokal untuk evaluasi web + endpoint pengambilan frame Himawari sesuai tanggal/jam pilihan."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .config import DATA_DIR, ROOT
from .processing.fusion import build_hourly_composites, build_multi_sensor_fusion
from .retention import aggregate_day
from .run_himawari import run as run_himawari
from .storage import build_manifest

log = logging.getLogger("server")


class LSTRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/fetch_frame":
            qs = parse_qs(parsed.query)
            region = (qs.get("region") or ["indonesia"])[0]
            time_str = (qs.get("time") or [""])[0]
            try:
                log.info("Permintaan on-demand dari Web: region=%s time=%s", region, time_str)
                # Proses untuk kedua wilayah; simpan raw saat wilayah pertama agar wilayah kedua tidak mengunduh ulang
                meta = run_himawari(region=region, at=time_str if time_str else None, out_dir=DATA_DIR, keep_raw=True)
                other = "kalimantan" if region == "indonesia" else "indonesia"
                try:
                    run_himawari(region=other, at=time_str if time_str else None, out_dir=DATA_DIR, keep_raw=False)
                except Exception:
                    pass
                try:
                    dt_day = datetime.fromisoformat(meta["time_utc"]).date()
                    for reg in ("indonesia", "kalimantan"):
                        build_hourly_composites(dt_day, reg, DATA_DIR)
                        aggregate_day(dt_day, reg, DATA_DIR)
                        build_multi_sensor_fusion(dt_day, reg, DATA_DIR)
                    build_manifest(DATA_DIR)
                except Exception as exc:
                    log.warning("Gagal memperbarui komposit pasca-fetch: %s", exc)
                body = json.dumps({"ok": True, "meta": meta}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                log.warning("Gagal mengambil frame %s: %s", time_str, e)
                body = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return

        super().do_GET()


def main(port: int = 8080) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    srv = ThreadingHTTPServer(("127.0.0.1", port), LSTRequestHandler)
    log.info("Server Nusantara LST berjalan di http://localhost:%d/web/", port)
    srv.serve_forever()


if __name__ == "__main__":
    main()

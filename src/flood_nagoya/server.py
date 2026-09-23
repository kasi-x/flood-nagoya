"""Local static server for the web app (``python -m flood_nagoya serve``)."""

from __future__ import annotations

import contextlib
import errno
import http.server
import webbrowser
from functools import partial

from .config import WEB_DIR


class _NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """Static files with no-store: the app is under active development."""

    def end_headers(self) -> None:  # pyright: ignore[reportImplicitOverride] - stdlib override
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve(host: str = "127.0.0.1", port: int = 8642, *, open_browser: bool = False) -> None:
    if not (WEB_DIR / "index.html").exists() or not (WEB_DIR / "meta.json").exists():
        msg = (
            f"{WEB_DIR} に index.html / meta.json がありません — 先に `python -m flood_nagoya build` を実行してください"
        )
        raise SystemExit(msg)
    handler = partial(_NoCacheHandler, directory=str(WEB_DIR))
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    try:
        with http.server.ThreadingHTTPServer((host, port), handler) as httpd:
            url = f"http://{host}:{port}/"
            print(f"serving {WEB_DIR} at {url} (Ctrl-C to stop)", flush=True)
            if open_browser:
                webbrowser.open(url)
            with contextlib.suppress(KeyboardInterrupt):
                httpd.serve_forever()
    except OSError as exc:
        if exc.errno in (errno.EADDRINUSE, 98, 48):
            msg = f"port {port} already in use — stop the other server first"
            raise SystemExit(msg) from exc
        raise

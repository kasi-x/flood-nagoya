"""Local static server for the web app (``python -m flood_nagoya serve``)."""

from __future__ import annotations

import contextlib
import http.server
import socketserver
import webbrowser
from functools import partial

from .config import WEB_DIR


class _NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """Static files with no-store: the app is under active development."""

    def end_headers(self) -> None:  # pyright: ignore[reportImplicitOverride] - stdlib override
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve(host: str = "127.0.0.1", port: int = 8642, *, open_browser: bool = False) -> None:
    if not (WEB_DIR / "index.html").exists():
        msg = f"{WEB_DIR}/index.html not found — run the build first"
        raise SystemExit(msg)
    handler = partial(_NoCacheHandler, directory=str(WEB_DIR))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((host, port), handler) as httpd:
        url = f"http://{host}:{port}/"
        print(f"serving {WEB_DIR} at {url} (Ctrl-C to stop)", flush=True)
        if open_browser:
            webbrowser.open(url)
        with contextlib.suppress(KeyboardInterrupt):
            httpd.serve_forever()

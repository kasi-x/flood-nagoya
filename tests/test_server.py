"""Server / config tests: WEB_DIR override and CLI wiring for containers."""

from __future__ import annotations

from pathlib import Path

import pytest


def test_web_dir_override(monkeypatch: pytest.MonkeyPatch) -> None:
    from flood_nagoya.config import PROJECT_ROOT, _web_dir

    monkeypatch.delenv("FLOOD_NAGOYA_WEB_DIR", raising=False)
    assert _web_dir() == PROJECT_ROOT / "web"
    monkeypatch.setenv("FLOOD_NAGOYA_WEB_DIR", "/srv/flood-nagoya-web")
    assert _web_dir() == Path("/srv/flood-nagoya-web")


def test_serve_requires_built_assets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from flood_nagoya import server

    monkeypatch.setattr(server, "WEB_DIR", tmp_path)
    with pytest.raises(SystemExit, match="build"):
        server.serve()
    # a lone index.html is not enough — meta.json marks a completed build
    (tmp_path / "index.html").write_text("<html></html>", encoding="utf-8")
    with pytest.raises(SystemExit, match="build"):
        server.serve()


def test_cli_serve_host_port(monkeypatch: pytest.MonkeyPatch) -> None:
    from flood_nagoya import __main__

    calls: dict[str, object] = {}

    def fake_serve(**kwargs: object) -> None:
        calls.update(kwargs)

    monkeypatch.setattr("flood_nagoya.server.serve", fake_serve)
    __main__.main(["serve", "--host", "0.0.0.0", "--port", "9000"])
    assert calls == {"host": "0.0.0.0", "port": 9000, "open_browser": False}


def test_serve_serves_files_and_no_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """serve() binds a real port, serves web assets with no-store, and stops."""
    import http.server
    import threading
    import urllib.request

    from flood_nagoya import server

    (tmp_path / "index.html").write_text("<html>ok</html>", encoding="utf-8")
    (tmp_path / "meta.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(server, "WEB_DIR", tmp_path)

    captured: dict[str, http.server.ThreadingHTTPServer] = {}
    real_cls = http.server.ThreadingHTTPServer

    class Spy(real_cls):
        def __init__(
            self,
            server_address: tuple[str, int],
            handler: type[http.server.BaseHTTPRequestHandler],
            *,
            bind_and_activate: bool = True,
        ) -> None:
            super().__init__(server_address, handler, bind_and_activate)
            captured["srv"] = self

    monkeypatch.setattr(http.server, "ThreadingHTTPServer", Spy)

    thread = threading.Thread(
        target=server.serve,
        kwargs={"host": "127.0.0.1", "port": 0},
        daemon=True,
    )
    thread.start()
    try:
        for _ in range(100):
            if "srv" in captured:
                break
            thread.join(0.05)
        srv = captured["srv"]
        port = srv.server_address[1]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=5) as res:
            assert res.status == 200
            assert res.read() == b"<html>ok</html>"
            assert res.headers["Cache-Control"] == "no-store"
    finally:
        captured["srv"].shutdown()
        thread.join(timeout=5)
    assert not thread.is_alive()

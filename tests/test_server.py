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

"""Tests for the satellite search/download helpers (all network mocked)."""

from __future__ import annotations

import email.message
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Self

import pytest

from flood_nagoya import satellite
from flood_nagoya.satellite import asf_search
from flood_nagoya.satellite import bearer_token
from flood_nagoya.satellite import cmr_granules
from flood_nagoya.satellite import download
from flood_nagoya.satellite import tellus_data_search
from flood_nagoya.satellite import tellus_datasets


class _Resp:
    def __init__(self, payload: bytes = b"") -> None:
        self._payload = payload

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            out, self._payload = self._payload, b""
            return out
        out, self._payload = self._payload[:size], self._payload[size:]
        return out


def _fake_json(payload: object, captured: dict[str, str]):
    def fake(req: urllib.request.Request, timeout: float) -> _Resp:  # noqa: ARG001
        captured["url"] = req.full_url
        captured["auth"] = req.headers.get("Authorization", "")
        return _Resp(json.dumps(payload).encode())

    return fake


def test_user_agent_names_project() -> None:
    assert satellite.USER_AGENT.startswith("flood-nagoya/")


def test_bearer_token_prefers_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EARTHDATA_TOKEN", "env-tok")
    assert bearer_token() == "env-tok"


def test_bearer_token_missing_env_and_netrc(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("EARTHDATA_TOKEN", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))  # no .netrc there
    assert bearer_token() is None


def test_asf_search_flattens_groups(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}
    payload = [[{"granuleName": "A"}, {"granuleName": "B"}]]
    monkeypatch.setattr(urllib.request, "urlopen", _fake_json(payload, captured))
    scenes = asf_search({"platform": "SENTINEL-1"}, token="t")
    assert [s["granuleName"] for s in scenes] == ["A", "B"]
    assert "api.daac.asf.alaska.edu" in captured["url"]
    assert "platform=SENTINEL-1" in captured["url"]
    assert captured["auth"] == "Bearer t"


def test_asf_search_empty_without_list(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(urllib.request, "urlopen", _fake_json({}, {}))
    assert asf_search({}) == []


def test_cmr_granules_builds_query(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}
    payload = {"feed": {"entry": [{"title": "granule-1"}, "not-a-dict"]}}
    monkeypatch.setattr(urllib.request, "urlopen", _fake_json(payload, captured))
    entries = cmr_granules("C123-X", bbox=(136.6, 34.9, 137.2, 35.4), temporal=("2026-09-08", "2026-09-09"))
    assert [e["title"] for e in entries] == ["granule-1"]
    assert "collection_concept_id=C123-X" in captured["url"]
    assert "bounding_box=" in captured["url"]
    assert captured["auth"] == ""  # no token → no auth header


def test_tellus_datasets_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}
    payload = {"results": [{"id": "d1", "name": "PALSAR-2"}]}
    monkeypatch.setattr(urllib.request, "urlopen", _fake_json(payload, captured))
    assert tellus_datasets("tok") == [{"id": "d1", "name": "PALSAR-2"}]
    assert captured["auth"] == "Bearer tok"


def test_tellus_data_search_returns_features(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}
    payload = {"features": [{"id": "s1"}], "meta": {"total": 1}}
    monkeypatch.setattr(urllib.request, "urlopen", _fake_json(payload, captured))
    scenes = tellus_data_search("did", "tok", "2026-09-01", "2026-09-15", [[136.7, 35.0]])
    assert scenes == [{"id": "s1"}]
    assert "data-search" in captured["url"]


def test_download_streams_to_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: dict[str, str] = {}

    def fake(req: urllib.request.Request, timeout: float) -> _Resp:  # noqa: ARG001
        captured["auth"] = req.headers.get("Authorization", "")
        return _Resp(b"x" * 100)

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    dest = tmp_path / "sub" / "scene.zip"
    out = download("https://example.invalid/scene.zip", dest, token="t", chunk=7)
    assert out == dest
    assert dest.stat().st_size == 100
    assert captured["auth"] == "Bearer t"


def test_download_removes_partial_on_http_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def fake(req: urllib.request.Request, timeout: float) -> _Resp:  # noqa: ARG001
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", email.message.Message(), None)

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    dest = tmp_path / "scene.zip"
    dest.write_bytes(b"partial")
    with pytest.raises(urllib.error.HTTPError):
        download("https://example.invalid/scene.zip", dest)
    assert not dest.exists()

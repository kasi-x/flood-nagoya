"""Tests for the MLIT XRAIN display-image ingest pipeline."""

from __future__ import annotations

import datetime as dt
import http.client
import io
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING
from typing import Self

import numpy as np
import pytest
from PIL import Image

from flood_nagoya import spatial
from flood_nagoya import xrain
from flood_nagoya.xrain import LEGEND
from flood_nagoya.xrain import RetentionError
from flood_nagoya.xrain import XrainTile
from flood_nagoya.xrain import decode_tile_png
from flood_nagoya.xrain import fetch_master
from flood_nagoya.xrain import frame_urls
from flood_nagoya.xrain import get_bytes
from flood_nagoya.xrain import overlapping_tiles
from flood_nagoya.xrain import sample_tiles
from flood_nagoya.xrain import tile_bounds
from flood_nagoya.xrain import _hhmm_candidates

if TYPE_CHECKING:
    import pytest_mock

EVENT_DAY = dt.date(2026, 9, 16)

# 名古屋市を含むタイル (北緯34.67〜35.33度・東経136〜137度) と南東の市外タイル
AREA_INFO: list[dict[str, int]] = [
    {"seq": 1, "areaCd": 83, "meshFrom": 5236, "meshTo": 5236},
    {"seq": 2, "areaCd": 83, "meshFrom": 4840, "meshTo": 4841},
]
MASTER = {"type": "xrain", "level": 3, "areaInfo": AREA_INFO}


def _rgb(hexcolor: str) -> tuple[int, int, int]:
    return int(hexcolor[0:2], 16), int(hexcolor[2:4], 16), int(hexcolor[4:6], 16)


def _tile(seq: int, mesh_from: int, mesh_to: int) -> XrainTile:
    return XrainTile(
        seq=seq,
        areaCd=83,
        meshFrom=mesh_from,
        meshTo=mesh_to,
        bounds=tile_bounds(mesh_from, mesh_to),
    )


def _png_of(colors: list[tuple[int, int, int]], size: tuple[int, int] = (4, 2)) -> bytes:
    image = Image.new("RGB", size)
    image.putdata(colors + [(0, 0, 0)] * (size[0] * size[1] - len(colors)))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _solid_png(color: tuple[int, int, int], size: tuple[int, int] = (8, 4)) -> bytes:
    image = Image.new("RGB", size, color)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def test_tile_bounds_matches_kawabou_formula() -> None:
    lat_min, lat_max, lon_min, lon_max = tile_bounds(5236, 5237)
    assert lat_min == pytest.approx(52 / 1.5)
    assert lat_max == pytest.approx(53 / 1.5)
    assert lon_min == pytest.approx(136.0)
    assert lon_max == pytest.approx(138.0)


def test_overlapping_tiles_filters_by_study_bbox() -> None:
    master = [_tile(e["seq"], e["meshFrom"], e["meshTo"]) for e in AREA_INFO]
    kept = overlapping_tiles(master)
    assert [t["seq"] for t in kept] == [1]  # only the Nagoya tile


def test_frame_urls_compose_area_level_and_stamp() -> None:
    urls = frame_urls(EVENT_DAY, "1300", [_tile(7, 5236, 5237)], 3)
    assert urls == ["https://www.river.go.jp/kawabou/file/radar/image/xrd/83/3/20260916/1300/7.png"]


def test_hhmm_candidates_skip_negative_minutes() -> None:
    assert _hhmm_candidates(0) == ["0000", "0001", "0002", "0003"]
    assert _hhmm_candidates(300)[0] == "0500"  # 05:00 JST


def test_decode_tile_png_maps_legend_colors() -> None:
    colors = [_rgb(LEGEND[i][0]) for i in (0, 3, 7)] + [_rgb(xrain.MISSING_HEX)]
    payload = _png_of(colors)
    values = decode_tile_png(payload)
    assert values.shape == (2, 4)
    assert values[0, 0] == pytest.approx(LEGEND[0][3])  # 1-5 mm/h → 中央値 3
    assert values[0, 1] == pytest.approx(LEGEND[3][3])  # 20-30 mm/h → 25
    assert values[0, 2] == pytest.approx(LEGEND[7][3])  # 100+ mm/h → 110
    assert np.isnan(values[0, 3])  # 欠測
    assert values[1, 0] == 0.0  # 階級未満は乾き


def test_sample_tiles_nearest_and_composite() -> None:
    lat2d = np.array([[35.3, 35.3, 35.3], [34.7, 34.7, 34.7]])
    lon2d = np.array([[136.8, 137.0, 137.2]] * 2)
    values = np.arange(9, dtype=np.float32).reshape(3, 3)
    # tile bounds: lat 34.667-36.0, lon 136-137.25 → covers the 2x3 target grid
    out = sample_tiles([((34.0 + 2 / 3, 36.0, 136.0, 137.25), values)], lat2d, lon2d)
    assert out.shape == (2, 3)
    assert not np.isnan(out).any()
    # 北端行は tile の最上行寄り、南端行は最下行寄りに対応する
    assert out[0, 0] in values[:2].ravel()
    assert out[1, 2] in values[-2:].ravel()


def test_get_bytes_404_returns_none_and_retry_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("flood_nagoya.xrain.time.sleep", lambda _s: None)

    class _Resp:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def read(self) -> bytes:
            return b"ok"

    calls: list[int] = []

    def fake_urlopen(req: urllib.request.Request, timeout: float) -> _Resp:  # noqa: ARG001
        calls.append(1)
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 404, "gone", http.client.HTTPMessage(), io.BytesIO(b""))
        return _Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    assert get_bytes("https://example.invalid/missing.png") is None
    assert get_bytes("https://example.invalid/ok.png") == b"ok"
    assert len(calls) == 2


def test_get_bytes_retries_on_network_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flood_nagoya.xrain.time.sleep", lambda _s: None)
    attempts: list[int] = []

    def fake_urlopen(req: urllib.request.Request, timeout: float) -> object:  # noqa: ARG001
        attempts.append(1)
        raise urllib.error.URLError("down")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(urllib.error.URLError):
        get_bytes("https://example.invalid/x", retries=3)
    assert len(attempts) == 3


def test_fetch_master_parses_and_attaches_bounds(
    mocker: pytest_mock.MockerFixture,
) -> None:
    mocker.patch.object(xrain, "get_bytes", return_value=json.dumps({"areaInfo": AREA_INFO}).encode())
    tiles = fetch_master(3)
    assert tiles[0]["bounds"] == tile_bounds(5236, 5236)
    assert tiles[1]["seq"] == 2


def test_fetch_master_missing_raises(mocker: pytest_mock.MockerFixture) -> None:
    mocker.patch.object(xrain, "get_bytes", return_value=None)
    with pytest.raises(RuntimeError, match="master mesh list"):
        fetch_master(3)


def test_build_day_scenario_guards_dates() -> None:
    with pytest.raises(ValueError, match="future"):
        xrain.build_day_scenario(dt.date(9999, 12, 31))
    with pytest.raises(RetentionError, match="retention"):
        xrain.build_day_scenario(dt.date(2020, 1, 1))


def test_build_day_scenario_no_frames_raises(mocker: pytest_mock.MockerFixture, tmp_path: Path) -> None:
    mocker.patch.object(xrain, "fetch_master", return_value=[])
    mocker.patch.object(xrain, "get_bytes", return_value=None)
    with pytest.raises(RuntimeError, match="no XRAIN"):
        xrain.build_day_scenario(EVENT_DAY, out_dir=tmp_path)


def test_build_day_scenario_full_flow(mocker: pytest_mock.MockerFixture, tmp_path: Path) -> None:
    master = [_tile(e["seq"], e["meshFrom"], e["meshTo"]) for e in AREA_INFO]
    mocker.patch.object(xrain, "fetch_master", return_value=master)
    mocker.patch.object(xrain, "get_bytes", return_value=_solid_png(_rgb(LEGEND[2][0])))
    small_lat = np.array([[35.2, 35.2, 35.2], [35.0, 35.0, 35.0]])
    small_lon = np.array([[136.8, 136.9, 137.0]] * 2)
    mocker.patch.object(xrain, "overview_lat_lon", return_value=(small_lat, small_lon))

    path = xrain.build_day_scenario(EVENT_DAY, level=3, out_dir=tmp_path, parallel=4)
    assert path.name == "rain_20260916_xrain.json"
    scenario = json.loads(path.read_text(encoding="utf-8"))
    assert scenario["kind"] == "xrain"
    assert scenario["frame_seconds"] == 300
    assert scenario["geo"]["width"] == spatial.overview_shape()[0]
    assert scenario["geo"]["height"] == spatial.overview_shape()[1]
    n_frames = len(scenario["frames"])
    assert n_frames > 0
    frame_pngs = list(path.parent.glob("rain_20260916_xrain/f*.png"))
    assert len(frame_pngs) == n_frames
    # すべてのフレームで雨 (階級 10-20mm/h の中央値 15) が降っている
    assert scenario["peak_mmh"] == pytest.approx(15.0)
    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    entry = next(e for e in index if e["file"] == "rain_20260916_xrain.json")
    assert "XRAINレーダー" in entry["name"]

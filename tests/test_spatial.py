"""Tests for the shared spatial-rain scenario plumbing."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import numpy as np
import pytest

from flood_nagoya import spatial
from flood_nagoya.gsitiles import bbox_tile_range
from flood_nagoya.spatial import build_spatial_scenario
from flood_nagoya.spatial import decode_frame_png
from flood_nagoya.spatial import encode_frame_png
from flood_nagoya.spatial import frame_series
from flood_nagoya.spatial import overview_shape
from flood_nagoya.spatial import tile_origin


def test_overview_shape_matches_tile_range() -> None:
    width, height = overview_shape()
    assert width > 0 and height > 0
    # the grid must be a multiple of the overview factor wide/tall
    assert width % spatial.OVERVIEW_FACTOR == 0
    assert height % spatial.OVERVIEW_FACTOR == 0


def test_tile_origin_is_mosaic_north_west() -> None:
    x0, _, y0, _ = bbox_tile_range()
    assert tile_origin() == (x0, y0)


def test_frame_png_roundtrip(tmp_path: Path) -> None:
    mmh = np.array([[0.0, 0.4], [2.7, 500.0]], dtype=np.float32)  # 500 → clipped
    path = tmp_path / "f.png"
    encode_frame_png(mmh, path)
    decoded = decode_frame_png(path)
    assert decoded[0, 0] == pytest.approx(0.0)
    assert decoded[0, 1] == pytest.approx(0.5)  # 0.4 rounds to count 1
    assert decoded[1, 0] == pytest.approx(2.5)
    assert decoded[1, 1] == pytest.approx(255 * spatial.MMH_PER_COUNT)


def test_build_spatial_scenario_metadata() -> None:
    fields = [np.array([2.0]), np.array([6.0])]
    scenario = build_spatial_scenario("xrain", date(2026, 9, 16), 3600, fields, {"source": "src", "note": "note"})
    assert scenario["kind"] == "xrain"
    assert scenario["date"] == "2026-09-16"
    assert scenario["frame_seconds"] == 3600
    assert scenario["mmh_per_count"] == spatial.MMH_PER_COUNT
    assert scenario["file"] == "rain_20260916_xrain.json"
    assert scenario["total_mm"] == pytest.approx(8.0)  # (2 + 6) mm/h x 1h
    assert scenario["peak_mmh"] == pytest.approx(6.0)
    assert scenario["geo"]["factor"] == spatial.OVERVIEW_FACTOR
    assert scenario["frames"][1] == {"t": 3600, "file": "f0001.png"}
    assert scenario["source"] == "src" and scenario["note"] == "note"


def test_frame_series_handles_nan_and_closes_at_zero() -> None:
    series = frame_series([np.array([np.nan, 4.0])], 300)
    assert series[0] == [0, 4.0]  # NaN ignored by nanmean
    assert series[-1] == [300, 0.0]


def test_write_spatial_scenario_updates_index(tmp_path: Path) -> None:
    scenario = build_spatial_scenario("msm", date(2026, 9, 8), 3600, [np.array([1.0])], {"source": "s", "note": "n"})
    path = spatial.write_spatial_scenario(scenario, tmp_path)
    assert path.name == "rain_20260908_msm.json"
    index = (tmp_path / "index.json").read_text(encoding="utf-8")
    assert "名古屋 MSM較正 2026-09-08" in index
    assert "(MSM較正)" in index

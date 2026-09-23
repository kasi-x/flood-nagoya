"""Unit tests for the core geometry/encoding/hydrology helpers."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from flood_nagoya import pipeline
from flood_nagoya.config import LAT_MAX, LAT_MIN, LON_MAX, LON_MIN, Z15_M_PER_PX
from flood_nagoya.gsitiles import (
    bbox_tile_range,
    lat_to_tile_y,
    lon_to_tile_x,
    parse_dem_txt,
    tile_x_to_lon,
    tile_y_to_lat,
)
from flood_nagoya.hydro import (
    d8_flow_directions,
    drainage_network_mask,
    fill_sinks_priority_flood,
    flow_accumulation,
)
from flood_nagoya.pipeline import build_overview, elevation_to_rgba, fill_voids
from PIL import Image


def test_tile_math_roundtrip() -> None:
    lon, lat = 136.9, 35.17
    x = lon_to_tile_x(lon)
    y = lat_to_tile_y(lat)
    assert tile_x_to_lon(x) == pytest.approx(lon, abs=1e-9)
    assert tile_y_to_lat(y) == pytest.approx(lat, abs=1e-9)
    # mercator y grows towards the south
    assert lat_to_tile_y(LAT_MAX) < lat_to_tile_y(LAT_MIN)


def test_bbox_tile_range_covers_bbox() -> None:
    x0, x1, y0, y1 = bbox_tile_range()
    assert 0 <= x0 <= x1 < 2**15
    assert 0 <= y0 <= y1 < 2**15
    # tile area must contain the study bbox corners
    west = tile_x_to_lon(x0)
    east = tile_x_to_lon(x1 + 1)
    assert west <= LON_MIN and east >= LON_MAX


def _encode_tile(values: list[list[str]]) -> bytes:
    body = "\n".join(",".join(row) for row in values)
    return body.encode("ascii")


def test_parse_dem_txt_valid_and_voids() -> None:
    from flood_nagoya.gsitiles import TILE_SIZE

    rows = [[str(10.0 + r) for _ in range(TILE_SIZE)] for r in range(TILE_SIZE)]
    rows[5] = ["e"] * TILE_SIZE
    data = parse_dem_txt(_encode_tile(rows))
    assert data.shape == (TILE_SIZE, TILE_SIZE)
    assert data[0, 0] == pytest.approx(10.0)
    assert np.isnan(data[5, 3])
    with pytest.raises(ValueError, match="rows"):
        parse_dem_txt(_encode_tile([["1"]]))


def test_fill_sinks_and_flow_accumulation() -> None:
    # a 5x5 plane sloping towards (0,0) with a sunken cell at (3, 3)
    dem = np.fromfunction(lambda y, x: 20.0 - (x + y) * 2.0, (5, 5))
    dem[3, 3] = 1.0
    filled = fill_sinks_priority_flood(dem, epsilon=0.01)
    # the depression is raised to (about) its spill elevation
    assert filled[3, 3] > dem[3, 3]
    assert filled[3, 3] < dem[2, 2]
    directions = d8_flow_directions(filled, cell_size=1.0)
    # every interior cell must now have a downslope neighbour
    assert directions[1:-1, 1:-1].min() > 0
    acc = flow_accumulation(filled, directions)
    # the low-corner outlet collects the whole grid
    assert acc[4, 4] == 25.0


def test_elevation_rgba_encoding_roundtrip() -> None:
    elev = np.array([[0.0, 3.3], [127.55, 250.0]], dtype=np.float32)
    img = elevation_to_rgba(elev)
    arr = np.array(img).astype(np.int64)
    decoded = (arr[..., 0] * 65536 + arr[..., 1] * 256 + arr[..., 2]) / 100.0
    assert decoded == pytest.approx(elev, abs=0.01)
    assert np.all(arr[..., 3] == 255)


def test_fill_voids_sea_and_inland_holes() -> None:
    mosaic = np.full((6, 6), 5.0, dtype=np.float32)
    # border-connected void becomes sea (0 m); the interior hole is infilled
    mosaic[0, 2] = np.nan
    mosaic[2:4, 2:4] = np.nan
    valid = np.isfinite(mosaic)
    dem, sea = fill_voids(mosaic, valid)
    assert dem[0, 2] == 0.0
    assert bool(sea[0, 2])
    assert not bool(sea[3, 3])
    assert dem[2:4, 2:4] == pytest.approx(5.0)


def test_build_overview_shape_and_m_per_px(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    dem = np.full((8, 12), 10.0, dtype=np.float32)
    sea = np.zeros((8, 12), dtype=bool)
    monkeypatch.setattr(pipeline, "WEB_DIR", tmp_path)
    overview = build_overview(dem, sea)
    assert overview["width"] == 3
    assert overview["height"] == 2
    assert overview["m_per_px"] == pytest.approx(pipeline.OVERVIEW_FACTOR * Z15_M_PER_PX)
    assert (tmp_path / "overview" / "dem.png").exists()


def test_build_overview_bldg_tile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """build_overview writes a building overlay when heights are provided."""
    dem = np.full((8, 12), 10.0, dtype=np.float32)
    sea = np.zeros((8, 12), dtype=bool)
    heights = np.ones((8, 12), dtype=np.int16) * 500  # 5m in cm
    monkeypatch.setattr(pipeline, "WEB_DIR", tmp_path)
    build_overview(dem, sea, heights)
    p = tmp_path / "overview" / "bldg.png"
    assert p.exists()
    img = np.array(Image.open(p))
    assert img.shape[:2] == (2, 3)  # overview factor 4
    assert int(img[0, 0, 0]) * 256 + int(img[0, 0, 1]) == 500  # max-pool preserves height


def test_drainage_network_mask_marks_valley_stream() -> None:
    # V-shaped valley: the bottom row must accumulate the hillsides
    dem = np.fromfunction(lambda y, x: abs(x - 2.0) + y * 0.5, (5, 5))
    mask, acc = drainage_network_mask(dem, cell_size=15.0, threshold=4.0)
    # the valley centreline collects the hillsides top-to-bottom
    assert bool(mask[0, 2])
    assert acc[0, 2] > acc[0, 0]


def test_write_bldg_tiles_order_and_clamp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    from flood_nagoya.pipeline import write_bldg_tiles

    monkeypatch.setattr(pipeline, "WEB_TILE_DIR", tmp_path)
    tr = (10, 11, 20, 21)  # (x0, x1, y0, y1): 2x2 tiles = 512x512 cells
    heights = np.zeros((512, 512), dtype=np.int16)
    heights[5, 5] = 303  # 3.03 m
    heights[300, 300] = -16860  # int16 overflow garbage -> must clamp to 0
    write_bldg_tiles((512, 512), heights, tr)
    # tile naming follows x0..x1 by y0..y1 (regression: swapped unpacking
    # made these loops empty and silently wrote nothing)
    assert (tmp_path / "bldg" / "10_20.png").exists()
    assert (tmp_path / "bldg" / "11_21.png").exists()
    tile00 = np.array(Image.open(tmp_path / "bldg" / "10_20.png"))
    h = int(tile00[5, 5, 0]) * 256 + int(tile00[5, 5, 1])
    assert h == 303
    tile11 = np.array(Image.open(tmp_path / "bldg" / "11_21.png"))
    g = int(tile11[44, 44, 0]) * 256 + int(tile11[44, 44, 1])
    assert g == 0, "negative height must not wrap into a huge unsigned value"

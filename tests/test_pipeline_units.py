"""Unit tests for the core geometry/encoding/hydrology helpers."""

from __future__ import annotations

import numpy as np
import pytest

from flood_nagoya.config import LAT_MAX, LAT_MIN, LON_MAX, LON_MIN
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
    fill_sinks_priority_flood,
    flow_accumulation,
)
from flood_nagoya.pipeline import elevation_to_rgba


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

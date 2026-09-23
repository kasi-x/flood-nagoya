"""Tests for the simplified underground-space inundation model."""

from __future__ import annotations

import numpy as np
import pytest

from flood_nagoya.underground import UndergroundZone
from flood_nagoya.underground import nagoya_zones
from flood_nagoya.underground import step_underground
from flood_nagoya.underground import underground_depth_map


def _small_zone() -> UndergroundZone:
    return UndergroundZone(
        name="test",
        polygon_lonlat=np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]),
        floor_depth_m=5.0,
        capacity_m3_per_m2=2.0,
        manhole_threshold_m=0.1,
        coupling_s=30.0,
    )


def test_step_underground_fills_when_surface_deep() -> None:
    zone = _small_zone()
    surface = np.zeros((10, 10), dtype=np.float32)
    surface[2:5, 2:5] = 0.5  # 30cm over threshold
    mask = np.zeros((10, 10), dtype=bool)
    mask[2:5, 2:5] = True
    area = float(mask.sum()) * 1.0  # dx=1
    volumes = np.zeros(1, dtype=np.float64)
    new_volumes, sink = step_underground([zone], surface, 1.0, volumes, [(mask, area)])
    assert float(new_volumes[0]) > 0.0
    assert float(sink[mask].sum()) > 0.0


def test_step_underground_returns_water_when_surface_drops() -> None:
    zone = _small_zone()
    surface = np.zeros((10, 10), dtype=np.float32)
    mask = np.zeros((10, 10), dtype=bool)
    mask[2:5, 2:5] = True
    area = float(mask.sum()) * 1.0
    # Within capacity so the outflow branch dominates (not overflow cap).
    volumes = np.array([20.0], dtype=np.float64)
    new_volumes, sink = step_underground([zone], surface, 1.0, volumes, [(mask, area)])
    assert float(new_volumes[0]) < volumes[0]
    assert float(sink[mask].sum()) < 0.0


def test_underground_depth_map_uniform() -> None:
    mask = np.zeros((10, 10), dtype=bool)
    mask[2:5, 2:5] = True
    area = float(mask.sum())
    volumes = np.array([45.0], dtype=np.float64)  # 45/9 = 5m depth
    depth = underground_depth_map(volumes, [(mask, area)])
    assert float(depth[mask].mean()) == pytest.approx(5.0)
    assert float(depth[~mask].max()) == 0.0


def test_nagoya_zones_are_named() -> None:
    zones = nagoya_zones()
    assert len(zones) >= 3
    assert all("名古屋" in z.name or "栄" in z.name or "伏見" in z.name for z in zones)


def test_zone_properties_mask_covers_polygon() -> None:
    from flood_nagoya.underground import _zone_properties

    zone = UndergroundZone(
        name="t",
        polygon_lonlat=np.array([[136.90, 35.17], [136.91, 35.17], [136.91, 35.16], [136.90, 35.16]]),
        floor_depth_m=5.0,
        capacity_m3_per_m2=2.0,
        manhole_threshold_m=0.1,
        coupling_s=30.0,
    )
    # grid origin at the polygon's NW corner, ~8 m cells, row 0 = north
    masks, areas = _zone_properties([zone], 136.90, 35.17, 8.0, (200, 200))
    mask = masks[0]
    assert mask.any()
    assert mask[70, 57]  # centre of the polygon
    assert not mask[199, 199]  # far SE, outside
    assert areas[0] == pytest.approx(float(mask.sum()) * 64.0)


def test_step_underground_skips_zero_area_zone() -> None:
    zone = _small_zone()
    surface = np.full((10, 10), 1.0, dtype=np.float32)
    mask = np.zeros((10, 10), dtype=bool)
    volumes = np.zeros(1, dtype=np.float64)
    new_volumes, sink = step_underground([zone], surface, 1.0, volumes, [(mask, 0.0)])
    assert float(new_volumes[0]) == 0.0
    assert float(sink.sum()) == 0.0


def test_step_underground_overflow_returns_to_surface() -> None:
    """Volume above the capacity cap is pushed back onto the surface."""
    zone = _small_zone()  # floor_depth_m = 5.0
    surface = np.full((10, 10), 5.0, dtype=np.float32)
    mask = np.zeros((10, 10), dtype=bool)
    mask[2:5, 2:5] = True
    area = float(mask.sum())
    max_vol = zone.floor_depth_m * area
    volumes = np.array([max_vol * 2.0], dtype=np.float64)  # over capacity
    new_volumes, sink = step_underground([zone], surface, 1.0, volumes, [(mask, area)])
    assert float(new_volumes[0]) == pytest.approx(max_vol)
    # the excess (max_vol) is returned as positive sink depth over the zone
    assert float(sink[mask].sum()) == pytest.approx(max_vol)

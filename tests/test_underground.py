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

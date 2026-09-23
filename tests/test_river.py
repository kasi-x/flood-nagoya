"""Tests for the 1D river-channel model (river.py)."""

import numpy as np

from flood_nagoya.river import ChannelField, extract_channels, river_excess_depth


def _synthetic_dem(h: int = 40, w: int = 40) -> np.ndarray:
    """Tilted plane with a central channel carved along the middle column."""
    z = np.zeros((h, w), dtype=np.float32)
    for y in range(h):
        for x in range(w):
            z[y, x] = 50.0 - 0.1 * y + 0.05 * abs(x - w // 2)
    return z


def test_extract_channels_finds_channel() -> None:
    z = _synthetic_dem()
    field = extract_channels(z, dx=5.0)
    assert isinstance(field, ChannelField)
    # The central column should be flagged as channel (high accumulation).
    mid = field.mask[:, z.shape[1] // 2]
    assert mid.sum() > 0
    # Channel cells carry positive area, width, depth.
    assert field.area_m2[field.mask.astype(bool)].min() > 0
    assert field.width_m[field.mask.astype(bool)].min() > 0
    assert field.depth_m[field.mask.astype(bool)].min() > 0


def test_river_excess_depth_zero_rain() -> None:
    z = _synthetic_dem()
    field = extract_channels(z, dx=5.0)
    out = river_excess_depth(field, 0.0)
    assert out.shape == z.shape
    assert out.max() == 0.0


def test_river_excess_depth_positive_on_channel() -> None:
    z = _synthetic_dem()
    field = extract_channels(z, dx=5.0)
    out = river_excess_depth(field, 50.0)  # 50 mm/h
    # Some channel cells should exceed bankfull.
    assert out.max() > 0.0
    # Non-channel cells stay zero.
    assert out[field.mask == 0].max() == 0.0


def test_river_excess_depth_monotonic_in_rain() -> None:
    z = _synthetic_dem()
    field = extract_channels(z, dx=5.0)
    low = river_excess_depth(field, 10.0)
    high = river_excess_depth(field, 100.0)
    assert high.max() >= low.max()


def test_river_excess_depth_no_channels() -> None:
    # Flat DEM → no accumulation → no channels.
    z = np.full((20, 20), 10.0, dtype=np.float32)
    field = extract_channels(z, dx=5.0)
    out = river_excess_depth(field, 100.0)
    assert out.max() == 0.0

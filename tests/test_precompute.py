"""Unit tests for the offline flood precompute (Sakai replay data)."""

from __future__ import annotations

import numpy as np
import numpy.typing as npt
import pytest

from flood_nagoya.precompute import (
    encode_frame_rgba,
    encode_max_gray,
    lonlat_to_z15px,
    m_per_px_at_z15,
    pool2,
    rain_rate_at,
    step,
)


def test_m_per_px_matches_web_value() -> None:
    # web/meta.json の overview_m_per_px (15.676m @ overview_factor 4) と整合
    m = m_per_px_at_z15(35.17)
    assert m == pytest.approx(3.92, abs=0.02)


def test_lonlat_to_z15px_relative_to_origin() -> None:
    x, y = lonlat_to_z15px(136.9066, 35.1700, 28830, 12945)
    # 名古屋中心はタイル範囲の中ほどにある
    assert 0 < x < 33 * 256
    assert 0 < y < 38 * 256


def test_pool2_averages_blocks() -> None:
    a = np.arange(16, dtype=np.float64).reshape(4, 4)
    pooled = pool2(a, 2)
    assert pooled.shape == (2, 2)
    assert pooled[0, 0] == pytest.approx((0 + 1 + 4 + 5) / 4)
    assert pooled[1, 1] == pytest.approx((10 + 11 + 14 + 15) / 4)


def test_pool2_with_channels() -> None:
    a = np.ones((4, 4, 3))
    pooled = pool2(a, 2)
    assert pooled.shape == (2, 2, 3)
    assert np.all(pooled == 1)


def test_rain_rate_interpolation() -> None:
    series = [[0.0, 0.0], [3600.0, 10.0], [7200.0, 30.0], [10800.0, 0.0]]
    assert rain_rate_at(series, -1) == 0.0
    assert rain_rate_at(series, 0) == 0.0
    assert rain_rate_at(series, 1800) == pytest.approx(5.0)
    assert rain_rate_at(series, 7200) == 30.0
    assert rain_rate_at(series, 99999) == 0.0


def _flat_grid(
    n: int = 32, depth: float = 0.5
) -> tuple[
    npt.NDArray[np.float32],
    npt.NDArray[np.float32],
    npt.NDArray[np.float32],
    npt.NDArray[np.float32],
    npt.NDArray[np.bool_],
]:
    z = np.full((n, n), 10.0, dtype=np.float32)
    h = np.full((n, n), depth, dtype=np.float32)
    qe = np.zeros((n, n - 1), dtype=np.float32)
    qs = np.zeros((n - 1, n), dtype=np.float32)
    wall = np.zeros((n, n), dtype=bool)
    return z, h, qe, qs, wall


def _basin_grid(
    n: int = 32, depth: float = 0.5
) -> tuple[
    npt.NDArray[np.float32],
    npt.NDArray[np.float32],
    npt.NDArray[np.float32],
    npt.NDArray[np.float32],
    npt.NDArray[np.bool_],
]:
    """Flat water pool closed by a wall ring (for conservation tests)."""
    z = np.full((n, n), 10.0, dtype=np.float32)
    h = np.full((n, n), depth, dtype=np.float32)
    qe = np.zeros((n, n - 1), dtype=np.float32)
    qs = np.zeros((n - 1, n), dtype=np.float32)
    wall = np.zeros((n, n), dtype=bool)
    wall[0, :] = wall[-1, :] = True
    wall[:, 0] = wall[:, -1] = True
    h[wall] = 0.0
    return z, h, qe, qs, wall


def test_step_conserves_mass_in_closed_basin() -> None:
    """Flat water in a walled basin produces no flux and conserves volume."""
    z, h, qe, qs, wall = _basin_grid()
    vol0 = float(h.sum())
    for _ in range(50):
        step(h, qe, qs, z, wall, 1.0, 8.0, 0.02, 0.0, 0.0)
    assert float(h.sum()) == pytest.approx(vol0, rel=1e-3)
    assert np.abs(qe).max() == pytest.approx(0.0, abs=1e-3)
    assert np.abs(qs).max() == pytest.approx(0.0, abs=1e-3)


def test_step_flows_downhill_and_drains_at_edges() -> None:
    """Water flows downhill and the volume drains over the open edges."""
    n = 32
    z = np.tile(np.linspace(20.0, 10.0, n).astype(np.float32), (n, 1))
    h = np.full((n, n), 0.3, dtype=np.float32)
    qe = np.zeros((n, n - 1), dtype=np.float32)
    qs = np.zeros((n - 1, n), dtype=np.float32)
    wall = np.zeros((n, n), dtype=bool)
    vol0 = float(h.sum())
    for _ in range(100):
        step(h, qe, qs, z, wall, 1.0, 8.0, 0.02, 0.0, 0.0)
    assert float(h.sum()) < vol0
    assert qe.max() > 0.0  # 東向き (下り) の正のフラックス


def test_step_walls_hold_no_water() -> None:
    z, h, qe, qs, wall = _flat_grid()
    wall[10:20, 10:20] = True
    for _ in range(10):
        step(h, qe, qs, z, wall, 1.0, 8.0, 0.02, 0.001, 0.0)
    assert float(h[wall].max()) == 0.0


def test_step_rain_and_loss_change_volume() -> None:
    z, h, qe, qs, wall = _basin_grid()
    n_eff = 30 * 30  # 壁リングを除く湿セル数
    vol0 = float(h.sum())
    # 97.5mm/h の雨 + 25.5mm/h の損失 → 正味の増加
    step(h, qe, qs, z, wall, 1.0, 8.0, 0.02, 97.5 / 1000 / 3600, 25.5 / 1000 / 3600)
    assert float(h.sum()) == pytest.approx(vol0 + (97.5 - 25.5) / 1000 / 3600 * n_eff, rel=1e-3)


def test_step_sea_level_raises_coastal_cells() -> None:
    """A raised sea level forces water depth at the coastal boundary mask."""
    n = 16
    z = np.full((n, n), 2.0, dtype=np.float32)
    h = np.zeros((n, n), dtype=np.float32)
    qe = np.zeros((n, n - 1), dtype=np.float32)
    qs = np.zeros((n - 1, n), dtype=np.float32)
    wall = np.zeros((n, n), dtype=bool)
    coastal = np.zeros((n, n), dtype=bool)
    coastal[-1, :] = True  # southern border = coast
    step(h, qe, qs, z, wall, 1.0, 8.0, 0.02, 0.0, 0.0, sea_level=3.0, coastal_mask=coastal)
    assert float(h[-1, :].min()) == pytest.approx(1.0, abs=1e-5)
    assert float(h[-1, :].max()) == pytest.approx(1.0, abs=1e-5)
    assert float(h[:-1, :].max()) == 0.0


def test_encode_frame_rgba_quantization() -> None:
    h = np.full((4, 4), 0.5, dtype=np.float32)
    hmax = np.full((4, 4), 1.2, dtype=np.float32)
    qe = np.full((4, 3), 0.1, dtype=np.float32)
    qs = np.full((3, 4), -0.2, dtype=np.float32)
    rgba = encode_frame_rgba(h, qe, qs)
    assert rgba.shape == (4, 4, 4)
    assert rgba[0, 0, 0] == 50  # 水深 0.5m → 50cm
    assert rgba[0, 0, 1] == 0.1 * 100 + 128  # qE
    assert rgba[0, 0, 2] == -0.2 * 100 + 128  # qS
    assert rgba[0, 0, 3] == 255  # Aは常に255 (canvas premultiply対策)
    # セル中心化のため最東と最南の列は端の面の値を引き延ばす
    assert rgba[0, 3, 1] == 0.1 * 100 + 128
    assert rgba[3, 0, 2] == -0.2 * 100 + 128
    gray = encode_max_gray(hmax)
    assert gray[0, 0] == 120  # 最大水深 1.2m


def test_streams_intensity_highlights_valley() -> None:
    """V-valley collects flow at the bottom; the ridge stays near zero."""
    from flood_nagoya.precompute import streams_intensity

    n = 64
    x = np.linspace(-1.0, 1.0, n)
    elev = (10.0 + np.abs(x)[None, :] * 20.0 + np.zeros((n, 1))).astype(np.float32)
    intensity = streams_intensity(elev, 8.0)
    assert intensity.shape == (n, n)
    assert float(intensity[:, n // 2].max()) > 0.8  # 谷底
    assert float(intensity[0, 0]) < 0.2  # 分水嶺寄りの角

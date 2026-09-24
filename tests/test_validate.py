"""Tests for the satellite flood-validation math (pure numpy, no network)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from flood_nagoya.precompute import lonlat_to_z15px
from flood_nagoya.precompute import m_per_px_at_z15
from flood_nagoya.validate import change_map
from flood_nagoya.validate import ChangeConfig
from flood_nagoya.validate import confusion
from flood_nagoya.validate import db
from flood_nagoya.validate import flood_mask
from flood_nagoya.validate import GridRef
from flood_nagoya.validate import load_sim_hmax
from flood_nagoya.validate import lonlat_to_sim_px
from flood_nagoya.validate import nisar_on_grid
from flood_nagoya.validate import reproject_nearest
from flood_nagoya.validate import s1_grd_on_grid
from flood_nagoya.validate import run_validation
from flood_nagoya.validate import sim_lonlat
from flood_nagoya.validate import summarize
from flood_nagoya.validate import swot_on_grid
from flood_nagoya.validate import swot_water_mask


def test_db_converts_power_ratio() -> None:
    assert db(np.array([10.0]))[0] == pytest.approx(10.0)
    assert db(np.array([0.0]))[0] > -100.0  # floor, no -inf


def test_change_map_flags_darkening_only() -> None:
    pre = np.array([[1.0, 1.0, 1.0]])  # 0 dB everywhere
    post = np.array([[0.5, 1.0, 2.0]])  # -3 dB, 0 dB, +3 dB
    out = change_map(pre, post)
    assert out.tolist() == [[True, False, False]]


def test_change_map_masks_permanent_water_and_nan() -> None:
    pre = np.array([[1e-4, np.nan]])  # -40 dB dark, NaN
    post = np.array([[1e-5, 1e-5]])
    out = change_map(pre, post)
    assert out.tolist() == [[False, False]]


def test_change_map_respects_custom_threshold() -> None:
    pre = np.full((1, 2), 1.0)
    post = np.array([[0.6, 0.4]])  # -2.2 dB, -4.0 dB
    assert change_map(pre, post, ChangeConfig(db_drop=-3.0)).tolist() == [[False, True]]
    assert change_map(pre, post, ChangeConfig(db_drop=-2.0)).tolist() == [[True, True]]


def test_flood_mask_threshold_and_nan() -> None:
    out = flood_mask(np.array([[0.0, 0.1, 0.5, np.nan]]))
    assert out.tolist() == [[False, True, True, False]]
    assert flood_mask(np.array([[0.2]]), threshold_m=0.5).tolist() == [[False]]


def test_swot_water_mask_threshold() -> None:
    out = swot_water_mask(np.array([[0.0, 0.49, 0.5, 1.0, np.nan]]))
    assert out.tolist() == [[False, False, True, True, False]]


def test_confusion_counts_and_scores() -> None:
    model = np.array([[True, True, False, False]])
    sat = np.array([[True, False, True, False]])
    res = confusion(model, sat)
    assert (res.true_positive, res.false_positive, res.false_negative, res.true_negative) == (1, 1, 1, 1)
    assert res.precision == pytest.approx(0.5)
    assert res.recall == pytest.approx(0.5)
    assert res.f1 == pytest.approx(0.5)
    assert "F1=0.500" in summarize(res)


def test_confusion_rejects_shape_mismatch() -> None:
    with pytest.raises(ValueError, match="shape mismatch"):
        confusion(np.zeros((2, 2), dtype=bool), np.zeros((3, 3), dtype=bool))


def test_lonlat_to_sim_px_matches_precompute_lattice() -> None:
    grid = GridRef(left=100, top=200, tile_x0=300, tile_y0=400, dx=3.9)
    lon = np.array([[136.9, 136.95]])
    lat = np.array([[35.17, 35.18]])
    xs, ys = lonlat_to_sim_px(lon, lat, grid)
    m_per_px = m_per_px_at_z15(grid.lat0)
    for lo, la, x, y in zip(lon.ravel(), lat.ravel(), xs.ravel(), ys.ravel(), strict=True):
        fx, fy = lonlat_to_z15px(float(lo), float(la), grid.tile_x0, grid.tile_y0)
        assert x == pytest.approx((fx - grid.left) * m_per_px / grid.dx / 2.0)
        assert y == pytest.approx((fy - grid.top) * m_per_px / grid.dx / 2.0)


def test_lonlat_to_sim_px_nan_propagates() -> None:
    grid = GridRef(left=0, top=0, tile_x0=0, tile_y0=0, dx=1.0)
    xs, ys = lonlat_to_sim_px(np.array([[np.nan]]), np.array([[35.0]]), grid)
    assert np.isnan(xs[0, 0]) and np.isnan(ys[0, 0])


def test_reproject_nearest_roundtrip() -> None:
    src = np.array([[1.0, 2.0], [3.0, 4.0]])
    # source pixel (r, c) maps to destination (c*2, r*2)
    sx = np.array([[0.0, 2.0], [0.0, 2.0]])
    sy = np.array([[0.0, 0.0], [2.0, 2.0]])
    out = reproject_nearest(src, sx, sy, (3, 3))
    assert out[0, 0] == 1.0
    assert out[0, 2] == 2.0
    assert out[2, 0] == 3.0
    assert out[2, 2] == 4.0
    assert np.isnan(out[1, 1])


def test_reproject_nearest_skips_out_of_range_and_nan() -> None:
    src = np.array([[5.0, np.nan]])
    out = reproject_nearest(src, np.array([[-1.0, 0.0]]), np.array([[0.0, 0.0]]), (1, 1))
    assert np.isnan(out[0, 0])


def test_sim_lonlat_roundtrips_to_cell_centres() -> None:
    """sim_lonlat → lonlat_to_sim_px must land on cell centres (i+0.5)."""
    grid = GridRef(left=4479, top=3688, tile_x0=28830, tile_y0=12945, dx=7.811877618560193)
    lon, lat = sim_lonlat(grid)
    assert lon.shape == (grid.sim_h, grid.sim_w)
    sx, sy = lonlat_to_sim_px(lon, lat, grid)
    rows, cols = np.mgrid[0 : grid.sim_h, 0 : grid.sim_w]
    assert np.allclose(sx, cols + 0.5, atol=1e-6)
    assert np.allclose(sy, rows + 0.5, atol=1e-6)


def test_grid_ref_from_meta(tmp_path: Path) -> None:
    meta = {
        "bounds_px": {"left": 4479, "top": 3688, "w": 1800, "h": 1400},
        "grid": {"w": 900, "h": 700, "dx": 7.811877618560193},
        "full": {"w": 1800, "h": 1400, "dx": 3.9059388092800966},
        "origin": {"lon": 136.9667, "lat": 35.1546},
    }
    p = tmp_path / "meta.json"
    p.write_text(json.dumps(meta))
    grid = GridRef.from_meta(p)
    assert grid.left == 4479 and grid.top == 3688
    assert grid.sim_w == 900 and grid.sim_h == 700
    assert grid.downsample == pytest.approx(2.0)
    assert grid.dx == pytest.approx(7.811877618560193)


def _mini_grid() -> GridRef:
    """Small sim grid centred on the synthetic fixtures' UTM window."""
    return GridRef(left=4479, top=3688, tile_x0=28830, tile_y0=12945, dx=7.811877618560193)


@pytest.mark.filterwarnings("ignore:Use `@` matmul:PendingDeprecationWarning")
def test_nisar_on_grid_reads_synthetic_h5(tmp_path: Path) -> None:
    h5py = pytest.importorskip("h5py")
    pytest.importorskip("rioxarray")
    path = tmp_path / "mini.h5"
    with h5py.File(path, "w") as f:
        g = f.create_group("science/LSAR/GCOV/grids/frequencyB")
        g.create_dataset("projection", data=np.uint32(32653))
        g.create_dataset("xCoordinates", data=np.linspace(660000, 680000, 20))
        g.create_dataset("yCoordinates", data=np.linspace(3900000, 3880000, 20))
        g.create_dataset("HHHH", data=np.ones((20, 20), dtype=np.float32))
    out = nisar_on_grid(path, _mini_grid())
    assert out.shape == (700, 900)
    assert np.isfinite(out).sum() > 0
    assert np.nanmean(out) == pytest.approx(1.0)


@pytest.mark.filterwarnings("ignore:Use `@` matmul:PendingDeprecationWarning")
def test_swot_on_grid_reads_synthetic_nc(tmp_path: Path) -> None:
    netcdf4 = pytest.importorskip("netCDF4")
    pytest.importorskip("rioxarray")
    path = tmp_path / "mini.nc"
    ds = netcdf4.Dataset(path, "w")
    ds.createDimension("y", 20)
    ds.createDimension("x", 20)
    ds.createVariable("x", "f8", ("x",))[:] = np.linspace(660000, 680000, 20)
    ds.createVariable("y", "f8", ("y",))[:] = np.linspace(3900000, 3880000, 20)
    ds.createVariable("longitude", "f8", ("y", "x"))[:] = np.meshgrid(
        np.linspace(136.9, 137.1, 20), np.linspace(35.0, 35.2, 20)
    )[0]
    ds.createVariable("latitude", "f8", ("y", "x"))[:] = np.meshgrid(
        np.linspace(136.9, 137.1, 20), np.linspace(35.0, 35.2, 20)
    )[1]
    ds.createVariable("water_frac", "f4", ("y", "x"))[:] = np.full((20, 20), 0.8)
    ds.close()
    out = swot_on_grid(path, _mini_grid())
    assert out.shape == (700, 900)
    assert np.isfinite(out).sum() > 0
    assert np.nanmean(out) == pytest.approx(0.8, abs=0.05)


def test_load_sim_hmax_reads_last_frame(tmp_path: Path) -> None:
    from PIL import Image

    Image.fromarray(np.full((4, 4), 50, np.uint8), "L").save(tmp_path / "max_0000.png")
    Image.fromarray(np.full((4, 4), 200, np.uint8), "L").save(tmp_path / "max_0001.png")
    out = load_sim_hmax(tmp_path)
    assert out.shape == (4, 4)
    assert out[0, 0] == pytest.approx(2.0)  # 200 cm = 2.0 m


def test_load_sim_hmax_missing_frames(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="no max_"):
        load_sim_hmax(tmp_path)


def test_region_box_path() -> None:
    from flood_nagoya.validate import region_box_path

    p = region_box_path()
    assert "satellite" in str(p) and "nagoya_" in p.name


def _write_meta(tmp_path: Path) -> Path:
    meta = {
        "bounds_px": {"left": 4479, "top": 3688, "w": 1800, "h": 1400},
        "grid": {"w": 900, "h": 700, "dx": 7.811877618560193},
        "full": {"w": 1800, "h": 1400, "dx": 3.9059388092800966},
        "origin": {"lon": 136.9667, "lat": 35.1546},
    }
    p = tmp_path / "meta.json"
    p.write_text(json.dumps(meta))
    return p


def _write_swot_nc(path: Path, frac: float) -> None:
    netcdf4 = pytest.importorskip("netCDF4")
    ds = netcdf4.Dataset(path, "w")
    ds.createDimension("y", 20)
    ds.createDimension("x", 20)
    ds.createVariable("x", "f8", ("x",))[:] = np.linspace(660000, 680000, 20)
    ds.createVariable("y", "f8", ("y",))[:] = np.linspace(3900000, 3880000, 20)
    ds.createVariable("longitude", "f8", ("y", "x"))[:] = np.meshgrid(
        np.linspace(136.9, 137.1, 20), np.linspace(35.0, 35.2, 20)
    )[0]
    ds.createVariable("latitude", "f8", ("y", "x"))[:] = np.meshgrid(
        np.linspace(136.9, 137.1, 20), np.linspace(35.0, 35.2, 20)
    )[1]
    ds.createVariable("water_frac", "f4", ("y", "x"))[:] = np.full((20, 20), frac)
    ds.close()


@pytest.mark.filterwarnings("ignore:Use `@` matmul:PendingDeprecationWarning")
def test_run_validation_swot_end_to_end(tmp_path: Path) -> None:
    pytest.importorskip("netCDF4")
    pytest.importorskip("rioxarray")
    from PIL import Image

    meta = _write_meta(tmp_path)
    Image.fromarray(np.full((700, 900), 50, np.uint8), "L").save(tmp_path / "max_0000.png")
    swot = tmp_path / "swot.nc"
    _write_swot_nc(swot, 0.8)
    out_dir = tmp_path / "out"
    results = run_validation(meta, tmp_path, swot_nc=swot, out_dir=out_dir)
    assert "swot" in results
    assert (out_dir / "validation.json").exists()
    assert (out_dir / "overlay_swot.png").exists()
    summary = json.loads((out_dir / "validation.json").read_text())
    assert summary["swot"]["model_cells"] == 700 * 900  # 50cm >= 0.1m everywhere


@pytest.mark.filterwarnings("ignore:Use `@` matmul:PendingDeprecationWarning")
def test_s1_grd_on_grid_missing_measurement(tmp_path: Path) -> None:
    pytest.importorskip("rioxarray")
    safe = tmp_path / "S1.SAFE"
    (safe / "measurement").mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="no vv measurement"):
        s1_grd_on_grid(safe, _mini_grid())

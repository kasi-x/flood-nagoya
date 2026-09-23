"""Unit tests for the offline flood precompute (Sakai replay data)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest

from flood_nagoya import precompute as pc

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


def test_step_river_excess_forces_channel_depth() -> None:
    """River overflow forces channel cells to at least the excess depth."""
    n = 16
    z = np.full((n, n), 10.0, dtype=np.float32)
    h = np.zeros((n, n), dtype=np.float32)
    qe = np.zeros((n, n - 1), dtype=np.float32)
    qs = np.zeros((n - 1, n), dtype=np.float32)
    wall = np.zeros((n, n), dtype=bool)
    river = np.zeros((n, n), dtype=np.float32)
    river[8, 8] = 2.5  # one channel cell with 2.5 m excess
    step(h, qe, qs, z, wall, 1.0, 8.0, 0.02, 0.0, 0.0, river_excess=river)
    assert float(h[8, 8]) == pytest.approx(2.5, abs=1e-5)
    assert float(h.max()) == pytest.approx(2.5, abs=1e-5)


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


def test_read_tiles_partial_coverage(tmp_path: Path) -> None:
    """Missing tiles stay transparent; present tiles land at the right offset."""
    from PIL import Image

    from flood_nagoya.precompute import _read_tiles

    tile_dir = tmp_path / "tiles" / "dem"
    tile_dir.mkdir(parents=True)
    tile = np.zeros((256, 256, 4), dtype=np.uint8)
    tile[:, :, 0] = 200
    tile[:, :, 3] = 255
    Image.fromarray(tile, "RGBA").save(tile_dir / "10_20.png")

    # rect straddles tile (10,20) and the missing (11,20); tx0/ty0 is the
    # global tile-range origin, so local index 0 → file 10_20.png
    out = _read_tiles(tmp_path, "dem", left=100, top=0, right=356, bottom=256, tx0=10, ty0=20)
    assert out.shape == (256, 256, 4)
    assert out[0, 0, 0] == 200  # inside the present tile
    assert out[0, 200, 0] == 0  # past tile edge → missing tile area


def test_coastal_mask_flags_low_border() -> None:
    from flood_nagoya.precompute import _coastal_mask

    elev = np.full((10, 10), 50.0, dtype=np.float32)
    elev[0, :] = 1.0  # low northern border
    elev[5, 5] = 1.0  # low interior cell — must NOT be coastal
    mask = _coastal_mask(elev, margin=1, z_thresh=5.0)
    assert mask[0, :].all()
    assert not mask[5, 5]
    assert not mask[-1, :].any()  # high border not flagged


def test_load_region_decodes_dem_and_bldg(tmp_path: Path) -> None:
    """load_region reads dem/bldg PNG tiles, pools, and detects building walls."""
    import json

    from PIL import Image

    from flood_nagoya import precompute as pc

    web = tmp_path
    (web / "meta.json").write_text(json.dumps({"tile_range": {"x0": 0, "y0": 0, "x1": 0, "y1": 0}}))
    # dem tile: 1000 cm = 10 m everywhere
    dem = np.zeros((256, 256, 4), dtype=np.uint8)
    dem[:, :, 1] = 1000 // 256
    dem[:, :, 2] = 1000 % 256
    dem[:, :, 3] = 255
    # bldg tile: 500 cm building covering the whole tile
    bldg = np.zeros((256, 256, 4), dtype=np.uint8)
    bldg[:, :, 0] = 500 // 256
    bldg[:, :, 1] = 500 % 256
    (web / "tiles" / "dem").mkdir(parents=True)
    (web / "tiles" / "bldg").mkdir(parents=True)
    Image.fromarray(dem, "RGBA").save(web / "tiles" / "dem" / "0_0.png")
    Image.fromarray(bldg, "RGBA").save(web / "tiles" / "bldg" / "0_0.png")

    # centre the box on the tile's middle: lon/lat of z15 px (128,128)
    lon = (128 / 256) / 2**15 * 360.0 - 180.0

    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (128 / 256) / 2**15))))
    region = pc.load_region(web, lon=lon, lat=lat, half_w=64, half_h=64, pool=2)
    assert region.elev.shape == (64, 64)
    assert float(region.elev.mean()) == pytest.approx(10.0, abs=0.01)
    assert region.wall.all()  # 100% coverage ≥ 0.75 threshold
    assert region.dx == pytest.approx(pc.m_per_px_at_z15(lat) * 2)


def test_stats_counts_depth_thresholds() -> None:
    from flood_nagoya.precompute import _stats

    h = np.zeros((4, 4), dtype=np.float32)
    h[0, 0] = 0.06  # >5cm only
    h[0, 1] = 0.50  # >30cm
    h[0, 2] = 1.50  # >1m
    s = _stats(h, 10.0)
    assert s["a5"] == pytest.approx(300.0)
    assert s["a30"] == pytest.approx(200.0)
    assert s["a100"] == pytest.approx(100.0)
    assert s["volume"] == pytest.approx((0.06 + 0.50 + 1.50) * 100.0)


def test_elev_to_rgba_png_roundtrip() -> None:
    from flood_nagoya.precompute import _elev_to_rgba_png

    rgba = _elev_to_rgba_png(np.array([[12.34]], dtype=np.float32))
    cm = int(rgba[0, 0, 0]) * 65536 + int(rgba[0, 0, 1]) * 256 + int(rgba[0, 0, 2])
    assert cm == 1234
    assert int(rgba[0, 0, 3]) == 255


def test_scenario_entry_lookup(tmp_path: Path) -> None:
    import json

    from flood_nagoya.precompute import _scenario_entry

    assert _scenario_entry(tmp_path, "x.json") == {}  # no index.json
    (tmp_path / "scenarios").mkdir()
    (tmp_path / "scenarios" / "index.json").write_text(
        json.dumps([{"file": "a.json", "name": "A"}, {"file": "b.json", "name": "B"}])
    )
    assert _scenario_entry(tmp_path, "b.json")["name"] == "B"
    assert _scenario_entry(tmp_path, "zzz.json") == {}


def test_update_replay_index_upserts(tmp_path: Path) -> None:
    import json

    from flood_nagoya.precompute import _update_replay_index

    out = tmp_path / "precomputed" / "sakai"
    out.mkdir(parents=True)
    _update_replay_index(out, "s.json", "N", "D", "栄")
    _update_replay_index(out, "s2.json", "N2", "D2", "栄")  # same dir → replace
    entries = json.loads((tmp_path / "precomputed" / "index.json").read_text())
    assert len(entries) == 1
    assert entries[0]["scenario"] == "s2.json"


def _tiny_region(elev_m: float = 10.0) -> pc.RegionGrid:
    from flood_nagoya import precompute as pc

    n = 16
    return pc.RegionGrid(
        elev=np.full((n, n), elev_m, dtype=np.float32),
        wall=np.zeros((n, n), dtype=bool),
        bldg_rgba=np.zeros((n, n, 4), dtype=np.uint8),
        dx=8.0,
        left=0,
        top=0,
        full_w=n * pc.POOL,
        full_h=n * pc.POOL,
        coastal_mask=np.zeros((n, n), dtype=bool),
    )


def test_run_precompute_simulation_writes_frames(tmp_path: Path) -> None:
    """Short rain series produces frame/max PNG files, times and stats."""
    from flood_nagoya.precompute import _run_precompute_simulation

    region = _tiny_region()
    series = [[0.0, 0.0], [600.0, 50.0], [1200.0, 0.0]]
    hmax, times, stats = _run_precompute_simulation(
        region,
        tmp_path,
        series,
        dt=60.0,
        frame_interval=300.0,
        loss_ms=0.0,
        sea_level_m=0.0,
        progress=False,
    )
    assert len(times) == len(stats) > 0
    assert (tmp_path / "frame_0000.png").exists()
    assert (tmp_path / "max_0000.png").exists()
    assert hmax.shape == region.elev.shape
    assert float(hmax.max()) > 0.0  # rain accumulated


def test_precompute_streams_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """streams_only writes only the overlay and skips the simulation."""
    from flood_nagoya import precompute as pc

    monkeypatch.setattr(pc, "WEB_DIR", tmp_path)
    monkeypatch.setattr(pc, "load_region", lambda *_a, **_k: _tiny_region())
    out = pc.precompute(out_dir=tmp_path / "sakai", streams_only=True, progress=False)
    assert (out / "streams.png").exists()
    assert not (out / "meta.json").exists()


def test_precompute_full_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """precompute() writes frames, meta.json and updates the replay index."""
    import json

    from flood_nagoya import precompute as pc

    web = tmp_path / "web"
    (web / "scenarios").mkdir(parents=True)
    (web / "scenarios" / "s.json").write_text(
        json.dumps(
            {
                "name": "テスト",
                "desc": "d",
                "series": [[0.0, 0.0], [600.0, 50.0], [1200.0, 0.0]],
            }
        )
    )
    monkeypatch.setattr(pc, "WEB_DIR", web)
    monkeypatch.setattr(pc, "load_region", lambda *_a, **_k: _tiny_region())

    out = pc.precompute(
        out_dir=tmp_path / "precomputed" / "sakai",
        scenario_file="s.json",
        dt=60.0,
        frame_interval=300.0,
        progress=False,
    )
    assert (out / "frame_0000.png").exists()
    assert (out / "terrain.png").exists()
    assert (out / "bldg.png").exists()
    assert (out / "streams.png").exists()
    meta = json.loads((out / "meta.json").read_text())
    assert meta["name"] == "テスト"
    assert meta["grid"]["w"] == 16
    assert len(meta["times"]) == len(meta["stats"]) > 0
    index = json.loads((tmp_path / "precomputed" / "index.json").read_text())
    assert index[0]["dir"] == "sakai"


def test_run_precompute_simulation_with_underground(tmp_path: Path) -> None:
    """Underground zones produce underground_*.png frames alongside surface ones."""
    import numpy as np

    from flood_nagoya.precompute import _run_precompute_simulation
    from flood_nagoya.underground import UndergroundZone

    region = _tiny_region()
    n = region.elev.shape[0]
    zone = UndergroundZone(
        name="t",
        polygon_lonlat=np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]),
        floor_depth_m=5.0,
        capacity_m3_per_m2=2.0,
        manhole_threshold_m=0.0,  # any surface water enters
        coupling_s=1.0,
    )
    mask = np.ones((n, n), dtype=bool)
    area = float(mask.sum()) * region.dx * region.dx
    volumes = np.zeros(1, dtype=np.float64)
    series = [[0.0, 0.0], [600.0, 50.0], [1200.0, 0.0]]
    _hmax, times, _stats = _run_precompute_simulation(
        region,
        tmp_path,
        series,
        dt=60.0,
        frame_interval=300.0,
        loss_ms=0.0,
        sea_level_m=0.0,
        progress=False,
        zones=[zone],
        zone_props=[(mask, area)],
        volumes=volumes,
    )
    assert (tmp_path / "underground_0000.png").exists()
    assert float(volumes[0]) > 0.0  # water entered the underground store
    assert len(times) > 0

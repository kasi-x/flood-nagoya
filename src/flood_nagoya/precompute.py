"""Offline precompute of the Sakai flood replay for the web app.

Runs the same LISFLOOD-FP style pipe scheme as ``web/sim.js`` with numpy,
then writes 60-second state frames (PNG) plus a meta JSON under
``web/precomputed/sakai/``. The web app plays these frames back, so the
flood is visible instantly on any machine without waiting for the live
GPU simulation.

Usage: ``python -m flood_nagoya precompute``
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image

if TYPE_CHECKING:
    from .underground import UndergroundZone

from .config import WEB_DIR
from .hydro import d8_flow_directions
from .hydro import fill_sinks_priority_flood
from .hydro import flow_accumulation

__all__ = [
    "RegionGrid",
    "encode_frame_rgba",
    "load_region",
    "m_per_px_at_z15",
    "pool2",
    "precompute",
    "rain_rate_at",
    "step",
    "streams_intensity",
]

TILE_PX = 256
Z15 = 15
EARTH_M = 40075016.686
G = 9.81

# 既定: 栄中心 7x5.5km ボックス (app.js REGIONS の「栄」と同じ)
SAKAI_LON = 136.9066
SAKAI_LAT = 35.1700
HALF_W_PX = 900
HALF_H_PX = 700
POOL = 2  # 空間間引き (2 → 約7.8m解像度, 900x700セル)
DT_S = 1.0  # 計算ステップ [s]
FRAME_INTERVAL_S = 60.0  # フレーム保存間隔 [s]
DRAIN_MMH = 25.0  # 下水道排水能力 (UI既定値)
INFIL_MMH = 0.5  # 地盤浸透 (UI既定値)
MANNING = 0.020  # 粗度係数 (UI既定値)
SCENARIO = "rain_20260908_47636.json"  # AMeDAS名古屋 2026-09-08 (最大97.5mm/h)


@dataclass
class RegionGrid:
    """Simulation grid; row 0 is the north edge (image orientation)."""

    elev: np.ndarray  # [m] (H, W) float32
    wall: np.ndarray  # 建物壁 (H, W) bool
    bldg_rgba: np.ndarray  # 2D表示用 高さラスタ (H, W, 4) uint8
    dx: float  # セルサイズ [m]
    left: int  # tile_range 原点からの z15 px オフセット
    top: int
    full_w: int  # 元 (3D用) 解像度の幅 [z15 px]
    full_h: int
    coastal_mask: np.ndarray  # (H, W) bool — sea-level boundary cells


def m_per_px_at_z15(lat: float) -> float:
    """Metres per z15 pixel at the given latitude."""
    return EARTH_M * float(np.cos(np.radians(lat))) / 2**Z15 / TILE_PX


def lonlat_to_z15px(lon: float, lat: float, tile_x0: int, tile_y0: int) -> tuple[float, float]:
    """Longitude/latitude to z15 pixels relative to the tile-range origin."""
    fx = (lon + 180.0) / 360.0 * 2**Z15
    r = np.radians(lat)
    fy = (1 - float(np.arcsinh(np.tan(r))) / np.pi) / 2 * 2**Z15
    return (fx - tile_x0) * TILE_PX, (fy - tile_y0) * TILE_PX


def pool2(a: np.ndarray, k: int) -> np.ndarray:
    """Mean over k x k blocks (trailing edges are dropped)."""
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    a = a[:h, :w]
    blocks = a.reshape(h // k, k, w // k, k, *a.shape[2:])
    return blocks.mean(axis=(1, 3))


def _read_tiles(
    web_dir: Path,
    layer: str,
    left: int,
    top: int,
    right: int,
    bottom: int,
    tx0: int,
    ty0: int,
) -> np.ndarray:
    """Assemble a z15 pixel rect from the tile PNG files (row 0 = north)."""
    out = np.zeros((bottom - top, right - left, 4), dtype=np.uint8)
    out[:, :, 3] = 255
    for ty in range(top // TILE_PX, (bottom - 1) // TILE_PX + 1):
        for tx in range(left // TILE_PX, (right - 1) // TILE_PX + 1):
            path = web_dir / "tiles" / layer / f"{tx0 + tx}_{ty0 + ty}.png"
            if not path.exists():
                continue
            tile = np.asarray(Image.open(path).convert("RGBA"))
            x0 = max(left, tx * TILE_PX) - left
            x1 = min(right, (tx + 1) * TILE_PX) - left
            y0 = max(top, ty * TILE_PX) - top
            y1 = min(bottom, (ty + 1) * TILE_PX) - top
            sx0 = x0 + left - tx * TILE_PX
            sy0 = y0 + top - ty * TILE_PX
            out[y0:y1, x0:x1] = tile[sy0 : sy0 + (y1 - y0), sx0 : sx0 + (x1 - x0)]
    return out


def _coastal_mask(elev: np.ndarray, margin: int = 1, z_thresh: float = 5.0) -> np.ndarray:
    """Identify near-border, low-elevation cells as storm-surge boundary cells.

    For a domain that extends to the coast, the southern (bay-facing) border
    cells are low and can be forced to a sea level.  Inland low areas near the
    other borders may also be flagged; this is a coarse approximation and
    should be reviewed against actual topography.
    """
    h, w = elev.shape
    border = np.zeros_like(elev, dtype=np.bool_)
    if h > 2 * margin and w > 2 * margin:
        border[:margin, :] = True
        border[-margin:, :] = True
        border[:, :margin] = True
        border[:, -margin:] = True
    else:
        border[:] = True
    return border & (elev < z_thresh)


def load_region(
    web_dir: Path,
    lon: float = SAKAI_LON,
    lat: float = SAKAI_LAT,
    half_w: int = HALF_W_PX,
    half_h: int = HALF_H_PX,
    pool: int = POOL,
) -> RegionGrid:
    """Load the box from web/tiles dem/bldg PNG files and shrink it pool times."""
    meta = json.loads((web_dir / "meta.json").read_text())
    tx0, ty0 = meta["tile_range"]["x0"], meta["tile_range"]["y0"]
    cx, cy = lonlat_to_z15px(lon, lat, tx0, ty0)
    left = round(cx - half_w)
    top = round(cy - half_h)
    right = left + 2 * half_w
    bottom = top + 2 * half_h

    dem = _read_tiles(web_dir, "dem", left, top, right, bottom, tx0, ty0)
    bldg = _read_tiles(web_dir, "bldg", left, top, right, bottom, tx0, ty0)

    # DEM: cm → m へ pool 平均
    cm = dem[:, :, :3].astype(np.float64)
    cm = cm[:, :, 0] * 65536 + cm[:, :, 1] * 256 + cm[:, :, 2]
    elev_m = pool2(cm, pool) / 100.0

    # 建物: 高さ [cm] の被覆率で壁判定、表示用には被覆セルの平均高さ
    bh_cm = bldg[:, :, 0].astype(np.float64) * 256 + bldg[:, :, 1].astype(np.float64)
    cover = pool2((bh_cm > 0).astype(np.float64), pool)
    wall = cover >= 0.75
    mean_h = np.where(cover > 0, pool2(bh_cm, pool) / np.maximum(cover, 1e-6), 0.0)
    bldg_rgba = np.zeros((*elev_m.shape, 4), dtype=np.uint8)
    bldg_rgba[:, :, 0] = np.clip(mean_h / 256.0, 0, 255).astype(np.uint8)
    bldg_rgba[:, :, 1] = np.clip(np.mod(mean_h, 256.0), 0, 255).astype(np.uint8)
    bldg_rgba[:, :, 3] = 255

    return RegionGrid(
        elev=elev_m.astype(np.float32),
        wall=wall,
        bldg_rgba=bldg_rgba,
        dx=m_per_px_at_z15(lat) * pool,
        left=left,
        top=top,
        full_w=right - left,
        full_h=bottom - top,
        coastal_mask=_coastal_mask(elev_m),
    )


def rain_rate_at(series: list[list[float]], t: float) -> float:
    """Piecewise-linear hyetograph interpolation in mm/h (as sim.js does)."""
    if t <= series[0][0]:
        return float(series[0][1])
    for i in range(1, len(series)):
        if t <= series[i][0]:
            t0, r0 = series[i - 1]
            t1, r1 = series[i]
            return float(r0 + (r1 - r0) * (t - t0) / max(t1 - t0, 1e-6))
    return 0.0


def _face_flux(
    q: np.ndarray,
    h0: np.ndarray,
    h1: np.ndarray,
    eta0: np.ndarray,
    eta1: np.ndarray,
    dt: float,
    dx: float,
    manning: float,
) -> np.ndarray:
    """Face flux cell0 -> cell1 (same formula and donor limit as sim.js)."""
    hf = np.maximum(h0, h1)
    deta = eta0 - eta1
    qn = (q + G * hf * dt * deta / dx) / (
        1.0 + G * dt * hf * manning * manning * np.abs(q) / np.power(np.maximum(hf, 1e-12), 7.0 / 3.0)
    )
    donor = np.where(deta > 0.0, h0, h1)
    qcap = np.minimum(0.25 * donor * dx / dt, 15.0 * np.maximum(donor, 0.005))
    qn = np.clip(qn, -qcap, qcap)
    qn[hf < 0.005] = 0.0
    return qn.astype(np.float32)


def step(
    h: np.ndarray,
    qe: np.ndarray,
    qs: np.ndarray,
    z: np.ndarray,
    wall: np.ndarray,
    dt: float,
    dx: float,
    manning: float,
    rain_ms: float,
    loss_ms: float,
    sea_level: float = 0.0,
    coastal_mask: np.ndarray | None = None,
) -> None:
    """One pipe-scheme step in place; updates qe (H,W-1) and qs (H-1,W) too.

    Outside the domain h=0 and the bed equals the edge cell, so water
    freely drains over the boundary like the browser implementation.

    If ``coastal_mask`` is supplied, those cells are forced to keep at
    least ``sea_level - z`` water depth, approximating a raised sea level
    (storm surge / high tide) backing up from the coast.
    """
    # 境界外は水なし (h=0) ・地盤は端セル値 → 端から自由排水
    h_we = np.pad(h, ((0, 0), (1, 1)), constant_values=0.0)
    eta_we = np.pad(z, ((0, 0), (1, 1)), mode="edge") + h_we
    h_ns = np.pad(h, ((1, 1), (0, 0)), constant_values=0.0)
    eta_ns = np.pad(z, ((1, 1), (0, 0)), mode="edge") + h_ns

    qe_face = np.zeros((h.shape[0], h.shape[1] + 1), dtype=np.float32)
    qe_face[:, 1:-1] = qe
    qs_face = np.zeros((h.shape[0] + 1, h.shape[1]), dtype=np.float32)
    qs_face[1:-1, :] = qs

    wall_we = np.pad(wall, ((0, 0), (1, 1)), constant_values=False)
    wall_ns = np.pad(wall, ((1, 1), (0, 0)), constant_values=False)

    qe_face = _face_flux(qe_face, h_we[:, :-1], h_we[:, 1:], eta_we[:, :-1], eta_we[:, 1:], dt, dx, manning)
    qs_face = _face_flux(qs_face, h_ns[:-1, :], h_ns[1:, :], eta_ns[:-1, :], eta_ns[1:, :], dt, dx, manning)
    qe_face[wall_we[:, :-1] | wall_we[:, 1:]] = 0.0
    qs_face[wall_ns[:-1, :] | wall_ns[1:, :]] = 0.0

    div = (qe_face[:, :-1] - qe_face[:, 1:]) / dx + (qs_face[:-1, :] - qs_face[1:, :]) / dx
    loss = np.minimum(h, loss_ms * dt)
    h += dt * div - loss + np.float32(rain_ms * dt)
    np.clip(h, 0.0, 30.0, out=h)
    h[wall] = 0.0
    if coastal_mask is not None and sea_level > 0.0:
        h[coastal_mask] = np.maximum(h[coastal_mask], sea_level - z[coastal_mask])
    qe[...] = qe_face[:, 1:-1]
    qs[...] = qs_face[1:-1, :]


def encode_frame_rgba(h: np.ndarray, qe: np.ndarray, qs: np.ndarray) -> np.ndarray:
    """Quantise the water state into an RGBA uint8 frame (row 0 = north).

    R=depth [cm], G/B=(east/south flux x100)+128. Alpha is always 255:
    canvas-based decode premultiplies RGB by alpha, so data must never
    ride in RGB under a low alpha.
    """
    rgba = np.full((*h.shape, 4), 255, dtype=np.uint8)
    qe_cell = np.pad(qe, ((0, 0), (0, 1)), mode="edge")  # (H, W)
    qs_cell = np.pad(qs, ((0, 1), (0, 0)), mode="edge")  # (H, W)
    rgba[:, :, 0] = np.clip(h * 100.0, 0, 255).astype(np.uint8)
    rgba[:, :, 1] = np.clip(qe_cell * 100.0 + 128.0, 0, 255).astype(np.uint8)
    rgba[:, :, 2] = np.clip(qs_cell * 100.0 + 128.0, 0, 255).astype(np.uint8)
    return rgba


def encode_max_gray(hmax: np.ndarray) -> np.ndarray:
    """Cumulative max depth [cm] as an 8-bit grayscale image (A-safe)."""
    return np.clip(hmax * 100.0, 0, 255).astype(np.uint8)


def streams_intensity(elev: np.ndarray, dx: float, min_cells: float = 80.0) -> np.ndarray:
    """D8 contributing-area intensity in 0..1 (watershed overlay source).

    上流寄与セル数をlogスケールで正規化し、集水面積が min_cells 未満の
    細流は切り捨てる。値が高い = 上流の集水域が広い流路・低地。
    """
    filled = fill_sinks_priority_flood(elev.astype(np.float64))
    directions = d8_flow_directions(filled, dx)
    acc = flow_accumulation(filled, directions)
    acc = np.where(acc >= min_cells, acc, 0.0)
    peak = max(float(acc.max()), 1.0)
    return (np.log1p(acc) / np.log1p(peak)).astype(np.float32)


def _stats(h: np.ndarray, dx: float) -> dict[str, float]:
    """Aggregate flood statistics for one frame."""
    cell = dx * dx
    return {
        "volume": float(h.sum(dtype=np.float64) * cell),
        "a5": float((h > 0.05).sum() * cell),
        "a30": float((h > 0.30).sum() * cell),
        "a100": float((h > 1.00).sum() * cell),
    }


def _elev_to_rgba_png(elev_m: np.ndarray) -> np.ndarray:
    """Encode elevation [m] into the RGBA cm layout the web app expects."""
    rgba = np.zeros((*elev_m.shape, 4), dtype=np.uint8)
    cmi = np.floor(np.clip(elev_m * 100.0, 0, 2**24 - 1)).astype(np.int64)
    rgba[:, :, 0] = (cmi // 65536).astype(np.uint8)
    rgba[:, :, 1] = ((cmi // 256) % 256).astype(np.uint8)
    rgba[:, :, 2] = (cmi % 256).astype(np.uint8)
    rgba[:, :, 3] = 255
    return rgba


def _scenario_entry(web_dir: Path, scenario_file: str) -> dict[str, str]:
    """Look up the display-name entry for a scenario in index.json."""
    idx_path = web_dir / "scenarios" / "index.json"
    if not idx_path.exists():
        return {}
    for e in json.loads(idx_path.read_text()):
        if e.get("file") == scenario_file:
            return e
    return {}


def _write_streams_overlay(out: Path, region: RegionGrid) -> None:
    """Write the full-resolution watershed overlay streams.png."""
    img = streams_intensity(region.elev, region.dx)
    full = np.repeat(np.repeat(img, POOL, axis=0), POOL, axis=1)
    full = full[: region.full_h, : region.full_w]
    Image.fromarray((full * 255).astype(np.uint8), "L").save(out / "streams.png", compress_level=5)


def _update_replay_index(out: Path, scenario_file: str, name: str, desc: str, label: str) -> None:
    """Upsert this replay's entry in the precomputed/index.json catalogue."""
    index_path = out.parent / "index.json"
    entries: list[dict[str, str]] = []
    if index_path.exists():
        entries = [e for e in json.loads(index_path.read_text()) if e.get("dir") != out.name]
    entries.append({"dir": out.name, "scenario": scenario_file, "name": name, "desc": desc, "label": label})
    index_path.write_text(json.dumps(entries, ensure_ascii=False))


def _run_precompute_simulation(
    region: RegionGrid,
    out: Path,
    series: list[list[float]],
    dt: float,
    frame_interval: float,
    loss_ms: float,
    sea_level_m: float,
    *,
    progress: bool,
    zones: list[UndergroundZone] | None = None,
    zone_props: list[tuple[np.ndarray, float]] | None = None,
    volumes: np.ndarray | None = None,
) -> tuple[np.ndarray, list[float], list[dict[str, float]]]:
    """Run the LISFLOOD-FP loop and emit 60-second frames to ``out``.

    Returns ``(hmax, times, stats)`` where ``times`` are relative to the
    simulation window start.

    If ``zones``/``zone_props``/``volumes`` are provided, a two-way simplified
    underground inundation model is applied each step and an
    ``underground_*.png`` frame is written alongside the surface frame.
    """
    from .underground import step_underground  # noqa: PLC0415 - avoid circular import
    from .underground import underground_depth_map  # noqa: PLC0415

    h = np.zeros(region.elev.shape, dtype=np.float32)
    qe = np.zeros((region.elev.shape[0], region.elev.shape[1] - 1), dtype=np.float32)
    qs = np.zeros((region.elev.shape[0] - 1, region.elev.shape[1]), dtype=np.float32)
    hmax = np.zeros_like(h)
    times: list[float] = []
    stats: list[dict[str, float]] = []
    underground_on = zones is not None and zone_props is not None and volumes is not None

    active = [t for t, r in series if r > 1.0]
    t_start = max(series[0][0], min(active) - 3600.0)
    t_end = min(series[-1][0], max(active) + 3 * 3600.0)
    n_steps = int((t_end - t_start) / dt)
    next_frame = t_start
    t = t_start
    for i in range(n_steps + 1):
        if t >= next_frame - 1e-9:
            np.maximum(hmax, h, out=hmax)
            idx = len(times)
            Image.fromarray(encode_frame_rgba(h, qe, qs), "RGBA").save(out / f"frame_{idx:04d}.png", compress_level=5)
            Image.fromarray(encode_max_gray(hmax), "L").save(out / f"max_{idx:04d}.png", compress_level=5)
            if underground_on:
                assert zones is not None and zone_props is not None and volumes is not None
                depth = underground_depth_map(volumes, zone_props=zone_props)
                Image.fromarray(np.clip(depth * 100.0, 0, 255).astype(np.uint8), "L").save(
                    out / f"underground_{idx:04d}.png", compress_level=5
                )
            times.append(round(t - t_start, 3))
            stats.append(_stats(h, region.dx))
            next_frame += frame_interval
        if i == n_steps:
            break
        rate = rain_rate_at(series, t) / 1000.0 / 3600.0
        if underground_on:
            assert zones is not None and zone_props is not None and volumes is not None
            volumes[:], sink = step_underground(zones, h, dt, volumes, zone_props)
            h -= sink
            np.clip(h, 0.0, 30.0, out=h)
        step(
            h,
            qe,
            qs,
            region.elev,
            region.wall,
            dt,
            region.dx,
            MANNING,
            rate,
            loss_ms,
            sea_level=sea_level_m,
            coastal_mask=region.coastal_mask,
        )
        t += dt
        if progress and i % 2000 == 0:
            pct = 100.0 * i / n_steps
            print(f"precompute: {pct:5.1f}%  t={t / 3600:.2f}h  max_h={h.max():.2f}m", flush=True)
    return hmax, times, stats


def precompute(
    out_dir: Path | None = None,
    scenario_file: str = SCENARIO,
    lon: float = SAKAI_LON,
    lat: float = SAKAI_LAT,
    dt: float = DT_S,
    frame_interval: float = FRAME_INTERVAL_S,
    label: str = "栄",
    *,
    streams_only: bool = False,
    progress: bool = True,
    sea_level_m: float = 0.0,
    underground: bool = False,
) -> Path:
    """Precompute a 7x5.5km flood replay (default: Sakai) into web/precomputed/.

    Args:
        out_dir: output directory; default ``web/precomputed/sakai``.
        scenario_file: rainfall scenario JSON under ``web/scenarios``.
        lon: simulation box centre longitude [deg].
        lat: simulation box centre latitude [deg].
        dt: physical time step [s].
        frame_interval: seconds between saved replay frames.
        label: display name used in the web UI replay list.
        streams_only: regenerate the streams overlay without recomputing flood.
        progress: print progress messages.
        sea_level_m: raised sea level [m] applied at coastal boundary cells,
            approximating storm surge / high tide backing into low ground.
        underground: enable the simplified underground-space inundation model
            for Nagoya Station / Sakae / Fushimi underground malls.
    """
    out = out_dir or (WEB_DIR / "precomputed" / "sakai")
    out.mkdir(parents=True, exist_ok=True)
    region = load_region(WEB_DIR, lon=lon, lat=lat)

    if streams_only:
        # 物理の再計算なしに分水域オーバーレイだけ再生成する
        _write_streams_overlay(out, region)
        print(f"streams overlay written: {out / 'streams.png'}", flush=True)
        return out

    scenario = json.loads((WEB_DIR / "scenarios" / scenario_file).read_text())
    series: list[list[float]] = [[float(t), float(r)] for t, r in scenario["series"]]
    entry = _scenario_entry(WEB_DIR, scenario_file)
    loss_ms = (DRAIN_MMH + INFIL_MMH) / 1000.0 / 3600.0

    zones: list[UndergroundZone] | None = None
    zone_props: list[tuple[np.ndarray, float]] | None = None
    volumes: np.ndarray | None = None
    if underground:
        from .underground import _zone_properties  # noqa: PLC0415
        from .underground import nagoya_zones  # noqa: PLC0415

        zones = nagoya_zones()
        masks, areas = _zone_properties(zones, lon, lat, region.dx, region.elev.shape)
        zone_props = list(zip(masks, areas, strict=True))
        volumes = np.zeros(len(zones), dtype=np.float64)

    _hmax, times, stats = _run_precompute_simulation(
        region,
        out,
        series,
        dt,
        frame_interval,
        loss_ms,
        sea_level_m,
        progress=progress,
        zones=zones,
        zone_props=zone_props,
        volumes=volumes,
    )

    # 2D表示用の縮小地形/建物ラスタ + 分水域オーバーレイ
    Image.fromarray(_elev_to_rgba_png(region.elev), "RGBA").save(out / "terrain.png", compress_level=5)
    Image.fromarray(region.bldg_rgba, "RGBA").save(out / "bldg.png", compress_level=5)
    _write_streams_overlay(out, region)

    # 再生用の時刻軸はウィンドウ開始を0とする (app.js の sim.time に直結)
    active = [t for t, r in series if r > 1.0]
    t_start = max(series[0][0], min(active) - 3600.0)
    rel_series = [[t - t_start, r] for t, r in series if t >= t_start]
    meta = {
        "name": entry.get("name", scenario.get("name", scenario_file)),
        "desc": entry.get("desc", scenario.get("desc", "")),
        "source": scenario.get("source", ""),
        "scenario": scenario_file,
        "label": label,
        "grid": {"w": region.elev.shape[1], "h": region.elev.shape[0], "dx": region.dx},
        "full": {"w": region.full_w, "h": region.full_h, "dx": region.dx / POOL},
        "bounds_px": {"left": region.left, "top": region.top, "w": region.full_w, "h": region.full_h},
        "origin": {"lon": lon, "lat": lat},
        "interval": frame_interval,
        "params": {
            "drain": DRAIN_MMH,
            "infil": INFIL_MMH,
            "manning": MANNING,
            "sea_level_m": sea_level_m,
            "underground": underground,
        },
        "series": rel_series,
        "times": times,
        "stats": stats,
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    _update_replay_index(out, scenario_file, str(meta["name"]), str(meta["desc"]), label)

    print(f"precompute: {len(times)} frames -> {out}", flush=True)
    return out

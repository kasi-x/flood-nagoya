"""Build command: mosaic DEM, rasterize buildings, emit web assets.

Pipeline (``python -m flood_nagoya build``):
1. mosaic raw GSI dem5a text tiles into one bbox-wide grid,
2. classify voids (sea vs inland holes) and fill them,
3. emit per-tile RGBA PNG files (elevation in cm across R/G/B, A = valid),
4. slice the PLATEAU building raster into per-tile RGB tiles,
5. build a city-wide overview grid + drainage-network overlay,
6. write ``web/meta.json`` describing everything for the client.
"""

from __future__ import annotations

import concurrent.futures as cf
import json
import os
import time

import numpy as np
import numpy.typing as npt
from PIL import Image
from scipy import ndimage

from .config import GSI_ZOOM
from .config import LAT_MAX
from .config import LAT_MIN
from .config import LON_MAX
from .config import LON_MIN
from .config import PLATEAU_EXTRACT_DIR
from .config import RAW_DEM_DIR
from .config import WEB_DIR
from .config import WEB_META
from .config import WEB_TILE_DIR
from .config import Z15_CELL_AREA_M2
from .config import Z15_M_PER_PX
from .gsitiles import bbox_tile_range
from .gsitiles import parse_dem_txt
from .hydro import drainage_network_mask

OVERVIEW_FACTOR = 4  # overview px = 4 x dem5a z15 px (~15.6 m/px)
STREAM_THRESHOLD_CELLS = 800.0  # contributing overview cells for a "stream"


def load_mosaic() -> tuple[np.ndarray, np.ndarray]:
    """Assemble raw tiles into (elevation, valid) arrays; voids are NaN."""
    x0, x1, y0, y1 = bbox_tile_range()
    height = (y1 + 1 - y0) * 256
    width = (x1 + 1 - x0) * 256
    mosaic = np.full((height, width), np.nan, dtype=np.float32)
    t0 = time.time()
    n_ok = 0
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            path = RAW_DEM_DIR / f"{x}_{y}.txt"
            if not path.exists() or path.stat().st_size == 0:
                continue  # outside DEM coverage (tombstone)
            tile = parse_dem_txt(path.read_bytes())
            ry = (y - y0) * 256
            rx = (x - x0) * 256
            mosaic[ry : ry + 256, rx : rx + 256] = tile
            n_ok += 1
    valid = np.isfinite(mosaic)
    print(f"mosaic {width}x{height}: {n_ok} tiles ok, void {100 * (1 - valid.mean()):.1f}%, {time.time() - t0:.0f}s")
    return mosaic, valid


def fill_voids(mosaic: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Sea-connected voids become 0 m; inland holes take nearest-neighbor fill.

    Returns (dem, sea_mask) — the sea mask survives so the client can shade
    water bodies distinctly from 0 m reclaimed land.
    """
    out = mosaic.copy()
    void = ~valid
    labels: npt.NDArray[np.int32] = ndimage.label(void)[0]
    border_labels = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])))
    border_labels.discard(0)
    sea = void & np.isin(labels, list(border_labels))
    out[sea] = 0.0
    holes = void & ~sea
    print(f"voids: sea {int(sea.sum())} px, inland holes {int(holes.sum())} px")
    if holes.any():
        _diffuse_holes(out, valid, holes)
    return out.astype(np.float32), sea


def _diffuse_holes(
    out: np.ndarray,
    valid: np.ndarray,
    holes: np.ndarray,
) -> None:
    """Lockstep 3-by-3 mean diffusion restricted to the remaining-hole bbox.

    Bit-for-bit identical to filtering the whole grid every iteration: each
    unfilled hole pixel's 3-by-3 window lies inside the bounding box of the
    remaining holes plus a one-pixel ring, and where the box is clamped at
    the grid edge the crop boundary reflects exactly like the full grid.
    The crop shrinks as rings are filled, so the work is O(bbox area) per
    iteration instead of O(full grid area).
    """
    arr = np.where(valid, out, 0.0)
    weight = (~holes).astype(np.float64)
    was_holes = holes.copy()
    ys, xs = np.nonzero(holes)
    y0 = max(int(ys.min()) - 1, 0)
    y1 = min(int(ys.max()) + 2, out.shape[0])
    x0 = max(int(xs.min()) - 1, 0)
    x1 = min(int(xs.max()) + 2, out.shape[1])
    for _ in range(500):
        hview = holes[y0:y1, x0:x1]
        if not hview.any():
            break
        av = arr[y0:y1, x0:x1]
        wv = weight[y0:y1, x0:x1]
        blur_v: npt.NDArray[np.float64] = ndimage.uniform_filter(av, size=3)
        blur_w: npt.NDArray[np.float64] = ndimage.uniform_filter(wv, size=3)
        fill_now = hview & (blur_w > 1e-6)
        av[fill_now] = blur_v[fill_now] / blur_w[fill_now]
        wv[fill_now] = 1.0
        hview[fill_now] = False
        rem = np.argwhere(hview)
        if rem.size == 0:
            break
        new_y0 = y0 + int(rem[:, 0].min()) - 1
        new_y1 = y0 + int(rem[:, 0].max()) + 2
        new_x0 = x0 + int(rem[:, 1].min()) - 1
        new_x1 = x0 + int(rem[:, 1].max()) + 2
        y0 = max(new_y0, 0)
        y1 = min(new_y1, out.shape[0])
        x0 = max(new_x0, 0)
        x1 = min(new_x1, out.shape[1])
    filled = was_holes & (weight > 0.0)
    out[filled] = arr[filled].astype(np.float32)
    leftover = was_holes & ~filled
    out[leftover] = 0.0
    if leftover.any():
        print(f"  hole fill left {int(leftover.sum())} px unfilled (set to 0)")


def elevation_to_rgba(elev: np.ndarray) -> Image.Image:
    """Encode metres into an RGBA PNG payload (cm across R/G/B, A=valid)."""
    cm = np.clip(np.rint(elev * 100.0), 0, 2**24 - 1).astype(np.uint32)
    h, w = cm.shape
    rgba = np.empty((h, w, 4), dtype=np.uint8)
    rgba[..., 0] = (cm >> 16) & 255
    rgba[..., 1] = (cm >> 8) & 255
    rgba[..., 2] = cm & 255
    rgba[..., 3] = 255
    return Image.fromarray(rgba, "RGBA")


def write_dem_tiles(dem: np.ndarray, tile_range: tuple[int, int, int, int]) -> None:
    x0, x1, y0, y1 = tile_range
    out_dir = WEB_TILE_DIR / "dem"
    out_dir.mkdir(parents=True, exist_ok=True)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    def save(job: tuple[int, int]) -> None:
        x, y = job
        ry = (y - y0) * 256
        rx = (x - x0) * 256
        elevation_to_rgba(dem[ry : ry + 256, rx : rx + 256]).save(
            out_dir / f"{x}_{y}.png", optimize=False, compress_level=6
        )

    # PIL's PNG encoder releases the GIL, so tiles encode on a thread pool.
    # Each tile is written independently, so the output bytes are unchanged.
    with cf.ThreadPoolExecutor(max_workers=min(16, os.cpu_count() or 1)) as pool:
        list(pool.map(save, jobs))
    print(f"  dem tiles: {len(jobs)} written")


def write_bldg_tiles(dem_shape: tuple[int, int], heights: np.ndarray, tile_range: tuple[int, int, int, int]) -> None:
    x0, x1, y0, y1 = tile_range
    out_dir = WEB_TILE_DIR / "bldg"
    out_dir.mkdir(parents=True, exist_ok=True)
    hh, hw = dem_shape
    heights = heights[:hh, :hw]
    # npz heights are int16: negative values mean the source value overflowed
    # int16 (e.g. an absurd measuredHeight) and must not wrap into a huge
    # unsigned height on decode. Clamp to a plausible 250 m cap.
    u16 = np.clip(heights.astype(np.int32), 0, 25000).astype(np.uint16)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    def save(job: tuple[int, int]) -> None:
        x, y = job
        ry = (y - y0) * 256
        rx = (x - x0) * 256
        tile = u16[ry : ry + 256, rx : rx + 256]
        rgb = np.zeros((tile.shape[0], tile.shape[1], 3), dtype=np.uint8)
        rgb[..., 0] = (tile >> 8) & 255
        rgb[..., 1] = tile & 255
        Image.fromarray(rgb, "RGB").save(out_dir / f"{x}_{y}.png", optimize=False, compress_level=6)

    with cf.ThreadPoolExecutor(max_workers=min(16, os.cpu_count() or 1)) as pool:
        list(pool.map(save, jobs))
    print(f"  bldg tiles: {len(jobs)} written")


def build_overview(
    mosaic: np.ndarray,
    sea: np.ndarray,
    heights: np.ndarray | None = None,
) -> dict[str, float | int]:
    h, w = mosaic.shape
    oh, ow = h // OVERVIEW_FACTOR, w // OVERVIEW_FACTOR
    crop = mosaic[: oh * OVERVIEW_FACTOR, : ow * OVERVIEW_FACTOR]
    blocks = crop.reshape(oh, OVERVIEW_FACTOR, ow, OVERVIEW_FACTOR)
    overview = np.nan_to_num(np.nanmean(blocks, axis=(1, 3)), nan=0.0).astype(np.float32)
    sea_crop = sea[: oh * OVERVIEW_FACTOR, : ow * OVERVIEW_FACTOR]
    sea_blocks = sea_crop.reshape(oh, OVERVIEW_FACTOR, ow, OVERVIEW_FACTOR)
    sea_ov = sea_blocks.mean(axis=(1, 3)) > 0.5
    px_per_cell = OVERVIEW_FACTOR * Z15_M_PER_PX  # ~m/px at Nagoya latitude
    print(f"overview {ow}x{oh} (~{px_per_cell:.1f} m/px); hydrology running…")
    t0 = time.time()
    streams, acc = drainage_network_mask(overview.astype(np.float64), px_per_cell, STREAM_THRESHOLD_CELLS)
    streams = streams & ~sea_ov
    print(f"  hydrology done in {time.time() - t0:.0f}s; stream cells {int(streams.sum())}")

    out_dir = WEB_DIR / "overview"
    out_dir.mkdir(parents=True, exist_ok=True)
    img = elevation_to_rgba(overview)
    # A=255 land, A=128 sea so the client can shade the bay distinctly
    a = np.where(sea_ov, 128, 255).astype(np.uint8)
    arr = np.array(img)
    arr[..., 3] = a
    Image.fromarray(arr, "RGBA").save(out_dir / "dem.png", optimize=False, compress_level=6)
    stream_u8 = (np.clip(acc / STREAM_THRESHOLD_CELLS, 1.0, 12.0) / 12.0 * 255).astype(np.uint8)
    stream_u8[~streams] = 0
    Image.fromarray(stream_u8, "L").save(out_dir / "streams.png")

    # Building overlay for the map view: max-pool the z15 height raster.
    if heights is not None:
        hc = heights[: mosaic.shape[0], : mosaic.shape[1]]
        hc = hc[: oh * OVERVIEW_FACTOR, : ow * OVERVIEW_FACTOR]
        hblocks = hc.reshape(oh, OVERVIEW_FACTOR, ow, OVERVIEW_FACTOR)
        bov = np.max(hblocks, axis=(1, 3)).astype(np.int32)
        bov = np.clip(bov, 0, 25000)
        bov[sea_ov] = 0
        rgb = np.empty((oh, ow, 3), dtype=np.uint8)
        rgb[..., 0] = (bov >> 8) & 255
        rgb[..., 1] = bov & 255
        rgb[..., 2] = 0
        Image.fromarray(rgb, "RGB").save(out_dir / "bldg.png", optimize=False, compress_level=6)
        print("  overview bldg.png written")
    return {"width": int(ow), "height": int(oh), "m_per_px": float(px_per_cell)}


def build() -> None:
    t0 = time.time()
    tile_range = bbox_tile_range()
    x0, x1, y0, y1 = tile_range

    mosaic, valid = load_mosaic()
    dem, sea = fill_voids(mosaic, valid)
    del mosaic, valid
    dem = np.clip(dem, -3.0, 3000.0)

    WEB_TILE_DIR.mkdir(parents=True, exist_ok=True)
    print("writing DEM tiles…")
    write_dem_tiles(dem, tile_range)

    print("writing building tiles…")
    npz_path = PLATEAU_EXTRACT_DIR / "buildings_z15.npz"
    heights: np.ndarray | None = None
    if npz_path.exists():
        heights_npz: np.ndarray = np.load(npz_path)["heights"]
        heights = heights_npz
        write_bldg_tiles(dem.shape, heights_npz, tile_range)
    else:
        print("  buildings npz missing — skipped")

    print("building overview…")
    overview = build_overview(dem, sea, heights)

    # Client-side pixel transform: z15 pixel (i, j) <-> lon/lat. Linear in x,
    # mercator in y; the overview shares the same origin (x0, y0).
    meta = {
        "data_sources": {
            "elevation": "国土地理院 地図タイル dem5a (数値標高モデル5m, 平成以降測量)",
            "buildings": "国土交通省 Project PLATEAU 名古屋市 2022 CityGML (lod0FootPrint + measuredHeight)",
            "license": "国土地理院コンテンツ利用規約 / PLATEAU利用規約に従う",
        },
        "zoom": GSI_ZOOM,
        "tile_range": {"x0": x0, "x1": x1, "y0": y0, "y1": y1},
        "bbox": {"lon_min": LON_MIN, "lat_min": LAT_MIN, "lon_max": LON_MAX, "lat_max": LAT_MAX},
        "px_per_tile": 256,
        "overview_factor": OVERVIEW_FACTOR,
        "overview": overview,
        "elevation_encoding": "RGBA PNG: elev_m = (R*65536+G*256+B)/100, A=255 valid",
        "building_encoding": "RGB PNG: height_cm = R*256+G, 0 = no building",
        "overview_bldg": heights is not None,
        "land_area_km2": float(np.sum(dem > 0.5) * Z15_CELL_AREA_M2 / 1e6),
    }
    WEB_META.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"build complete in {time.time() - t0:.0f}s → {WEB_DIR}")

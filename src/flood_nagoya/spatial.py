"""Shared plumbing for spatial rainfall scenarios (XRAIN / MSM).

Both sources emit the same frame format: one 8-bit PNG per time step
covering the study bbox on the overview grid (z15 pixels / OVERVIEW_FACTOR,
same origin as ``web/meta.json`` ``tile_range``). Rain intensity is
quantised to 0.5 mm/h per count so the shader decodes ``value * 0.5``
directly. Frames keep geographic rows (row 0 = north), like every other
web asset in this project.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import TypedDict

import numpy as np
from PIL import Image

from .config import GSI_ZOOM
from .gsitiles import bbox_tile_range
from .gsitiles import tile_x_to_lon
from .gsitiles import tile_y_to_lat

OVERVIEW_FACTOR = 4  # overview px = 4 x z15 px (~15.6 m/px); mirrors pipeline.py
MMH_PER_COUNT = 0.5  # frame PNG quantisation


class FrameGeo(TypedDict):
    """Georeference of the frame ONGs, consumed by web/app.js."""

    tile_x0: int
    tile_y0: int
    zoom: int
    factor: int
    width: int
    height: int


class SpatialScenario(TypedDict):
    kind: str
    date: str
    tz: str
    frame_seconds: int
    mmh_per_count: float
    geo: FrameGeo
    frames: list[dict[str, object]]
    series: list[list[float]]
    total_mm: float
    peak_mmh: float
    source: str
    note: str
    file: str


def overview_shape() -> tuple[int, int]:
    """(width, height) of the study overview grid in pixels."""
    x0, x1, y0, y1 = bbox_tile_range()
    width = (x1 + 1 - x0) * 256 // OVERVIEW_FACTOR
    height = (y1 + 1 - y0) * 256 // OVERVIEW_FACTOR
    return width, height


def overview_lat_lon() -> tuple[np.ndarray, np.ndarray]:
    """Latitude/longitude of every overview pixel centre (2D arrays)."""
    x0, _, y0, _ = bbox_tile_range()
    width, height = overview_shape()
    z15_x = (x0 * 256 + np.arange(width) * OVERVIEW_FACTOR + OVERVIEW_FACTOR / 2.0) / 256.0
    z15_y = (y0 * 256 + np.arange(height) * OVERVIEW_FACTOR + OVERVIEW_FACTOR / 2.0) / 256.0
    lon = np.array([tile_x_to_lon(float(x), GSI_ZOOM) for x in z15_x])
    lat = np.array([tile_y_to_lat(float(y), GSI_ZOOM) for y in z15_y])
    lon2d, lat2d = np.meshgrid(lon, lat)
    return lat2d, lon2d


def tile_origin() -> tuple[int, int]:
    """(x0, y0) z15 tile coords of the mosaic north-west corner."""
    x0, _, y0, _ = bbox_tile_range()
    return x0, y0


def encode_frame_png(mmh: np.ndarray, path: Path) -> None:
    """Write one rain frame (mm/h) as an 8-bit grayscale PNG."""
    counts = np.clip(np.rint(mmh / MMH_PER_COUNT), 0, 255).astype(np.uint8)
    Image.fromarray(counts, "L").save(path, optimize=False, compress_level=6)


def decode_frame_png(path: Path) -> np.ndarray:
    """Inverse of :func:`encode_frame_png` (used by tests and tooling)."""
    counts = np.asarray(Image.open(path).convert("L"), dtype=np.float64)
    return counts * MMH_PER_COUNT


def build_spatial_scenario(
    kind: str,
    day: date,
    frame_seconds: int,
    fields: list[np.ndarray],
    meta: dict[str, str],
) -> SpatialScenario:
    """Assemble the shared scenario document from decoded rain fields."""
    width, height = overview_shape()
    tile_x0, tile_y0 = tile_origin()
    series = frame_series(fields, frame_seconds)
    totals = [rate for _, rate in series]
    frames: list[dict[str, object]] = [{"t": i * frame_seconds, "file": f"f{i:04d}.png"} for i in range(len(fields))]
    return SpatialScenario(
        kind=kind,
        date=day.isoformat(),
        tz="Asia/Tokyo",
        frame_seconds=frame_seconds,
        mmh_per_count=MMH_PER_COUNT,
        geo=FrameGeo(
            tile_x0=tile_x0,
            tile_y0=tile_y0,
            zoom=GSI_ZOOM,
            factor=OVERVIEW_FACTOR,
            width=width,
            height=height,
        ),
        frames=frames,
        series=series,
        total_mm=round(sum(totals) * frame_seconds / 3600.0, 1),
        peak_mmh=max(totals, default=0.0),
        source=meta.get("source", ""),
        note=meta.get("note", ""),
        file=f"rain_{day:%Y%m%d}_{kind}.json",
    )


def write_spatial_scenario(scenario: SpatialScenario, out_dir: Path | None = None) -> Path:
    """Write scenario JSON + refresh the app-facing index (see amedas.write_index)."""
    from .amedas import write_scenario  # noqa: PLC0415 - avoids an import cycle

    return write_scenario(dict(scenario), out_dir)


def frame_series(frames_mmh: list[np.ndarray], step_seconds: int) -> list[list[float]]:
    """Domain-mean rain rate per frame as [[t_seconds, mm_h], ...] breakpoints."""
    series = [[i * step_seconds, round(float(np.nanmean(field)), 2)] for i, field in enumerate(frames_mmh)]
    series.append([len(frames_mmh) * step_seconds, 0.0])
    return series

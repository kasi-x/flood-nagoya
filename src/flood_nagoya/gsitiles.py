"""XYZ tile math, download and parsing for GSI Tiles "dem5a" text tiles."""

from __future__ import annotations

import concurrent.futures as cf
import math
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import overload

import numpy as np

from .config import GSI_LAYER
from .config import GSI_TILE_TXT
from .config import GSI_ZOOM
from .config import LAT_MAX
from .config import LAT_MIN
from .config import LON_MAX
from .config import LON_MIN
from .config import RAW_DEM_DIR

TILE_SIZE = 256  # px, equals number of values per row in the .txt payload
REQUEST_TIMEOUT = 30.0


@overload
def lon_to_tile_x(lon: float, zoom: int = GSI_ZOOM) -> float: ...


@overload
def lon_to_tile_x(lon: np.ndarray, zoom: int = GSI_ZOOM) -> np.ndarray: ...


def lon_to_tile_x(lon: float | np.ndarray, zoom: int = GSI_ZOOM) -> float | np.ndarray:
    # the arithmetic is Any under the float/ndarray union; pin the result
    result: float | np.ndarray = (lon + 180.0) / 360.0 * 2**zoom
    return result


@overload
def lat_to_tile_y(lat: float, zoom: int = GSI_ZOOM) -> float: ...


@overload
def lat_to_tile_y(lat: np.ndarray, zoom: int = GSI_ZOOM) -> np.ndarray: ...


def lat_to_tile_y(lat: float | np.ndarray, zoom: int = GSI_ZOOM) -> float | np.ndarray:
    lat_rad: float | np.ndarray = np.radians(lat)
    y: float | np.ndarray = (1.0 - np.arcsinh(np.tan(lat_rad)) / np.pi) / 2.0 * 2**zoom
    return y


def tile_x_to_lon(x: float, zoom: int = GSI_ZOOM) -> float:
    return x / 2**zoom * 360.0 - 180.0


def tile_y_to_lat(y: float, zoom: int = GSI_ZOOM) -> float:
    y_norm = 1.0 - 2.0 * y / 2**zoom
    return math.degrees(math.atan(math.sinh(y_norm * math.pi)))


def bbox_tile_range() -> tuple[int, int, int, int]:
    """Inclusive (x0, x1, y0, y1) covering the study bbox at GSI_ZOOM."""
    x0 = math.floor(lon_to_tile_x(LON_MIN))
    x1 = math.floor(lon_to_tile_x(LON_MAX))
    # Web-mercator y grows towards the south, so flip the ordering.
    y0 = math.floor(lat_to_tile_y(LAT_MAX))
    y1 = math.floor(lat_to_tile_y(LAT_MIN))
    return x0, x1, y0, y1


def tile_url(x: int, y: int, layer: str = GSI_LAYER, zoom: int = GSI_ZOOM) -> str:
    return GSI_TILE_TXT.format(layer=layer, z=zoom, x=x, y=y)


def parse_dem_txt(payload: bytes) -> np.ndarray:
    """Parse a GSI dem text tile into a float32 array (NaN = void)."""
    text = payload.decode("ascii")
    rows = [row for row in text.splitlines() if row.strip()]
    if len(rows) != TILE_SIZE:
        msg = f"expected {TILE_SIZE} rows, got {len(rows)}"
        raise ValueError(msg)
    # Fast path (the overwhelming majority of tiles): comma-separated plain
    # decimal grid, no "e" void markers. One C-level split + one bulk float
    # conversion instead of 256 per-row Python passes. Falls back to the
    # strict per-row parser on any anomaly.
    if b"e" not in payload and all(len(row.split(",")) == TILE_SIZE for row in rows):
        flat = np.array(text.replace(",", " ").split(), dtype=np.float32)
        if flat.size == TILE_SIZE * TILE_SIZE:
            return flat.reshape(TILE_SIZE, TILE_SIZE)
    out = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)
    for r, row in enumerate(rows):
        values = row.split(",")
        if len(values) < TILE_SIZE:
            msg = f"row {r}: expected {TILE_SIZE} values, got {len(values)}"
            raise ValueError(msg)
        vals = values[:TILE_SIZE]
        valid = [v for v in vals if v != "e"]
        if len(valid) == len(vals):
            out[r] = np.fromiter(map(float, vals), dtype=np.float32, count=TILE_SIZE)
        else:
            out[r] = [float(v) if v != "e" else np.nan for v in vals]
    return out


def fetch_tile(x: int, y: int, retries: int = 3) -> bytes | None:
    """Download one text tile; None if the server reports missing data."""
    url = tile_url(x, y)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(  # noqa: S310 - https-only config URLs
                url, headers={"User-Agent": "flood-nagoya/0.1"}
            )
            with urllib.request.urlopen(  # noqa: S310 - https-only config URLs
                req, timeout=REQUEST_TIMEOUT
            ) as resp:
                body: bytes = resp.read()
            if body.lstrip().startswith(b"<?xml"):
                return None  # NoSuchKey: outside DEM coverage
            return body  # noqa: TRY300
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None  # tile outside DEM coverage
            if attempt == retries - 1:
                raise
            time.sleep(1.0 + attempt)
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == retries - 1:
                raise
            time.sleep(1.0 + attempt)
    return None


def download_bbox(parallel: int = 12) -> dict[str, int]:
    """Download every dem5a text tile overlapping the study bbox."""
    x0, x1, y0, y1 = bbox_tile_range()
    RAW_DEM_DIR.mkdir(parents=True, exist_ok=True)
    jobs: list[tuple[int, int, Path]] = []
    for x in range(x0, x1 + 1):
        jobs.extend((x, y, RAW_DEM_DIR / f"{x}_{y}.txt") for y in range(y0, y1 + 1))

    stats = {"ok": 0, "missing": 0, "cached": 0}
    todo = [(x, y, p) for x, y, p in jobs if not p.exists()]
    stats["cached"] = len(jobs) - len(todo)
    print(f"tiles: {len(jobs)} total, {len(todo)} to download, range x[{x0},{x1}] y[{y0},{y1}]")

    def work(job: tuple[int, int, Path]) -> str:
        x, y, path = job
        body = fetch_tile(x, y)
        if body is None:
            path.write_bytes(b"")  # tombstone for tiles outside coverage
            return "missing"
        path.write_bytes(body)
        return "ok"

    done = 0
    with cf.ThreadPoolExecutor(max_workers=parallel) as pool:
        for result in pool.map(work, todo):
            stats[result] += 1
            done += 1
            if done % 100 == 0 or done == len(todo):
                print(f"  {done}/{len(todo)} (ok={stats['ok']} missing={stats['missing']})")
    return stats

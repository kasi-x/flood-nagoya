"""Observed spatial rainfall from MLIT XRAIN (X-band MP radar) display images.

川の防災情報 (river.go.jp kawabou) publishes coloured XRAIN mesh images at
``kawabou/file/radar/image/xrd/{area}/{level}/{YYYYMMDD}/{HHMM}/{seq}.png``.
Each image is a palette PNG (960x320 at level 2) covering a lat/lon box
encoded in the master mesh list ``kawabou/file/files/master/radar/xrd/
{level}.json``; the online map converts ``meshFrom``/``meshTo`` into
bounds as ``lat = row / 1.5``, ``lng = col + 100`` — mirrored in
:func:`tile_bounds` below. Colours map to fixed intensity classes
(see :data:`LEGEND`), so the display images decode into rain rates
without access to the (application-only) binary distribution.

Images are retained server-side for roughly 8 days; older dates raise
:class:`RetentionError`.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import io
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import NamedTuple
from typing import TypedDict
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image

from .config import LAT_MAX
from .config import LAT_MIN
from .config import LON_MAX
from .config import LON_MIN
from .spatial import build_spatial_scenario
from .spatial import encode_frame_png
from .spatial import overview_lat_lon
from .spatial import write_spatial_scenario

USER_AGENT = "flood-nagoya/0.1"
REQUEST_TIMEOUT = 30.0
IMAGE_BASE = "https://www.river.go.jp/kawabou/file/radar/image/xrd"
MASTER_URL = "https://www.river.go.jp/kawabou/file/files/master/radar/xrd/{level}.json"
RETENTION_DAYS = 8

Bounds = tuple[float, float, float, float]  # (lat_min, lat_max, lon_min, lon_max)


class XrainTile(TypedDict):
    """One master-mesh entry plus its derived geographic bounds."""

    seq: int
    areaCd: int
    meshFrom: int
    meshTo: int
    bounds: Bounds


class _DayContext(NamedTuple):
    """Per-run parameters shared by the probe and download stages."""

    day: dt.date
    tiles: list[XrainTile]
    level: int
    parallel: int


# (hex, lower inclusive, upper exclusive, representative mm/h) — the
# kawabou legend classes: 1 / 5 / 10 / 20 / 30 / 50 / 80 / 100+ mm/h.
LEGEND: list[tuple[str, float, float | None, float]] = [
    ("99ffff", 1.0, 5.0, 3.0),
    ("66ccff", 5.0, 10.0, 7.0),
    ("2198ff", 10.0, 20.0, 15.0),
    ("0038ff", 20.0, 30.0, 25.0),
    ("faf500", 30.0, 50.0, 40.0),
    ("ff9900", 50.0, 80.0, 65.0),
    ("e72800", 80.0, 100.0, 90.0),
    ("9a0079", 100.0, None, 110.0),
]
MISSING_HEX = "c8c8cb"  # 欠測


class RetentionError(RuntimeError):
    """Requested date is outside the server-side image retention window."""


def _hex_to_rgb(hexcolor: str) -> tuple[int, int, int]:
    return int(hexcolor[0:2], 16), int(hexcolor[2:4], 16), int(hexcolor[4:6], 16)


def get_bytes(url: str, retries: int = 3) -> bytes | None:
    """GET one resource; None on 404, raising after exhausted retries."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310 - https-only source
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:  # noqa: S310
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if attempt == retries - 1:
                raise
            time.sleep(1.0 + attempt)
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == retries - 1:
                raise
            time.sleep(1.0 + attempt)
    return None


def tile_bounds(mesh_from: int, mesh_to: int) -> Bounds:
    """(lat_min, lat_max, lon_min, lon_max) of one XRAIN display mesh.

    Mirrors the kawabou map code: ``lat = floor(code/100) / 1.5`` and
    ``lng = code % 100 + 100``; ``meshTo`` is exclusive on both axes.
    """
    row0, col0 = divmod(mesh_from, 100)
    row1, col1 = divmod(mesh_to, 100)
    return row0 / 1.5, (row1 + 1) / 1.5, col0 + 100.0, col1 + 101.0


def fetch_master(level: int = 3) -> list[XrainTile]:
    """Mesh tile list of one XRAIN zoom level from the kawabou master JSON."""
    payload = get_bytes(MASTER_URL.format(level=level))
    if payload is None:
        msg = f"XRAIN master mesh list not found for level {level}"
        raise RuntimeError(msg)
    master = json.loads(payload.decode("utf-8"))
    tiles: list[XrainTile] = []
    for entry in master["areaInfo"]:
        mesh_from, mesh_to = int(entry["meshFrom"]), int(entry["meshTo"])
        tiles.append(
            XrainTile(
                seq=int(entry["seq"]),
                areaCd=int(entry["areaCd"]),
                meshFrom=mesh_from,
                meshTo=mesh_to,
                bounds=tile_bounds(mesh_from, mesh_to),
            )
        )
    return tiles


def overlapping_tiles(tiles: list[XrainTile]) -> list[XrainTile]:
    """Tiles whose bounds intersect the study bbox (Nagoya city + margin)."""
    return [
        t
        for t in tiles
        if t["bounds"][0] < LAT_MAX
        and t["bounds"][1] > LAT_MIN
        and t["bounds"][2] < LON_MAX
        and t["bounds"][3] > LON_MIN
    ]


def frame_urls(day: dt.date, hhmm: str, tiles: list[XrainTile], level: int) -> list[str]:
    stamp = f"{day:%Y%m%d}/{hhmm}"
    return [f"{IMAGE_BASE}/{t['areaCd']}/{level}/{stamp}/{t['seq']}.png" for t in tiles]


def decode_tile_png(payload: bytes) -> np.ndarray:
    """Decode one palette PNG into rain rates (mm/h; missing → NaN)."""
    image = Image.open(io.BytesIO(payload)).convert("RGB")
    arr = np.asarray(image, dtype=np.uint8)
    out = np.zeros(arr.shape[:2], dtype=np.float32)
    filled = np.zeros(arr.shape[:2], dtype=bool)
    for hexcolor, _lo, _hi, rep in LEGEND:
        rgb = np.array(_hex_to_rgb(hexcolor), dtype=np.uint8)
        mask = np.all(arr == rgb, axis=-1)
        out[mask] = rep
        filled |= mask
    missing = np.array(_hex_to_rgb(MISSING_HEX), dtype=np.uint8)
    out[np.all(arr == missing, axis=-1)] = np.nan
    filled |= np.all(arr == missing, axis=-1)
    out[~filled] = 0.0  # below-class pixels (1 mm/h 未満) count as dry
    return out


def sample_tiles(
    decoded: list[tuple[tuple[float, float, float, float], np.ndarray]],
    lat2d: np.ndarray,
    lon2d: np.ndarray,
) -> np.ndarray:
    """Nearest-neighbour composite of decoded tiles onto (lat2d, lon2d)."""
    out = np.full(lat2d.shape, np.nan, dtype=np.float32)
    for (lat_min, lat_max, lon_min, lon_max), values in decoded:
        th, tw = values.shape
        rows = np.clip(((lat_max - lat2d) / (lat_max - lat_min) * th).astype(np.int64), 0, th - 1)
        cols = np.clip(((lon2d - lon_min) / (lon_max - lon_min) * tw).astype(np.int64), 0, tw - 1)
        inside = (lat2d >= lat_min) & (lat2d <= lat_max) & (lon2d >= lon_min) & (lon2d <= lon_max)
        out[inside] = values[rows[inside], cols[inside]]
    return out


def _hhmm_candidates(minute: int) -> list[str]:
    """URL timestamps to try for one 5-minute slot (server keeps 1-min frames)."""
    out = []
    for offset in (0, 1, 2, -1, -2, 3, -3):
        m = minute + offset
        if m < 0:
            continue
        out.append(f"{(m // 60):02d}{(m % 60):02d}")
    return out


def _check_date(day: dt.date) -> None:
    """Reject future dates and dates outside the server retention window."""
    today = dt.datetime.now(ZoneInfo("Asia/Tokyo")).date()
    if day > today:
        msg = f"date {day} is in the future"
        raise ValueError(msg)
    if (today - day).days >= RETENTION_DAYS:
        msg = (
            f"XRAIN images for {day} are older than the ~{RETENTION_DAYS}-day "
            "retention of 川の防災情報; pick a more recent date"
        )
        raise RetentionError(msg)


def _probe_frame_times(ctx: _DayContext) -> dict[int, str]:
    """Find an existing image timestamp for every 5-minute slot of the day."""
    jobs = [(slot, hhmm) for slot in range(0, 24 * 60, 5) for hhmm in _hhmm_candidates(slot)]

    def probe(job: tuple[int, str]) -> tuple[int, str | None]:
        slot, hhmm = job
        url = frame_urls(ctx.day, hhmm, ctx.tiles, ctx.level)[0]
        ok = get_bytes(url, retries=1) is not None
        return (slot, hhmm if ok else None)

    found: dict[int, str] = {}
    with cf.ThreadPoolExecutor(max_workers=ctx.parallel) as pool:
        for slot, hhmm in pool.map(probe, jobs):
            if hhmm is not None and slot not in found:
                found[slot] = hhmm
    return {slot: found[slot] for slot in sorted(found)}


def _fetch_fields(
    ctx: _DayContext,
    hhmm_by_slot: dict[int, str],
    lat2d: np.ndarray,
    lon2d: np.ndarray,
) -> dict[int, np.ndarray]:
    """Download + decode + resample every frame slot onto the target grid."""

    def fetch_frame(job: tuple[int, str]) -> tuple[int, np.ndarray | None]:
        slot, hhmm = job
        parts = [get_bytes(u, retries=2) for u in frame_urls(ctx.day, hhmm, ctx.tiles, ctx.level)]
        decoded: list[tuple[Bounds, np.ndarray]] = [
            (t["bounds"], decode_tile_png(p)) for t, p in zip(ctx.tiles, parts, strict=True) if p is not None
        ]
        if not decoded:
            return slot, None
        return slot, sample_tiles(decoded, lat2d, lon2d)

    with cf.ThreadPoolExecutor(max_workers=ctx.parallel) as pool:
        results = pool.map(fetch_frame, list(hhmm_by_slot.items()))
    return {slot: field for slot, field in results if field is not None}


def build_day_scenario(
    day: dt.date,
    level: int = 3,
    out_dir: Path | None = None,
    parallel: int = 8,
) -> Path:
    """Download, decode and resample a full day of XRAIN frames.

    Frames land in ``<out>/rain_YYYYMMDD_xrain/f*.png`` alongside a
    scenario JSON ready for the web app; returns the JSON path.
    """
    _check_date(day)
    tiles = overlapping_tiles(fetch_master(level))
    if not tiles:
        msg = "no XRAIN mesh tiles cover the study area — check the master mesh list"
        raise RuntimeError(msg)
    lat2d, lon2d = overview_lat_lon()
    ctx = _DayContext(day=day, tiles=tiles, level=level, parallel=parallel)

    hhmm_by_slot = _probe_frame_times(ctx)
    if not hhmm_by_slot:
        msg = f"no XRAIN frames found for {day} (no rain or outside retention)"
        raise RuntimeError(msg)
    fields_map = _fetch_fields(ctx, hhmm_by_slot, lat2d, lon2d)

    fields = [fields_map[slot] for slot in sorted(fields_map)]
    scenario = build_spatial_scenario(
        kind="xrain",
        day=day,
        frame_seconds=300,
        fields=fields,
        meta={
            "source": f"国土交通省 川の防災情報 XRAIN (level {level} 表示画像)",
            "note": "表示画像の階級色を雨量強度に復元 (階級中央値)。1枚=5分",
        },
    )
    base = write_spatial_scenario(scenario, out_dir)
    frame_dir = base.parent / base.stem
    frame_dir.mkdir(parents=True, exist_ok=True)
    for frame, field in zip(scenario["frames"], fields, strict=True):
        encode_frame_png(field, frame_dir / str(frame["file"]))
    print(f"xrain frames: {len(fields)} → {frame_dir}")
    return base

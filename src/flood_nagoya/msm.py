"""Spatial rainfall reconstruction from the JMA MSM model (via Open-Meteo).

XRAIN display images are purged after ~8 days, so older events cannot be
reproduced from radar. This module rebuilds a spatial rain field for any
past date from the JMA Meso-Scale Model archive (5 km / hourly, obtained
through the free Open-Meteo archive API) and calibrates it hour-by-hour
against the AMeDAS ground observation: each hourly field is scaled so
that its value at the gauge location matches the observed hourly total.
The spatial *pattern* therefore comes from the model, the magnitudes
from the rain gauge — a transparent approximation, clearly labelled in
the generated scenario (``kind="msm"``).
"""

from __future__ import annotations

import datetime as dt
import json
import urllib.request
from pathlib import Path

import numpy as np
from scipy.interpolate import RegularGridInterpolator

from .amedas import STATIONS
from .amedas import fetch_hourly_html
from .amedas import parse_hourly_precip
from .config import LAT_MAX
from .config import LAT_MIN
from .config import LON_MAX
from .config import LON_MIN
from .spatial import build_spatial_scenario
from .spatial import encode_frame_png
from .spatial import overview_lat_lon
from .spatial import write_spatial_scenario

ARCHIVE_URL = (
    "https://archive-api.open-meteo.com/v1/archive"
    "?latitude={lats}&longitude={lons}"
    "&start_date={day}&end_date={day}&hourly=precipitation"
    "&models=jma_msm&timezone=Asia%2FTokyo"
)
GRID_STEP = 0.05  # ≈ MSM native 5 km
GAUGE_LON, GAUGE_LAT = 136.90, 35.17  # ≈ 名古屋 AMeDAS (御器所)
MAX_MMH = 150.0  # calibration cap (guards divide-by-tiny factors)


def grid_points() -> tuple[list[float], list[float]]:
    """Paired lat/lon request points covering the study bbox + one-step margin.

    Open-Meteo pairs ``latitude``/``longitude`` element-wise (not as a
    cartesian product), so both lists carry every grid point.
    """
    lat1d = np.arange(LAT_MIN - GRID_STEP, LAT_MAX + GRID_STEP, GRID_STEP)
    lon1d = np.arange(LON_MIN - GRID_STEP, LON_MAX + GRID_STEP, GRID_STEP)
    lats: list[float] = []
    lons: list[float] = []
    for lat in lat1d:
        for lon in lon1d:
            lats.append(round(float(lat), 4))
            lons.append(round(float(lon), 4))
    return lats, lons


def fetch_msm_grid(day: dt.date, lats: list[float], lons: list[float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Hourly MSM precipitation for a coordinate grid → (lat, lon, values[24, ny, nx])."""
    url = ARCHIVE_URL.format(
        lats=",".join(str(v) for v in lats),
        lons=",".join(str(v) for v in lons),
        day=day.isoformat(),
    )
    req = urllib.request.Request(url, headers={"User-Agent": "flood-nagoya/0.1"})  # noqa: S310 - https-only API
    with urllib.request.urlopen(req, timeout=60.0) as resp:  # noqa: S310
        payload = json.loads(resp.read().decode("utf-8"))
    entries = payload if isinstance(payload, list) else [payload]

    seen: dict[tuple[float, float], list[float]] = {}
    for entry in entries:
        lat, lon = float(entry["latitude"]), float(entry["longitude"])
        hourly = entry["hourly"]["precipitation"]
        if len(hourly) != 24:
            msg = f"expected 24 hourly values, got {len(hourly)}"
            raise RuntimeError(msg)
        seen[(lat, lon)] = [0.0 if v is None else float(v) for v in hourly]
    if not seen:
        msg = "Open-Meteo returned no MSM data for the requested grid"
        raise RuntimeError(msg)

    grid_lats = sorted({lat for lat, _ in seen})
    grid_lons = sorted({lon for _, lon in seen})
    values = np.full((24, len(grid_lats), len(grid_lons)), np.nan)
    for (lat, lon), hourly in seen.items():
        values[:, grid_lats.index(lat), grid_lons.index(lon)] = hourly
    return np.array(grid_lats), np.array(grid_lons), values


def hourly_factors(
    values: np.ndarray,
    grid_lats: np.ndarray,
    grid_lons: np.ndarray,
    observed: list[float | None],
) -> np.ndarray:
    """Per-hour calibration factors (observed / MSM at the gauge point)."""
    iy = int(np.argmin(np.abs(grid_lats - GAUGE_LAT)))
    ix = int(np.argmin(np.abs(grid_lons - GAUGE_LON)))
    factors = np.zeros(values.shape[0], dtype=np.float64)
    for hour in range(values.shape[0]):
        obs = observed[hour]
        obs = 0.0 if obs is None else obs
        msm = float(values[hour, iy, ix])
        if obs <= 0.0:
            factors[hour] = 0.0  # gauge says dry — suppress the field
        elif msm < 0.1:
            factors[hour] = 1.0  # model missed it entirely → uniform observed rain
        else:
            factors[hour] = min(obs / msm, MAX_MMH)
    return factors


def resample_hour(
    field: np.ndarray,
    grid_lats: np.ndarray,
    grid_lons: np.ndarray,
    lat2d: np.ndarray,
    lon2d: np.ndarray,
) -> np.ndarray:
    """Bilinear MSM field onto the overview grid (edges clamp outward)."""
    padded = np.pad(field, 1, mode="edge")
    interp = RegularGridInterpolator(
        (
            np.concatenate(([grid_lats[0] - GRID_STEP], grid_lats, [grid_lats[-1] + GRID_STEP])),
            np.concatenate(([grid_lons[0] - GRID_STEP], grid_lons, [grid_lons[-1] + GRID_STEP])),
        ),
        padded,
        method="linear",
        bounds_error=False,
        fill_value=None,
    )
    points = np.stack([lat2d.ravel(), lon2d.ravel()], axis=-1)
    out: np.ndarray = interp(points).reshape(lat2d.shape)
    return np.clip(out, 0.0, None).astype(np.float32)


def build_day_scenario(day: dt.date, station: str = "名古屋", out_dir: Path | None = None) -> Path:
    """Fetch MSM + AMeDAS for one day and write calibrated frame ONGs + JSON."""
    prec_no, block_no = STATIONS[station]
    observed = parse_hourly_precip(fetch_hourly_html(prec_no, block_no, day))
    lats, lons = grid_points()
    grid_lats, grid_lons, values = fetch_msm_grid(day, lats, lons)
    factors = hourly_factors(values, grid_lats, grid_lons, observed)
    lat2d, lon2d = overview_lat_lon()

    fields = []
    for hour in range(24):
        obs = observed[hour]
        obs = 0.0 if obs is None else obs
        factor = factors[hour]
        if factor == 0.0:
            field = np.zeros(lat2d.shape, dtype=np.float32)  # gauge dry → suppress
        elif float(np.nanmax(values[hour])) < 0.1:
            # model missed the rain entirely → uniform observed rate
            field = np.full(lat2d.shape, obs, dtype=np.float32)
        else:
            field = resample_hour(values[hour] * factor, grid_lats, grid_lons, lat2d, lon2d)
        fields.append(np.nan_to_num(field, nan=0.0).astype(np.float32))

    scenario = build_spatial_scenario(
        kind="msm",
        day=day,
        frame_seconds=3600,
        fields=fields,
        meta={
            "source": "JMA MSM (Open-Meteo archive API) + AMeDAS較正",
            "note": (
                "空間パターンはMSM(5km)・毎時の強度はAMeDAS観測値に較正 "
                "(較正係数は地点値比)。レーダー実測ではない点に注意"
            ),
        },
    )
    base = write_spatial_scenario(scenario, out_dir)
    frame_dir = base.parent / base.stem
    frame_dir.mkdir(parents=True, exist_ok=True)
    for frame, field in zip(scenario["frames"], fields, strict=True):
        encode_frame_png(field, frame_dir / str(frame["file"]))
    print(f"msm frames: 24 (peak factor x{factors.max():.1f}) → {frame_dir}")
    return base

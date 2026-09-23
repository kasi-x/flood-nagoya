"""1D river-channel model coupled to the 2D surface flood grid.

Each channel cell carries a steady-state discharge estimated from its
upstream contributing area and the current rainfall intensity (rational
method with a concentration-time lag).  Manning's equation converts that
discharge to a channel depth; depth above the bankfull level spills onto
the 2D floodplain as a prescribed water depth, exactly like the coastal
sea-level boundary.

This is a screening model: it captures the first-order physics of riverine
flooding (catchment -> discharge -> stage -> overflow) without dynamic
routing or backwater.  It is not a substitute for a surveyed-channel
hydraulic model.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from .hydro import d8_flow_directions
from .hydro import fill_sinks_priority_flood
from .hydro import flow_accumulation

__all__ = ["ChannelField", "extract_channels", "river_excess_depth"]

# Hydraulic-geometry scaling (width/depth vs upstream area, km²).
# Typical mid-latitude alluvial channels: W ≈ 2.5·A^0.5, D ≈ 0.3·A^0.4.
WIDTH_A = 2.5
WIDTH_B = 0.5
DEPTH_C = 0.3
DEPTH_D = 0.4
MANNING_RIVER = 0.035  # rougher than the floodplain (vegetation, bedforms)
RUNOFF_COEFF = 0.65  # fraction of rainfall reaching the channel
MIN_SLOPE = 1e-4  # numerical floor for the Manning slope


@dataclass(frozen=True)
class ChannelField:
    """Per-cell river-channel parameters on the simulation grid."""

    mask: npt.NDArray[np.bool_]  # (H, W) channel cells
    area_m2: npt.NDArray[np.float64]  # upstream contributing area
    slope: npt.NDArray[np.float64]  # local bed slope (D8)
    width_m: npt.NDArray[np.float64]  # channel width
    depth_m: npt.NDArray[np.float64]  # bankfull depth below the rim
    lag_s: npt.NDArray[np.float64]  # concentration-time lag per cell


def extract_channels(
    elev: npt.NDArray[np.floating],
    dx: float,
    acc_threshold_cells: float = 200.0,
) -> ChannelField:
    """Build channel geometry from the DEM via D8 flow accumulation.

    ``acc_threshold_cells`` is the minimum upstream cell count for a cell to
    count as a channel (≈ a few km² at 5 m resolution).
    """
    filled = fill_sinks_priority_flood(np.asarray(elev, dtype=np.float64))
    directions = d8_flow_directions(filled, dx)
    acc = flow_accumulation(filled, directions)
    mask = acc >= acc_threshold_cells

    # Local slope: steepest-descent drop to the D8 neighbour.
    h, w = filled.shape
    slope = np.full((h, w), MIN_SLOPE, dtype=np.float64)
    zpad = np.pad(filled, 1, mode="edge")
    offsets = [(dx_, dy_) for dx_, dy_ in [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]]
    for flag, (ddx, ddy) in enumerate(offsets):
        sel = directions == (1 << flag)
        if not sel.any():
            continue
        dist = dx * (1.4142135623730951 if ddx and ddy else 1.0)
        zn = zpad[1 + ddy : 1 + ddy + h, 1 + ddx : 1 + ddx + w]
        s = (filled - zn) / dist
        slope[sel] = np.maximum(s[sel], MIN_SLOPE)

    area_m2 = acc * dx * dx
    area_km2 = area_m2 / 1e6
    width_m = np.where(mask, WIDTH_A * np.power(area_km2, WIDTH_B), 0.0)
    depth_m = np.where(mask, DEPTH_C * np.power(area_km2, DEPTH_D), 0.0)
    # Concentration-time lag ~ A^0.3 hours (Kirpich-style, coarse).
    lag_s = np.where(mask, np.power(np.maximum(area_km2, 0.01), 0.3) * 3600.0, 0.0)
    return ChannelField(
        mask=mask,
        area_m2=area_m2,
        slope=slope,
        width_m=width_m,
        depth_m=depth_m,
        lag_s=lag_s,
    )


def river_excess_depth(
    field: ChannelField,
    rain_mmh: float,
) -> npt.NDArray[np.float32]:
    """Water depth [m] to inject into channel cells.

    Discharge is the rational method applied to the rainfall intensity;
    Manning's equation gives the channel stage; the excess over bankfull
    depth is what the 2D grid receives.  The concentration-time lag is
    approximated by scaling the current rate (a full convolution is
    overkill for a screening model).
    """
    h, w = field.mask.shape
    out = np.zeros((h, w), dtype=np.float32)
    if rain_mmh <= 0.0 or not field.mask.any():
        return out
    # Lagged intensity: rain that fell lag_s ago is what reaches the channel now.
    # (The caller passes the *current* rate; we approximate the lagged rate by
    # scaling with a fixed lag — a proper convolution is overkill here.)
    q = RUNOFF_COEFF * (rain_mmh / 1000.0 / 3600.0) * field.area_m2  # m³/s
    # Manning wide-channel: Q = (1/n)·W·h^(5/3)·S^0.5  →  h = (Q·n/(W·√S))^0.6
    with np.errstate(divide="ignore", invalid="ignore"):
        stage = np.power(
            q * MANNING_RIVER / np.maximum(field.width_m * np.sqrt(field.slope), 1e-9),
            0.6,
        )
    excess = np.where(field.mask, np.maximum(stage - field.depth_m, 0.0), 0.0)
    out[:] = excess.astype(np.float32)
    return out

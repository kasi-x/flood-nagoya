"""Simplified underground-space inundation model for dense urban cores.

Nagoya Station and Sakae have extensive underground malls / passages.  During
surface flooding, water can flow into these spaces through stairways and
manholes.  This module models each underground zone as a single storage tank
connected to the surface cells that cover it.

It is intentionally coarse: it does not resolve individual passages, pipes, or
pumps.  Use it for order-of-magnitude "where could underground flooding become
serious" screening, not for engineering design.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

__all__ = ["UndergroundZone", "nagoya_zones", "step_underground", "underground_depth_map"]


@dataclass(frozen=True)
class UndergroundZone:
    """A single underground space (mall, passage, station concourse, etc.)."""

    name: str
    # Polygon corners as (lon, lat).  The first corner is repeated implicitly.
    polygon_lonlat: np.ndarray
    floor_depth_m: float  # depth from ground surface to lowest walkable floor
    capacity_m3_per_m2: float  # effective storage per unit surface area [m]
    manhole_threshold_m: float  # surface depth at which water starts entering
    coupling_s: float  # time scale of surface <-> underground exchange [s]


def nagoya_zones() -> list[UndergroundZone]:
    """Return a minimal set of underground zones in central Nagoya.

    Coordinates are rough bounding polygons based on publicly known locations of
    the main underground malls / station concourses.  They are meant for
    demonstration and can be refined with precise floor plans.
    """
    return [
        UndergroundZone(
            name="名古屋駅地下街 (Central Park, Unimall)",
            polygon_lonlat=np.array(
                [
                    [136.877, 35.173],
                    [136.886, 35.173],
                    [136.886, 35.168],
                    [136.877, 35.168],
                ]
            ),
            floor_depth_m=8.0,
            capacity_m3_per_m2=4.0,
            manhole_threshold_m=0.15,
            coupling_s=60.0,
        ),
        UndergroundZone(
            name="栄地下街 (Sakae Chika)",
            polygon_lonlat=np.array(
                [
                    [136.902, 35.172],
                    [136.912, 35.172],
                    [136.912, 35.167],
                    [136.902, 35.167],
                ]
            ),
            floor_depth_m=6.0,
            capacity_m3_per_m2=3.0,
            manhole_threshold_m=0.10,
            coupling_s=90.0,
        ),
        UndergroundZone(
            name="伏見地下街 (Fushimi Chika)",
            polygon_lonlat=np.array(
                [
                    [136.894, 35.170],
                    [136.900, 35.170],
                    [136.900, 35.166],
                    [136.894, 35.166],
                ]
            ),
            floor_depth_m=6.0,
            capacity_m3_per_m2=3.0,
            manhole_threshold_m=0.10,
            coupling_s=90.0,
        ),
    ]


def _mask_for_zone(
    zone: UndergroundZone,
    lon_origin: float,
    lat_origin: float,
    dx: float,
    shape: tuple[int, int],
) -> npt.NDArray[np.bool_]:
    """Return a boolean mask of grid cells covered by the zone polygon.

    The grid origin (row 0 = north) is mapped from (lon_origin, lat_origin)
    assuming a local equirectangular approximation with pixel size ``dx``.
    """
    h, w = shape
    # Approximate degrees per metre at mid-latitude.
    mid_lat = lat_origin
    deg_per_m_lon = 1.0 / (111_320.0 * np.cos(np.radians(mid_lat)))
    deg_per_m_lat = 1.0 / 111_320.0

    rows = np.arange(h)
    cols = np.arange(w)
    # row 0 = north, so latitude decreases with row.
    lats = mid_lat - (rows[:, None] * dx * deg_per_m_lat)
    lons = lon_origin + (cols[None, :] * dx * deg_per_m_lon)

    poly = zone.polygon_lonlat
    # Simple bounding-box test is exact for rectangles.
    lon_min, lon_max = poly[:, 0].min(), poly[:, 0].max()
    lat_min, lat_max = poly[:, 1].min(), poly[:, 1].max()
    return (lons >= lon_min) & (lons <= lon_max) & (lats >= lat_min) & (lats <= lat_max)


def _zone_properties(
    zones: list[UndergroundZone],
    lon_origin: float,
    lat_origin: float,
    dx: float,
    shape: tuple[int, int],
) -> tuple[list[npt.NDArray[np.bool_]], list[float]]:
    """Return (masks, surface_areas_m2) for each zone."""
    masks = [_mask_for_zone(z, lon_origin, lat_origin, dx, shape) for z in zones]
    areas = [float(mask.sum()) * dx * dx for mask in masks]
    return masks, areas


def step_underground(
    zones: list[UndergroundZone],
    surface_h: npt.NDArray[np.float32],
    dt: float,
    volumes: npt.NDArray[np.float64],
    zone_props: list[tuple[npt.NDArray[np.bool_], float]],
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float32]]:
    """Advance underground storage by one step and return (new_volumes, surface_sink).

    ``surface_sink`` is positive when water leaves the surface and enters the
    underground (i.e. it should be *subtracted* from surface depth).
    """
    new_volumes = volumes.copy()
    sink = np.zeros_like(surface_h, dtype=np.float32)
    for i, zone in enumerate(zones):
        mask, area = zone_props[i]
        if area <= 0:
            continue
        # Average surface water depth inside the zone.
        avg_h = float(surface_h[mask].mean()) if mask.any() else 0.0
        # Underground head: volume spread over the surface footprint.
        u_head = float(volumes[i]) / area  # m above ground
        # Flow direction depends on head difference across manhole threshold.
        if avg_h > zone.manhole_threshold_m:
            drive = avg_h - zone.manhole_threshold_m
            # Max inflow is limited by available surface water and remaining capacity.
            max_in = max(0.0, (zone.floor_depth_m - u_head) * area)
            inflow = min(drive / zone.coupling_s * area * dt, max_in)
            inflow = min(inflow, avg_h * area * 0.5)  # don't drain surface instantly
            new_volumes[i] += inflow
            sink[mask] += float(inflow / area)
        elif u_head > 0.0 and avg_h < zone.manhole_threshold_m:
            # Water flows back to surface when surface drops.
            drive = u_head
            outflow = min(drive / zone.coupling_s * area * dt, volumes[i])
            new_volumes[i] -= outflow
            sink[mask] -= float(outflow / area)
    # Storage capacity hard cap.
    for i, zone in enumerate(zones):
        mask, area = zone_props[i]
        max_vol = zone.floor_depth_m * area
        if new_volumes[i] > max_vol:
            overflow = new_volumes[i] - max_vol
            new_volumes[i] = max_vol
            # Excess returns to surface.
            if area > 0:
                sink[mask] += float(overflow / area)
    return new_volumes, sink


def underground_depth_map(
    volumes: npt.NDArray[np.float64],
    zone_props: list[tuple[npt.NDArray[np.bool_], float]],
) -> npt.NDArray[np.float32]:
    """Return a per-cell underground inundation depth [m] map.

    Depth is the volume averaged over the zone footprint; cells outside zones
    are zero.
    """
    depth = np.zeros_like(zone_props[0][0], dtype=np.float32)
    for i, (mask, area) in enumerate(zone_props):
        if area > 0:
            depth[mask] = float(volumes[i] / area)
    return depth

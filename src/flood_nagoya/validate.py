"""Flood validation from satellite water observations.

Compares the 2D simulation's maximum-depth field against three independent
satellite water signals over Nagoya for the 2026-09-08 flood:

- NISAR GCOV L-band backscatter change (before → after): flooded pixels
  darken because smooth water reflects the radar pulse away (specular).
- Sentinel-1 GRD VV change (before → after): same specular mechanism at
  C-band, higher resolution, more vegetation noise.
- SWOT Ka-band water mask: direct water-surface measurement, no baseline
  needed — the reference truth for the comparison date.

All products land on the simulation grid via :func:`lonlat_to_sim_px`
(which reuses :mod:`flood_nagoya.precompute`'s z15 lattice verbatim) plus
pure-numpy nearest-neighbour, so this module has no heavy geospatial
dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt

from .precompute import lonlat_to_z15px
from .precompute import m_per_px_at_z15

__all__ = [
    "DEFAULT_DB_DROP",
    "DEFAULT_SIM_DEPTH_M",
    "DEFAULT_SWOT_FRAC",
    "ChangeConfig",
    "GridRef",
    "NAGoyaBox",
    "NAGoya_BOX",
    "ValidationResult",
    "change_map",
    "confusion",
    "db",
    "flood_mask",
    "load_sim_hmax",
    "lonlat_to_sim_px",
    "nisar_on_grid",
    "reproject_nearest",
    "run_validation",
    "s1_grd_on_grid",
    "sim_lonlat",
    "summarize",
    "swot_on_grid",
    "swot_water_mask",
]

#: Nagoya study bbox used for every satellite subset (lon_min, lat_min, lon_max, lat_max).
NAGoya_BOX: tuple[float, float, float, float] = (136.740, 34.970, 137.090, 35.305)

NAGoyaBox = tuple[float, float, float, float]

#: Specular-darkening threshold (dB): post/pre ratio below this counts as new water.
DEFAULT_DB_DROP = -3.0
#: Minimum simulated depth (m) counted as "model says flooded".
DEFAULT_SIM_DEPTH_M = 0.10
#: SWOT water fraction above this counts as "satellite says water".
DEFAULT_SWOT_FRAC = 0.5


@dataclass(frozen=True)
class ChangeConfig:
    """Thresholds for one before→after change-detection pair."""

    db_drop: float = DEFAULT_DB_DROP
    min_pre_db: float = -25.0  # ignore pre-existing dark pixels (rivers, radar shadow)
    sim_depth_m: float = DEFAULT_SIM_DEPTH_M


_DEFAULT_CHANGE = ChangeConfig()


@dataclass(frozen=True)
class GridRef:
    """Simulation-grid georeference (mirrors :class:`precompute.RegionGrid`)."""

    left: int  # z15 px offset of the region from the mosaic origin
    top: int
    tile_x0: int  # mosaic origin tile x
    tile_y0: int
    dx: float  # sim cell size [m]
    sim_w: int = 900  # sim grid width [cells]
    sim_h: int = 700
    full_w: int = 1800  # full-res width [z15 px]; sim grid is downsampled
    full_h: int = 1400
    lat0: float = 35.1546  # reference latitude for the z15 metre scale

    @property
    def downsample(self) -> float:
        """Full-res z15 px per sim cell (2.0 for the standard 2x grid)."""
        return self.full_w / self.sim_w

    @classmethod
    def from_meta(cls, meta_path: Path) -> GridRef:
        """Build the georeference from a precomputed region's ``meta.json``."""
        import json  # noqa: PLC0415 - only needed here

        from .gsitiles import bbox_tile_range  # noqa: PLC0415 - keep import light

        meta = json.loads(Path(meta_path).read_text())
        bounds = meta["bounds_px"]
        grid = meta["grid"]
        full = meta["full"]
        tile_x0, _, tile_y0, _ = bbox_tile_range()
        return cls(
            left=int(bounds["left"]),
            top=int(bounds["top"]),
            tile_x0=tile_x0,
            tile_y0=tile_y0,
            dx=float(grid["dx"]),
            sim_w=int(grid["w"]),
            sim_h=int(grid["h"]),
            full_w=int(full["w"]),
            full_h=int(full["h"]),
            lat0=float(meta["origin"]["lat"]),
        )


@dataclass(frozen=True)
class ValidationResult:
    """Confusion counts of model-flooded vs satellite-water on the sim grid."""

    true_positive: int
    false_positive: int
    false_negative: int
    true_negative: int
    model_cells: int
    sat_cells: int

    @property
    def precision(self) -> float:
        denom = self.true_positive + self.false_positive
        return self.true_positive / denom if denom else float("nan")

    @property
    def recall(self) -> float:
        denom = self.true_positive + self.false_negative
        return self.true_positive / denom if denom else float("nan")

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) > 0 else float("nan")


def db(x: npt.NDArray[np.floating], floor: float = 1e-9) -> npt.NDArray[np.float64]:
    """Linear power → dB with a floor against log(0)."""
    return 10.0 * np.log10(np.maximum(np.asarray(x, dtype=np.float64), floor))


def change_map(
    pre: npt.NDArray[np.floating],
    post: npt.NDArray[np.floating],
    cfg: ChangeConfig | None = None,
) -> npt.NDArray[np.bool_]:
    """New-water mask from a before→after backscatter pair.

    Flags pixels that darkened by at least ``cfg.db_drop`` dB *and* were
    brighter than ``cfg.min_pre_db`` before (masks permanent water/shadow).
    NaNs in either input mask the output False.
    """
    cfg = cfg if cfg is not None else _DEFAULT_CHANGE
    pre_a = np.asarray(pre, dtype=np.float64)
    post_a = np.asarray(post, dtype=np.float64)
    valid = np.isfinite(pre_a) & np.isfinite(post_a)
    out = np.zeros(pre_a.shape, dtype=bool)
    drop = db(post_a[valid]) - db(pre_a[valid])
    out[valid] = (drop <= cfg.db_drop) & (db(pre_a[valid]) >= cfg.min_pre_db)
    return out


def flood_mask(depth_m: npt.NDArray[np.floating], threshold_m: float = DEFAULT_SIM_DEPTH_M) -> npt.NDArray[np.bool_]:
    """Simulated maximum-depth field → boolean flooded mask."""
    depth = np.asarray(depth_m, dtype=np.float64)
    return np.isfinite(depth) & (depth >= threshold_m)


def swot_water_mask(
    water_frac: npt.NDArray[np.floating],
    threshold: float = DEFAULT_SWOT_FRAC,
) -> npt.NDArray[np.bool_]:
    """SWOT water-fraction field → boolean water mask."""
    wf = np.asarray(water_frac, dtype=np.float64)
    return np.isfinite(wf) & (wf >= threshold)


def confusion(model: npt.NDArray[np.bool_], sat: npt.NDArray[np.bool_]) -> ValidationResult:
    """Confusion counts between model-flooded and satellite-water masks."""
    m = np.asarray(model, dtype=bool)
    s = np.asarray(sat, dtype=bool)
    if m.shape != s.shape:
        msg = f"shape mismatch: model {m.shape} vs satellite {s.shape}"
        raise ValueError(msg)
    tp = int(np.sum(m & s))
    fp = int(np.sum(m & ~s))
    fn = int(np.sum(~m & s))
    tn = int(np.sum(~m & ~s))
    return ValidationResult(tp, fp, fn, tn, int(np.sum(m)), int(np.sum(s)))


def summarize(result: ValidationResult) -> str:
    """One-line human summary: ``F1=… P=… R=… (TP/FP/FN …)``."""
    return (
        f"F1={result.f1:.3f} P={result.precision:.3f} R={result.recall:.3f} "
        f"(TP={result.true_positive} FP={result.false_positive} "
        f"FN={result.false_negative} model={result.model_cells} sat={result.sat_cells})"
    )


def lonlat_to_sim_px(
    lon: npt.NDArray[np.floating],
    lat: npt.NDArray[np.floating],
    grid: GridRef,
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Lon/lat → floating sim-grid pixel coords via the z15 lattice."""
    lon_a = np.asarray(lon, dtype=np.float64).ravel()
    lat_a = np.asarray(lat, dtype=np.float64).ravel()
    m_per_px = m_per_px_at_z15(grid.lat0)
    xs = np.empty_like(lon_a)
    ys = np.empty_like(lon_a)
    for i, (lo, la) in enumerate(zip(lon_a, lat_a, strict=True)):
        if not (np.isfinite(lo) and np.isfinite(la)):
            xs[i], ys[i] = np.nan, np.nan
            continue
        fx, fy = lonlat_to_z15px(float(lo), float(la), grid.tile_x0, grid.tile_y0)
        # fx/fy are full-res z15 px; the sim grid is downsampled by
        # ``grid.downsample`` (2x for the standard 900x700 overlays).
        xs[i] = (fx - grid.left) * m_per_px / grid.dx / grid.downsample
        ys[i] = (fy - grid.top) * m_per_px / grid.dx / grid.downsample
    return xs.reshape(np.shape(lon)), ys.reshape(np.shape(lat))


def reproject_nearest(
    src: npt.NDArray[np.floating],
    src_x: npt.NDArray[np.floating],
    src_y: npt.NDArray[np.floating],
    shape: tuple[int, int],
) -> npt.NDArray[np.float64]:
    """Nearest-neighbour resample of ``src`` onto a ``shape`` grid.

    ``src_x``/``src_y`` hold per-source-pixel destination coords (as from
    :func:`lonlat_to_sim_px`); out-of-range or NaN coords are skipped.
    Untouched cells stay NaN.
    """
    out = np.full(shape, np.nan)
    h, w = shape
    xi = np.rint(np.asarray(src_x, dtype=np.float64).ravel()).astype(np.int64)
    yi = np.rint(np.asarray(src_y, dtype=np.float64).ravel()).astype(np.int64)
    vs = np.asarray(src, dtype=np.float64).ravel()
    ok = np.isfinite(vs) & (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
    out[yi[ok], xi[ok]] = vs[ok]
    return out


def sim_lonlat(grid: GridRef) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Lon/lat of every sim-cell centre — inverse of :func:`lonlat_to_sim_px`.

    Returns ``(lon, lat)`` as ``(sim_h, sim_w)`` arrays; used to sample
    warped satellite rasters at sim-cell positions.
    """
    m_per_px = m_per_px_at_z15(grid.lat0)
    rows = np.arange(grid.sim_h, dtype=np.float64)
    cols = np.arange(grid.sim_w, dtype=np.float64)
    # sim cell centre in full-res z15 px (cell centre = +0.5 cell)
    fx = grid.left + (cols + 0.5) * grid.dx * grid.downsample / m_per_px
    fy = grid.top + (rows + 0.5) * grid.dx * grid.downsample / m_per_px
    n = 1 << 15
    lon = (fx / 256.0 + grid.tile_x0) / n * 360.0 - 180.0
    yy = (fy / 256.0 + grid.tile_y0) / n
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * yy))))
    return np.broadcast_to(lon, (grid.sim_h, grid.sim_w)).copy(), np.broadcast_to(
        lat[:, None],
        (grid.sim_h, grid.sim_w),
    ).copy()


def region_box_path(box: NAGoyaBox = NAGoya_BOX) -> Path:
    """Default cache path stem for satellite subsets (caller adds suffix)."""
    from .config import INTERIM_DIR  # noqa: PLC0415 - keep module import light

    return INTERIM_DIR / "satellite" / f"nagoya_{box[0]:.3f}_{box[1]:.3f}_{box[2]:.3f}_{box[3]:.3f}"


def load_sim_hmax(precomputed_dir: Path) -> npt.NDArray[np.float64]:
    """Cumulative max-depth field [m] from the last ``max_*.png`` frame."""
    from PIL import Image  # noqa: PLC0415 - keep module import light

    frames = sorted(Path(precomputed_dir).glob("max_*.png"))
    if not frames:
        msg = f"no max_*.png frames under {precomputed_dir}"
        raise FileNotFoundError(msg)
    return np.asarray(Image.open(frames[-1]).convert("L"), dtype=np.float64) / 100.0


def _sample_on_grid(
    da: object,
    grid: GridRef,
) -> npt.NDArray[np.float64]:
    """Bilinear-sample an EPSG:4326 raster at sim-cell centres."""
    import xarray as xr  # noqa: PLC0415 - heavy optional dep

    lon, lat = sim_lonlat(grid)
    sampled = da.interp(  # type: ignore[attr-defined]
        x=xr.DataArray(lon[0], dims="x"),
        y=xr.DataArray(lat[:, 0], dims="y"),
        method="linear",
        kwargs={"fill_value": np.nan},
    )
    return np.asarray(sampled, dtype=np.float64)


def swot_on_grid(
    nc_path: Path,
    grid: GridRef,
    var: str = "water_frac",
) -> npt.NDArray[np.float64]:
    """Reproject a SWOT L2 raster tile onto the sim grid.

    SWOT rasters are UTM-gridded with per-pixel lon/lat; we warp the field
    to EPSG:4326 with rasterio, then bilinear-sample at sim cells.
    """
    import netCDF4  # noqa: PLC0415 - heavy optional dep
    import rioxarray  # noqa: F401, PLC0415 - registers .rio accessor
    import xarray as xr  # noqa: PLC0415
    from rasterio.crs import CRS  # noqa: PLC0415
    from rasterio.transform import from_bounds  # noqa: PLC0415

    ds = netCDF4.Dataset(nc_path)
    try:
        field = np.asarray(ds[var][:], dtype=np.float64)
        x = np.asarray(ds["x"][:], dtype=np.float64)
        y = np.asarray(ds["y"][:], dtype=np.float64)
    finally:
        ds.close()
    field = np.where(np.abs(field) > 1e30, np.nan, field)
    dx = float(np.median(np.diff(x)))
    dy = float(np.median(np.diff(y)))
    west, east = float(x.min() - dx / 2), float(x.max() + dx / 2)
    south, north = float(y.min() + dy / 2), float(y.max() - dy / 2)
    src_crs = CRS.from_epsg(32653)
    transform = from_bounds(west, south, east, north, field.shape[1], field.shape[0])

    da = xr.DataArray(
        field,
        dims=("y", "x"),
        coords={"y": y, "x": x},
    )
    da = da.rio.write_crs(src_crs).rio.write_transform(transform)
    warped = da.rio.reproject("EPSG:4326", nodata=np.nan)
    return _sample_on_grid(warped, grid)


def nisar_on_grid(
    h5_path: Path,
    grid: GridRef,
    pol: str = "HHHH",
    freq: str = "frequencyB",
) -> npt.NDArray[np.float64]:
    """Reproject a NISAR GCOV backscatter layer onto the sim grid.

    GCOV grids are UTM-projected; the HDF5 subdatasets carry no geotransform,
    so we attach it from the x/y coordinate vectors before warping.
    """
    import h5py  # noqa: PLC0415 - heavy optional dep
    import rioxarray  # noqa: F401, PLC0415 - registers .rio accessor
    import xarray as xr  # noqa: PLC0415
    from rasterio.transform import from_origin  # noqa: PLC0415

    with h5py.File(h5_path, "r") as f:
        grp = f[f"science/LSAR/GCOV/grids/{freq}"]
        epsg = int(np.asarray(grp["projection"])[()])
        xc = np.asarray(grp["xCoordinates"][:], dtype=np.float64)
        yc = np.asarray(grp["yCoordinates"][:], dtype=np.float64)
        field = np.asarray(grp[pol][:], dtype=np.float64)
    dx = float(np.median(np.diff(xc)))
    dy = float(np.median(np.diff(yc)))  # negative (north-up)
    transform = from_origin(xc[0] - dx / 2, yc[0] - dy / 2, abs(dx), abs(dy))

    da = xr.DataArray(
        field,
        dims=("y", "x"),
        coords={"y": yc, "x": xc},
    )
    da = da.rio.write_crs(f"EPSG:{epsg}").rio.write_transform(transform)
    warped = da.rio.reproject("EPSG:4326", nodata=np.nan)
    return _sample_on_grid(warped, grid)


def s1_grd_on_grid(
    safe_dir: Path,
    grid: GridRef,
    pol: str = "vv",
) -> npt.NDArray[np.float64]:
    """Reproject a Sentinel-1 GRD measurement onto the sim grid.

    GRD GeoTIFFs carry GCPs; rasterio's warp honours them, giving proper
    terrain-corrected geolocation without a DEM (ellipsoid height).
    """
    import rioxarray  # noqa: PLC0415 - registers .rio accessor

    safe = Path(safe_dir)
    tiffs = sorted((safe / "measurement").glob(f"*-{pol}-*.tiff"))
    if not tiffs:
        msg = f"no {pol} measurement under {safe}"
        raise FileNotFoundError(msg)
    da = rioxarray.open_rasterio(tiffs[0])
    da = da.squeeze("band", drop=True)  # type: ignore[reportAttributeAccessIssue]
    warped = da.rio.reproject("EPSG:4326", nodata=np.nan)
    return _sample_on_grid(warped, grid)


def run_validation(  # noqa: PLR0913 - product selection is the API contract

    meta_path: Path,
    precomputed_dir: Path,
    *,
    swot_nc: Path | None = None,
    swot_pre_nc: Path | None = None,
    nisar_pair: tuple[Path, Path] | None = None,
    s1_pair: tuple[Path, Path] | None = None,
    cfg: ChangeConfig | None = None,
    out_dir: Path | None = None,
) -> dict[str, ValidationResult]:
    """Compare the simulated flood extent against every available product.

    Returns ``{product_name: ValidationResult}``; writes a JSON summary and
    RGB overlay PNGs (model=red, satellite=blue, overlap=yellow) under
    ``out_dir`` when given.
    """
    from PIL import Image  # noqa: PLC0415 - keep module import light

    cfg = cfg or _DEFAULT_CHANGE
    grid = GridRef.from_meta(meta_path)
    hmax = load_sim_hmax(precomputed_dir)
    model = flood_mask(hmax, cfg.sim_depth_m)
    results: dict[str, ValidationResult] = {}
    overlays: dict[str, npt.NDArray[np.bool_]] = {}

    if swot_nc is not None:
        sat = swot_water_mask(swot_on_grid(swot_nc, grid))
        if swot_pre_nc is not None:
            # subtract permanent water from the pre-flood baseline pass
            sat = sat & ~swot_water_mask(swot_on_grid(swot_pre_nc, grid))
        results["swot"] = confusion(model, sat)
        overlays["swot"] = sat
    if nisar_pair is not None:
        pre = nisar_on_grid(nisar_pair[0], grid)
        post = nisar_on_grid(nisar_pair[1], grid)
        sat = change_map(pre, post, cfg)
        results["nisar"] = confusion(model, sat)
        overlays["nisar"] = sat
    if s1_pair is not None:
        pre = s1_grd_on_grid(s1_pair[0], grid)
        post = s1_grd_on_grid(s1_pair[1], grid)
        sat = change_map(pre, post, cfg)
        results["s1"] = confusion(model, sat)
        overlays["s1"] = sat

    if out_dir is not None:
        import json  # noqa: PLC0415 - only needed here

        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        summary = {
            name: {
                "tp": r.true_positive,
                "fp": r.false_positive,
                "fn": r.false_negative,
                "tn": r.true_negative,
                "model_cells": r.model_cells,
                "sat_cells": r.sat_cells,
                "precision": r.precision,
                "recall": r.recall,
                "f1": r.f1,
            }
            for name, r in results.items()
        }
        (out / "validation.json").write_text(json.dumps(summary, indent=2))
        for name, sat in overlays.items():
            rgb = np.full((*model.shape, 3), 20, np.uint8)
            rgb[model] = [200, 60, 40]
            rgb[sat] = [60, 140, 255]
            rgb[model & sat] = [255, 220, 80]
            Image.fromarray(rgb).save(out / f"overlay_{name}.png")
    return results

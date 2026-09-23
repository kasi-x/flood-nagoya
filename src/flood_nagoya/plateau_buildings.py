"""Rasterize PLATEAU CityGML building footprints (LOD0) onto the tile grid.

Buildings come from 国土交通省 Project PLATEAU (2022年度, CityGML 4.0 format).
Each ``bldg:Building`` carries a ``bldg:measuredHeight`` and an
``bldg:lod0FootPrint`` polygon in EPSG:6697 (JGD2011 geographic). We treat
footprints as flow obstacles of the given height, painted into a z15
pixel-space raster (height in centimetres, 0 = no building).
"""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from pathlib import Path

import numpy as np
from PIL import Image
from PIL import ImageDraw

from .config import PLATEAU_EXTRACT_DIR
from .config import Z15_CELL_AREA_M2
from .gsitiles import bbox_tile_range
from .gsitiles import lat_to_tile_y
from .gsitiles import lon_to_tile_x

GML_NS = "http://www.opengis.net/gml"
BLDG_NS = "http://www.opengis.net/citygml/building/2.0"


def _iter_buildings(gml_path: Path) -> Iterator[tuple[list[np.ndarray], float]]:
    """Yield (polygons_lonlat, height_m) per building, streaming the XML."""
    tags = {
        "building": f"{{{BLDG_NS}}}Building",
        "measured_height": f"{{{BLDG_NS}}}measuredHeight",
        "footprint": f"{{{BLDG_NS}}}lod0FootPrint",
        "poslist": f"{{{GML_NS}}}posList",
    }
    # Local, trusted GML files from the official PLATEAU distribution.
    context = ET.iterparse(str(gml_path), events=("end",))  # noqa: S314
    for _, elem in context:
        if elem.tag != tags["building"]:
            continue
        height_el = elem.find(f".//{tags['measured_height']}")
        if height_el is None or height_el.text is None:
            elem.clear()
            continue
        try:
            height_m = float(height_el.text)
        except ValueError:
            elem.clear()
            continue
        polys: list[np.ndarray] = []
        for fp in elem.iter(tags["footprint"]):
            for pos in fp.iter(tags["poslist"]):
                if pos.text is None:
                    continue
                flat = np.fromstring(pos.text.strip(), sep=" ")
                if flat.size < 4:
                    continue
                # Detect 2D vs 3D tuples. EPSG:6697 axis order is
                # (latitude, longitude[, height]) — GML follows the CRS.
                stride = 3 if flat.size % 3 == 0 and _looks_3d(flat) else 2
                pts = flat.reshape(-1, stride)[:, :2]
                polys.append(pts)
        elem.clear()
        if polys:
            yield polys, height_m


def _looks_3d(flat: np.ndarray) -> bool:
    """Heuristic: in 3D lists every 3rd value is a plausible elevation."""
    z = flat.reshape(-1, 3)[:, 2]
    return bool(np.all(np.isfinite(z)) and z.min() > -100 and z.max() < 5000)


def rasterize_buildings(output_npz: Path | None = None) -> Path:
    """Paint PLATEAU footprints into a bbox-wide height raster (cm, int16)."""
    bldg_dir = PLATEAU_EXTRACT_DIR / "udx" / "bldg"
    gml_files = sorted(bldg_dir.glob("*.gml"))
    if not gml_files:
        msg = f"no bldg GML under {bldg_dir}; extract the zip first"
        raise FileNotFoundError(msg)

    x0, x1, y0, y1 = bbox_tile_range()
    width = (x1 + 1 - x0) * 256
    height = (y1 + 1 - y0) * 256
    canvas = Image.new("I", (width, height), 0)
    draw = ImageDraw.Draw(canvas)

    t_start = time.time()
    n_bldg = 0
    for i, gml_path in enumerate(gml_files):
        for polys, height_m in _iter_buildings(gml_path):
            height_cm = min(round(height_m * 100), 32000)
            for pts in polys:
                if len(pts) < 3:
                    continue
                lat, lon = pts[:, 0], pts[:, 1]  # EPSG:6697 axis order
                px = (lon_to_tile_x(lon) - x0) * 256.0
                py = (lat_to_tile_y(lat) - y0) * 256.0
                draw.polygon(list(zip(px.tolist(), py.tolist(), strict=True)), fill=height_cm)
            n_bldg += 1
        if (i + 1) % 50 == 0:
            print(f"  bldg {i + 1}/{len(gml_files)} files, {n_bldg} buildings, {time.time() - t_start:.0f}s")

    # clip before the int16 cast: absurd measuredHeights must not wrap around
    # into a negative (and later huge-unsigned) value on decode
    arr = np.clip(np.asarray(canvas, dtype=np.int32).reshape(height, width), 0, 32000).astype(np.int16)
    output_npz = output_npz or PLATEAU_EXTRACT_DIR / "buildings_z15.npz"
    output_npz.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output_npz, heights=arr, x0=x0, y0=y0)
    covered = int((arr > 0).sum())
    print(
        f"buildings rasterized: {n_bldg} buildings, {covered} px covered "
        f"({covered * Z15_CELL_AREA_M2 / 1e6:.1f} km2), saved to {output_npz}"
    )
    return output_npz

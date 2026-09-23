"""Project-wide constants: study area, tile scheme, and path layout."""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _web_dir() -> Path:
    """Web asset directory — ``FLOOD_NAGOYA_WEB_DIR`` overrides the repo ``web/``.

    The Docker image serves the prebuilt assets from a separate path
    (``/srv/...``), and the override lets any deployment point the server at
    a mounted/moved asset tree without touching the source tree.
    """
    override = os.environ.get("FLOOD_NAGOYA_WEB_DIR")
    return Path(override) if override else PROJECT_ROOT / "web"


WEB_DIR = _web_dir()
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"

# GSI Tiles "dem5a" (5m DEM, 平成以降測量) served as text tiles on XYZ scheme.
GSI_LAYER = "dem5a"
GSI_ZOOM = 15
GSI_TILE_TXT = "https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.txt"

# z15 grid geometry at Nagoya's latitude: web-mercator pixel size shrinks
# with cos(lat); at the study-area mid-latitude one z15 pixel spans ~3.92 m.
Z15_M_PER_PX = 3.919
Z15_CELL_AREA_M2 = Z15_M_PER_PX**2

# Study area: Nagoya City (名古屋市, city code 23100) plus a small margin.
# Rough city extent is lon 136.77-137.06 / lat 35.00-35.28.
LON_MIN, LAT_MIN, LON_MAX, LAT_MAX = 136.740, 34.970, 137.090, 35.305

# Web tile encoding: elevation is stored losslessly in centimetres across
# R/G/B (v = R*65536 + G*256 + B) with A=255 for valid cells and A=0 for
# voids. Building heights are stored in centimetres as v = R*256 + G.
ELEV_CM_ENCODE_OFFSET = 0

RAW_DEM_DIR = RAW_DIR / "gsi" / GSI_LAYER / str(GSI_ZOOM)
PLATEAU_ZIP = RAW_DIR / "plateau" / "23100_nagoya-shi_city_2022_citygml_4_op.zip"
PLATEAU_EXTRACT_DIR = RAW_DIR / "plateau" / "extracted"

WEB_TILE_DIR = WEB_DIR / "tiles"
WEB_META = WEB_DIR / "meta.json"

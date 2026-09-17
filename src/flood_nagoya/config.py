"""Project-wide constants: study area, tile scheme, and path layout."""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"
WEB_DIR = PROJECT_ROOT / "web"

// placeholder
# Web tile encoding: elevation is stored losslessly in centimetres across
# R/G/B (v = R*65536 + G*256 + B) with A=255 for valid cells and A=0 for
# voids. Building heights are stored in centimetres as v = R*256 + G.
ELEV_CM_ENCODE_OFFSET = 0

RAW_DEM_DIR = RAW_DIR / "gsi" / GSI_LAYER / str(GSI_ZOOM)
PLATEAU_ZIP = RAW_DIR / "plateau" / "23100_nagoya-shi_city_2022_citygml_4_op.zip"
PLATEAU_EXTRACT_DIR = RAW_DIR / "plateau" / "extracted"

WEB_TILE_DIR = WEB_DIR / "tiles"
WEB_META = WEB_DIR / "meta.json"

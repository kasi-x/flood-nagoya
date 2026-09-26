#!/usr/bin/env bash
# Fetch every large data asset the app needs from its online source.
# Nothing under data/ or the generated web assets is stored in git (see
# .gitignore), so a fresh clone needs this before `flood_nagoya serve`.
#
# Steps (idempotent — each stage is skipped when its output already exists):
#   1. uv sync                     Python environment (Python 3.11+ and uv required)
#   2. GSI dem5a tiles             ~46MB, cached by flood_nagoya download-dem
#   3. PLATEAU CityGML             2.8GB download → building GMLs → height raster
#   4. web asset build             tiles / overview / meta.json for the app
#
# Precomputed replays (web/precomputed) are NOT downloadable; without them the
# app falls back to a live simulation. Generate with:
#   uv run --locked python -m flood_nagoya precompute
#
# Equivalent to `just sync && just setup` for environments without `just`.

set -euo pipefail
cd "$(dirname "$0")/.."

PLATEAU_URL="https://assets.cms.plateau.reearth.io/assets/79/e43a02-06b6-40c2-ae97-51eba1b4297b/23100_nagoya-shi_city_2022_citygml_4_op.zip"
PLATEAU_ZIP="data/raw/plateau/23100_nagoya-shi_city_2022_citygml_4_op.zip"
PLATEAU_DIR="data/raw/plateau/extracted/udx/bldg"

command -v uv >/dev/null || { echo "error: uv not found — https://docs.astral.sh/uv/" >&2; exit 1; }
command -v unzip >/dev/null || { echo "error: unzip not found" >&2; exit 1; }

echo "== 1/4 uv sync =="
uv sync --locked

echo "== 2/4 GSI dem5a tiles (~46MB, cached on re-run) =="
uv run --locked python -m flood_nagoya download-dem

echo "== 3/4 PLATEAU CityGML (2.8GB download) =="
mkdir -p data/raw/plateau
if [ ! -f "$PLATEAU_ZIP" ]; then
    curl -fL --progress-bar -o "$PLATEAU_ZIP" "$PLATEAU_URL"
else
    echo "   zip already present, skipping download: $PLATEAU_ZIP"
fi
if [ -d "$PLATEAU_DIR" ] && [ -n "$(ls "$PLATEAU_DIR" 2>/dev/null)" ]; then
    echo "   extracted GMLs already present, skipping unzip"
else
    unzip -o -q "$PLATEAU_ZIP" "udx/bldg/*" -d data/raw/plateau/extracted/
fi
uv run --locked python -c "from flood_nagoya.plateau_buildings import rasterize_buildings; rasterize_buildings()"

echo "== 4/4 web assets (tiles / overview / meta.json) =="
uv run --locked python -m flood_nagoya build

echo "done — start the app with: uv run --locked python -m flood_nagoya serve"

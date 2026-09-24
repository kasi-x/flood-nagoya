default:
    @just --list


# Check formatting and lint (ruff, check-only)

lint:
    uv run --locked ruff format --check . && uv run --locked ruff check .

# Auto-fix formatting and lint (run before committing).
# typos は自動書き換えしない (-w は識別子まで書き換える危険があるため)。
# 実際のタイポは `just check` の typos で検出され、手動で直す。

fix:
    uv run --locked ruff check --fix .
    uv run --locked ruff format .

# Run basedpyright + pyrefly + static analysis

type-check:
    uv run --locked basedpyright
    uv run --locked pyrefly check
    uv run --locked vulture src/flood_nagoya --min-confidence 80
    uv run --locked deptry .
    uv run --locked typos .

# Audit dependencies for known vulnerabilities (needs network)

audit:
    uv run --locked pip-audit

# Check dependency licenses comply with MIT (needs network)

license-check:
    uv run --locked pip-licenses --from=mixed --partial-match --fail-on=GPL

# Run tests with coverage

test:
    uv run --locked pytest --cov=src/flood_nagoya --cov-report term --cov-report xml:cov.xml

# Build documentation

docs:
    uv run --locked zensical build

# Serve documentation with live reload

docs-serve:
    uv run --locked zensical serve

# Launch marimo notebook editor

marimo:
    uv run --extra experiment --locked marimo edit notebooks

# Launch Jupyter on notebooks/

notebook:
    uv run --extra experiment --locked jupyter lab notebooks/ --allow-root

# Render the paper to arxiv-pdf and html

paper:
    quarto render paper/paper.qmd

# Render the slides to reveal.js html

slides:
    quarto render slides/slides.qmd

# Build the quartodoc API reference

paper-api:
    uv run --locked quartodoc build --config _quarto.yml

# Run all quality checks

check: lint type-check test

# --- App commands ---------------------------------------------------------

# Install the environment (first time / after pyproject.toml changes)

sync:
    uv sync --locked

# Download GSI dem5a tiles for the Nagoya study area (~46MB, cached)

dem:
    uv run --locked python -m flood_nagoya download-dem

# Download PLATEAU CityGML (2.8GB), extract building GML, rasterize heights

plateau:
    mkdir -p data/raw/plateau
    curl -o data/raw/plateau/23100_nagoya-shi_city_2022_citygml_4_op.zip \
      "https://assets.cms.plateau.reearth.io/assets/79/e43a02-06b6-40c2-ae97-51eba1b4297b/23100_nagoya-shi_city_2022_citygml_4_op.zip"
    unzip -o -q data/raw/plateau/23100_nagoya-shi_city_2022_citygml_4_op.zip \
      "udx/bldg/*" -d data/raw/plateau/extracted/
    uv run --locked python -c "from flood_nagoya.plateau_buildings import rasterize_buildings; rasterize_buildings()"

# Generate web assets (tiles, overview, meta.json) from data/raw

build:
    uv run --locked python -m flood_nagoya build

# Serve the web app (http://127.0.0.1:8642/)

serve:
    uv run --locked python -m flood_nagoya serve

# Precompute the Sakai flood replay for the web app (~10 min)

precompute:
    uv run --locked python -m flood_nagoya precompute

# Expose the local app via a Cloudflare quick tunnel (needs `just serve`
# running and the cloudflared binary; the public URL is ephemeral —
# a new one is printed on every run)

tunnel:
    cloudflared tunnel --url http://localhost:8642

# AMeDAS observed-rain hyetograph scenario for DATE (YYYY-MM-DD)

rain date:
    uv run --locked python -m flood_nagoya rain-scenario --date {{date}}

# XRAIN radar spatial-rain scenario for DATE (last ~8 days only)

xrain date:
    uv run --locked python -m flood_nagoya xrain-scenario --date {{date}}

# MSM + AMeDAS-calibrated spatial-rain scenario for DATE

msm date:
    uv run --locked python -m flood_nagoya msm-scenario --date {{date}}

# Historical disaster observed-rain scenarios (hagibis-2019, meiyu-2023, july-2023)

historical event:
    uv run --locked python -m flood_nagoya historical-scenario {{event}}

# All historical disaster observed-rain scenarios

historical-all:
    uv run --locked python -m flood_nagoya historical-scenarios

# Precompute with a raised sea level (storm surge / high tide) [m]

precompute-surge sea_level:
    uv run --locked python -m flood_nagoya precompute --sea-level {{sea_level}}

# Precompute with the simplified underground inundation model

precompute-underground:
    uv run --locked python -m flood_nagoya precompute --underground


# Precompute with the 1D river-channel model (catchment → stage → overflow)

precompute-river:
    uv run --locked python -m flood_nagoya precompute --river

# Full data pipeline: DEM + buildings + web assets (after `just sync`)

setup:
    @just dem
    @just plateau
    @just build

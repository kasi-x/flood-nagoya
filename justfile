default:
    @just --list


# Check formatting and lint (ruff, check-only)

lint:
    uv run --locked ruff format --check . && uv run --locked ruff check .

# Auto-fix formatting, lint and typos (run before committing)

fix:
    uv run --locked ruff check --fix .
    uv run --locked ruff format . && uv run --locked typos -w .

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

# syntax=docker/dockerfile:1

# ======================================================================
# Stage: developer — used by .devcontainer/devcontainer.json
# ======================================================================
FROM ghcr.io/diamondlightsource/ubuntu-devcontainer:resolute AS developer

# Add any system dependencies for the developer/build environment here
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    graphviz \
    && apt-get dist-clean

# ======================================================================
# Stage: runtime — serve the prebuilt web app on :8642
#
#   docker build --target runtime -t flood-nagoya .
#   docker run --rm -p 8642:8642 flood-nagoya
#   -> http://localhost:8642
#
# The image serves the *prebuilt* web assets (web/tiles, web/overview,
# web/meta.json, web/lib). Build or refresh them locally first:
#   uv run python -m flood_nagoya build      # needs data/raw (GSI/PLATEAU)
# The 12GB data/ tree is excluded by .dockerignore; only src/ + web/
# enter the build context. `docker compose up --build` bind-mounts ./web
# so a local rebuild is picked up without recreating the image.
# ======================================================================
FROM python:3.11-alpine AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FLOOD_NAGOYA_WEB_DIR=/srv/flood-nagoya-web

WORKDIR /opt/flood-nagoya

# Install the CLI (serving needs only the stdlib + this package; the heavy
# numpy/scipy/pillow deps are required only for `build`/`download-dem`).
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN pip install --no-cache-dir --no-deps .

# Prebuilt assets: server reads WEB_DIR from FLOOD_NAGOYA_WEB_DIR
COPY web /srv/flood-nagoya-web

# The server binds 0.0.0.0 so the mapped port is reachable from the host;
# compose mounts ./web over /srv/flood-nagoya-web for live asset updates.
EXPOSE 8642

RUN adduser -D -u 10001 app
USER app

CMD ["python", "-m", "flood_nagoya", "serve", "--host", "0.0.0.0", "--port", "8642"]
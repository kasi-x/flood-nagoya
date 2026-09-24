"""Satellite validation data: search and download SAR/optical scenes for flood checks.

Free sources, all reachable with the NASA Earthdata login (see README):

- ASF Search API — Sentinel-1 GRD/RTC and NISAR GCOV scene search + download.
- NASA CMR — SWOT and GPM IMERG granule search.
- Tellus Traveler — JAXA ALOS-2/ASNARO-2 archive (own API token).

Authentication never lives in code: the Earthdata bearer token comes from the
``EARTHDATA_TOKEN`` environment variable, falling back to the password field
of a ``urs.earthdata.nasa.gov`` entry in ``~/.netrc``. The Tellus token comes
from ``TELLUS_API_TOKEN``. Every network function takes an explicit ``token``
argument so tests can inject fakes without touching the environment.
"""

from __future__ import annotations

import json
import netrc
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

__all__ = [
    "ASF_API_URL",
    "CMR_GRANULES_URL",
    "USER_AGENT",
    "asf_search",
    "bearer_token",
    "cmr_granules",
    "download",
    "tellus_data_search",
    "tellus_datasets",
]

USER_AGENT = "flood-nagoya/0.1"
REQUEST_TIMEOUT = 60.0

ASF_API_URL = "https://api.daac.asf.alaska.edu/services/search/param"
CMR_GRANULES_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
TELLUS_API_URL = "https://www.tellusxdp.com/api/traveler/v1"


def bearer_token() -> str | None:
    """Earthdata bearer token from env, else ``~/.netrc`` (never raises)."""
    token = os.environ.get("EARTHDATA_TOKEN")
    if token:
        return token
    try:
        auth = netrc.netrc().authenticators("urs.earthdata.nasa.gov")
    except (OSError, netrc.NetrcParseError):
        return None
    return auth[2] if auth else None


def _get_json(url: str, token: str | None = None, timeout: float = REQUEST_TIMEOUT) -> object:
    """GET a JSON document (dict/list); bearer header only when given."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def asf_search(params: dict[str, str], token: str | None = None) -> list[dict[str, object]]:
    """Search ASF (Sentinel-1 / NISAR) → list of scene dicts.

    ``params`` are ASF API keywords (platform, processingLevel,
    intersectsWith, start, end, ...). The API wraps hits in one extra
    list level (``[[{...}]]``); this is flattened away.
    """
    query = urllib.parse.urlencode({**params, "output": "JSON"})
    payload = _get_json(f"{ASF_API_URL}?{query}", token)
    if isinstance(payload, list):
        scenes: list[dict[str, object]] = []
        for group in payload:
            scenes.extend(group if isinstance(group, list) else [group])
        return [s for s in scenes if isinstance(s, dict)]  # type: ignore[reportUnnecessaryIsInstance]
    return []


def cmr_granules(
    collection_id: str,
    bbox: tuple[float, float, float, float] | None = None,
    temporal: tuple[str, str] | None = None,
    token: str | None = None,
    page_size: int = 100,
) -> list[dict[str, object]]:
    """Search NASA CMR granules (SWOT, IMERG, ...) → list of entry dicts."""
    params: dict[str, str] = {
        "collection_concept_id": collection_id,
        "page_size": str(page_size),
    }
    if bbox is not None:
        params["bounding_box"] = ",".join(str(v) for v in bbox)
    if temporal is not None:
        params["temporal"] = ",".join(temporal)
    payload = _get_json(f"{CMR_GRANULES_URL}?{urllib.parse.urlencode(params)}", token)
    if isinstance(payload, dict):
        feed = payload.get("feed", {})
        if isinstance(feed, dict):
            entries = feed.get("entry", [])
            return [e for e in entries if isinstance(e, dict)]
    return []


def tellus_datasets(token: str) -> list[dict[str, object]]:
    """List Tellus Traveler datasets visible to the token."""
    req = urllib.request.Request(  # noqa: S310
        f"{TELLUS_API_URL}/datasets/?limit=100",
        headers={"User-Agent": USER_AGENT, "Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:  # noqa: S310
        payload = json.loads(resp.read().decode("utf-8"))
    if isinstance(payload, dict):
        items = payload.get("results", [])
        return [d for d in items if isinstance(d, dict)]
    return []


def tellus_data_search(  # noqa: PLR0913, PLR0917 - search knobs are the API contract
    dataset_id: str,
    token: str,
    start: str,
    end: str,
    polygon: list[list[float]],
    limit: int = 50,
) -> list[dict[str, object]]:
    """Search one Tellus dataset for scenes over a polygon in [start, end].

    ``polygon`` is a lon/lat ring; dates are ISO ``YYYY-MM-DD`` strings.
    """
    body = json.dumps(
        {
            "intersects": {"type": "Polygon", "coordinates": [polygon]},
            "query": {
                "start_datetime": {
                    "gte": f"{start}T00:00:00Z",
                    "lte": f"{end}T00:00:00Z",
                }
            },
            "paginate": {"size": limit, "cursor": None},
        }
    ).encode("utf-8")
    req = urllib.request.Request(  # noqa: S310
        f"{TELLUS_API_URL}/datasets/{dataset_id}/data-search/",
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:  # noqa: S310
        payload = json.loads(resp.read().decode("utf-8"))
    if isinstance(payload, dict):
        features = payload.get("features", [])
        return [f for f in features if isinstance(f, dict)]
    return []


def download(
    url: str,
    dest: Path,
    token: str | None = None,
    timeout: float = 600.0,
    chunk: int = 1 << 20,
) -> Path:
    """Stream a (possibly huge) file to ``dest``; bearer header when given."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, dest.open("wb") as fh:  # noqa: S310
            while True:
                block = resp.read(chunk)
                if not block:
                    break
                fh.write(block)
    except urllib.error.HTTPError:
        if dest.exists():
            dest.unlink()
        raise
    return dest

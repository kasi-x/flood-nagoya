"""Observed-rainfall scenarios from JMA past weather data (過去の気象データ検索).

``rain-scenario`` downloads the hourly table of an AMeDAS station from the
JMA "過去の気象データ検索" site (``www.data.jma.go.jp/stats/etrn/``),
extracts the 1-hour-precipitation column and writes a hyetograph scenario
JSON into ``web/scenarios/``. The web app lists those files under
「観測降雨」 and drives the GPU shallow-water engine with the observed
time series instead of a constant rate.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import TypedDict

from .config import WEB_DIR

ETRN_HOURLY_URL = "https://www.data.jma.go.jp/stats/etrn/view/hourly_s1.php"
REQUEST_TIMEOUT = 30.0
USER_AGENT = "flood-nagoya/0.1"

# AMeDAS stations useful for 名古屋市: name -> (prec_no, block_no).
# The etrn site addresses stations by their WMO-style 5-digit block number
# (the legacy 4-digit 0511 no longer resolves there).
STATIONS: dict[str, tuple[int, str]] = {
    "名古屋": (51, "47636"),
}

# Column layout of the hourly_s1 table: 時, 気圧, 海面気圧, 降水量, …
_PRECIP_COLUMN = 3
_TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.DOTALL)
_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")


def hourly_url(prec_no: int, block_no: str, day: date) -> str:
    return (
        f"{ETRN_HOURLY_URL}?prec_no={prec_no}&block_no={block_no}"
        f"&year={day.year}&month={day.month}&day={day.day}&view=1"
    )


def _urlopen_text(req: urllib.request.Request) -> str:
    with urllib.request.urlopen(  # noqa: S310 - https-only data source
        req, timeout=REQUEST_TIMEOUT
    ) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_hourly_html(prec_no: int, block_no: str, day: date, retries: int = 3) -> str:
    """Download the etrn hourly table page for one station and day."""
    req = urllib.request.Request(  # noqa: S310 - https-only data source
        hourly_url(prec_no, block_no, day), headers={"User-Agent": USER_AGENT}
    )
    for attempt in range(retries - 1):
        try:
            return _urlopen_text(req)
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(1.0 + attempt)
    return _urlopen_text(req)  # final attempt: let errors propagate


def _cell_to_float(cell: str) -> float | None:
    """Numeric cell value; None for the etrn missing markers (--, ##, //)."""
    text = _TAG_RE.sub("", cell).strip()
    try:
        return float(text)
    except ValueError:
        return None


def parse_hourly_precip(html: str) -> list[float | None]:
    """Extract 24 hourly precipitation values (index 0 = 1時台, None = 欠測)."""
    values: dict[int, float | None] = {}
    for row in _ROW_RE.findall(html):
        cells = _TD_RE.findall(row)
        if len(cells) <= _PRECIP_COLUMN or not cells[0].strip().isdigit():
            continue
        hour = int(cells[0])
        if 1 <= hour <= 24:
            values[hour] = _cell_to_float(cells[_PRECIP_COLUMN])
    if len(values) < 24:
        msg = f"expected 24 hourly rows, found {len(values)} — check prec_no/block_no"
        raise ValueError(msg)
    return [values[hour] for hour in range(1, 25)]


def hyetograph(series: Sequence[float | None]) -> list[list[float]]:
    """Piecewise-linear rain-rate breakpoints as ``[[t_seconds, mm_h], ...]``.

    Row ``h`` of the etrn table is the precipitation from h-1 to h JST, so
    the rate on interval [h-1, h) is ``series[h-1]``; t=0 is midnight JST.
    Missing observations count as dry (the scenario metadata reports how
    many hours were missing).
    """
    points: list[list[float]] = []
    for hour in range(1, 25):
        rate = series[hour - 1]
        points.append([(hour - 1) * 3600.0, 0.0 if rate is None else float(rate)])
    points.append([86400.0, 0.0])
    return points


class StationInfo(TypedDict):
    name: str
    prec_no: int
    block_no: str


class Scenario(TypedDict):
    """Scenario document consumed by web/app.js (「観測降雨」 buttons)."""

    kind: str
    date: str
    tz: str
    station: StationInfo
    source: str
    series: list[list[float]]
    total_mm: float
    peak_mmh: float
    peak_hour_jst: int | None
    missing_hours: int


def build_scenario(prec_no: int, block_no: str, station: str, day: date, html: str) -> Scenario:
    """Assemble the web-app scenario document from a fetched hourly page."""
    series = parse_hourly_precip(html)
    observed = [v for v in series if v is not None]
    peak = max(observed, default=0.0)
    return Scenario(
        kind="observed-rain",
        date=day.isoformat(),
        tz="Asia/Tokyo",
        station=StationInfo(name=station, prec_no=prec_no, block_no=block_no),
        source=hourly_url(prec_no, block_no, day),
        series=hyetograph(series),
        total_mm=round(sum(observed), 1),
        peak_mmh=peak,
        peak_hour_jst=series.index(peak) + 1 if observed else None,
        missing_hours=series.count(None),
    )


def scenario_path(day: date, block_no: str, out_dir: Path | None = None) -> Path:
    out = out_dir if out_dir is not None else WEB_DIR / "scenarios"
    return out / f"rain_{day:%Y%m%d}_{block_no}.json"


def write_index(out_dir: Path | None = None) -> Path:
    """(Re)build ``index.json`` listing every ``rain_*.json`` in the directory."""
    out = out_dir if out_dir is not None else WEB_DIR / "scenarios"
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    for path in sorted(out.glob("rain_*.json")):
        scenario = json.loads(path.read_text(encoding="utf-8"))
        entries.append(
            {
                "file": path.name,
                "name": f"{scenario['station']['name']} {scenario['date']}",
                "desc": (f"最大 {scenario['peak_mmh']:g} mm/h・合計 {scenario['total_mm']:g} mm (AMeDAS実測)"),
            }
        )
    index = out / "index.json"
    index.write_text(json.dumps(entries, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return index


def write_scenario(scenario: Scenario, out_dir: Path | None = None) -> Path:
    """Write one scenario JSON and refresh the listing index."""
    path = scenario_path(date.fromisoformat(scenario["date"]), scenario["station"]["block_no"], out_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(scenario, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    write_index(path.parent)
    return path


def generate(day: date, station: str = "名古屋", out_dir: Path | None = None) -> Path:
    """Fetch observed rainfall for one day and write the scenario JSON."""
    if station not in STATIONS:
        msg = f"unknown station {station!r}; known: {', '.join(STATIONS)}"
        raise ValueError(msg)
    prec_no, block_no = STATIONS[station]
    html = fetch_hourly_html(prec_no, block_no, day)
    return write_scenario(build_scenario(prec_no, block_no, station, day, html), out_dir)

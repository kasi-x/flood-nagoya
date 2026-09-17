"""Tests for the AMeDAS observed-rainfall scenario pipeline."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING
from typing import Self

import pytest

from flood_nagoya.amedas import build_scenario
from flood_nagoya.amedas import fetch_hourly_html
from flood_nagoya.amedas import generate
from flood_nagoya.amedas import hourly_url
from flood_nagoya.amedas import parse_hourly_precip
from flood_nagoya.amedas import Scenario
from flood_nagoya.amedas import scenario_path
from flood_nagoya.amedas import write_index
from flood_nagoya.amedas import write_scenario
from flood_nagoya.__main__ import main

if TYPE_CHECKING:
    import pytest_mock

FIXTURE = Path(__file__).parent / "fixtures" / "etrn_hourly_nagoya_20260908.html"


def _scenario() -> Scenario:
    return build_scenario(51, "47636", "名古屋", date(2026, 9, 8), FIXTURE.read_text(encoding="utf-8"))


def test_hourly_url_contains_params() -> None:
    url = hourly_url(51, "47636", date(2026, 9, 8))
    assert url.startswith("https://www.data.jma.go.jp/stats/etrn/view/hourly_s1.php?")
    assert "prec_no=51" in url
    assert "block_no=47636" in url
    assert "year=2026&month=9&day=8" in url


def test_parse_real_event_fixture() -> None:
    series = parse_hourly_precip(FIXTURE.read_text(encoding="utf-8"))
    assert len(series) == 24
    assert series[15] == pytest.approx(67.0)  # 16時台
    assert series[16] == pytest.approx(97.5)  # 17時台 — 観測史上最多
    assert series[4] is None  # 5時台は欠測 (--)


def test_parse_rejects_page_without_hourly_rows() -> None:
    with pytest.raises(ValueError, match="24 hourly rows"):
        parse_hourly_precip("<html><body><p>no data</p></body></html>")


def test_build_scenario_metadata() -> None:
    scenario = _scenario()
    assert scenario["kind"] == "observed-rain"
    assert scenario["date"] == "2026-09-08"
    assert scenario["tz"] == "Asia/Tokyo"
    assert scenario["station"] == {"name": "名古屋", "prec_no": 51, "block_no": "47636"}
    assert scenario["total_mm"] == pytest.approx(219.5)
    assert scenario["peak_mmh"] == pytest.approx(97.5)
    assert scenario["peak_hour_jst"] == 17
    assert scenario["missing_hours"] == 1
    assert "block_no=47636" in scenario["source"]


def test_hyetograph_breakpoints_match_jst_hours() -> None:
    series = parse_hourly_precip(FIXTURE.read_text(encoding="utf-8"))
    points = build_scenario(51, "47636", "名古屋", date(2026, 9, 8), FIXTURE.read_text(encoding="utf-8"))["series"]
    assert len(points) == 25
    assert points[0] == [0.0, series[0]]
    # 17時台の雨 (series[16]) は 16:00-17:00 JST のレートとして現れる
    assert points[16] == [16 * 3600.0, pytest.approx(97.5)]
    # 欠測は乾き扱い
    assert points[4] == [4 * 3600.0, 0.0]
    assert points[-1] == [86400.0, 0.0]


def test_scenario_path_default_and_override(tmp_path: Path) -> None:
    assert scenario_path(date(2026, 9, 8), "47636").name == "rain_20260908_47636.json"
    override = scenario_path(date(2026, 9, 8), "47636", tmp_path)
    assert override == tmp_path / "rain_20260908_47636.json"


def test_write_scenario_and_index(tmp_path: Path) -> None:
    path = write_scenario(_scenario(), tmp_path)
    assert path.read_text(encoding="utf-8").startswith("{")
    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert index == [
        {
            "file": "rain_20260908_47636.json",
            "name": "名古屋 2026-09-08",
            "desc": "最大 97.5 mm/h・合計 219.5 mm (AMeDAS実測)",
        }
    ]
    write_index(tmp_path)  # idempotent regeneration
    assert json.loads((tmp_path / "index.json").read_text(encoding="utf-8")) == index


def test_generate_fetches_and_writes(tmp_path: Path, mocker: pytest_mock.MockerFixture) -> None:
    fetch = mocker.patch(
        "flood_nagoya.amedas.fetch_hourly_html",
        return_value=FIXTURE.read_text(encoding="utf-8"),
    )
    path = generate(date(2026, 9, 8), "名古屋", tmp_path)
    fetch.assert_called_once_with(51, "47636", date(2026, 9, 8))
    scenario = json.loads(path.read_text(encoding="utf-8"))
    assert scenario["peak_mmh"] == pytest.approx(97.5)


def test_generate_unknown_station(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="known: 名古屋"):
        generate(date(2026, 9, 8), "トーキョー", tmp_path)


class _FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload: bytes = payload

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self._payload


def test_fetch_hourly_html_success(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    def fake_urlopen(req: urllib.request.Request, _timeout: float) -> _FakeResponse:
        seen["url"] = req.full_url
        seen["ua"] = req.headers["User-agent"]
        return _FakeResponse(FIXTURE.read_bytes())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    html = fetch_hourly_html(51, "47636", date(2026, 9, 8))
    assert "97.5" in html
    assert "block_no=47636" in seen["url"]
    assert seen["ua"].startswith("flood-nagoya/")


def test_fetch_hourly_html_retries_then_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("flood_nagoya.amedas.time.sleep", lambda _seconds: None)

    def fake_urlopen(_req: urllib.request.Request, _timeout: float) -> _FakeResponse:
        raise urllib.error.URLError("boom")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(urllib.error.URLError):
        fetch_hourly_html(51, "47636", date(2026, 9, 8), retries=3)


def test_cli_rain_scenario(tmp_path: Path, mocker: pytest_mock.MockerFixture) -> None:
    mocker.patch(
        "flood_nagoya.amedas.fetch_hourly_html",
        return_value=FIXTURE.read_text(encoding="utf-8"),
    )
    main(["rain-scenario", "--date", "2026-09-08", "--out", str(tmp_path)])
    scenario = json.loads((tmp_path / "rain_20260908_47636.json").read_text(encoding="utf-8"))
    assert scenario["station"]["name"] == "名古屋"
    assert (tmp_path / "index.json").exists()

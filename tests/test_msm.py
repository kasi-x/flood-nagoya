"""Tests for the MSM (Open-Meteo) + AMeDAS calibrated spatial reconstruction."""

from __future__ import annotations

import datetime as dt
import json
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING
from typing import Self

import numpy as np
import pytest

from flood_nagoya import msm
from flood_nagoya.config import LAT_MAX
from flood_nagoya.config import LAT_MIN
from flood_nagoya.config import LON_MAX
from flood_nagoya.config import LON_MIN
from flood_nagoya.msm import build_day_scenario
from flood_nagoya.msm import fetch_msm_grid
from flood_nagoya.msm import grid_points
from flood_nagoya.msm import hourly_factors
from flood_nagoya.msm import resample_hour

if TYPE_CHECKING:
    import pytest_mock


def _api_payload(lats: list[float], lons: list[float], hours: int = 24) -> list[dict[str, object]]:
    out = []
    for i, lat in enumerate(lats):
        for j, lon in enumerate(lons):
            out.append(
                {
                    "latitude": lat,
                    "longitude": lon,
                    "hourly": {"precipitation": [float(i + j) if h == 14 else 0.0 for h in range(hours)]},
                }
            )
    return out


def test_grid_points_covers_bbox_with_margin() -> None:
    lats, lons = grid_points()
    assert len(lats) == len(lons) and len(lats) >= 4  # paired request points
    assert min(lats) <= LAT_MIN and max(lats) >= LAT_MAX
    assert min(lons) <= LON_MIN and max(lons) >= LON_MAX


def test_fetch_msm_grid_dedupes_snapped_points(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Open-Meteo snaps requests to the model lattice: two request points can
    # collapse into one returned entry.
    payload = _api_payload([35.0, 35.05], [136.75, 136.8125])[:2]
    payload[0]["latitude"] = payload[1]["latitude"]  # force a duplicate pair
    payload[0]["longitude"] = payload[1]["longitude"]

    class _Resp:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(payload).encode()

    captured: dict[str, str] = {}

    def fake_urlopen(req: urllib.request.Request, timeout: float) -> _Resp:  # noqa: ARG001
        captured["url"] = req.full_url
        return _Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    glats, glons, values = fetch_msm_grid(dt.date(2026, 9, 8), [35.0, 35.05], [136.75, 136.8125])
    assert "start_date=2026-09-08" in captured["url"]
    assert "jma_msm" in captured["url"]
    assert glats.tolist() == [35.0]
    assert glons.tolist() == [136.8125]
    assert values.shape == (24, 1, 1)
    assert values[14, 0, 0] == pytest.approx(1.0)  # duplicate kept the last entry


def test_fetch_msm_grid_rejects_short_series(
    mocker: pytest_mock.MockerFixture,
) -> None:
    bad = [{"latitude": 35.0, "longitude": 136.75, "hourly": {"precipitation": [0.0] * 5}}]

    class _Resp:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(bad).encode()

    mocker.patch("flood_nagoya.msm.urllib.request.urlopen", return_value=_Resp())
    with pytest.raises(RuntimeError, match="24 hourly"):
        fetch_msm_grid(dt.date(2026, 9, 8), [35.0], [136.75])


def test_hourly_factors_calibration_and_fallbacks() -> None:
    glats = np.array([35.1, 35.17, 35.3])
    glons = np.array([136.8, 136.9, 137.0])
    values = np.zeros((4, 3, 3), dtype=np.float64)
    values[0, 1, 1] = 2.0  # gauge MSM=2, observed 10 → factor 5
    values[1, 1, 1] = 0.0  # observed 0 → factor 0
    values[2, 1, 1] = 0.0  # observed 5 but model dry → factor 1 (uniform)
    values[3, 1, 1] = 0.5  # observed None → dry gauge → 0 … but msm tiny → min(0/0.5)=0
    observed: list[float | None] = [10.0, 0.0, 5.0, None]
    factors = hourly_factors(values, glats, glons, observed)
    assert factors[0] == pytest.approx(5.0)
    assert factors[1] == 0.0
    assert factors[2] == 1.0
    assert factors[3] == 0.0


def test_hourly_factors_capped() -> None:
    glats = np.array([35.17])
    glons = np.array([136.9])
    values = np.full((1, 1, 1), 1.0)
    factors = hourly_factors(values, glats, glons, [200.0])
    assert factors[0] == pytest.approx(msm.MAX_MMH)  # cap guards extremes


def test_resample_hour_bilinear_and_clamped() -> None:
    glats = np.array([35.0, 35.1])
    glons = np.array([136.8, 136.9])
    field = np.array([[1.0, 3.0], [5.0, 7.0]])
    lat2d = np.array([[35.05], [35.05]])
    lon2d = np.array([[136.85], [136.85]])
    out = resample_hour(field, glats, glons, lat2d, lon2d)
    # 中心点は4隅の平均値になる
    assert out[0, 0] == pytest.approx(4.0)
    # 外挿ではなくエッジクランプで埋まる
    lat_edge = np.array([[34.9]])
    lon_edge = np.array([[136.95]])
    corner = resample_hour(field, glats, glons, lat_edge, lon_edge)
    assert corner[0, 0] == pytest.approx(3.0)


def test_build_day_scenario_full_flow(mocker: pytest_mock.MockerFixture, tmp_path: Path) -> None:
    amedas_html = (Path(__file__).parent / "fixtures" / "etrn_hourly_nagoya_20260908.html").read_text(encoding="utf-8")
    mocker.patch.object(msm, "fetch_hourly_html", return_value=amedas_html)
    glats = np.array([35.0, 35.1])
    glons = np.array([136.8, 136.9])
    values = np.full((24, 2, 2), 2.0)
    values[16] = 90.0  # 17時台の観測ピークに対応する時間
    mocker.patch.object(msm, "fetch_msm_grid", return_value=(glats, glons, values))
    small_lat = np.array([[35.05], [35.05]])
    small_lon = np.array([[136.85], [136.85]])
    mocker.patch.object(msm, "overview_lat_lon", return_value=(small_lat, small_lon))

    path = build_day_scenario(dt.date(2026, 9, 8), out_dir=tmp_path)
    assert path.name == "rain_20260908_msm.json"
    scenario = json.loads(path.read_text(encoding="utf-8"))
    assert scenario["kind"] == "msm"
    assert scenario["frame_seconds"] == 3600
    assert len(scenario["frames"]) == 24
    assert len(list(path.parent.glob("rain_20260908_msm/f*.png"))) == 24
    # 較正によりピーク時の領域平均が観測 (97.5mm/h 近傍) まで引き上げられる
    rates = [r for _, r in scenario["series"]]
    assert max(rates) == pytest.approx(97.5, rel=0.2)
    assert "AMeDAS" in scenario["note"]
    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    entry = next(e for e in index if e["file"] == "rain_20260908_msm.json")
    assert "MSM較正" in entry["name"]

"""CLI dispatch tests: argument parsing reaches the right module functions."""

from __future__ import annotations

import datetime as dt
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from flood_nagoya import __version__

if TYPE_CHECKING:
    import pytest_mock


def test_cli_version() -> None:
    cmd = [sys.executable, "-m", "flood_nagoya", "--version"]
    assert subprocess.check_output(cmd).decode().strip() == __version__


def test_cli_xrain_scenario_dispatch(tmp_path: Path, mocker: pytest_mock.MockerFixture) -> None:
    """xrain-scenario forwards --date/--level/--out to build_day_scenario."""
    from flood_nagoya.__main__ import main

    calls: dict[str, object] = {}

    def fake(day: dt.date, level: int, out: Path) -> Path:
        calls.update(day=day, level=level, out=out)
        return tmp_path / "x.json"

    mocker.patch("flood_nagoya.xrain.build_day_scenario", side_effect=fake)
    main(["xrain-scenario", "--date", "2026-09-20", "--level", "2", "--out", str(tmp_path)])
    assert calls == {"day": dt.date(2026, 9, 20), "level": 2, "out": tmp_path}


def test_cli_msm_scenario_dispatch(tmp_path: Path, mocker: pytest_mock.MockerFixture) -> None:
    from flood_nagoya.__main__ import main

    calls: dict[str, object] = {}

    def fake(day: dt.date, station: str, out: Path) -> Path:
        calls.update(day=day, station=station, out=out)
        return tmp_path / "m.json"

    mocker.patch("flood_nagoya.msm.build_day_scenario", side_effect=fake)
    main(["msm-scenario", "--date", "2026-09-08", "--station", "名古屋", "--out", str(tmp_path)])
    assert calls == {"day": dt.date(2026, 9, 8), "station": "名古屋", "out": tmp_path}


def test_cli_download_dem_dispatch(mocker: pytest_mock.MockerFixture) -> None:
    from flood_nagoya.__main__ import main

    spy = mocker.patch("flood_nagoya.gsitiles.download_bbox")
    main(["download-dem"])
    spy.assert_called_once_with()


def test_cli_build_dispatch(mocker: pytest_mock.MockerFixture) -> None:
    from flood_nagoya.__main__ import main

    spy = mocker.patch("flood_nagoya.pipeline.build")
    main(["build"])
    spy.assert_called_once_with()


def test_cli_historical_scenario_dispatch(tmp_path: Path, mocker: pytest_mock.MockerFixture) -> None:
    from flood_nagoya.__main__ import main
    from flood_nagoya.historical import EVENTS

    event = next(iter(EVENTS))
    spy = mocker.patch("flood_nagoya.historical.generate_event", return_value=tmp_path / "h.json")
    main(["historical-scenario", event, "--out", str(tmp_path)])
    spy.assert_called_once_with(event, tmp_path)


def test_cli_historical_scenarios_dispatch(tmp_path: Path, mocker: pytest_mock.MockerFixture) -> None:
    from flood_nagoya.__main__ import main

    spy = mocker.patch("flood_nagoya.historical.generate_all", return_value=[tmp_path / "a.json"])
    main(["historical-scenarios", "--out", str(tmp_path)])
    spy.assert_called_once_with(tmp_path)


def test_cli_precompute_dispatch(tmp_path: Path, mocker: pytest_mock.MockerFixture) -> None:
    from flood_nagoya.__main__ import main

    spy = mocker.patch("flood_nagoya.precompute.precompute")
    main(
        [
            "precompute",
            "--out",
            str(tmp_path),
            "--lon",
            "136.9",
            "--lat",
            "35.17",
            "--label",
            "栄",
            "--streams-only",
            "--sea-level",
            "0.5",
            "--underground",
        ]
    )
    spy.assert_called_once()
    kwargs = spy.call_args.kwargs
    assert kwargs["out_dir"] == tmp_path
    assert kwargs["lon"] == 136.9
    assert kwargs["lat"] == 35.17
    assert kwargs["label"] == "栄"
    assert kwargs["streams_only"] is True
    assert kwargs["sea_level_m"] == 0.5
    assert kwargs["underground"] is True

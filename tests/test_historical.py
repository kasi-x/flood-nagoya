"""Tests for the historical disaster scenario catalogue."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from flood_nagoya.historical import EVENTS
from flood_nagoya.historical import generate_all
from flood_nagoya.historical import generate_event

if TYPE_CHECKING:
    import pytest_mock


@pytest.mark.parametrize("key", list(EVENTS))
def test_event_keys_match_dates(key: str) -> None:
    event = EVENTS[key]
    assert event.key == key
    assert event.date.year in (2019, 2023)
    assert event.station == "名古屋"


def test_event_lookup_failure() -> None:
    with pytest.raises(ValueError, match="Unknown historical event"):
        generate_event("no-such-event")


def test_generate_all_mocks(mocker: pytest_mock.MockerFixture, tmp_path: Path) -> None:
    mock = mocker.patch("flood_nagoya.historical.generate")
    mock.return_value = tmp_path / "dummy.json"
    paths = generate_all(tmp_path)
    assert len(paths) == len(EVENTS)
    assert mock.call_count == len(EVENTS)
    calls = [call.args for call in mock.call_args_list]
    dates = {call[0] for call in calls}
    assert dates == {e.date for e in EVENTS.values()}


def test_generate_event_mocks(mocker: pytest_mock.MockerFixture, tmp_path: Path) -> None:
    mock = mocker.patch("flood_nagoya.historical.generate")
    mock.return_value = tmp_path / "dummy.json"
    path = generate_event("hagibis-2019", tmp_path)
    assert path == tmp_path / "dummy.json"
    mock.assert_called_once_with(date(2019, 10, 12), "名古屋", tmp_path)

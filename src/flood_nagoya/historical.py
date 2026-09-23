"""Known historical rainfall events for Nagoya (AMeDAS 名古屋).

This module is a thin catalogue over :mod:`flood_nagoya.amedas`.  It gives
convenient names and descriptions for disaster-reproduction cases so that
users do not have to remember exact dates.  Each event is still fetched from
JMA ``etrn`` hourly data, so the resulting scenario reflects the actual
observed rainfall at AMeDAS Nagoya.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from .amedas import generate

__all__ = ["EVENTS", "HistoricalEvent", "generate_all", "generate_event"]


@dataclass(frozen=True)
class HistoricalEvent:
    """A named historical rainfall case."""

    key: str
    date: date
    name: str
    desc: str
    station: str = "名古屋"


EVENTS: dict[str, HistoricalEvent] = {
    "hagibis-2019": HistoricalEvent(
        key="hagibis-2019",
        date=date(2019, 10, 12),
        name="令和元年東日本台風(台風19号)",
        desc="2019年10月12日の名古屋地点観測雨量。東海地方で河川氾濫・低地浸水被害。",
    ),
    "meiyu-2023": HistoricalEvent(
        key="meiyu-2023",
        date=date(2023, 6, 30),
        name="令和5年6月末 梅雨前線豪雨",
        desc="2023年6月30日の名古屋地点観測雨量。東海・北陸で線状降水帯による集中豪雨。",
    ),
    "july-2023": HistoricalEvent(
        key="july-2023",
        date=date(2023, 7, 13),
        name="令和5年7月 梅雨前線通過雨",
        desc="2023年7月13日の名古屋地点観測雨量。東海地方で局地的な大雨・冠水。",
    ),
}


def generate_event(key: str, out_dir: Path | None = None) -> Path:
    """Generate an AMeDAS scenario for a named historical event.

    Args:
        key: one of the keys in :data:`EVENTS`.
        out_dir: directory for the scenario JSON (default ``web/scenarios``).

    Returns:
        Path to the written scenario JSON.
    """
    try:
        event = EVENTS[key]
    except KeyError as exc:
        msg = f"Unknown historical event '{key}'. Known: {', '.join(EVENTS)}"
        raise ValueError(msg) from exc
    return generate(event.date, event.station, out_dir)


def generate_all(out_dir: Path | None = None) -> list[Path]:
    """Generate scenarios for every known historical event."""
    return [generate_event(key, out_dir) for key in EVENTS]

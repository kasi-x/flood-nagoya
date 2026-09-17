"""Interface for ``python -m flood_nagoya``."""

from __future__ import annotations

from argparse import ArgumentParser
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from . import __version__

__all__ = ["main"]


def main(args: Sequence[str] | None = None) -> None:
    """Argument parser for the CLI."""
    parser = ArgumentParser(prog="flood-nagoya", description=__doc__)
    parser.add_argument("-v", "--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("download-dem", help="名古屋市域のGSI dem5a (5m) タイルを取得する")
    sub.add_parser("build", help="DEM+建物からWebアプリ用タイル/オーバービューを生成する")
    sub.add_parser("serve", help="Webアプリをローカル配信する")

    rain = sub.add_parser(
        "rain-scenario",
        help="AMeDAS観測降雨からハイエトグラフシナリオJSONを生成する",
    )
    rain.add_argument("--date", required=True, help="対象日 (YYYY-MM-DD)")
    rain.add_argument("--station", default="名古屋", help="AMeDAS地点名 (既定: 名古屋)")
    rain.add_argument("--out", type=Path, default=None, help="出力先ディレクトリ (既定: web/scenarios)")

    xrain = sub.add_parser(
        "xrain-scenario",
        help="XRAINレーダー画像から空間分布付き降雨シナリオを生成する (直近~8日のみ)",
    )
    xrain.add_argument("--date", required=True, help="対象日 (YYYY-MM-DD)")
    xrain.add_argument("--level", type=int, default=3, choices=[1, 2, 3], help="XRAIN表示レベル (既定: 3)")
    xrain.add_argument("--out", type=Path, default=None, help="出力先ディレクトリ (既定: web/scenarios)")

    msm = sub.add_parser(
        "msm-scenario",
        help="JMA MSM + AMeDAS較正で過去の空間分布降雨シナリオを生成する (XRAIN保持期限切れの日付用)",
    )
    msm.add_argument("--date", required=True, help="対象日 (YYYY-MM-DD)")
    msm.add_argument("--station", default="名古屋", help="較正に使うAMeDAS地点名 (既定: 名古屋)")
    msm.add_argument("--out", type=Path, default=None, help="出力先ディレクトリ (既定: web/scenarios)")

    parsed = parser.parse_args(args)
    if parsed.command == "download-dem":
        from .gsitiles import download_bbox  # noqa: PLC0415 - keep CLI startup fast

        download_bbox()
    elif parsed.command == "build":
        from .pipeline import build  # noqa: PLC0415 - keep CLI startup fast

        build()
    elif parsed.command == "serve":
        from .server import serve  # noqa: PLC0415 - keep CLI startup fast

        serve()
    elif parsed.command == "rain-scenario":
        from .amedas import generate  # noqa: PLC0415 - keep CLI startup fast

        day = date.fromisoformat(parsed.date)
        path = generate(day, parsed.station, parsed.out)
        print(f"scenario written: {path}")
    elif parsed.command == "xrain-scenario":
        from .xrain import build_day_scenario  # noqa: PLC0415 - keep CLI startup fast

        day = date.fromisoformat(parsed.date)
        path = build_day_scenario(day, parsed.level, parsed.out)
        print(f"scenario written: {path}")
    elif parsed.command == "msm-scenario":
        from .msm import build_day_scenario  # noqa: PLC0415 - keep CLI startup fast

        day = date.fromisoformat(parsed.date)
        path = build_day_scenario(day, parsed.station, parsed.out)
        print(f"scenario written: {path}")


if __name__ == "__main__":
    main()

"""Interface for ``python -m flood_nagoya``."""

from __future__ import annotations

from argparse import ArgumentParser
from argparse import Namespace
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from . import __version__

__all__ = ["main"]


def _historical_event_keys() -> list[str]:
    """Return the keys known by the historical-scenario command."""
    from .historical import EVENTS  # noqa: PLC0415 - keep CLI startup fast

    return list(EVENTS)


def _generate_date_scenario(command: str, parsed: Namespace) -> None:
    """Dispatch the observed-rain scenario generators (date-based commands)."""
    day = date.fromisoformat(parsed.date)
    if command == "rain-scenario":
        from .amedas import generate  # noqa: PLC0415 - keep CLI startup fast

        path = generate(day, parsed.station, parsed.out)
    elif command == "xrain-scenario":
        from .xrain import build_day_scenario  # noqa: PLC0415 - keep CLI startup fast

        path = build_day_scenario(day, parsed.level, parsed.out)
    else:
        from .msm import build_day_scenario  # noqa: PLC0415 - keep CLI startup fast

        path = build_day_scenario(day, parsed.station, parsed.out)
    print(f"scenario written: {path}")


def _build_parser() -> ArgumentParser:
    """Build the CLI argument parser."""
    parser = ArgumentParser(prog="flood-nagoya", description=__doc__)
    parser.add_argument("-v", "--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("download-dem", help="名古屋市域のGSI dem5a (5m) タイルを取得する")
    sub.add_parser("build", help="DEM+建物からWebアプリ用タイル/オーバービューを生成する")

    serve_cmd = sub.add_parser("serve", help="Webアプリをローカル配信する")
    serve_cmd.add_argument(
        "--host", default="127.0.0.1", help="バインドアドレス (既定: 127.0.0.1 / コンテナでは0.0.0.0)"
    )
    serve_cmd.add_argument("--port", type=int, default=8642, help="ポート番号 (既定: 8642)")
    serve_cmd.add_argument("--open", action="store_true", help="起動後にブラウザを開く")

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

    prec = sub.add_parser(
        "precompute",
        help="浸水シミュレーションを事前計算し、Webアプリ用リプレイデータを生成する (既定: 栄)",
    )
    prec.add_argument("--out", type=Path, default=None, help="出力先 (既定: web/precomputed/sakai)")
    prec.add_argument("--scenario", default=None, help="降雨シナリオJSON名 (既定: AMeDAS 2026-09-08)")
    prec.add_argument("--lon", type=float, default=None, help="ボックス中心の経度 (既定: 栄)")
    prec.add_argument("--lat", type=float, default=None, help="ボックス中心の緯度 (既定: 栄)")
    prec.add_argument("--label", default=None, help="UI表示用の地域名 (既定: 栄)")
    prec.add_argument(
        "--streams-only",
        action="store_true",
        help="浸水フレームを再計算せず、分水域オーバーレイ (streams.png) のみ再生成する",
    )
    prec.add_argument(
        "--sea-level",
        type=float,
        default=0.0,
        help="高潮・風浪による海面水位上昇 [m] (既定: 0)。海側境界セルの水位を強制する",
    )
    prec.add_argument(
        "--underground",
        action="store_true",
        help="名古屋駅・栄地下街などの簡易地下空間内水氾濫モデルを有効にする",
    )
    prec.add_argument(
        "--river",
        action="store_true",
        help="1D河道モデル (集水域→流量→水位→氾濫原への溢水) を有効にする",
    )

    hist = sub.add_parser(
        "historical-scenario",
        help="指定した既往災害のAMeDAS降雨シナリオを生成する",
    )
    hist.add_argument(
        "event",
        choices=list(_historical_event_keys()),
        help="既往災害イベントID",
    )
    hist.add_argument("--out", type=Path, default=None, help="出力先ディレクトリ (既定: web/scenarios)")

    hist_all = sub.add_parser(
        "historical-scenarios",
        help="全ての既往災害AMeDAS降雨シナリオを生成する",
    )
    hist_all.add_argument("--out", type=Path, default=None, help="出力先ディレクトリ (既定: web/scenarios)")

    val = sub.add_parser(
        "validate",
        help="衛星観測 (SWOT/NISAR/Sentinel-1) と事前計算済み浸水範囲を比較する",
    )
    val.add_argument("--region", type=Path, required=True, help="precomputedリージョンのディレクトリ (meta.jsonを含む)")
    val.add_argument("--swot", type=Path, default=None, help="SWOT L2 raster .nc (事後)")
    val.add_argument(
        "--swot-pre",
        type=Path,
        default=None,
        help="SWOT L2 raster .nc (事前ベースライン、常水差し引き用)",
    )
    val.add_argument("--nisar-pre", type=Path, default=None, help="NISAR GCOV .h5 (事前)")
    val.add_argument("--nisar-post", type=Path, default=None, help="NISAR GCOV .h5 (事後)")
    val.add_argument("--s1-pre", type=Path, default=None, help="Sentinel-1 GRD SAFE展開済みdir (事前)")
    val.add_argument("--s1-post", type=Path, default=None, help="Sentinel-1 GRD SAFE展開済みdir (事後)")
    val.add_argument("--out", type=Path, default=None, help="出力先 (既定: reports/satellite/<region名>)")

    return parser


def _dispatch(parsed: Namespace) -> None:  # noqa: C901 - one branch per subcommand
    """Run the command selected by the parsed arguments."""
    if parsed.command == "download-dem":
        from .gsitiles import download_bbox  # noqa: PLC0415 - keep CLI startup fast

        download_bbox()
    elif parsed.command == "build":
        from .pipeline import build  # noqa: PLC0415 - keep CLI startup fast

        build()
    elif parsed.command == "serve":
        from .server import serve  # noqa: PLC0415 - keep CLI startup fast

        serve(host=parsed.host, port=parsed.port, open_browser=parsed.open)
    elif parsed.command in ("rain-scenario", "xrain-scenario", "msm-scenario"):
        _generate_date_scenario(parsed.command, parsed)
    elif parsed.command == "historical-scenario":
        from .historical import generate_event  # noqa: PLC0415 - keep CLI startup fast

        path = generate_event(parsed.event, parsed.out)
        print(f"scenario written: {path}")
    elif parsed.command == "historical-scenarios":
        from .historical import generate_all  # noqa: PLC0415 - keep CLI startup fast

        for path in generate_all(parsed.out):
            print(f"scenario written: {path}")
    elif parsed.command == "precompute":
        from .precompute import SCENARIO  # noqa: PLC0415 - keep CLI startup fast
        from .precompute import precompute  # noqa: PLC0415 - keep CLI startup fast

        precompute(
            out_dir=parsed.out,
            scenario_file=parsed.scenario or SCENARIO,
            lon=parsed.lon,
            lat=parsed.lat,
            label=parsed.label,
            streams_only=parsed.streams_only,
            sea_level_m=parsed.sea_level,
            underground=parsed.underground,
            river=parsed.river,
        )
    elif parsed.command == "validate":
        from .validate import run_validation  # noqa: PLC0415 - keep CLI startup fast
        from .validate import summarize  # noqa: PLC0415

        nisar_pair = (parsed.nisar_pre, parsed.nisar_post) if parsed.nisar_pre and parsed.nisar_post else None
        s1_pair = (parsed.s1_pre, parsed.s1_post) if parsed.s1_pre and parsed.s1_post else None
        out = parsed.out or Path("reports/satellite") / parsed.region.name
        results = run_validation(
            parsed.region / "meta.json",
            parsed.region,
            swot_nc=parsed.swot,
            swot_pre_nc=parsed.swot_pre,
            nisar_pair=nisar_pair,
            s1_pair=s1_pair,
            out_dir=out,
        )
        for name, res in results.items():
            print(f"{name}: {summarize(res)}")


def main(args: Sequence[str] | None = None) -> None:
    """Argument parser for the CLI."""
    parser = _build_parser()
    parsed = parser.parse_args(args)
    _dispatch(parsed)


if __name__ == "__main__":
    main()

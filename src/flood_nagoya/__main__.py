"""Interface for ``python -m flood_nagoya``."""

from __future__ import annotations

from argparse import ArgumentParser
from collections.abc import Sequence

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


if __name__ == "__main__":
    main()

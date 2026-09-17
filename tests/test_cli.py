import subprocess
import sys

from flood_nagoya import __version__


def test_cli_version() -> None:
    cmd = [sys.executable, "-m", "flood_nagoya", "--version"]
    assert subprocess.check_output(cmd).decode().strip() == __version__

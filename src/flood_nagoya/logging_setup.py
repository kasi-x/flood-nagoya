
"""ロギング設定 (structlog)。

既定は人間向けの開発表示、`LOG_FORMAT=json` で cron / systemd / 集約ログ向けの
JSON に切り替えられる。

    from flood_nagoya.logging_setup import logger

    logger = logger.bind(task_id="T-123")
    logger.info("job_done", chunks=3)
"""

from __future__ import annotations

import logging
import os
import sys
import structlog

_configured = False



def setup_logging(format_: str | None = None, level: str = "INFO") -> None:
    """プロセス起動時に一度だけ呼ぶ。既に設定済みなら何もしない。"""
    global _configured
    if _configured:
        return

    fmt = (format_ or os.environ.get("LOG_FORMAT") or "console").lower()
    processors: list[structlog.typing.Processor] = [
        structlog.contextvars.merge_contextvars,

        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    if fmt == "json":
        processors.append(structlog.processors.JSONRenderer(ensure_ascii=False))
    else:
        processors.append(structlog.processors.StackInfoRenderer())
        processors.append(structlog.dev.ConsoleRenderer(colors=fmt == "dev" and _stdout_is_tty()))

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(int(getattr(logging, level.upper(), logging.INFO))),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )
    _configured = True


def _stdout_is_tty() -> bool:
    try:
        return bool(os.isatty(1))
    except Exception:  # noqa: BLE001
        return False



def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """設定を行い、bound logger を返す。"""
    setup_logging()
    return structlog.stdlib.get_logger(name)


# Module-level logger: `from flood_nagoya.logging_setup import logger`
logger = get_logger()

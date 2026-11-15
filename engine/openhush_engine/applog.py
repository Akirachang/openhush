"""Log full details (including tracebacks) to ~/Library/Logs/OpenHush/engine.log."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from .tools import LOG_DIR


def setup_logging() -> None:
    logger = logging.getLogger("openhush")
    if logger.handlers:
        return
    logger.setLevel(logging.INFO)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(LOG_DIR / "engine.log", maxBytes=2_000_000, backupCount=2)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(threadName)s: %(message)s"))
        logger.addHandler(handler)
    except OSError:
        logger.addHandler(logging.NullHandler())

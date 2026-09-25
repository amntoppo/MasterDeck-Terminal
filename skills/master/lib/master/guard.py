# lib/master/guard.py
from __future__ import annotations

from typing import Callable

from . import config

REFUSAL = "refused: master CLI writes are only allowed from the master-agent session or a plain terminal"


def check(environ: dict, agents_loader: Callable[[], list]) -> "str | None":
    """Return None when a write is allowed, else the refusal message.

    A plain terminal or the MasterBar app (no CLAUDECODE env var) is always allowed.
    Inside a Claude Code session, the caller's CLAUDE_CODE_SESSION_ID must match the
    sessionId of the single row named config.MASTER_NAME in `claude agents --json`
    (loaded via agents_loader so this is unit-testable). Anything that prevents that
    comparison — the loader raising or returning something that isn't a list of dicts,
    no master row found, or more than one row named master (ambiguous) — fails closed
    (refused).
    """
    if environ.get("CLAUDECODE") != "1":
        return None
    session_id = environ.get("CLAUDE_CODE_SESSION_ID")
    try:
        agents = agents_loader()
        master_rows = [a for a in agents if isinstance(a, dict) and a.get("name") == config.MASTER_NAME]
    except Exception:
        return REFUSAL
    if len(master_rows) != 1:
        return REFUSAL
    master_id = master_rows[0].get("sessionId")
    if master_id is None or session_id != master_id:
        return REFUSAL
    return None

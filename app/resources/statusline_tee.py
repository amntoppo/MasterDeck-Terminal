#!/usr/bin/env python3
"""MasterDeck status line hook.

Claude Code runs the status line command with a JSON description of the session on stdin
(cost, context window, model, workspace). This script saves that JSON to
<MASTERDECK_HOME>/stats/<session_id>.json for MasterDeck, then runs the status line command
that was configured before MasterDeck took over (saved in statusline-original.json) with the
same stdin, and prints its output. It never fails the status line: every error is swallowed.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SESSION_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")


def home() -> Path:
    return Path(os.environ.get("MASTERDECK_HOME", str(Path.home() / ".claude" / "masterdeck")))


def save(raw: str) -> None:
    data = json.loads(raw)
    sid = data.get("session_id") if isinstance(data, dict) else None
    if not isinstance(sid, str) or not SESSION_ID.match(sid):
        return
    d = home() / "stats"
    d.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(d), prefix=".tmp-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(raw)
    os.replace(tmp, str(d / f"{sid}.json"))


def original_command() -> "str | None":
    try:
        cmd = json.loads((home() / "statusline-original.json").read_text(encoding="utf-8")).get("command")
    except (OSError, ValueError, AttributeError):
        return None
    return cmd if isinstance(cmd, str) and cmd.strip() else None


def main() -> int:
    raw = sys.stdin.read()
    try:
        save(raw)
    except Exception:
        pass
    cmd = original_command()
    if cmd:
        try:
            r = subprocess.run(cmd, shell=True, input=raw, capture_output=True, text=True, timeout=10)
            sys.stdout.write(r.stdout)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

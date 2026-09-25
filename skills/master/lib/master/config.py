# lib/master/config.py
"""Per-user settings: which GitHub org, issue repo and project board, the board's status names,
and where master works. One JSON file, `~/.claude/master/config.json`, shared by the master CLI,
babysit-ticket's tt.sh and the MasterDeck app. MasterDeck's Setup screen writes it; so does
`master config save`. `MASTER_CONFIG` points somewhere else (tests use it).

The module-level names (OWNER, PROJECT, DONE_STATUSES, ...) are read once at import.
"""
from __future__ import annotations

import json
import os
from datetime import timedelta
from pathlib import Path

STALE_AFTER = timedelta(hours=4)

# A board built from GitHub's default "Team planning" template uses Todo / In Progress / Done.
# Setup replaces these with the real board's options.
DEFAULTS: dict = {
    "version": 1,
    "owner": "",
    # "organization" or "user": which kind of account owns the repos and the project board.
    "ownerType": "organization",
    "issueRepo": "",
    "project": 0,
    "projectId": "",
    "statusFieldId": "",
    "statusOptions": {},
    "columns": ["Todo", "In Progress", "In Review", "Done"],
    "statuses": {
        "ready": "Todo",
        "inProgress": "In Progress",
        "prRaised": "In Review",
        "devDone": "Done",
        "blocked": ["Blocked"],
        "done": ["Done"],
        # Fully finished: hidden from a session's pick list (tt.sh candidates). Usually past QA.
        "finished": ["Done"],
        "assignable": ["Todo"],
        "resumable": ["In Progress", "In Review"],
        # Automatic moves only go up this order. Names not listed rank by their column position.
        "rank": {},
    },
    "sprintQuery": "is:issue assignee:@me sprint:@current",
    # The board's iteration field (sprints); boards without one simply have no sprints.
    "sprintField": "Sprint",
    "workspace": str(Path.home() / "Documents"),
    "masterName": "master-agent",
}


def master_home() -> Path:
    return Path(os.environ.get("MASTER_HOME", str(Path.home() / ".claude" / "master")))


def config_path() -> Path:
    return Path(os.environ.get("MASTER_CONFIG", str(master_home() / "config.json")))


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict) and k not in ("statusOptions", "rank"):
            out[k] = _merge(base[k], v)
        else:
            out[k] = v
    return out


def load(path: "Path | None" = None) -> dict:
    """The saved config over the defaults. A missing or broken file gives the defaults."""
    try:
        saved = json.loads((path or config_path()).read_text())
    except (OSError, ValueError):
        saved = {}
    return _merge(DEFAULTS, saved if isinstance(saved, dict) else {})


def is_configured(cfg: dict) -> bool:
    return bool(cfg.get("owner") and cfg.get("issueRepo"))


def rank(cfg: dict, status: str) -> int:
    """Board order for forward-only moves: the explicit rank, else the column position, else -1."""
    r = cfg["statuses"].get("rank") or {}
    if status in r:
        return int(r[status])
    cols = cfg.get("columns") or []
    return cols.index(status) if status in cols else -1


CONFIG = load()

OWNER: str = CONFIG["owner"]
OWNER_TYPE: str = "user" if CONFIG.get("ownerType") == "user" else "organization"
# GitHub search qualifier for everything the owner has: org:acme or user:alice.
OWNER_QUALIFIER: str = f"{'user' if OWNER_TYPE == 'user' else 'org'}:{OWNER}"
SPRINT_FIELD: str = CONFIG.get("sprintField") or "Sprint"
PROJECT: int = int(CONFIG["project"] or 0)
ISSUE_REPO: str = CONFIG["issueRepo"]
MASTER_NAME: str = CONFIG["masterName"]
STATUSES: dict = CONFIG["statuses"]
DONE_STATUSES = set(STATUSES["done"])
ASSIGNABLE_STATUSES = set(STATUSES["assignable"])
RESUMABLE_STATUSES = set(STATUSES["resumable"])
READY_STATUS: str = STATUSES["ready"]
IN_PROGRESS_STATUS: str = STATUSES["inProgress"]
BOARD_COLUMNS: list = list(CONFIG["columns"])
BOARD_SPRINT_QUERY: str = CONFIG["sprintQuery"]


def workspace() -> Path:
    return Path(os.path.expanduser(os.environ.get("MASTER_WORKSPACE") or CONFIG["workspace"]))


def issue_ref() -> str:
    """How the issue repo is named in messages: owner/repo."""
    return f"{OWNER}/{ISSUE_REPO}"

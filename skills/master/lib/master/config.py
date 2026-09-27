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
    # False: no master-agent session. MasterDeck and the CLI still work; new sessions report to
    # the user in their own session instead of messaging master.
    "masterEnabled": True,
    # Several repositories and project boards. Repos are "owner/name"; each project carries its own
    # status field, options, columns and status meanings. Empty lists mean the single issueRepo and
    # project above (configs from before). The first repo is the primary one: a bare issue number
    # (#12, in the ledger and babysit-ticket's state) means an issue there. allRepos/allProjects:
    # the user chose "Select all" (every repo counts, not only the listed ones).
    "repos": [],
    "allRepos": False,
    "projects": [],
    "allProjects": False,
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


REPO_RE = r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}"


def primary_repo(cfg: "dict | None" = None) -> str:
    """owner/name of the primary issue repo: bare issue numbers mean an issue there."""
    cfg = cfg or CONFIG
    return f"{cfg['owner']}/{cfg['issueRepo']}" if cfg.get("owner") and cfg.get("issueRepo") else ""


def repos(cfg: "dict | None" = None) -> list:
    """The selected repositories (owner/name), primary first."""
    import re
    cfg = cfg or CONFIG
    listed = [r for r in cfg.get("repos") or [] if isinstance(r, str) and re.fullmatch(REPO_RE, r)]
    prim = primary_repo(cfg)
    out = ([prim] if prim else []) + [r for r in listed if r.lower() != prim.lower()]
    return out


def repo_allowed(repo: "str | None", cfg: "dict | None" = None) -> bool:
    """Is a ticket in this repo one of ours? Every repo when the user selected all."""
    cfg = cfg or CONFIG
    if not repo or cfg.get("allRepos"):
        return True
    return repo.lower() in {r.lower() for r in repos(cfg)}


def _project(p: dict, cfg: dict) -> "dict | None":
    if not isinstance(p, dict) or not isinstance(p.get("number"), int) or p["number"] <= 0:
        return None
    owner = p.get("owner") or cfg.get("owner")
    if not owner:
        return None
    return {
        "owner": owner,
        "ownerType": "user" if p.get("ownerType") == "user" else "organization",
        "number": p["number"],
        "id": p.get("id") or "",
        "title": p.get("title") or f"Project {p['number']}",
        "statusField": p.get("statusField") or "Status",
        "statusFieldId": p.get("statusFieldId") or "",
        "statusOptions": dict(p.get("statusOptions") or {}),
        "columns": list(p.get("columns") or []),
        "statuses": _merge(DEFAULTS["statuses"], p.get("statuses") or {}),
        "sprintField": p.get("sprintField") if isinstance(p.get("sprintField"), str) else "Sprint",
    }


def projects(cfg: "dict | None" = None) -> list:
    """The selected project boards, each with its own statuses. Older configs: the one project."""
    cfg = cfg or CONFIG
    listed = [x for x in (_project(p, cfg) for p in cfg.get("projects") or []) if x]
    if listed:
        return listed
    if int(cfg.get("project") or 0) > 0:
        legacy = _project({"owner": cfg.get("owner"), "ownerType": cfg.get("ownerType"), "number": int(cfg["project"]),
                           "id": cfg.get("projectId"), "statusFieldId": cfg.get("statusFieldId"),
                           "statusOptions": cfg.get("statusOptions"), "columns": cfg.get("columns"),
                           "statuses": cfg.get("statuses"), "sprintField": cfg.get("sprintField")}, cfg)
        return [legacy] if legacy else []
    return []


def project_key(p: dict) -> str:
    return f"{p['owner']}/{p['number']}"


def project_by_key(key: "str | None", cfg: "dict | None" = None) -> "dict | None":
    return next((p for p in projects(cfg) if project_key(p) == key), None)


def statuses_for(key: "str | None") -> dict:
    """A project's status meanings; the global ones for items with no known project."""
    p = project_by_key(key)
    return p["statuses"] if p else STATUSES


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


def master_enabled() -> bool:
    return CONFIG.get("masterEnabled", True) is not False


def issue_ref() -> str:
    """How the issue repo is named in messages: owner/repo."""
    return f"{OWNER}/{ISSUE_REPO}"

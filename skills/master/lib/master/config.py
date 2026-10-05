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
import re
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


def _repos_of(cfg: dict) -> list:
    listed = [r for r in cfg.get("repos") or [] if isinstance(r, str) and re.fullmatch(REPO_RE, r)]
    prim = primary_repo(cfg)
    return ([prim] if prim else []) + [r for r in listed if r.lower() != prim.lower()]


def repos(cfg: "dict | None" = None) -> list:
    """The selected repositories (owner/name), primary first; with accounts, every account's (the primary's first)."""
    cfg = cfg or CONFIG
    union = [r for v in (accounts(cfg) if cfg.get("accounts") else []) for r in v["repos"]]
    return union or _repos_of(cfg)


def repo_allowed(repo: "str | None", cfg: "dict | None" = None) -> bool:
    """Is a ticket in this repo one of ours? Every repo when the user selected all (on any account)."""
    cfg = cfg or CONFIG
    if not repo or cfg.get("allRepos"):
        return True
    if cfg.get("accounts") and any(v["allRepos"] for v in accounts(cfg)):
        return True
    return repo.lower() in {r.lower() for r in repos(cfg)}


def repo_readable(repo: "str | None", cfg: "dict | None" = None) -> bool:
    """May `master repo-issues` read this repository? Stricter than repo_allowed, because the name
    comes from outside (a Board tab, also one in a paired browser): a repository listed under any
    account, or, not listed, one whose owner is the owner of an account that itself has "Select
    all" (no accounts: the config's owner with its "Select all"). Another account's "Select all"
    never opens this account's owner, and a login is no owner (the app's repoPickable)."""
    cfg = cfg or CONFIG
    if not repo or not re.fullmatch(REPO_RE, repo):
        return False
    if repo.lower() in {r.lower() for r in repos(cfg)}:
        return True
    owner = repo.split("/", 1)[0].lower()
    if cfg.get("accounts"):
        return any(v["allRepos"] and v["owner"].lower() == owner for v in accounts(cfg))
    return cfg.get("allRepos") is True and str(cfg.get("owner") or "").lower() == owner


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
        # A board MasterDeck created: no sprint field. Only present when set, so older boards read as before.
        **({"sprintless": True} if p.get("sprintless") is True else {}),
    }


def _projects_of(cfg: dict) -> list:
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


def projects(cfg: "dict | None" = None) -> list:
    """The selected project boards, each with its own statuses; with accounts, every account's.
    Older configs: the one project."""
    cfg = cfg or CONFIG
    if cfg.get("accounts"):
        seen, out = set(), []
        for v in accounts(cfg):
            for p in _projects_of(v):
                if project_key(p) not in seen:
                    seen.add(project_key(p))
                    out.append(p)
        if out:
            return out
    return _projects_of(cfg)


def project_key(p: dict) -> str:
    return f"{p['owner']}/{p['number']}"


def project_by_key(key: "str | None", cfg: "dict | None" = None) -> "dict | None":
    return next((p for p in projects(cfg) if project_key(p) == key), None)


LOGIN_RE = r"[A-Za-z0-9-]{1,39}"


def account_view(a: dict) -> dict:
    """One account as a config of its own (owner, repos, boards): what repos()/projects() read for it."""
    return {"login": a["login"], "primary": a.get("primary") is True,
            "name": str(a.get("name") or a["login"]), "email": str(a.get("email") or ""),
            "owner": a.get("owner") or "", "ownerType": "user" if a.get("ownerType") == "user" else "organization",
            "issueRepo": a.get("issueRepo") or "",
            "repos": [r for r in a.get("repos") or [] if isinstance(r, str) and re.fullmatch(REPO_RE, r)],
            "allRepos": a.get("allRepos") is True,
            "projects": [p for p in a.get("projects") or [] if isinstance(p, dict)],
            "allProjects": a.get("allProjects") is True,
            # Where this account's checkouts live; "" = the config's workspace.
            "workspace": a["workspace"] if isinstance(a.get("workspace"), str) else ""}


def accounts(cfg: "dict | None" = None) -> list:
    """Connected GitHub accounts (MasterDeck's Setup writes them), the primary first, each login
    once. A repo belongs to the first account that lists it; later accounts lose it."""
    cfg = cfg or CONFIG
    raw = [a for a in cfg.get("accounts") or [] if isinstance(a, dict) and isinstance(a.get("login"), str)
           and re.fullmatch(LOGIN_RE, a["login"])]
    raw.sort(key=lambda a: 0 if a.get("primary") is True else 1)
    out: list = []
    owner_of: dict = {}
    for a in raw:
        if any(v["login"].lower() == a["login"].lower() for v in out):
            continue
        v = account_view(a)
        kept = []
        for r in _repos_of(v):
            if r.lower() not in owner_of:
                owner_of[r.lower()] = v["login"]
                kept.append(r)
        v["repos"] = kept
        v["primary"] = not out
        out.append(v)
    return out


def is_multi(cfg: "dict | None" = None) -> bool:
    """Multi-account mode: two or more connected accounts. The one place to ask; with one account
    everything behaves as before."""
    return len(accounts(cfg)) >= 2


# An account (with one account: the whole config) that has repositories but no project board. The
# Board then shows its repositories' issues in these columns, which MasterDeck works out itself
# and stores nowhere on GitHub.
DERIVED_COLUMNS = ["Todo", "In Dev", "PR Raised", "Done"]
DERIVED_STATUSES: dict = {
    "ready": "Todo", "inProgress": "In Dev", "prRaised": "PR Raised", "devDone": "Done",
    "blocked": [], "done": ["Done"], "finished": ["Done"], "assignable": ["Todo"],
    "resumable": ["In Dev", "PR Raised"], "rank": {},
}
DERIVED_DONE_DAYS = 14    # a closed issue stays in Done this long
DERIVED_MAX_CARDS = 300   # open issues shown per account
DERIVED_MAX_DONE = 50     # closed issues shown per account
DERIVED_MAX_REPOS = 10    # repositories read per account (one GraphQL query covers them)


def boardless(cfg: "dict | None" = None) -> bool:
    """Repositories but no project board: one account's view, or the whole config."""
    return bool(repos(cfg)) and not projects(cfg)


def sprintless(key: "str | None") -> bool:
    """A board with no sprint field that MasterDeck created: the sprint filter does not apply to it."""
    p = project_by_key(key)
    return bool(p and p.get("sprintless"))


def masterdeck_home() -> Path:
    """MasterDeck's folder (ticket links, session accounts, account settings); MASTERDECK_HOME overrides it."""
    return Path(os.environ.get("MASTERDECK_HOME") or Path.home() / ".claude" / "masterdeck")


def session_account(session_id: str) -> "str | None":
    """The connected login MasterDeck recorded a session as (session-accounts.json); None when
    unrecorded, the file is missing or broken, or the login is no longer connected."""
    try:
        login = json.loads((masterdeck_home() / "session-accounts.json").read_text()).get(session_id)
    except (OSError, ValueError, AttributeError):
        return None
    return login if isinstance(login, str) and any(a["login"] == login for a in accounts()) else None


def superseded_ids() -> set:
    """Ids (bg ids and session ids) of sessions a copy replaced (superseded-sessions.json, written by
    MasterDeck and `master spawn`): the old side of a resume as another account. Missing or broken: none."""
    try:
        ids = json.loads((masterdeck_home() / "superseded-sessions.json").read_text())
    except (OSError, ValueError):
        return set()
    return {x for x in ids if isinstance(x, str)} if isinstance(ids, list) else set()


def match_repo(repo: "str | None", cfg: "dict | None" = None) -> "str | None":
    """The account listing `repo` (None = the primary repo), or whose "Select all" org owns it; None
    when no account does, or with one account (the app's matchRepo)."""
    if not is_multi(cfg):
        return None
    views = accounts(cfg)
    r = (repo or primary_repo(cfg)).lower()
    for v in views:
        if r in {x.lower() for x in v["repos"]}:
            return v["login"]
    owner = r.split("/", 1)[0]
    for v in views:
        if v["allRepos"] and v["owner"].lower() == owner:
            return v["login"]
    return None


def account_for_repo(repo: "str | None", cfg: "dict | None" = None) -> "str | None":
    """The login a spawned session for an issue in `repo` works as (None = the primary repo): its
    account, else the primary. Only with two or more accounts: with one, sessions start as before."""
    if not is_multi(cfg):
        return None
    return match_repo(repo, cfg) or accounts(cfg)[0]["login"]


# https://github.com/o/r, git@<host or ssh alias>:o/r, ssh://git@<host or alias>/o/r (the app's repoFromRemote).
_REMOTE_RE = re.compile(r"^(?:https?://(?:[^@/\s]+@)?github\.com/|ssh://[^@/\s]+@[^/\s]+/|[^@/\s]+@[^:/\s]+:)"
                        r"([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$")


def origin_repo(cwd: str, runner=None) -> "str | None":
    """owner/name of the folder's `origin` remote; None when it has none or it is not GitHub."""
    import subprocess
    try:
        r = (runner or subprocess.run)(["git", "-C", cwd, "remote", "get-url", "origin"],
                                       capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = _REMOTE_RE.match(r.stdout.strip()) if r.returncode == 0 else None
    return f"{m.group(1)}/{m.group(2)}" if m else None


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


def workspace_for(repo: "str | None", cfg: "dict | None" = None) -> Path:
    """The workspace of the account a ticket in `repo` belongs to (None = the primary issue repo):
    the account that lists the repo, else the primary; an account without one of its own, and a
    config without accounts, use the config's workspace. MASTER_WORKSPACE overrides them all."""
    cfg = cfg or CONFIG
    views = accounts(cfg)
    login = match_repo(repo, cfg)
    view = next((v for v in views if v["login"] == login), views[0] if views else None)
    own = view["workspace"] if view else ""
    return Path(os.path.expanduser(os.environ.get("MASTER_WORKSPACE") or own or cfg["workspace"]))


def master_enabled() -> bool:
    return CONFIG.get("masterEnabled", True) is not False


def issue_ref() -> str:
    """How the issue repo is named in messages: owner/repo."""
    return f"{OWNER}/{ISSUE_REPO}"

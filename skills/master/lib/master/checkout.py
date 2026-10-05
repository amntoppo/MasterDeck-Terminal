"""Where a ticket's session starts: the checkout of the ticket's repository when there is one under
its account's workspace, else that workspace. The one place that decides it: master's ASSIGN
proposals (`rules._assign`), the app's Start dialog (`master draft-assign`), its PR review sessions
(`master checkout`), and `master add` / `master spawn` for ticket work that names no folder.

A checkout is a folder with a `.git` folder whose `origin` is the repository, compared without
case. The origin is read from `.git/config` (no process); git itself is asked (`config.origin_repo`,
which also applies insteadOf rewrites) only for an origin the file does not spell out, and at most
MAX_GIT_CALLS times a scan. A linked worktree (a `.git` file) is another ticket's working copy, not
the checkout: it is never picked and never looked into.

Note: this reads the filesystem, so `rules.propose` (through `_assign`) does too.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

from . import config

MAX_FOLDERS = 2000   # folders looked at per scan (a stat each), the workspace included
MAX_GIT_CALLS = 20   # `git remote get-url` runs per scan, 5 s each at most
TTL = 60.0           # seconds a scan is remembered
TICKET_KINDS = ("ASSIGN", "PRREVIEW")

# ponytail: remembered in this process only (one sweep proposes for many issues; the app asks once
# per Start dialog, in a new process each time). A scan is a stat per folder and a small file read
# per checkout; if that gets slow on a huge workspace, keep the map in a file under master_home()
# and re-scan on a miss.
_seen: dict = {}


def forget() -> None:
    _seen.clear()


def _kind(d: str) -> str:
    """"checkout" (a `.git` folder), "worktree" (a `.git` file: a linked worktree or a submodule) or "plain"."""
    g = os.path.join(d, ".git")
    return "checkout" if os.path.isdir(g) else "worktree" if os.path.isfile(g) else "plain"


_SECTION = re.compile(r'^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]')
_URL = re.compile(r"^\s*url\s*=\s*(.*?)\s*$", re.I)


def _config_origin(d: str) -> "tuple[str | None, bool]":
    """(owner/name of `origin` as `.git/config` spells it, whether git must be asked instead).
    git is needed when the file has no origin url but includes other files, or the url is not a
    full URL (it may be an insteadOf alias like `gh:acme/api`). A full URL of another host is
    simply not GitHub."""
    try:
        text = Path(d, ".git", "config").read_text(errors="replace")
    except OSError:
        return None, False
    url, here, includes = None, False, False
    for line in text.splitlines():
        m = _SECTION.match(line)
        if m:
            here = m.group(1).lower() == "remote" and m.group(2) == "origin"
            includes = includes or m.group(1).lower() in ("include", "includeif")
            continue
        u = _URL.match(line) if here and url is None else None
        if u:
            url = u.group(1).strip('"')
    if url is None:
        return None, includes
    m = config._REMOTE_RE.match(url)
    if m:
        return f"{m.group(1)}/{m.group(2)}", False
    return None, not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", url)


def _folders(parent: str, root: str) -> list:
    """Sub-folders of `parent`, by name; hidden ones and links leading out of `root` left out."""
    try:
        names = sorted(e.name for e in os.scandir(parent) if not e.name.startswith(".") and e.is_dir())
    except OSError:
        return []
    return [d for d in (os.path.join(parent, n) for n in names) if _inside(d, root)]


def _inside(d: str, root: str) -> bool:
    real = os.path.realpath(d)
    return real != root and real.startswith(root + os.sep)


def _rank(folder: str, repo: str, depth: int) -> tuple:
    """Among several checkouts of one repository: the folder named after it, then the nearest, then
    the shortest path (then by name, so the pick never depends on listing order)."""
    return (os.path.basename(folder).lower() != repo.split("/", 1)[1].lower(), depth, len(folder), folder)


def scan(ws: "Path | str", git=None, now=time.monotonic) -> dict:
    """The checkouts in a workspace: `repos` {owner/name in lower case: folder}, `searched` (folders
    looked at) and `partial` (a limit was reached: the answer may miss some). Looked at: the
    workspace itself, its sub-folders, and the sub-folders of those that are plain folders (an
    `acme/` folder of clones)."""
    ws = str(ws)
    root = os.path.realpath(ws)
    hit = _seen.get(root)
    if hit and now() - hit[0] < TTL:
        return hit[1]
    git = git or config.origin_repo
    best: dict = {}
    n = {"searched": 0, "git": 0}
    partial = [False]

    def look(d: str, depth: int) -> "str | None":
        """What `d` is (see _kind); None: the folder limit is reached."""
        if n["searched"] >= MAX_FOLDERS:
            partial[0] = True
            return None
        n["searched"] += 1
        kind = _kind(d)
        if kind != "checkout":
            return kind
        repo, ask = _config_origin(d)
        if ask:
            if n["git"] >= MAX_GIT_CALLS:
                partial[0] = True
            else:
                n["git"] += 1
                repo = git(d)
        if repo:
            rank = _rank(d, repo, depth)
            if repo.lower() not in best or rank < best[repo.lower()]:
                best[repo.lower()] = rank
        return kind

    if os.path.isdir(root):
        look(ws, 0)
        plain = []
        for d in _folders(ws, root):
            kind = look(d, 1)
            if kind is None:
                break
            if kind == "plain":
                plain.append(d)
        for d in plain:
            if partial[0] and n["searched"] >= MAX_FOLDERS:
                break
            if any(look(e, 2) is None for e in _folders(d, root)):
                break
    out = {"repos": {k: v[3] for k, v in best.items()}, "searched": n["searched"], "partial": partial[0]}
    _seen[root] = (now(), out)
    return out


def _named(ws: str, full: str) -> "str | None":
    """The usual case with one directory read and no scan: the workspace named after the repository,
    or its sub-folder of that name (any case, as spelled on disk), when its `.git/config` says it is
    the repository. The same pick a scan makes (`_rank`)."""
    name = full.split("/", 1)[1].lower()
    if name.startswith("."):
        return None
    root = os.path.realpath(ws)
    try:
        subs = sorted(e for e in os.listdir(ws) if e.lower() == name)
    except OSError:
        return None
    tries = ([ws] if os.path.basename(ws.rstrip(os.sep)).lower() == name else []) + \
        [d for d in (os.path.join(ws, e) for e in subs) if _inside(d, root)]
    for d in tries:
        if _kind(d) == "checkout" and (_config_origin(d)[0] or "").lower() == full.lower():
            return d
    return None


def resolve(repo: "str | None", cwd: "str | None" = None, cfg: "dict | None" = None) -> dict:
    """Where a session for a ticket in `repo` starts (None = the primary issue repo).
    `cwd`: the checkout when `found`, else the account's `workspace`. A folder the user chose is
    passed as `cwd` and used as it is; `found` then says whether it is a checkout of the repo.
    Not found after a search that hit a limit: also `partial` and `searched` (folders looked at)."""
    full = repo or config.primary_repo(cfg)
    ws = str(config.workspace_for(repo, cfg))
    if cwd:
        return {"cwd": cwd, "workspace": ws, "repo": full,
                "found": bool(full) and (config.origin_repo(cwd) or "").lower() == full.lower()}
    if not full:
        return {"cwd": ws, "workspace": ws, "repo": full, "found": False}
    hit = _named(ws, full)
    if hit:
        return {"cwd": hit, "workspace": ws, "repo": full, "found": True}
    got = scan(ws)
    hit = got["repos"].get(full.lower())
    out = {"cwd": hit or ws, "workspace": ws, "repo": full, "found": bool(hit)}
    if not hit and got["partial"]:
        out.update(partial=True, searched=got["searched"])
    return out


def default_cwd(kind: str, issue, repo: "str | None") -> str:
    """The folder of a proposal that names none: ticket work (an ASSIGN or a PR review for a real
    issue) starts where `resolve` says; anything else (a meeting, a chat, issue 0) in the
    workspace, as it always did."""
    if kind in TICKET_KINDS and isinstance(issue, int) and issue > 0:
        return resolve(repo)["cwd"]
    return str(config.workspace())


def branch_of(d: str) -> str:
    """The branch a main checkout is on, read from `.git/HEAD` (no process); "" for a detached
    HEAD, a linked worktree or a folder that is no checkout."""
    try:
        head = Path(d, ".git", "HEAD").read_text().strip()
    except OSError:
        return ""
    return head[len("ref: refs/heads/"):] if head.startswith("ref: refs/heads/") else ""


def is_workspace(d: str, cfg: "dict | None" = None) -> bool:
    """Is `d` the config's workspace or an account's own?"""
    all_ws = [config.workspace()] + [Path(os.path.expanduser(v["workspace"])) for v in config.accounts(cfg) if v["workspace"]]
    real = os.path.realpath(d)
    return any(os.path.realpath(str(w)) == real for w in all_ws)


def parked(kind: str, cwd: str, name: str) -> "dict | None":
    """What to remember of a ticket session about to start in `cwd`: a folder that is not a
    workspace, most often the repository's main checkout, on whatever branch was left checked
    out there. That branch (and its open PR) is not the session's; MasterDeck reads this record
    (`parked-sessions.json`) and keeps the two apart until the session has its own worktree or
    branch. None: nothing to remember (not ticket work, or a workspace)."""
    if kind not in TICKET_KINDS or is_workspace(cwd):
        return None
    return {"dir": cwd, "branch": branch_of(cwd), "review": kind == "PRREVIEW", "name": name}

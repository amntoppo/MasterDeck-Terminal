"""Where a ticket's session starts: the checkout of the ticket's repository when there is one under
its account's workspace, else that workspace. The one place that decides it: master's ASSIGN
proposals (`rules._assign`), the app's Start dialog (`master draft-assign`), its PR review sessions
(`master checkout`), and `master add` / `master spawn` for a proposal that names no folder.

A checkout is a folder with a `.git` folder whose `origin` is the repository (`config.origin_repo`:
https, ssh, a host alias, after git's own insteadOf rewrites), compared without case. A linked
worktree (a `.git` file) is another ticket's working copy, not the checkout, and is never picked.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from . import config

MAX_FOLDERS = 200  # folders looked at per scan, the workspace included
TTL = 60.0         # seconds a scan is remembered

# ponytail: remembered in this process only (one sweep proposes for many issues; the app asks once
# per Start dialog, in a new process each time). A scan is one stat per folder and one `git remote
# get-url` per checkout; if that gets slow on a huge workspace, keep the map in a file under
# master_home() and re-scan on a miss.
_seen: dict = {}


def forget() -> None:
    _seen.clear()


def _folders(parent: str, root: str) -> list:
    """Sub-folders of `parent`, by name; hidden ones and links leading out of `root` left out."""
    try:
        names = sorted(e.name for e in os.scandir(parent) if not e.name.startswith(".") and e.is_dir())
    except OSError:
        return []
    out = []
    for n in names:
        d = os.path.join(parent, n)
        real = os.path.realpath(d)
        if real != root and real.startswith(root + os.sep):
            out.append(d)
    return out


def scan(ws: "Path | str", origin=None, now=time.monotonic) -> dict:
    """{owner/name in lower case: folder} of the checkouts in a workspace: the workspace itself, its
    sub-folders, and the sub-folders of those that are not checkouts themselves (an `acme/` folder
    of clones). The nearest one wins. At most MAX_FOLDERS folders are looked at."""
    ws = str(ws)
    root = os.path.realpath(ws)
    hit = _seen.get(root)
    if hit and now() - hit[0] < TTL:
        return hit[1]
    origin = origin or config.origin_repo
    found: dict = {}
    left = [MAX_FOLDERS]

    def look(d: str) -> "bool | None":
        """Is `d` a checkout? None: the limit is reached."""
        if left[0] <= 0:
            return None
        left[0] -= 1
        if not os.path.isdir(os.path.join(d, ".git")):
            return False
        repo = origin(d)
        if repo:
            found.setdefault(repo.lower(), d)
        return True

    if os.path.isdir(root):
        look(ws)
        plain = []
        for d in _folders(ws, root):
            is_checkout = look(d)
            if is_checkout is None:
                break
            if not is_checkout:
                plain.append(d)
        for d in plain:
            if left[0] <= 0 or any(look(e) is None for e in _folders(d, root)):
                break
    _seen[root] = (now(), found)
    return found


def resolve(repo: "str | None", cwd: "str | None" = None, cfg: "dict | None" = None) -> dict:
    """Where a session for a ticket in `repo` starts (None = the primary issue repo).
    `cwd`: the checkout when `found`, else the account's `workspace`. A folder the user chose is
    passed as `cwd` and used as it is; `found` then says whether it is a checkout of the repo."""
    full = repo or config.primary_repo(cfg)
    ws = str(config.workspace_for(repo, cfg))
    if cwd:
        return {"cwd": cwd, "workspace": ws, "repo": full,
                "found": bool(full) and (config.origin_repo(cwd) or "").lower() == full.lower()}
    hit = scan(ws).get(full.lower()) if full else None
    return {"cwd": hit or ws, "workspace": ws, "repo": full, "found": bool(hit)}

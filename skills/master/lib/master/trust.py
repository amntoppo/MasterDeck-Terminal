"""Whether Claude Code has been allowed to work in a folder: its trust prompt was accepted there.

`claude --bg` refuses to start a session in a folder where it was not ("Workspace not trusted.
Run `claude` in <folder> once and accept the trust prompt, then retry."). Claude Code records the
answer in its own `.claude.json`, under `projects["<folder>"].hasTrustDialogAccepted`, and looks
at the folder and its parents: inside a git repository up to and including the repository's root
(the first folder with a `.git`), outside one all the way up. So a sub-folder of a trusted
repository is trusted, a plain folder under a trusted parent is trusted, and a repository under a
trusted plain parent is not (a ticket's checkout under a trusted workspace).

The one place that reads it, for the Start dialog's draft (`master draft-assign`), PR review
sessions (`master checkout`) and the app's re-check while the user accepts the prompt (`master
trust`). Read only: accepting the prompt is Claude Code's own, done by the user in `claude`.
The answer is True, False, or None when it is not known (no file, one that cannot be read or
parsed, too large, not the expected shape, a folder that is not there, a linked worktree that is
not listed): never True on a guess, and never False on one either (the app holds Start back on
False).
"""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from pathlib import Path

MAX_BYTES = 8 * 1024 * 1024  # far above any real one; larger than this is not read
EVERY = 2.0                   # seconds between two looks while waiting
MAX_WAIT = 60.0

# Claude Code's refusal, loosely: the wording around it may change.
_NOT_TRUSTED = re.compile(r"workspace\s+(?:is\s+not|isn['’]?t|not)\s+trusted", re.I)


def not_trusted(text: "str | None") -> bool:
    """Is this failure Claude Code refusing a folder it was not allowed to work in? (The app has
    the same matcher, `shared/trust.ts`; both are tested on the same sentence.)"""
    return bool(text) and bool(_NOT_TRUSTED.search(text))


def claude_json() -> Path:
    """Claude Code's own config file: in the home folder, or in CLAUDE_CONFIG_DIR when that is set."""
    d = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(d) if d else Path(os.path.expanduser("~"))) / ".claude.json"


def _stamp(path: Path) -> "tuple | None":
    """What tells a rewrite: time, size and file (a rename puts a new file there). None: no file."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


def _projects(path: Path, max_bytes: int = MAX_BYTES) -> "dict | None":
    try:
        if os.stat(path).st_size > max_bytes:
            return None
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):  # ValueError: not JSON, or not UTF-8
        return None
    got = data.get("projects") if isinstance(data, dict) else None
    return got if isinstance(got, dict) else None


def _spelled(p: str) -> str:
    """A path as Claude Code keys it: forward slashes, no trailing one, composed characters;
    Windows does not tell upper from lower case."""
    p = unicodedata.normalize("NFC", p).replace("\\", "/")
    p = p.rstrip("/") or "/"
    return p.lower() if os.name == "nt" else p


def _walk(folder: str) -> "tuple[list, bool] | None":
    """The folders Claude Code looks at for `folder` (real paths: it never sees a link), and
    whether the walk ended at a linked worktree or submodule (a `.git` file). None: no such folder."""
    try:
        real = os.path.realpath(folder)
    except (OSError, ValueError):
        return None
    if not folder or not os.path.isdir(real):
        return None
    out, d = [], real
    while True:
        out.append(d)
        g = os.path.join(d, ".git")
        if os.path.isdir(g):
            return out, False
        if os.path.isfile(g):
            return out, True
        up = os.path.dirname(d)
        if up == d:
            return out, False
        d = up


def trusted(folder: str, path: "Path | None" = None, max_bytes: int = MAX_BYTES) -> "bool | None":
    """True: the trust prompt was accepted for this folder or a parent Claude Code counts (see the
    module text), each compared by its real path with the keys as they are stored. False: the file
    is readable and says so for none of them. None: not known."""
    projects = _projects(path or claude_json(), max_bytes)
    if projects is None:
        return None
    walk = _walk(folder)
    if walk is None:
        return None
    mine = {_spelled(d) for d in walk[0]}
    if any(isinstance(k, str) and _spelled(k) in mine and isinstance(v, dict) and v.get("hasTrustDialogAccepted") is True
           for k, v in projects.items()):
        return True
    # A linked worktree: Claude Code may go by its main repository. Not a no, then.
    return None if walk[1] else False


def wait(folder: str, seconds: float, path: "Path | None" = None, sleep=time.sleep, clock=time.monotonic) -> "bool | None":
    """`trusted`, looked at again every two seconds until it is True or `seconds` are over. The file
    is read at once, then only after it changed (time, size or file): a rewrite that changes none
    of them is seen by the caller's next call, which reads again."""
    path = path or claude_json()
    seen = _stamp(path)
    got = trusted(folder, path)
    end = clock() + min(max(seconds, 0.0), MAX_WAIT)
    while got is not True and clock() < end:
        sleep(EVERY)
        now = _stamp(path)
        if now != seen:
            seen, got = now, trusted(folder, path)
    return got

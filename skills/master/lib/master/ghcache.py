# lib/master/ghcache.py
"""One shared cache in front of `gh`, for master's sweep, the babysit skills and MasterDeck.

GitHub allows 5,000 GraphQL points an hour plus a secondary limit on bursts, shared by every
`gh` call on the machine. Many sessions polling the same data used to spend it many times over.
`ghc` (this module's CLI) takes the same arguments as `gh` and:

- caches reads for a short TTL in ~/.claude/gh-cache (keyed by the arguments, plus the working
  directory for commands that infer the repo from it), so identical reads within the TTL make
  one call;
- single-flights concurrent identical reads (a per-key lock: the second caller waits and reuses);
- passes writes straight through and drops the cached reads they could have changed;
- keeps one shared pause: after a rate-limit error every caller stops calling GitHub until the
  limit resets, and reads get the last cached answer (any age) instead.

Only successful reads are cached. Output (stdout, stderr, exit code) is exactly what gh printed.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

try:
    import fcntl  # POSIX only; without it (Windows) calls go straight to gh, uncached
except ImportError:  # pragma: no cover
    fcntl = None

DEFAULT_TTL = 60
PAUSE_SECONDS = 600
RATE_LIMITED = re.compile(r"rate limit|secondary rate|abuse detection|unknown owner type", re.I)

# Subcommands that only read. Everything else (create, edit, merge, review, comment, checkout,
# item-edit, ...) is treated as a write.
READ_SUBCOMMANDS = {
    "pr": {"view", "list", "checks", "diff", "status"},
    "issue": {"view", "list", "status"},
    "project": {"item-list", "field-list", "list", "view"},
    "repo": {"view", "list"},
    "run": {"view", "list"},
    "search": None,  # every search subcommand reads
    "release": {"view", "list"},
    "label": {"list"},
}
# Commands whose repo comes from the working directory unless -R/--repo is given.
CWD_SCOPED = {"pr", "issue", "repo", "run", "release", "label"}


def cache_dir() -> Path:
    d = Path(os.environ.get("GH_CACHE_DIR", str(Path.home() / ".claude" / "gh-cache")))
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def _has_repo_flag(args: list) -> bool:
    return any(a in ("-R", "--repo") or a.startswith("--repo=") for a in args)


def _api_method(args: list) -> str:
    for i, a in enumerate(args):
        if a in ("-X", "--method") and i + 1 < len(args):
            return args[i + 1].upper()
        if a.startswith("--method="):
            return a.split("=", 1)[1].upper()
    # gh api switches to POST when fields or input are given.
    fields = any(a in ("-f", "-F", "--field", "--raw-field", "--input") or a.startswith(("--field=", "--raw-field="))
                 for a in args)
    return "POST" if fields else "GET"


def is_read(args: list) -> bool:
    """Would `gh <args>` only read? GraphQL is a read unless the query is a mutation."""
    if not args:
        return False
    cmd = args[0]
    if cmd == "api":
        if len(args) > 1 and args[1] == "graphql":
            return not any("mutation" in a for a in args[2:])
        return _api_method(args[1:]) == "GET"
    subs = READ_SUBCOMMANDS.get(cmd, set())
    if subs is None:
        return True
    return len(args) > 1 and args[1] in subs


def cacheable(args: list) -> bool:
    """Reads that can be replayed: no stdin input, no watching, no paging through a pager."""
    if not is_read(args):
        return False
    return not any(a in ("--input", "--watch", "-w", "--web") for a in args)


def categories(args: list) -> set:
    """What a call touches, for invalidation: project, pr, issue, or all when unknown."""
    text = " ".join(args).lower()
    cats = set()
    cmd = args[0] if args else ""
    if cmd == "project" or "projectv2" in text or "projectitems" in text or "item-edit" in text:
        cats.add("project")
    if cmd == "pr" or "pullrequest" in text or "/pulls" in text:
        cats.add("pr")
    if cmd == "issue" or re.search(r"\bissue\(|/issues\b|closeissue|linkedbranch", text):
        cats.add("issue")
    if "issue" in cats:
        cats.add("project")  # the board shows issues' assignees, labels and state
    return cats or {"all"}


def cache_key(args: list, cwd: str) -> str:
    scoped = args and args[0] in CWD_SCOPED and not _has_repo_flag(args)
    material = {"args": args, "cwd": cwd if scoped else None, "repo": os.environ.get("GH_REPO") if scoped else None}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:32]


# --- pause -------------------------------------------------------------------------------------

def _pause_path() -> Path:
    return cache_dir() / "paused.json"


def paused_until(now: float) -> float:
    try:
        until = float(json.loads(_pause_path().read_text()).get("until", 0))
    except (OSError, ValueError, AttributeError):
        return 0.0
    return until if until > now else 0.0


def pause(now: float, seconds: float = PAUSE_SECONDS, reason: str = "") -> None:
    until = max(paused_until(now), now + seconds)
    _write_json(_pause_path(), {"until": until, "reason": reason[:300], "at": now})


# --- stats ------------------------------------------------------------------------------------

def bump(stat: str) -> None:
    """Hit/miss/stale/write counters for MasterDeck's display (best effort)."""
    p = cache_dir() / "stats.json"
    if fcntl is None:
        return
    try:
        with open(cache_dir() / "stats.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                data = json.loads(p.read_text())
            except (OSError, ValueError):
                data = {}
            day = time.strftime("%Y-%m-%d")
            if data.get("day") != day:
                data = {"day": day}
            data[stat] = int(data.get(stat, 0)) + 1
            _write_json(p, data)
    except OSError:
        pass


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# --- the call ---------------------------------------------------------------------------------

def _entry_path(key: str) -> Path:
    return cache_dir() / f"{key}.json"


def _read_entry(key: str):
    try:
        return json.loads(_entry_path(key).read_text())
    except (OSError, ValueError):
        return None


def invalidate(cats: set) -> None:
    for f in cache_dir().glob("*.json"):
        if f.name in ("paused.json", "stats.json"):
            continue
        try:
            entry = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        # A write drops the reads it can touch; an uncategorised write drops everything. Reads we
        # couldn't categorise (e.g. `api user`) are left to expire with their short TTL.
        if "all" in cats or set(entry.get("cats", [])) & cats:
            try:
                f.unlink()
            except OSError:
                pass


def prune(max_age: float = 86_400, now: float | None = None) -> None:
    now = now or time.time()
    for f in cache_dir().glob("*.json"):
        if f.name in ("paused.json", "stats.json"):
            continue
        try:
            if now - f.stat().st_mtime > max_age:
                f.unlink()
        except OSError:
            pass


def _gh_binary() -> str:
    return os.environ.get("GHC_GH", "gh")


def _run_gh(args: list, stdin: bytes | None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run([_gh_binary(), *args], input=stdin, capture_output=True, timeout=180)
    except FileNotFoundError:
        return subprocess.CompletedProcess(args, 127, b"", b"ghc: gh not found on PATH\n")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, b"", b"ghc: gh timed out\n")


def run(args: list, ttl: float = DEFAULT_TTL, cwd: str | None = None, stdin: bytes | None = None,
        now_fn=time.time, force: bool = False) -> "tuple[int, bytes, bytes]":
    """`gh <args>` through the shared cache. Returns (exit code, stdout, stderr).

    `force` (or GHC_FORCE=1) skips answers cached before this call, for a manual refresh; the new
    answer is still cached, and a caller already fetching the same read is waited for, not repeated.
    """
    cwd = cwd or os.getcwd()
    force = force or os.environ.get("GHC_FORCE") == "1"
    started = now_fn()
    if fcntl is None:
        res = _run_gh(args, stdin)
        return res.returncode, res.stdout, res.stderr
    if not cacheable(args) or ttl <= 0 or stdin:
        # Writes (and uncacheable reads) go straight through; writes drop what they may change.
        res = _run_gh(args, stdin)
        if RATE_LIMITED.search((res.stderr or b"").decode(errors="replace")) and res.returncode != 0:
            pause(now_fn(), reason=res.stderr.decode(errors="replace"))
        if not is_read(args) and res.returncode == 0:
            invalidate(categories(args))
            bump("write")
        return res.returncode, res.stdout, res.stderr

    key = cache_key(args, cwd)

    def fresh(entry) -> bool:
        if entry is None or (force and entry.get("at", 0) < started):
            return False
        return now_fn() - entry.get("at", 0) < ttl

    entry = _read_entry(key)
    if fresh(entry):
        bump("hit")
        return 0, entry["stdout"].encode(), entry.get("stderr", "").encode()

    with open(cache_dir() / f"{key}.lock", "w") as lock:
        # Single flight: whoever holds the lock fetches; the rest find its answer when they get in.
        fcntl.flock(lock, fcntl.LOCK_EX)
        entry = _read_entry(key)
        if fresh(entry):
            bump("hit")
            return 0, entry["stdout"].encode(), entry.get("stderr", "").encode()
        until = paused_until(now_fn())
        if until:
            when = time.strftime("%H:%M", time.localtime(until))
            if entry is not None:
                bump("stale")
                note = f"ghc: GitHub paused until {when} (rate limit); served the cached answer from " \
                       f"{time.strftime('%H:%M', time.localtime(entry.get('at', 0)))}\n"
                return 0, entry["stdout"].encode(), note.encode()
            bump("blocked")
            return 1, b"", f"ghc: GitHub API rate limit: calls paused until {when}, nothing cached for this\n".encode()
        res = _run_gh(args, None)
        err = (res.stderr or b"").decode(errors="replace")
        if res.returncode == 0:
            _write_json(_entry_path(key), {"at": now_fn(), "args": args, "cats": sorted(categories(args)),
                                            "stdout": res.stdout.decode(errors="replace"), "stderr": err})
            bump("miss")
        elif RATE_LIMITED.search(err):
            pause(now_fn(), reason=err)
            if entry is not None:
                bump("stale")
                return 0, entry["stdout"].encode(), b"ghc: GitHub rate limit hit; served the last cached answer\n"
        if hash(key) % 100 == 0:
            prune()
        return res.returncode, res.stdout, res.stderr


def main(argv: "list | None" = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    ttl = float(os.environ.get("GHC_TTL", DEFAULT_TTL))
    while argv and argv[0].startswith("--") and argv[0] in ("--ttl", "--no-cache", "--status", "--"):
        flag = argv.pop(0)
        if flag == "--":
            break
        if flag == "--ttl":
            ttl = float(argv.pop(0))
        elif flag == "--no-cache":
            ttl = 0
        elif flag == "--status":
            now = time.time()
            until = paused_until(now)
            try:
                stats = json.loads((cache_dir() / "stats.json").read_text())
            except (OSError, ValueError):
                stats = {}
            print(json.dumps({"paused_until": until or None, "stats": stats}))
            return 0
    if argv and argv[0] == "gh":
        argv = argv[1:]
    code, out, err = run(argv, ttl=ttl, stdin=None if sys.stdin.isatty() or not _wants_stdin(argv) else sys.stdin.buffer.read())
    sys.stdout.buffer.write(out)
    sys.stderr.buffer.write(err)
    return code


def _wants_stdin(args: list) -> bool:
    for i, a in enumerate(args):
        if a == "--input" and i + 1 < len(args) and args[i + 1] == "-":
            return True
        if a in ("-F", "--field") and i + 1 < len(args) and args[i + 1].endswith("=@-"):
            return True
    return False


if __name__ == "__main__":
    sys.exit(main())

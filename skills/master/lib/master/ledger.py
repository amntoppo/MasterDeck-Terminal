# lib/master/ledger.py
from __future__ import annotations

import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from . import config

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt

TRANSITIONS = {
    "proposed": {"approved", "rejected"},
    "approved": {"sent", "rejected", "held"},
    "sent": {"done", "blocked", "held", "question"},
    "held": {"sent", "rejected"},
    "blocked": {"sent", "done", "rejected"},
    "question": {"sent", "done", "blocked", "rejected", "question"},  # a second question replaces the note
    "done": {"question", "sent"},  # a finished session can get a follow-up question or new work
    "rejected": set(),
}


def empty() -> dict:
    return {
        "cursor": {"snapshot_at": None, "meetings_since": None},
        "last_snapshot": None,
        "next_id": 1,
        "proposals": [],
        "acked": [],
    }


def ledger_path() -> Path:
    return config.master_home() / "ledger.json"


def load(path: Path | None = None) -> dict:
    path = path or ledger_path()
    if not path.exists():
        return empty()
    led = json.loads(path.read_text())
    led.setdefault("acked", [])
    return led


def save(led: dict, path: Path | None = None) -> None:
    path = path or ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(led, f, indent=2)
    os.replace(tmp, path)


@contextmanager
def file_lock(directory: Path | None = None):
    directory = directory or config.master_home()
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / "ledger.lock", "a+") as lf:
        _lock(lf)
        try:
            yield
        finally:
            _unlock(lf)


def _lock(f) -> None:
    if fcntl:
        fcntl.flock(f, fcntl.LOCK_EX)
        return
    f.seek(0)  # msvcrt locks bytes from the current position
    while True:
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError:
            time.sleep(0.05)


def _unlock(f) -> None:
    if fcntl:
        fcntl.flock(f, fcntl.LOCK_UN)
        return
    f.seek(0)
    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)


@contextmanager
def locked(path: Path | None = None):
    """Load, yield, save — all under the lock. A raising block saves nothing."""
    path = path or ledger_path()
    with file_lock(path.parent):
        led = load(path)
        yield led
        save(led, path)


def add(led: dict, *, kind: str, issue: int, source: str, target: dict,
        message: str, summary: str, now: str) -> dict | None:
    key = (kind, issue, source)
    if any((p["kind"], p["issue"], p["source"]) == key for p in led["proposals"]):
        return None
    p = {
        "id": led["next_id"], "kind": kind, "issue": issue, "source": source,
        "target": target, "message": message, "summary": summary,
        "status": "proposed", "created_at": now, "decided_at": None,
        "sent_at": None, "closed_at": None, "note": None,
    }
    led["next_id"] += 1
    led["proposals"].append(p)
    return p


def get(led: dict, pid: int) -> dict:
    for p in led["proposals"]:
        if p["id"] == pid:
            return p
    raise KeyError(f"no proposal {pid}")


def transition(led: dict, pid: int, to: str, *, now: str, note: str | None = None) -> dict:
    p = get(led, pid)
    if to not in TRANSITIONS[p["status"]]:
        raise ValueError(f"proposal {pid}: {p['status']} -> {to} is not allowed")
    if p["status"] == "done":
        p["closed_at"] = None
    p["status"] = to
    if to in ("approved", "rejected") and p["decided_at"] is None:
        p["decided_at"] = now
    if to == "sent":
        p["sent_at"] = now
    if to in ("done", "rejected"):
        p["closed_at"] = now
    if note is not None:
        p["note"] = note
    return p


def set_note(led: dict, pid: int, note: str) -> dict:
    p = get(led, pid)
    p["note"] = note
    return p

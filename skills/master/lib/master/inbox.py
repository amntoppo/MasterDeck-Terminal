from __future__ import annotations

import json
import time

from . import config, ledger

INBOX = "inbox.jsonl"
OUTBOX = "outbox.jsonl"


def read(name: str) -> list:
    path = config.master_home() / name
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and "id" in entry:
            out.append(entry)
    return out


def _append(name: str, rec: dict) -> dict:
    # The ledger lock also serialises id allocation here. Never call this from inside
    # ledger.locked(): flock would deadlock against the lock this process already holds.
    with ledger.file_lock():
        path = config.master_home() / name
        # max(), not len(): read() silently drops a corrupt/malformed line, and counting
        # survivors instead of the highest id actually written would reuse an id.
        next_id = max((e["id"] for e in read(name)), default=0) + 1
        entry = {"id": next_id, **rec}
        with path.open("a") as f:
            f.write(json.dumps(entry) + "\n")
    return entry


def _require(entry_id: int) -> None:
    if not any(e["id"] == entry_id for e in read(INBOX)):
        raise KeyError(f"no inbox entry {entry_id}")


def say(text: str, *, now: str, kind: str = "say", to: "str | None" = None) -> dict:
    if to is not None:
        return _append(INBOX, {"at": now, "kind": "send", "to": to, "text": text})
    return _append(INBOX, {"at": now, "kind": kind, "text": text})


def reply(in_reply_to: int, text: str, *, now: str) -> dict:
    _require(in_reply_to)
    return _append(OUTBOX, {"at": now, "in_reply_to": in_reply_to, "text": text})


def ack(entry_id: int) -> None:
    _require(entry_id)
    with ledger.locked() as led:
        if entry_id not in led["acked"]:
            led["acked"].append(entry_id)


def _one_line(text: str, replacement: str) -> str:
    # Order matters: collapse "\r\n" first so it becomes one replacement, not two.
    return text.replace("\r\n", replacement).replace("\r", replacement).replace("\n", replacement)


def _inbox_line(e: dict) -> str:
    text = _one_line(e.get("text") or "", " ⏎ ")
    if e.get("kind") == "send":
        return f"inbox {e['id']} send → {e.get('to')}: {text}"
    return f"inbox {e['id']} {e.get('kind', 'say')}" + (f": {text}" if text else "")


def watch_lines(led: dict, seen: set) -> list:
    acked = set(led.get("acked", []))
    out = []
    for e in read(INBOX):
        key = f"inbox:{e['id']}"
        if e["id"] not in acked and key not in seen:
            seen.add(key)
            out.append(_inbox_line(e))
    for p in led["proposals"]:
        key = f"approved:{p['id']}"
        if p["status"] == "approved" and key not in seen:
            seen.add(key)
            summary = _one_line(p["summary"], " ")
            out.append(f"approved {p['id']} {p['kind']} #{p['issue']}: {summary}")
    return out


def _print(line: str) -> None:
    print(line, flush=True)


def watch(*, interval: float = 1.0, iterations: "int | None" = None, sleep=time.sleep, out=_print) -> None:
    seen: set = set()
    i = 0
    while iterations is None or i < iterations:
        for line in watch_lines(ledger.load(), seen):
            out(line)
        i += 1
        if iterations is None or i < iterations:
            sleep(interval)

from __future__ import annotations

import json
import re
import subprocess
import uuid
from pathlib import Path

from . import config, ledger

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# A model alias (opus, sonnet[1m]) or full name (claude-opus-5-5); never an option.
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$")


class SpawnError(RuntimeError):
    pass


def validate_name(name: "str | None") -> "str | None":
    if not name or not NAME_RE.fullmatch(name):
        return f"invalid session name: {name!r}"
    return None


def validate_prompt(prompt: "str | None") -> "str | None":
    if not prompt or not prompt.strip():
        return "prompt must not be empty"
    if prompt.lstrip().startswith("-"):
        return f"prompt must not start with '-': {prompt!r}"
    return None


def validate_model(model: "str | None") -> "str | None":
    if model is not None and not MODEL_RE.fullmatch(model):
        return f"invalid model: {model!r}"
    return None


def validate_resume(resume: "str | None") -> "str | None":
    try:
        if str(uuid.UUID(resume)) != resume.lower():
            return f"invalid resume id: {resume!r}"
    except (ValueError, AttributeError, TypeError):
        return f"invalid resume id: {resume!r}"
    return None


def validate_spawn_target(sp: dict) -> "str | None":
    """Validate a `target["spawn"]` dict. Returns None when valid, else the reason."""
    if sp.get("resume"):
        return validate_resume(sp["resume"])
    err = validate_name(sp.get("name")) or validate_model(sp.get("model"))
    if err:
        return err
    return validate_prompt(sp.get("prompt"))


def command(target: dict) -> list:
    sp = target["spawn"]
    err = validate_spawn_target(sp)
    if err:
        raise SpawnError(err)
    if sp.get("resume"):
        return ["claude", "--bg", "--resume", sp["resume"]]
    model = ["--model", sp["model"]] if sp.get("model") else []
    return ["claude", "--bg", "-n", sp["name"], *model, sp["prompt"]]


def running(session_id: str, runner=subprocess.run) -> bool:
    """Whether `claude agents` shows a live process for this session. `claude --bg --resume` on a
    running session starts a copy, so a resume checks first. Unknown counts as not running."""
    try:
        r = runner(["claude", "agents", "--json"], capture_output=True, text=True, timeout=30)
        rows = json.loads(r.stdout) if r.returncode == 0 else []
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False
    return isinstance(rows, list) and any(
        isinstance(x, dict) and x.get("sessionId") == session_id and x.get("pid") for x in rows)


def spawn(led: dict, pid: int, *, now: str, runner=subprocess.run) -> dict:
    p = ledger.get(led, pid)
    if "spawn" not in p["target"]:
        raise SpawnError(f"proposal {pid} targets a session; send it with SendMessage")
    if p["status"] not in ("approved", "held"):
        raise SpawnError(f"proposal {pid} is {p['status']}, not approved")

    def hold(note: str) -> None:
        # A failure moves an approved proposal to held so a re-armed watch never re-emits
        # it (watch_lines only emits "approved"). An already-held proposal just gets a
        # fresher note — held -> held is not a transition ledger.TRANSITIONS allows.
        if p["status"] == "held":
            ledger.set_note(led, pid, note)
        else:
            ledger.transition(led, pid, "held", now=now, note=note)

    cwd = p["target"]["spawn"].get("cwd") or str(config.workspace())
    if not Path(cwd).is_dir():
        note = f"cwd does not exist: {cwd}"
        hold(note)
        raise SpawnError(f"proposal {pid}: {note}")
    try:
        cmd = command(p["target"])
    except (KeyError, ValueError, SpawnError) as e:
        note = str(e)
        hold(note)
        raise SpawnError(f"proposal {pid}: {note}")
    resume = p["target"]["spawn"].get("resume")
    if resume and running(resume, runner):
        # Resumed already (MasterDeck's Resume all, or by hand): the session is working again.
        return ledger.transition(led, pid, "sent", now=now, note="already running; not resumed again")
    try:
        r = runner(cmd, cwd=cwd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        note = ("claude --bg did not return within 60 s and may still have started a session; "
                "check `claude agents` before retrying")
        hold(note)
        raise SpawnError(f"proposal {pid}: {note}")
    except OSError as e:
        note = str(e)
        hold(note)
        raise SpawnError(f"proposal {pid}: {note}")
    if r.returncode != 0:
        err = (r.stderr or r.stdout or f"exit {r.returncode}").strip()[:500]
        hold(err)
        raise SpawnError(f"proposal {pid}: {err}")
    return ledger.transition(led, pid, "sent", now=now, note=(r.stdout or "").strip()[:200])

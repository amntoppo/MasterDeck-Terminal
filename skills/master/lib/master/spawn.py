from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

from . import checkout, config, ledger, trust

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# A model alias (opus, sonnet[1m]) or full name (claude-opus-5-5); never an option.
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$")
ACCOUNT_RE = re.compile(rf"^{config.LOGIN_RE}$")


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


def validate_account(account: "str | None") -> "str | None":
    if account is not None and not ACCOUNT_RE.fullmatch(str(account)):
        return f"invalid account: {account!r}"
    return None


def account_settings(account: str) -> Path:
    """The Claude Code settings file MasterDeck writes for a connected GitHub account (two or more)."""
    return config.masterdeck_home() / "accounts" / f"{account}.settings.json"


def validate_resume(resume: "str | None") -> "str | None":
    try:
        if str(uuid.UUID(resume)) != resume.lower():
            return f"invalid resume id: {resume!r}"
    except (ValueError, AttributeError, TypeError):
        return f"invalid resume id: {resume!r}"
    return None


def validate_spawn_target(sp: dict) -> "str | None":
    """Validate a `target["spawn"]` dict. Returns None when valid, else the reason."""
    err = validate_account(sp.get("account"))
    if err:
        return err
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
    acct = []
    # One account: no --settings, the command as before (an account in the target is ignored).
    if sp.get("account") and config.is_multi():
        # A disconnected account's file may linger while its old sessions run: never start a new one as it.
        login = next((a["login"] for a in config.accounts() if a["login"].lower() == str(sp["account"]).lower()), None)
        if not login:
            raise SpawnError(f"GitHub account {sp['account']} is not a connected account (Setup → GitHub accounts)")
        # Never start as gh's active account instead: that would commit as someone else.
        f = account_settings(login)
        if not f.is_file():
            raise SpawnError(f"GitHub account {sp['account']} has no settings file ({f}); "
                             "open MasterDeck (it writes them) or log the account in again there")
        acct = ["--settings", str(f)]
    if sp.get("resume"):
        # No flag at all wakes the session itself, with its saved options (its account's --settings
        # among them). Any flag starts a copy under new ids and leaves the old session listed, so
        # --settings goes only when the proposal names another account than the one MasterDeck
        # recorded the session as: a copy on purpose. No record: bare.
        rec = config.session_account(sp["resume"]) if acct else None
        if not rec or rec.lower() == login.lower():
            acct = []
        return ["claude", "--bg", *acct, "--resume", sp["resume"]]
    model = ["--model", sp["model"]] if sp.get("model") else []
    return ["claude", "--bg", *acct, "-n", sp["name"], *model, sp["prompt"]]


def default_account(led: dict, p: dict, cwd: str) -> "str | None":
    """The account a proposal without one starts as (two or more accounts). A resume (an ORPHAN whose
    session MasterDeck did not record) as the app's sessionAccount: the session's own spawn proposal,
    its folder's `origin` repo, then the issue repo's account, else the primary. A new session: the
    issue repo's account, else the primary."""
    sp = p["target"]["spawn"]
    if sp.get("resume"):
        connected = {a["login"].lower(): a["login"] for a in config.accounts()}
        for q in reversed(led["proposals"]):
            qs = (q.get("target") or {}).get("spawn") or {}
            if q is not p and qs.get("name") == sp.get("name") and not qs.get("resume"):
                login = connected.get(str(qs.get("account") or "").lower())
                if login:
                    return login
        repo = config.origin_repo(cwd)
        origin = config.match_repo(repo) if repo else None
        if origin:
            return origin
    return config.account_for_repo(p.get("repo"))


_COPY = re.compile(r"background session ([0-9a-f]{8}) keeps its own saved options[^\n]*?started a copy as ([0-9a-f]{8})\b")


def copy_of(out: str) -> "tuple[str, str] | None":
    """(old bg id, new bg id) when a resume started a copy (`note: background session <old> keeps its
    own saved options, so the flags you passed started a copy as <new>`); None when it woke the session itself."""
    m = _COPY.search(re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out))
    return (m.group(1), m.group(2)) if m and m.group(1) != m.group(2) else None


PARKED_KEEP = 500  # parked-sessions.json: the oldest records go past this
_BG = (re.compile(r"^\s*backgrounded\s*·\s*([0-9a-f]{8})\b", re.I | re.M), re.compile(r"^\s*claude attach ([0-9a-f]{8})\b", re.I | re.M))


def bg_id(out: str) -> "str | None":
    """The new session's background id from `claude --bg` output (the app's bgIdFromOutput)."""
    t = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out)
    return next((m.group(1) for m in (rx.search(t) for rx in _BG) if m), None)


def running(session_id: str, runner=subprocess.run) -> "bool | None":
    """Whether `claude agents` shows a live process for this session: by its session id, or its
    background id (the first 8 characters of the id it started with; it survives a resume under a
    new session id). `claude --bg --resume` beside a running session would be a second one of it, so
    a resume checks first. None: not known (`claude agents` failed or printed something else)."""
    try:
        r = runner(["claude", "agents", "--json"], capture_output=True, text=True, timeout=30)
        rows = json.loads(r.stdout) if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    if not isinstance(rows, list):
        return None
    return any(isinstance(x, dict) and x.get("pid") and (x.get("sessionId") == session_id or x.get("id") == session_id[:8])
               for x in rows)


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

    sp0 = p["target"]["spawn"]
    # No folder: ticket work starts where the resolver says; a resume and anything else in the workspace.
    cwd = sp0.get("cwd") or (str(config.workspace()) if sp0.get("resume")
                             else checkout.default_cwd(p["kind"], p["issue"], p.get("repo")))
    if not Path(cwd).is_dir():
        note = f"cwd does not exist: {cwd}"
        hold(note)
        raise SpawnError(f"proposal {pid}: {note}")
    if config.is_multi() and not p["target"]["spawn"].get("account"):
        # A proposal without an account (older, or `master add` without --account) never starts as
        # gh's active account: its repo's account, else the primary's (spec 4.2). Written to the
        # ledger (locked by the caller) so the app attributes the session to it.
        p["target"]["spawn"]["account"] = default_account(led, p, cwd)
    try:
        cmd = command(p["target"])
    except (KeyError, ValueError, SpawnError) as e:
        note = str(e)
        hold(note)
        raise SpawnError(f"proposal {pid}: {note}")
    resume = p["target"]["spawn"].get("resume")
    # Before the session exists: the branch its folder is on now is not its own.
    park = None if resume else checkout.parked(p["kind"], cwd, p["target"]["spawn"].get("name") or "")
    if resume:
        live = running(resume, runner)
        if live:
            # Resumed already (MasterDeck's Resume all, or by hand): the session is working again.
            return ledger.transition(led, pid, "sent", now=now, note="already running; not resumed again")
        if live is None:
            # Not known: a resume beside a running session would be a second one of it.
            note = "`claude agents` failed, so it is not known whether the session runs; not resumed"
            hold(note)
            raise SpawnError(f"proposal {pid}: {note}")
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
        if trust.not_trusted(err):
            # Claude Code was never allowed to work in this folder. The proposal now names it: the
            # app shows it (and opens `claude` there), and the retry starts in the same one.
            sp0.setdefault("cwd", cwd)
        hold(err)
        raise SpawnError(f"proposal {pid}: {err}")
    out = r.stdout or ""
    if park:
        try:
            key = bg_id(out) or f"name:{park['name']}"
            # `at`: when it started, so a record kept by name is not taken for a later session of that name.
            rec = {**park, "at": now}
            merge_json(config.masterdeck_home() / "parked-sessions.json",
                       lambda d: dict(list({**(d if isinstance(d, dict) else {}), key: rec}.items())[-PARKED_KEEP:]),
                       replace_broken=True)
        except OSError:
            pass  # the session then counts as started by hand
    if resume:
        c = copy_of(out)
        if c:
            # The flags started a copy. The old session stays as it is (never removed: `claude rm`
            # deletes its worktree too); MasterDeck hides it while it does not run, and knows the
            # copy's account, so its own resume of the copy stays bare.
            old, new = c
            login = p["target"]["spawn"].get("account")
            try:
                if login:
                    merge_json(config.masterdeck_home() / "session-accounts.json",
                               lambda d: {**(d if isinstance(d, dict) else {}), new: login})
                merge_json(config.masterdeck_home() / "superseded-sessions.json",
                           lambda d: list(dict.fromkeys([*(d if isinstance(d, list) else []), old, resume])))
            except OSError:
                pass  # the app then shows both, and copies once more
    return ledger.transition(led, pid, "sent", now=now, note=out.strip()[:200])


def merge_json(path: Path, change, replace_broken: bool = False) -> None:
    """Read `path`, apply `change`, and replace it atomically (temp file + rename). A missing file is
    created (`change(None)`); one that is there but cannot be read or parsed is left untouched (it may
    be half-written, or not ours to overwrite). MasterDeck writes the same files the same way.
    `replace_broken`: for a file only `master` writes, one that cannot be parsed is started afresh
    (left alone, it would switch what it records off for good, without a word)."""
    cur = None
    if path.exists():
        try:
            cur = json.loads(path.read_text())
        except (OSError, ValueError) as e:
            if not (replace_broken and isinstance(e, ValueError)):
                print(f"master: {path.name} is unreadable ({e}); not updated", file=sys.stderr)
                return
            print(f"master: {path.name} could not be parsed ({e}); started afresh", file=sys.stderr)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(change(cur)))
    os.replace(tmp, path)

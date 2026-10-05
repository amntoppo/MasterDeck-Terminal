from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from . import board, checkout, collect, config, guard, inbox, ledger, refs, rules, snapshot, spawn

WRITE_CMDS = {"add", "approve", "reject", "mark", "spawn", "say", "sweep-request", "reply", "ack"}


def _now(args) -> str:
    return args.now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _today(args) -> date:
    # A generated --now is UTC; the local calendar date can differ from its date part near
    # midnight, so an explicit --now uses its own date and an absent one uses the local date.
    return date.fromisoformat(args.now[:10]) if args.now else date.today()


def _source(args):
    return collect.Fixtures(Path(args.fixtures)) if args.fixtures else collect.Live()


def _sources(args) -> list:
    """One source per connected account (two or more, each with its own token); else today's one."""
    if args.fixtures or not config.is_multi():
        return [_source(args)]
    return [collect.Live.for_account(a) for a in config.accounts()]


class _BranchesByRepo:
    """The primary's source, with each session's branch head read as the account owning its repo
    (its failure tagged with that account)."""

    def __init__(self, primary, by_login: dict):
        self._primary, self._by = primary, by_login

    def __getattr__(self, name):
        return getattr(self._primary, name)

    def branch_head(self, key: str) -> str:
        login = config.account_for_repo(key.split("@", 1)[0])
        try:
            return self._by.get(login, self._primary).branch_head(key)
        except Exception as e:
            e.account = login
            raise


def _snap(args) -> dict:
    now = _now(args)
    srcs = _sources(args)
    if len(srcs) == 1:
        return snapshot.build(srcs[0], now_iso=now, today=_today(args))
    # Each account's issues and PRs with its own token; the sessions once, with the primary.
    logins = [a["login"] for a in config.accounts()]
    srcs[0] = _BranchesByRepo(srcs[0], dict(zip(logins, srcs)))
    return snapshot.merge([(login, snapshot.build(s, now_iso=now, today=_today(args), with_sessions=i == 0))
                           for i, (login, s) in enumerate(zip(logins, srcs))])


def cmd_snapshot(args) -> int:
    print(json.dumps(_snap(args), indent=2))
    return 0


def _apply(led: dict, cur: dict, now: str) -> list:
    prev = led.get("last_snapshot")
    rules.carry_idle(prev, cur, now)
    return [p for p in (ledger.add(led, now=now, **c) for c in rules.propose(prev, cur, now)) if p]


def cmd_sweep(args) -> int:
    now = _now(args)
    # The snapshot makes network calls for seconds; build it before taking the lock
    # so an approval from the app is never stuck behind gh.
    cur = _snap(args)
    if args.dry_run:
        new = _apply(ledger.load(), cur, now)
    else:
        with ledger.locked() as led:
            new = _apply(led, cur, now)
            led["last_snapshot"] = cur
            led["cursor"]["snapshot_at"] = now
    print(rules.format_batch(new) if new else "no new proposals")
    missing = [k for k, v in cur["sources"].items() if not v]
    if missing:
        print("sources missing: " + ", ".join(missing))
    if cur["errors"]:
        for e in cur["errors"]:
            print(f"  {e['source']}: {e['message']}")
    return 0


def cmd_status(args) -> int:
    snap = _snap(args)
    issues = {refs.key(i.get("repo"), i["number"]): i for i in snap["issues"]}
    threads: dict = {}
    for pr in snap["prs"]:
        if pr["refs_issue"]:
            k = refs.key(pr.get("refs_repo"), pr["refs_issue"])
            threads[k] = threads.get(k, 0) + pr["unresolved_threads"]
    for s in snap["sessions"]:
        k = refs.key(s.get("issue_repo"), s["issue"]) if s["issue"] is not None else None
        if s["status"] == "dead" and k not in issues:
            continue
        line = f"{s['name']:<32} {s['status']:<8}"
        if s["issue"] is not None:
            # the snapshot drops Dev Done and later, so a missing issue is finished or out of scope
            board = (issues.get(k) or {}).get("status") or "done or out of scope"
            line += f" {refs.label(s.get('issue_repo'), s['issue'])} [{board}]"
            if threads.get(k):
                line += f" threads={threads[k]}"
        if s["status"] == "blocked":
            attach = f"claude attach {s['bg_id']}" if s["bg_id"] else "switch to its terminal"
            line += f"  needs input — {attach}"
        print(line)
    missing = [k for k, v in snap["sources"].items() if not v]
    if missing:
        print("sources missing: " + ", ".join(missing))
    return 0


def _fill_stdin(args, *names: str) -> "str | None":
    """For each name where getattr(args, name) == '-', replace it with stdin's full content.
    At most one field may be '-' per call. Returns an error message, or None on success."""
    dashes = [n for n in names if getattr(args, n, None) == "-"]
    if len(dashes) > 1:
        flags = ", ".join("--" + n.replace("_", "-") for n in dashes)
        return f"only one of {flags} may be '-'"
    if dashes:
        setattr(args, dashes[0], sys.stdin.read())
    return None


def _derive_summary(message: str) -> str:
    """First line of message, with a leading '#<digits>: ' prefix removed, whitespace
    collapsed, truncated to 60 chars (with '…' appended when it was cut)."""
    first_line = message.splitlines()[0] if message else ""
    first_line = re.sub(r"^(?:[A-Za-z0-9._/-]*)#\d+:\s*", "", first_line)
    first_line = re.sub(r"\s+", " ", first_line).strip()
    if len(first_line) > 60:
        first_line = first_line[:60] + "…"
    return first_line


def cmd_add(args) -> int:
    err = _fill_stdin(args, "message", "summary", "prompt")
    if err:
        print(err)
        return 2
    if not args.summary:
        args.summary = _derive_summary(args.message)
    if args.session:
        target = {"session": args.session}
    else:
        add_repo = refs.stored(args.repo) if args.repo else refs.parse(args.issue)[0]
        sp = {"name": args.spawn_name, "cwd": args.cwd or checkout.resolve(add_repo)["cwd"], "prompt": args.prompt}
        if args.model:
            sp["model"] = args.model
        if args.account:
            sp["account"] = args.account
        err = spawn.validate_spawn_target(sp)
        if err:
            print(err)
            return 2
        target = {"spawn": sp}
    with ledger.locked() as led:
        repo, n = refs.parse(args.issue)
        if args.repo:
            repo = refs.stored(args.repo)
        p = ledger.add(led, kind=args.kind, issue=n, repo=repo, source=args.source, target=target,
                       message=args.message, summary=args.summary, now=_now(args))
    print("duplicate" if p is None else f"added {p['id']}")
    return 0


def _decide(args, to: str) -> int:
    now = _now(args)
    with ledger.locked() as led:  # one bad id raises and saves none of them
        for pid in args.ids:
            ledger.transition(led, pid, to, now=now)
    print(f"{to}: {' '.join(str(i) for i in args.ids)}")
    return 0


def cmd_mark(args) -> int:
    err = _fill_stdin(args, "note")
    if err:
        print(err)
        return 2
    with ledger.locked() as led:
        ledger.transition(led, args.id, args.status, now=_now(args), note=args.note)
    print(f"{args.id}: {args.status}")
    return 0


def cmd_spawn(args) -> int:
    # The lock is held while `claude --bg` starts (about a second, 60 s at most) so the
    # proposal cannot be dispatched twice. A failure is caught inside the block, so the
    # note recording it is saved.
    err = None
    with ledger.locked() as led:
        try:
            p = spawn.spawn(led, args.id, now=_now(args))
        except spawn.SpawnError as e:
            err = str(e)
    if err:
        print(err)
        return 1
    print(f"{args.id}: sent — {p['note']}")
    return 0


def cmd_list(args) -> int:
    for p in ledger.load()["proposals"]:
        if args.status is None or p["status"] == args.status:
            print(json.dumps(p))
    return 0


def cmd_cursor(args) -> int:
    if args.meetings_since:
        with ledger.locked() as led:
            led["cursor"]["meetings_since"] = args.meetings_since
    else:
        led = ledger.load()
    print(json.dumps(led["cursor"]))
    return 0


def _validate_to(name: str) -> "str | None":
    """Validate `say --to NAME`. Session names may contain spaces, unlike spawn names."""
    if not name:
        return "invalid name: must not be empty"
    if len(name) > 100:
        return f"invalid name: too long ({len(name)} chars, max 100)"
    if "\r" in name or "\n" in name:
        return "invalid name: must not contain a newline"
    if name.startswith("-"):
        return f"invalid name: must not start with '-': {name!r}"
    return None


def cmd_say(args) -> int:
    err = _fill_stdin(args, "text")
    if err:
        print(err)
        return 2
    if args.to is not None:
        err = _validate_to(args.to)
        if err:
            print(err)
            return 2
    print(f"inbox {inbox.say(args.text, now=_now(args), to=args.to)['id']}")
    return 0


def cmd_sweep_request(args) -> int:
    print(f"inbox {inbox.say('', now=_now(args), kind='sweep')['id']}")
    return 0


def cmd_reply(args) -> int:
    err = _fill_stdin(args, "text")
    if err:
        print(err)
        return 2
    print(f"outbox {inbox.reply(args.id, args.text, now=_now(args))['id']}")
    return 0


def cmd_ack(args) -> int:
    inbox.ack(args.id)
    print(f"acked {args.id}")
    return 0


def cmd_watch(args) -> int:
    inbox.watch(interval=args.interval, iterations=args.iterations)
    return 0


def cmd_draft_assign(args) -> int:
    repo, n = refs.parse(args.issue)
    if args.repo:
        repo = refs.stored(args.repo)
    k = refs.key(repo, n)
    if args.title and args.url:
        # The caller already knows the issue (a board card): no snapshot needed.
        issue = {"number": n, "repo": repo, "title": args.title, "url": args.url}
    else:
        snap = None if args.live else ledger.load().get("last_snapshot")
        issue = next((i for i in (snap or {}).get("issues", []) if refs.key(i.get("repo"), i["number"]) == k), None)
        if issue is None:
            # Master's last sweep can predate the issue (or --live asked for fresh data).
            issue = next((i for i in _snap(args)["issues"] if refs.key(i.get("repo"), i["number"]) == k), None)
        if issue is None:
            print(f"issue {refs.label(repo, n).lstrip('#')} not found")
            return 1
    a = rules._assign(issue, args.cwd)
    sp = a["target"]["spawn"]
    where = checkout.resolve(repo, args.cwd)  # the one _assign used (a scan is remembered)
    print(json.dumps({"issue": a["issue"], "repo": a["repo"], "name": sp["name"], "cwd": sp["cwd"], "prompt": sp["prompt"],
                      "summary": a["summary"], "title": issue["title"], "url": issue["url"],
                      # For the Start dialog: where it looked, for which repository, and whether it found it.
                      "workspace": where["workspace"], "found": where["found"], "checkoutOf": where["repo"]}))
    return 0


def cmd_checkout(args) -> int:
    """Where a session for this repository starts (the app's PR review sessions): JSON."""
    if not re.fullmatch(config.REPO_RE, args.repo):
        print(f"not a repository (owner/name): {args.repo}")
        return 2
    print(json.dumps(checkout.resolve(args.repo)))
    return 0


def _pr_facts(src, items: list) -> "tuple[dict, str | None]":
    """What is known of the PRs linked to repository issues: their state from the issue read, and
    CI and review threads for the open ones (one more read, only when there is one). A failed read
    keeps the states and says so in the second value."""
    details = {u: {"state": st, "ci": None, "unresolved": 0}
               for it in items for u, st in (it.get("pr states") or {}).items()}
    live = [u for u, d in details.items() if d["state"] in ("OPEN", "DRAFT")]
    if live:
        try:
            details.update(src.pr_details(live))
        except Exception as e:  # the states are known already; say CI and threads are missing
            return details, f"Pull request details not read: {str(e).strip() or type(e).__name__}"
    return details, None


def _repo_cards(src, args) -> "tuple[list, dict, dict]":
    """An account with no board: its repositories' issues as board items, the details of their
    PRs, and what was read (for the Board's note)."""
    got = src.repo_issues(_today(args))
    if args.mine:  # the sprint filter has no meaning without a board; "mine" does
        me = ((getattr(src, "cfg", None) or {}).get("login") or src.me()).lower()
        got = dict(got, items=[it for it in got["items"] if me in [a.lower() for a in it.get("assignees") or []]])
    items, shown = board.trim_repo_issues(got["items"], board.done_since(_today(args)))
    why = got.get("unread") or {}  # asked again next time: say why this time
    lines = [f"{r} not read: {w}" for r, w in why.items()]
    details, pr_note = _pr_facts(src, items)
    if pr_note:
        lines.append(pr_note)
    part = {"repos": got["repos"], "total": got["total"], "shown": shown,
            "skipped": got["skipped"], "missing": got["missing"]}
    if lines:
        # "notes": one line each, on this account's part (the Board shows them in its tab);
        # "note": the same in one line, for the top-level list.
        part["notes"] = lines
        part["note"] = "; ".join(lines)
    return items, details, part


def cmd_board(args) -> int:
    srcs = _sources(args)
    logins = [a["login"] for a in config.accounts()] if len(srcs) > 1 else [None]
    items, details, errors, derived, notes = [], {}, [], [], []
    for login, src in zip(logins, srcs):
        try:
            if config.boardless(getattr(src, "cfg", None)):
                # No board on this account (or at all): its repositories' issues stand in.
                got, more, part = _repo_cards(src, args)
                details.update(more)
                if "note" in part:
                    notes.append(part.pop("note"))
                derived.append(dict(part, account=login))
            else:
                got = src.board_sprint(board.sprint_query(args.sprint, mine=args.mine))
                details.update(src.pr_details(board.linked_prs(got)))
            items += [dict(it, account=login) for it in got] if login else got
        except Exception as e:  # gh missing, network, rate limit, an account to log in again: say what gh said
            errors.append(str(e).strip() or type(e).__name__)
    if len(errors) == len(srcs):
        print(errors[0])
        return 1
    out = board.build(items, details, _now(args))
    if errors:
        out["errors"] = errors
    # An issue another account's board holds is that board's card: this account's tab does not
    # show it, so its counts leave it out ("Showing the first N of M" stays about cards of the tab).
    held = board.on_boards(items) if derived else set()
    for part in derived if held else []:
        gone = board.shadowed_open([it for it in items if it.get("account") == part["account"]], held)
        part["total"], part["shown"] = max(0, part["total"] - gone), max(0, part["shown"] - gone)
    if derived:
        out["derived"] = derived
    if notes:
        out["notes"] = notes
    print(json.dumps(out))
    return 0


def _repo_source(args, login: "str | None"):
    """Where one account's repositories are read from: the fixtures, the whole config (one account),
    or that account with its own token."""
    if args.fixtures or login is None:
        return _source(args)
    return collect.Live.for_account(next(a for a in config.accounts() if a["login"] == login))


def cmd_repo_issues(args) -> int:
    """The Board's repository view: every issue of the named repositories (open, and closed
    lately), whether or not a board holds it. Read-only. Each repository gets its own part
    ({repo, account, ok, total, shown, note?}), so one that cannot be read never hides another."""
    asked = list(dict.fromkeys(r.strip() for r in (args.repos or "").split(",") if r.strip()))
    if not asked or not all(re.fullmatch(config.REPO_RE, r) for r in asked):
        print("--repos takes owner/name, comma separated")
        return 2
    listed = {r.lower(): r for r in config.repos()}
    parts, groups, order = {}, {}, []

    def bad(repo, login, note):
        return {"repo": repo, "account": login, "ok": False, "total": 0, "shown": 0, "note": note[:300]}

    for r in asked:
        name = listed.get(r.lower(), r)
        if name in order:
            continue
        order.append(name)
        # Stricter than repo_allowed: the names come from outside (a Board tab, also in a paired browser).
        if not config.repo_readable(name):
            parts[name] = bad(name, None, f"{name} is not selected in Setup")
            continue
        groups.setdefault(None if args.fixtures else config.account_for_repo(name), []).append(name)
    since = board.done_since(_today(args))
    items, details = [], {}

    def why(e):  # gh missing, network, rate limit, an account to log in again: say what gh said
        return str(e).strip() or type(e).__name__

    for login, repos in groups.items():
        try:
            src = _repo_source(args, login)
        except Exception as e:
            for r in repos:
                parts[r] = bad(r, login, f"{r} not read: {why(e)}")
            continue
        # One read takes DERIVED_MAX_REPOS repositories of an account: more are read in turn, so
        # none is left out ("skipped") however many a tab picked.
        step = config.DERIVED_MAX_REPOS
        for at in range(0, len(repos), step):
            chunk = repos[at:at + step]
            try:
                got = src.repo_issues(_today(args), only=chunk, boards=True)
            except Exception as e:
                # The rest of this account is not asked: the same failure (a rate limit) would only repeat.
                for r in repos[at:]:
                    parts[r] = bad(r, login, f"{r} not read: {why(e)}")
                break
            by_repo: dict = {}
            for it in got["items"]:
                by_repo.setdefault(str((it.get("content") or {}).get("repository") or "").lower(), []).append(it)
            unread, kept = got.get("unread") or {}, []
            for r in chunk:
                if r in (got.get("skipped") or []):
                    parts[r] = bad(r, login, f"{r} not read: more than {config.DERIVED_MAX_REPOS} repositories at once")
                elif r in (got.get("missing") or []):
                    parts[r] = bad(r, login, f"{r} not read: {unread[r]}" if r in unread else f"Not found: {r}")
                else:
                    # The Board's limits (open, then closed lately), for each repository on its own.
                    mine, shown = board.trim_repo_issues(by_repo.get(r.lower(), []), since)
                    kept += mine
                    parts[r] = {"repo": r, "account": login, "ok": True, "shown": shown,
                                "total": max(shown, int((got.get("totals") or {}).get(r) or 0))}
            more, pr_note = _pr_facts(src, kept)
            details.update(more)
            notes = [n for n in (pr_note, (f"Board columns only partly read (later pages): {got['boards_unread']}" if got.get("boards_partial")
                             else f"Board columns not read: {got['boards_unread']}") if got.get("boards_unread") else None) if n]
            for r in chunk:
                if notes and parts[r]["ok"]:
                    parts[r]["note"] = "; ".join(notes)[:300]
            items += [dict(it, account=login) for it in kept] if login else kept
    print(json.dumps({"taken_at": _now(args), "cards": board.build(items, details, _now(args))["cards"],
                      "repos": [parts[r] for r in order]}))
    return 0


def cmd_sprints(args) -> int:
    if not args.fixtures and not any(p.get("sprintField") for p in config.projects()):
        print("[]")  # no board, or a board without a sprint (iteration) field
        return 0
    srcs = _sources(args)
    out, errors = [], []
    for src in srcs:
        try:
            out += src.sprints()
        except Exception as e:
            errors.append(str(e).strip() or type(e).__name__)
    if len(errors) == len(srcs):
        print(errors[0])
        return 1
    # Two or more accounts: a sprint title on several accounts' boards is one sprint.
    print(json.dumps(board.merge_sprints(out) if len(srcs) > 1 else out))
    return 0


def cmd_key(args) -> int:
    text = sys.stdin.read()
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    print(hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12])
    return 0


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="master")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def with_src(p):
        p.add_argument("--fixtures")
        p.add_argument("--now")
        return p

    with_src(sub.add_parser("snapshot")).set_defaults(fn=cmd_snapshot)
    sw = with_src(sub.add_parser("sweep"))
    sw.add_argument("--dry-run", action="store_true")
    sw.set_defaults(fn=cmd_sweep)
    with_src(sub.add_parser("status")).set_defaults(fn=cmd_status)

    ad = sub.add_parser("add")
    ad.add_argument("--kind", required=True)
    ad.add_argument("--issue", required=True, help="12, name#12 or owner/name#12")
    ad.add_argument("--repo", help="owner/name of the issue's repo; omitted: from --issue, else the primary repo")
    ad.add_argument("--source", required=True)
    ad.add_argument("--summary")
    ad.add_argument("--message", required=True)
    ad.add_argument("--now")
    tgt = ad.add_mutually_exclusive_group(required=True)
    tgt.add_argument("--session")
    tgt.add_argument("--spawn-name")
    ad.add_argument("--prompt")
    ad.add_argument("--cwd")
    ad.add_argument("--model", help="claude --model for the spawned session; omitted: the default model")
    ad.add_argument("--account", help="gh login the spawned session works as (MasterDeck's connected accounts)")
    ad.set_defaults(fn=cmd_add)

    for name, to in (("approve", "approved"), ("reject", "rejected")):
        p = sub.add_parser(name)
        p.add_argument("ids", type=int, nargs="+")
        p.add_argument("--now")
        p.set_defaults(fn=lambda a, to=to: _decide(a, to))

    mk = sub.add_parser("mark")
    mk.add_argument("id", type=int)
    mk.add_argument("status", choices=["sent", "done", "blocked", "held", "question"])
    mk.add_argument("--note")
    mk.add_argument("--now")
    mk.set_defaults(fn=cmd_mark)

    ls = sub.add_parser("list")
    ls.add_argument("--status")
    ls.set_defaults(fn=cmd_list)

    cu = sub.add_parser("cursor")
    cu.add_argument("--meetings-since")
    cu.set_defaults(fn=cmd_cursor)

    sp = sub.add_parser("spawn")
    sp.add_argument("id", type=int)
    sp.add_argument("--now")
    sp.set_defaults(fn=cmd_spawn)

    sy = sub.add_parser("say")
    sy.add_argument("text")
    sy.add_argument("--to")
    sy.add_argument("--now")
    sy.set_defaults(fn=cmd_say)

    sr = sub.add_parser("sweep-request")
    sr.add_argument("--now")
    sr.set_defaults(fn=cmd_sweep_request)

    rp = sub.add_parser("reply")
    rp.add_argument("id", type=int)
    rp.add_argument("text")
    rp.add_argument("--now")
    rp.set_defaults(fn=cmd_reply)

    ak = sub.add_parser("ack")
    ak.add_argument("id", type=int)
    ak.set_defaults(fn=cmd_ack)

    wa = sub.add_parser("watch")
    wa.add_argument("--interval", type=float, default=1.0)
    wa.add_argument("--iterations", type=int)
    wa.set_defaults(fn=cmd_watch)

    sub.add_parser("key").set_defaults(fn=cmd_key)

    bo = with_src(sub.add_parser("board"))
    bo.add_argument("--sprint", default="@current")
    bo.add_argument("--mine", action="store_true")
    bo.set_defaults(fn=cmd_board)
    with_src(sub.add_parser("sprints")).set_defaults(fn=cmd_sprints)
    ri = with_src(sub.add_parser("repo-issues"))
    ri.add_argument("--repos", required=True, help="owner/name, comma separated: the repositories a Board tab picked")
    ri.set_defaults(fn=cmd_repo_issues)

    da = with_src(sub.add_parser("draft-assign"))
    da.add_argument("issue", help="12, name#12 or owner/name#12")
    da.add_argument("--repo", help="owner/name of the issue's repo; omitted: from the issue, else the primary repo")
    da.add_argument("--live", action="store_true")
    da.add_argument("--title")
    da.add_argument("--url")
    da.add_argument("--cwd", help="a folder the user chose; omitted: the repository's checkout, else its account's workspace")
    da.set_defaults(fn=cmd_draft_assign)

    co = sub.add_parser("checkout")
    co.add_argument("repo", help="owner/name")
    co.set_defaults(fn=cmd_checkout)

    return ap


def _is_write(args) -> bool:
    if args.cmd == "sweep":
        return not args.dry_run
    if args.cmd == "cursor":
        return bool(args.meetings_since)
    return args.cmd in WRITE_CMDS


def _default_agents_loader() -> list:
    return json.loads(collect._run(["claude", "agents", "--json"]))


def main(argv: "list | None" = None, *, agents_loader=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["config"]:
        # Settings, not the ledger: no guard, and its own small argument handling.
        from . import setup
        return setup.main(argv[1:])
    args = parser().parse_args(argv)
    if args.cmd == "add" and args.spawn_name and not args.prompt:
        print("--spawn-name needs --prompt")
        return 2
    if _is_write(args):
        msg = guard.check(os.environ, agents_loader or _default_agents_loader)
        if msg:
            print(msg)
            return 3
    try:
        return args.fn(args)
    except (KeyError, ValueError) as e:
        print(str(e).strip("'\""))
        return 1


if __name__ == "__main__":
    sys.exit(main())

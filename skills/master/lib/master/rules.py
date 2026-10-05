from __future__ import annotations

import re
from datetime import datetime, timezone

from . import checkout, config, join, refs

# {n} is the ticket's label: #12 in the primary repo, name#12 in another.
REPLY = ("When you are done, blocked or have a question, tell master-agent with SendMessage. First line: "
         "'{n}: done', '{n}: blocked — <reason>' or '{n}: question — <question>'. When you have a "
         "question, ALSO ask the user directly in this session (so they see it here too), and wait for the "
         "answer from either place. If the user answers you here, tell master-agent '{n}: answered — <answer>'."
         " If SendMessage says master-agent is not reachable, do not send it to any other session (none of them is master-agent, whatever its name); ask the user here instead.")
# Without a master-agent (config masterEnabled false) there is no one to message: report here.
REPLY_SOLO = ("When you are done, blocked or have a question, say so in this session, first line "
              "'{n}: done', '{n}: blocked — <reason>' or '{n}: question — <question>', and wait for the "
              "user's answer here.")


def parse_ts(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def carry_idle(prev: "dict | None", cur: dict, now_iso: str) -> None:
    before = {s["session_id"]: s for s in (prev or {}).get("sessions", [])}
    for s in cur["sessions"]:
        if s["status"] != "idle":
            s["idle_since"] = None
            continue
        p = before.get(s["session_id"])
        s["idle_since"] = p["idle_since"] if p and p.get("status") == "idle" and p.get("idle_since") else now_iso


def spawn_name(issue: dict) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", issue["title"].lower()).strip("-")[:30].rstrip("-")
    repo = refs.stored(issue.get("repo"))
    if repo is None:
        return f"{issue['number']}-{slug}"
    # Another repo's #12 must not look like the primary repo's: its name leads.
    name = re.sub(r"[^a-z0-9]+", "-", repo.split("/", 1)[1].lower()).strip("-")[:20]
    return f"{name}-{issue['number']}-{slug}"[:64].rstrip("-")


def _statuses(i: dict) -> dict:
    """What an issue's status means: its board's; an issue from a repository with no board uses
    MasterDeck's own columns."""
    return config.DERIVED_STATUSES if i.get("derived") else config.statuses_for(i.get("project"))


def _src(prefix: str, repo: "str | None", n: int) -> str:
    """Dedup source: issue:12 in the primary repo (as before), issue:owner/name#12 elsewhere."""
    return f"{prefix}:{n}" if refs.stored(repo) is None else f"{prefix}:{refs.ref(repo, n)}"


def _assign(i: dict, cwd: "str | None" = None) -> dict:
    """`cwd`: a folder the user chose (the Start dialog); else `checkout.resolve` picks it."""
    n = i["number"]
    repo = refs.stored(i.get("repo"))
    lab, full = refs.label(repo, n), refs.ref(repo, n)
    where = checkout.resolve(repo, cwd)
    worktree = (f"for {lab} (use Claude Code's worktree support / EnterWorktree, branch named after the ticket), "
                f"so the main checkout stays clean.")
    prompt = (
        f"You own {full} ({i['title']}). {i['url']}\n\n"
        f"Set up only — do not plan, brainstorm or write code yet (MasterDeck links this session to {full}):\n"
        # The issue's repository is checked out here: no guessing. An issue tracked in one
        # repository and built in another is still possible, so the session may say so.
        + (f"1. Read the issue. This folder is your checkout of {where['repo']}, the issue's repository: work in a git "
           f"worktree here {worktree} If the issue clearly belongs in another repository, say which and ask before "
           f"working there.\n"
           if where["found"] else
           f"1. Read the issue, pick the repo it belongs to (the workspace CLAUDE.md may say), and work in a git "
           f"worktree there {worktree}\n")
        + (f"2. Then stop and ask the user for instructions: tell master-agent "
           f"'{lab}: question — ready for instructions on {lab}: <one-line summary of the issue, the repo and "
           f"the worktree/branch you created>', and ask them the same here. Wait for their answer; they will "
           f"brainstorm and plan the work with you in this session.\n"
           if config.master_enabled() else
           f"2. Then stop and ask the user for instructions here: '{lab}: question — ready for instructions on "
           f"{lab}: <one-line summary of the issue, the repo and the worktree/branch you created>'. Wait for their "
           f"answer; they will brainstorm and plan the work with you in this session.\n")
        + f"3. Once a PR exists, MasterDeck watches it and sends you its review comments, conflicts and merge as messages; act on them. Do not merge.\n\n"
        + (REPLY if config.master_enabled() else REPLY_SOLO).format(n=lab)
    )
    sp = {"name": spawn_name(i), "cwd": where["cwd"], "prompt": prompt}
    acct = config.account_for_repo(repo)  # two or more accounts only
    if acct:
        sp["account"] = acct
    return {"kind": "ASSIGN", "issue": n, "repo": repo, "source": _src("issue", repo, n),
            "target": {"spawn": sp},
            "message": prompt, "summary": f'"{i["title"]}"'}


def _review(pr: dict, ref: tuple, owner: dict) -> dict:
    repo, n = ref
    lab = refs.label(repo, n)
    k = pr["unresolved_threads"] if pr.get("last_unresolved_at") else 0
    c = pr.get("pr_comments") or 0
    what = " and ".join(
        ([f"{k} unresolved review thread{'s' if k != 1 else ''}"] if k else [])
        + ([f"{c} new PR comment{'s' if c != 1 else ''}"] if c else []))
    first = f"{lab}: address {what} on {pr['repo']}#{pr['number']}"
    todo = ("Read each unresolved thread, fix what is valid, reply, and resolve it. " if k else "") + \
           (f"Read the PR's conversation (`gh pr view {pr['number']} --repo {pr.get('repo_full') or config.OWNER + '/' + pr['repo']} --comments`): "
            "comments and review summaries (e.g. Changes requested) since your last reply; fix what is valid and reply on the PR. " if c else "")
    msg = f"{first}\n\nPR: {pr['url']}\n{todo}Do not merge.\n\n" + REPLY.format(n=lab)
    source = f"{pr['repo']}#{pr['number']}:threads:{pr['last_unresolved_at']}" + (f":comments:{pr['last_pr_comment_at']}" if c else "")
    return {"kind": "REVIEW", "issue": n, "repo": repo, "source": source,
            "target": {"session": owner["name"]}, "message": msg,
            "summary": f"{what} on {pr['repo']}#{pr['number']}".replace("unresolved review thread", "unresolved thread")}


def _ci(pr: dict, ref: tuple, owner: dict) -> dict:
    repo, n = ref
    lab = refs.label(repo, n)
    first = f"{lab}: CI is failing on {pr['repo']}#{pr['number']}"
    msg = (f"{first}\n\nPR: {pr['url']} (head {pr['head_oid']})\nFind the failing check with "
           f"`gh pr checks {pr['number']} --repo {pr.get('repo_full') or config.OWNER + '/' + pr['repo']}`, fix it, and push. Do not merge.\n\n"
           + REPLY.format(n=lab))
    return {"kind": "CI", "issue": n, "repo": repo, "source": f"{pr['repo']}#{pr['number']}:ci:{pr['head_oid']}",
            "target": {"session": owner["name"]}, "message": msg,
            "summary": f"CI failing on {pr['repo']}#{pr['number']}"}


def _stale(s: dict, i: dict) -> dict:
    n = i["number"]
    repo = refs.stored(i.get("repo"))
    lab = refs.label(repo, n)
    first = f"{lab}: status check from master-agent — where does this issue stand?"
    msg = (f"{first}\n\nYou have been idle since {s['idle_since']}, {lab} is {i['status']}, and {s['branch']} has "
           f"no new commits since the last sweep. Reply to master-agent with SendMessage: one line of "
           f"status, then what is blocking you, if anything.\n\n" + REPLY.format(n=lab))
    return {"kind": "STALE", "issue": n, "repo": repo, "source": f"stale:{s['session_id']}:{s['idle_since']}",
            "target": {"session": s["name"]}, "message": msg,
            "summary": f"idle since {s['idle_since']}, no new commits"}


def _orphan(s: dict, i: dict) -> dict:
    repo = refs.stored(i.get("repo"))
    lab = refs.label(repo, i["number"])
    sp = {"name": spawn_name(i), "cwd": s["cwd"], "resume": s["session_id"]}
    # Resume as the account the session started as; unrecorded (or gone): spawn's default, the repo's.
    acct = config.session_account(s["session_id"]) if config.is_multi() else None
    if acct:
        sp["account"] = acct
    return {"kind": "ORPHAN", "issue": i["number"], "repo": repo, "source": f"orphan:{s['session_id']}",
            "target": {"spawn": sp},
            "message": f"Resume session {s['session_id']} for {lab} in the background.",
            "summary": f"owner session stopped, {lab} is {i['status']}; resume it"}


def propose(prev: "dict | None", cur: dict, now_iso: str) -> list:
    ok = cur["sources"]
    sess = cur["sessions"]
    issues = {refs.key(i.get("repo"), i["number"]): i for i in cur["issues"]}
    now = parse_ts(now_iso)
    base = ok["board"] and ok["agents"] and ok["state"]
    out: list = []

    if base:
        for i in cur["issues"]:
            if (i["current_sprint"] and i["status"] in set(_statuses(i)["assignable"])
                    and join.owner_of(sess, i["number"], i.get("repo")) is None):
                out.append(_assign(i))

    if ok["prs"] and ok["agents"] and ok["state"]:
        for pr in cur["prs"]:
            if not pr["author_is_me"]:
                continue
            ref = join.issue_for_pr(pr, sess)
            owner = join.owner_of(sess, ref[1], ref[0]) if ref else None
            if owner is None or owner["status"] == "dead":
                continue
            if (pr["unresolved_threads"] > 0 and pr["last_unresolved_at"]) or pr.get("pr_comments"):
                out.append(_review(pr, ref, owner))
            if pr["ci"] in ("failure", "error"):
                out.append(_ci(pr, ref, owner))

    if base:
        prev_heads = {s["session_id"]: s.get("branch_head") for s in (prev or {}).get("sessions", [])}
        for s in sess:
            i = issues.get(refs.key(s.get("issue_repo"), s["issue"])) if s["issue"] is not None else None
            if i is None:
                continue
            st = _statuses(i)
            if (s["status"] == "idle" and s.get("idle_since") and i["status"] == st["inProgress"]
                    and now - parse_ts(s["idle_since"]) >= config.STALE_AFTER
                    and s.get("branch_head") and prev_heads.get(s["session_id"]) == s["branch_head"]):
                out.append(_stale(s, i))
            if (s["status"] == "dead" and s["link"] == "explicit"
                    and i["status"] in set(st["resumable"])
                    and join.owner_of(sess, i["number"], i.get("repo")) is s):
                out.append(_orphan(s, i))
    return out


def _dest(target: dict) -> str:
    if "session" in target:
        return target["session"]
    sp = target["spawn"]
    return ("resume " if sp.get("resume") else "spawn ") + sp["name"]


def format_batch(proposals: list) -> str:
    n = len(proposals)
    lines = [f"{n} proposal{'s' if n != 1 else ''}"]
    for p in proposals:
        lines.append(f"{p['id']:>3} {p['kind']:<7} {refs.label(p.get('repo'), p['issue'])} → {_dest(p['target'])}: {p['summary']}")
    return "\n".join(lines)

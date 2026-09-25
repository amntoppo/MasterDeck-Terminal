from __future__ import annotations

import re
from datetime import datetime, timezone

from . import config, join

REPLY = ("When you are done, blocked or have a question, tell master-agent with SendMessage. First line: "
         "'#{n}: done', '#{n}: blocked — <reason>' or '#{n}: question — <question>'. When you have a "
         "question, ALSO ask the user directly in this session (so they see it here too), and wait for the "
         "answer from either place. If the user answers you here, tell master-agent '#{n}: answered — <answer>'.")
# Without a master-agent (config masterEnabled false) there is no one to message: report here.
REPLY_SOLO = ("When you are done, blocked or have a question, say so in this session, first line "
              "'#{n}: done', '#{n}: blocked — <reason>' or '#{n}: question — <question>', and wait for the "
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
    return f"{issue['number']}-{slug}"


def _assign(i: dict) -> dict:
    n = i["number"]
    prompt = (
        f"You own {config.issue_ref()}#{n} ({i['title']}). {i['url']}\n\n"
        f"Set up only — do not plan, brainstorm or write code yet:\n"
        f"1. Use the babysit-ticket skill to link this session to #{n}.\n"
        f"2. Read the issue, pick the repo it belongs to (the workspace CLAUDE.md may say), and use the babysit-worktree skill "
        f"there to create a worktree for #{n}.\n"
        + (f"3. Then stop and ask the user for instructions: tell master-agent "
           f"'#{n}: question — ready for instructions on #{n}: <one-line summary of the issue, the repo and "
           f"the worktree/branch you created>', and ask them the same here. Wait for their answer; they will "
           f"brainstorm and plan the work with you in this session.\n"
           if config.master_enabled() else
           f"3. Then stop and ask the user for instructions here: '#{n}: question — ready for instructions on "
           f"#{n}: <one-line summary of the issue, the repo and the worktree/branch you created>'. Wait for their "
           f"answer; they will brainstorm and plan the work with you in this session.\n")
        + f"4. Once a PR exists, use the babysit-pr skill to babysit it. Do not merge.\n\n"
        + (REPLY if config.master_enabled() else REPLY_SOLO).format(n=n)
    )
    return {"kind": "ASSIGN", "issue": n, "source": f"issue:{n}",
            "target": {"spawn": {"name": spawn_name(i), "cwd": str(config.workspace()), "prompt": prompt}},
            "message": prompt, "summary": f'"{i["title"]}"'}


def _review(pr: dict, n: int, owner: dict) -> dict:
    k = pr["unresolved_threads"]
    first = f"#{n}: address {k} unresolved review thread{'s' if k != 1 else ''} on {pr['repo']}#{pr['number']}"
    msg = (f"{first}\n\nPR: {pr['url']}\nRead each unresolved thread, fix what is valid, reply, and resolve it. "
           f"Do not merge.\n\n" + REPLY.format(n=n))
    return {"kind": "REVIEW", "issue": n,
            "source": f"{pr['repo']}#{pr['number']}:threads:{pr['last_unresolved_at']}",
            "target": {"session": owner["name"]}, "message": msg,
            "summary": f"{k} unresolved thread{'s' if k != 1 else ''} on {pr['repo']}#{pr['number']}"}


def _ci(pr: dict, n: int, owner: dict) -> dict:
    first = f"#{n}: CI is failing on {pr['repo']}#{pr['number']}"
    msg = (f"{first}\n\nPR: {pr['url']} (head {pr['head_oid']})\nFind the failing check with "
           f"`gh pr checks {pr['number']} --repo {config.OWNER}/{pr['repo']}`, fix it, and push. Do not merge.\n\n"
           + REPLY.format(n=n))
    return {"kind": "CI", "issue": n, "source": f"{pr['repo']}#{pr['number']}:ci:{pr['head_oid']}",
            "target": {"session": owner["name"]}, "message": msg,
            "summary": f"CI failing on {pr['repo']}#{pr['number']}"}


def _stale(s: dict, i: dict) -> dict:
    n = i["number"]
    first = f"#{n}: status check from master-agent — where does this issue stand?"
    msg = (f"{first}\n\nYou have been idle since {s['idle_since']}, #{n} is In Dev, and {s['branch']} has "
           f"no new commits since the last sweep. Reply to master-agent with SendMessage: one line of "
           f"status, then what is blocking you, if anything.\n\n" + REPLY.format(n=n))
    return {"kind": "STALE", "issue": n, "source": f"stale:{s['session_id']}:{s['idle_since']}",
            "target": {"session": s["name"]}, "message": msg,
            "summary": f"idle since {s['idle_since']}, no new commits"}


def _orphan(s: dict, i: dict) -> dict:
    return {"kind": "ORPHAN", "issue": i["number"], "source": f"orphan:{s['session_id']}",
            "target": {"spawn": {"name": spawn_name(i), "cwd": s["cwd"], "resume": s["session_id"]}},
            "message": f"Resume session {s['session_id']} for #{i['number']} in the background.",
            "summary": f"owner session stopped, #{i['number']} is {i['status']}; resume it"}


def propose(prev: "dict | None", cur: dict, now_iso: str) -> list:
    ok = cur["sources"]
    sess = cur["sessions"]
    issues = {i["number"]: i for i in cur["issues"]}
    now = parse_ts(now_iso)
    base = ok["board"] and ok["agents"] and ok["state"]
    out: list = []

    if base:
        for i in cur["issues"]:
            if (i["current_sprint"] and i["status"] in config.ASSIGNABLE_STATUSES
                    and join.owner_of(sess, i["number"]) is None):
                out.append(_assign(i))

    if ok["prs"] and ok["agents"] and ok["state"]:
        for pr in cur["prs"]:
            if not pr["author_is_me"]:
                continue
            n = join.issue_for_pr(pr, sess)
            owner = join.owner_of(sess, n)
            if owner is None or owner["status"] == "dead":
                continue
            if pr["unresolved_threads"] > 0 and pr["last_unresolved_at"]:
                out.append(_review(pr, n, owner))
            if pr["ci"] in ("failure", "error"):
                out.append(_ci(pr, n, owner))

    if base:
        prev_heads = {s["session_id"]: s.get("branch_head") for s in (prev or {}).get("sessions", [])}
        for s in sess:
            i = issues.get(s["issue"])
            if i is None:
                continue
            if (s["status"] == "idle" and s.get("idle_since") and i["status"] == config.IN_PROGRESS_STATUS
                    and now - parse_ts(s["idle_since"]) >= config.STALE_AFTER
                    and s.get("branch_head") and prev_heads.get(s["session_id"]) == s["branch_head"]):
                out.append(_stale(s, i))
            if (s["status"] == "dead" and s["link"] == "explicit"
                    and i["status"] in config.RESUMABLE_STATUSES
                    and join.owner_of(sess, i["number"]) is s):
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
        lines.append(f"{p['id']:>3} {p['kind']:<7} #{p['issue']} → {_dest(p['target'])}: {p['summary']}")
    return "\n".join(lines)

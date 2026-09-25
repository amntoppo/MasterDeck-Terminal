from __future__ import annotations

import re
from datetime import date, timedelta

from . import config


def in_current_sprint(sprint: dict | None, today: date) -> bool:
    if not sprint or not sprint.get("startDate"):
        return False
    start = date.fromisoformat(sprint["startDate"])
    return start <= today < start + timedelta(days=int(sprint.get("duration") or 0))


def _issue(item: dict, today: date, assigned_to_me: bool) -> dict:
    c = item["content"]
    sprint = item.get("sprint")
    return {
        "number": c["number"],
        "title": c.get("title") or item.get("title") or "",
        "status": item.get("status"),
        "sprint": sprint["title"] if sprint else None,
        "current_sprint": in_current_sprint(sprint, today),
        "assigned_to_me": assigned_to_me,
        "url": c.get("url"),
    }


def issues(mine_items: list, ready_items: list, today: date) -> list:
    out: dict = {}
    for item in mine_items:
        c = item.get("content") or {}
        if c.get("type") != "Issue" or item.get("status") in config.DONE_STATUSES:
            continue
        out[c["number"]] = _issue(item, today, assigned_to_me=True)
    for item in ready_items:
        c = item.get("content") or {}
        if c.get("type") != "Issue" or item.get("assignees"):
            continue
        if item.get("status") != config.READY_STATUS or not in_current_sprint(item.get("sprint"), today):
            continue
        out.setdefault(c["number"], _issue(item, today, assigned_to_me=False))
    return sorted(out.values(), key=lambda i: i["number"])


ISSUE_REF = re.compile(re.escape(config.issue_ref()) + r"#(\d+)", re.IGNORECASE)


def _last_comment_author(t: dict) -> "str | None":
    nodes = t["comments"]["nodes"]
    if not nodes:
        return None
    return (nodes[-1].get("author") or {}).get("login")


def _pr(node: dict, me: str | None) -> dict:
    # A thread whose last comment is mine doesn't need a session's attention: replying to
    # a thread without resolving it must not re-propose "address N threads" forever.
    unresolved = [t for t in node["reviewThreads"]["nodes"]
                  if not t["isResolved"] and (me is None or _last_comment_author(t) != me)]
    stamps = [t["comments"]["nodes"][-1]["createdAt"] for t in unresolved if t["comments"]["nodes"]]
    commits = node["commits"]["nodes"]
    commit = commits[0]["commit"] if commits else {}
    rollup = commit.get("statusCheckRollup")
    ref = ISSUE_REF.search(node.get("body") or "")
    author = (node.get("author") or {}).get("login")
    return {
        "url": node["url"],
        "repo": node["repository"]["name"],
        "number": node["number"],
        "title": node["title"],
        "author_is_me": bool(me) and author == me,
        "review_requested": False,
        "unresolved_threads": len(unresolved),
        "last_unresolved_at": max(stamps) if stamps else None,
        "ci": rollup["state"].lower() if rollup else None,
        "head_oid": commit.get("oid"),
        "head_ref": node.get("headRefName"),
        "refs_issue": int(ref.group(1)) if ref else None,
        "updated_at": node.get("updatedAt"),
    }


def prs(mine_nodes: list, review_nodes: list, me: str | None) -> list:
    out: dict = {}
    for node in mine_nodes:
        if node and node.get("url"):
            out[node["url"]] = _pr(node, me)
    for node in review_nodes:
        if node and node.get("url"):
            out.setdefault(node["url"], _pr(node, me))["review_requested"] = True
    return sorted(out.values(), key=lambda p: p["url"])

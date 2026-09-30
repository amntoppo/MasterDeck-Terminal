from __future__ import annotations

import re
from datetime import date, timedelta

from . import config, refs


def in_current_sprint(sprint: dict | None, today: date) -> bool:
    if not sprint or not sprint.get("startDate"):
        return False
    start = date.fromisoformat(sprint["startDate"])
    return start <= today < start + timedelta(days=int(sprint.get("duration") or 0))


def _repo(item: dict) -> "str | None":
    """The item's repo as records keep it: None for the primary repo."""
    r = (item.get("content") or {}).get("repository")
    return refs.stored(r if isinstance(r, str) else None)


def _issue(item: dict, today: date, assigned_to_me: bool) -> dict:
    c = item["content"]
    sprint = item.get("sprint")
    return {
        "number": c["number"],
        # None: the primary issue repo (older readers see just the number, as before).
        "repo": _repo(item),
        "project": item.get("project"),
        "title": c.get("title") or item.get("title") or "",
        "status": item.get("status"),
        "sprint": sprint["title"] if sprint else None,
        "current_sprint": in_current_sprint(sprint, today),
        "assigned_to_me": assigned_to_me,
        "url": c.get("url"),
    }


def _ours(item: dict) -> bool:
    c = item.get("content") or {}
    r = c.get("repository")
    return c.get("type") == "Issue" and config.repo_allowed(r if isinstance(r, str) else None)


def issues(mine_items: list, ready_items: list, today: date) -> list:
    """My open issues and the unassigned ready ones of the current sprint, on every board, from
    every selected repo. Each board's own statuses say what is done and what is ready."""
    out: dict = {}
    for item in mine_items:
        c = item.get("content") or {}
        if not _ours(item) or item.get("status") in set(config.statuses_for(item.get("project"))["done"]):
            continue
        out.setdefault(refs.key(_repo(item), c["number"]), _issue(item, today, assigned_to_me=True))
    for item in ready_items:
        c = item.get("content") or {}
        if not _ours(item) or item.get("assignees"):
            continue
        if item.get("status") != config.statuses_for(item.get("project"))["ready"] or not in_current_sprint(item.get("sprint"), today):
            continue
        out.setdefault(refs.key(_repo(item), c["number"]), _issue(item, today, assigned_to_me=False))
    # The primary repo's issues first, as before; then the others by repo.
    return sorted(out.values(), key=lambda i: (i["repo"] is not None, (i["repo"] or "").lower(), i["number"]))


# owner/name#12 in a PR body (babysit-ticket writes "Refs owner/name#12"), for any selected repo;
# a bare "Closes #12" names an issue in the PR's own repo.
FULL_REF = re.compile(r"(?<![\w/.-])([A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100})#(\d+)")
BARE_REF = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#(\d+)", re.IGNORECASE)


def issue_ref_in(body: str, pr_repo: "str | None") -> "tuple[str | None, int] | None":
    """The issue a PR says it is for: (stored repo, number), or None."""
    for m in FULL_REF.finditer(body or ""):
        if config.repo_allowed(m.group(1)) and (config.CONFIG.get("allRepos") or m.group(1).lower() in {r.lower() for r in config.repos()}):
            return refs.stored(m.group(1)), int(m.group(2))
    m = BARE_REF.search(body or "")
    if m and pr_repo and pr_repo.lower() in {r.lower() for r in config.repos()}:
        return refs.stored(pr_repo), int(m.group(1))
    return None


def _last_comment_author(t: dict) -> "str | None":
    nodes = t["comments"]["nodes"]
    if not nodes:
        return None
    return (nodes[-1].get("author") or {}).get("login")


# Bots whose PR comments are review feedback; other bots (deploy previews, coverage) are noise.
REVIEW_BOTS = {"claude", "claude[bot]"}


def _counts(login: "str | None", me: "str | None") -> bool:
    if not login or login == me:
        return False
    return not login.endswith("[bot]") or login.lower() in REVIEW_BOTS


def _pr_comments(node: dict, me: "str | None") -> list:
    """Timestamps of feedback on the PR outside the code threads that came after my last word:
    ordinary PR comments (an edit counts: a reviewer bot fills its comment in later) and
    review summaries (a body, or Changes requested). Comments and reviews of mine mark
    what I have answered."""
    comments = [c for c in ((node.get("comments") or {}).get("nodes") or []) if isinstance(c, dict)]
    reviews = [r for r in ((node.get("reviews") or {}).get("nodes") or []) if isinstance(r, dict)]
    who = lambda x: (x.get("author") or {}).get("login")
    mine = [c.get("updatedAt") for c in comments if me and who(c) == me] + \
           [r.get("submittedAt") for r in reviews if me and who(r) == me]
    last_mine = max((t for t in mine if t), default="")
    theirs = [c.get("updatedAt") for c in comments if _counts(who(c), me)] + \
             [r.get("submittedAt") for r in reviews if _counts(who(r), me)
              and (r.get("state") == "CHANGES_REQUESTED" or (r.get("body") or "").strip())]
    return sorted(t for t in theirs if t and t > last_mine)


def _pr(node: dict, me: str | None) -> dict:
    # A thread whose last comment is mine doesn't need a session's attention: replying to
    # a thread without resolving it must not re-propose "address N threads" forever.
    unresolved = [t for t in node["reviewThreads"]["nodes"]
                  if not t["isResolved"] and (me is None or _last_comment_author(t) != me)]
    stamps = [t["comments"]["nodes"][-1]["createdAt"] for t in unresolved if t["comments"]["nodes"]]
    convo = _pr_comments(node, me)
    commits = node["commits"]["nodes"]
    commit = commits[0]["commit"] if commits else {}
    rollup = commit.get("statusCheckRollup")
    full = node["repository"].get("nameWithOwner")
    ref = issue_ref_in(node.get("body") or "", full)
    author = (node.get("author") or {}).get("login")
    return {
        "url": node["url"],
        "repo": node["repository"]["name"],
        "repo_full": full,
        "number": node["number"],
        "title": node["title"],
        "author_is_me": bool(me) and author == me,
        "review_requested": False,
        "unresolved_threads": len(unresolved),
        "last_unresolved_at": max(stamps) if stamps else None,
        "pr_comments": len(convo),
        "last_pr_comment_at": convo[-1] if convo else None,
        "ci": rollup["state"].lower() if rollup else None,
        "head_oid": commit.get("oid"),
        "head_ref": node.get("headRefName"),
        "refs_issue": ref[1] if ref else None,
        "refs_repo": ref[0] if ref else None,
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

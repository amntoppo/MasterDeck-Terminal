from __future__ import annotations

ME = "alice"


def board_item(n, status, sprint_start=None, assignees=(ME,), typ="Issue", duration=14):
    item = {
        "assignees": list(assignees),
        "content": {"number": n, "title": f"Issue {n}", "type": typ,
                    "url": f"https://github.com/acme/tracker/issues/{n}"},
        "title": f"Issue {n}",
    }
    if status is not None:
        item["status"] = status
    if sprint_start:
        item["sprint"] = {"startDate": sprint_start, "duration": duration, "title": "Sprint 6"}
    return item


def pr_node(number, repo="mobile-app", author=ME, threads=(), ci=None, body="",
            head_oid="abc123", updated="2026-09-24T09:00:00Z", head_ref="feat/x"):
    """threads: list of (is_resolved, last_comment_iso) or (is_resolved, last_comment_iso,
    last_comment_author), default author "reviewer"."""
    def _thread(t):
        r, ts, who = (*t, "reviewer")[:3] if len(t) == 2 else t
        return {"isResolved": r, "comments": {"nodes": [{"createdAt": ts, "author": {"login": who}}]}}

    return {
        "url": f"https://github.com/acme/{repo}/pull/{number}",
        "number": number, "title": f"PR {number}", "updatedAt": updated,
        "headRefName": head_ref, "body": body,
        "repository": {"name": repo},
        "author": {"login": author} if author else None,
        "reviewThreads": {"nodes": [_thread(t) for t in threads]},
        "commits": {"nodes": [{"commit": {"oid": head_oid,
                                          "statusCheckRollup": {"state": ci} if ci else None}}]},
    }


def agent(session_id, name, kind="interactive", status="idle", state=None, cwd="/w", pid=1, bg_id=None):
    a = {"sessionId": session_id, "kind": kind, "cwd": cwd, "startedAt": 0}
    if name is not None:
        a["name"] = name
    if kind == "interactive":
        a["pid"] = pid
        a["status"] = status
    else:
        a["id"] = bg_id or session_id[:8]
        a["state"] = state or "running"
    return a

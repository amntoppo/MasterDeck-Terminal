from __future__ import annotations

from typing import Callable


from . import refs


def _rec(sid, *, name, kind, status, pid, bg_id, cwd) -> dict:
    return {"name": name, "session_id": sid, "pid": pid, "bg_id": bg_id, "kind": kind,
            "status": status, "cwd": cwd, "issue": None, "issue_repo": None, "link": None, "branch": None, "prs": []}


def sessions(agents: list, state: dict, master_name: str,
             cwd_lookup: Callable[[str], "str | None"], superseded=frozenset()) -> list:
    """`superseded`: ids of sessions a copy replaced (config.superseded_ids). While one does not run it
    is left out altogether, so it never owns an issue and is never resumed beside its copy."""
    master_ids = {a["sessionId"] for a in agents if a.get("name") == master_name}
    recs: dict = {}
    gone: set = set()
    for a in agents:
        sid = a["sessionId"]
        if sid in master_ids:
            continue
        background = a.get("kind") == "background"
        if background and a.get("state") == "done":
            continue
        if background and not a.get("pid") and a.get("id") in superseded:
            gone.add(sid)
            continue
        recs[sid] = _rec(
            sid,
            name=a.get("name") or a.get("id") or sid[:8],
            kind=a.get("kind"),
            status=a.get("status") or a.get("state") or "unknown",
            pid=a.get("pid"),
            bg_id=a.get("id") if background else None,
            cwd=a.get("cwd"),
        )
    for sid, entry in (state.get("sessions") or {}).items():
        # Only explicit links count. Older babysit-ticket versions "adopted" a link for any session
        # whose checkout sat on a branch once linked; those were never asked for.
        if sid in master_ids or entry.get("issue") is None or entry.get("adopted"):
            continue
        r = recs.get(sid)
        # Not running (or no longer listed) and superseded: its copy carries the work.
        if sid in gone or (r is None and sid in superseded):
            continue
        if r is None:
            r = recs[sid] = _rec(sid, name=f"dead-{sid[:8]}", kind=None, status="dead",
                                 pid=None, bg_id=None, cwd=cwd_lookup(sid))
        r.update(issue=entry["issue"], issue_repo=refs.stored(entry.get("repo")), link="explicit",
                 branch=entry.get("branch"), prs=list(entry.get("prs") or []))
    return sorted(recs.values(), key=lambda r: (r["status"] == "dead", r["name"]))


def owner_of(sessions: list, issue: "int | None", repo: "str | None" = None) -> "dict | None":
    if issue is None:
        return None
    k = refs.key(repo, issue)
    cands = [s for s in sessions if s["issue"] is not None and refs.key(s.get("issue_repo"), s["issue"]) == k]
    if not cands:
        return None
    return min(cands, key=lambda s: (s["status"] == "dead", s["link"] != "explicit", s["name"]))


def issue_for_pr(pr: dict, sessions: list) -> "tuple[str | None, int] | None":
    """(stored repo, number) of the issue a PR is for: its body's reference, else the session
    that opened it."""
    if pr.get("refs_issue"):
        return pr.get("refs_repo"), pr["refs_issue"]
    for s in sessions:
        if pr["url"] in s["prs"] and s["issue"] is not None:
            return s.get("issue_repo"), s["issue"]
    return None

# lib/master/board.py
"""The current-sprint board for MasterDeck's Board View: issue cards by status, each with its
linked PRs' state. Read-only; the network calls live in collect.py."""
from __future__ import annotations

import json
import re

from . import config

PR_URL = re.compile(r"^https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)$")

_PR_FIELDS = ("number url state isDraft merged "
              "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } "
              "reviewThreads(first: 100) { nodes { isResolved } }")

_CI = {"SUCCESS": "success", "FAILURE": "failure", "ERROR": "failure", "PENDING": "pending", "EXPECTED": "pending"}


def pr_query(urls) -> "tuple[str, dict]":
    """One GraphQL query for every PR: an alias per repository, one per PR inside it.
    Returns the query and {(repo_alias, pr_alias): url}."""
    repos: dict = {}
    for u in dict.fromkeys(urls):
        m = PR_URL.match(u or "")
        if m:
            repos.setdefault((m.group(1), m.group(2)), []).append((int(m.group(3)), u))
    parts, keys = [], {}
    for i, ((owner, name), prs) in enumerate(sorted(repos.items())):
        inner = []
        for n, u in prs:
            inner.append(f"p{n}: pullRequest(number: {n}) {{ {_PR_FIELDS} }}")
            keys[(f"r{i}", f"p{n}")] = u
        parts.append(f'r{i}: repository(owner: "{owner}", name: "{name}") {{ {" ".join(inner)} }}')
    return "query { " + " ".join(parts) + " }", keys


def parse_pr_details(data: dict, keys: dict) -> dict:
    """{url: {state, ci, unresolved}} for every PR the query resolved. state is OPEN, DRAFT
    (open and draft), MERGED or CLOSED."""
    out = {}
    for (r, p), url in keys.items():
        node = ((data or {}).get(r) or {}).get(p)
        if not isinstance(node, dict):
            continue
        state = node.get("state")
        if state == "OPEN" and node.get("isDraft"):
            state = "DRAFT"
        commits = ((node.get("commits") or {}).get("nodes") or [{}])
        rollup = ((commits[-1] or {}).get("commit") or {}).get("statusCheckRollup") or {}
        threads = (node.get("reviewThreads") or {}).get("nodes") or []
        out[url] = {"state": state, "ci": _CI.get(rollup.get("state")),
                    "unresolved": sum(1 for t in threads if isinstance(t, dict) and not t.get("isResolved"))}
    return out


_ITEM = """
  status: fieldValueByName(name: %s) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  %s
  content {
    __typename
    ... on Issue {
      number title url
      repository { nameWithOwner }
      assignees(first: 20) { nodes { login } }
      labels(first: 20) { nodes { name } }
      milestone { title }
      issueType { name }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { url } }
    }
  }
"""

_SPRINT_VALUE = "sprint: fieldValueByName(name: %s) { ... on ProjectV2ItemFieldIterationValue { title startDate duration } }"


def _q(s: str) -> str:
    return json.dumps(s)


def items_query(reqs: list) -> "tuple[str, dict]":
    """One GraphQL query for items of several projects (and several filters of one project):
    reqs is [(alias, project, filter, cursor)]. Owners and projects are aliased; each filter and
    cursor is a variable. Returns the query and its variables."""
    by_owner: dict = {}
    for alias, p, flt, cursor in reqs:
        by_owner.setdefault((p["owner"], p["ownerType"]), []).append((alias, p, flt, cursor))
    decl, variables, parts = [], {}, []
    for oi, ((owner, kind), rs) in enumerate(sorted(by_owner.items())):
        inner = []
        for alias, p, flt, cursor in rs:
            decl += [f"$q_{alias}: String!", f"$c_{alias}: String"]
            variables[f"q_{alias}"] = flt
            if cursor:
                variables[f"c_{alias}"] = cursor
            sprint = _SPRINT_VALUE % _q(p["sprintField"]) if p.get("sprintField") else ""
            inner.append(f"{alias}: projectV2(number: {int(p['number'])}) {{ items(first: 100, after: $c_{alias}, query: $q_{alias}) "
                         f"{{ pageInfo {{ hasNextPage endCursor }} nodes {{ {_ITEM % (_q(p['statusField']), sprint)} }} }} }}")
        root = "user" if kind == "user" else "organization"
        parts.append(f"o{oi}: {root}(login: {_q(owner)}) {{ {' '.join(inner)} }}")
    return f"query({', '.join(decl)}) {{ {' '.join(parts)} }}", variables


def items_page(data: dict, alias: str) -> "tuple[list, str | None]":
    """The items of one alias, in `gh project item-list --format json` shape, and the next cursor."""
    for owner in (data or {}).values():
        conn = ((owner or {}).get(alias) or {}).get("items") if isinstance(owner, dict) else None
        if conn is None:
            continue
        out = []
        for n in conn.get("nodes") or []:
            c = (n or {}).get("content") or {}
            if c.get("__typename") != "Issue" or not isinstance(c.get("number"), int):
                out.append({"content": {"type": c.get("__typename")}})
                continue
            ms = c.get("milestone")
            out.append({
                "content": {"type": "Issue", "number": c["number"], "title": c.get("title") or "", "url": c.get("url") or "",
                            "repository": (c.get("repository") or {}).get("nameWithOwner")},
                "status": ((n.get("status") or {}).get("name")),
                "sprint": n.get("sprint") if isinstance(n.get("sprint"), dict) and n["sprint"].get("title") else None,
                "assignees": [a["login"] for a in (c.get("assignees") or {}).get("nodes") or [] if a and a.get("login")],
                "labels": [x["name"] for x in (c.get("labels") or {}).get("nodes") or [] if x and x.get("name")],
                "milestone": {"title": ms["title"]} if isinstance(ms, dict) and ms.get("title") else None,
                "issue type": ((c.get("issueType") or {}).get("name")),
                "linked pull requests": [x["url"] for x in (c.get("closedByPullRequestsReferences") or {}).get("nodes") or [] if x and x.get("url")],
            })
        page = conn.get("pageInfo") or {}
        return out, (page.get("endCursor") if page.get("hasNextPage") else None)
    return [], None


def sprints_query(projects: list) -> str:
    """Every project's sprint (iteration) field, in one query."""
    by_owner: dict = {}
    for i, p in enumerate(projects):
        if p.get("sprintField"):
            by_owner.setdefault((p["owner"], p["ownerType"]), []).append((i, p))
    parts = []
    for oi, ((owner, kind), ps) in enumerate(sorted(by_owner.items())):
        inner = [f"p{i}: projectV2(number: {int(p['number'])}) {{ field(name: {_q(p['sprintField'])}) {{ ... on ProjectV2IterationField {{ configuration {{ "
                 f"iterations {{ id title startDate duration }} completedIterations {{ id title startDate duration }} }} }} }} }}"
                 for i, p in ps]
        parts.append(f"o{oi}: {'user' if kind == 'user' else 'organization'}(login: {_q(owner)}) {{ {' '.join(inner)} }}")
    return "query { " + " ".join(parts) + " }" if parts else ""


def merge_sprints(sprints: list) -> list:
    """A title several boards (or accounts) share is one sprint: its boards joined, completed only
    where every one has it completed; newest first."""
    out: dict = {}
    for sp in sprints:
        cur = out.get(sp["title"])
        if cur is None:
            out[sp["title"]] = dict(sp)
            continue
        cur["completed"] = bool(cur.get("completed")) and bool(sp.get("completed"))
        cur["projects"] = list(dict.fromkeys([*(cur.get("projects") or []), *(sp.get("projects") or [])]))
    return sorted(out.values(), key=lambda s: s.get("startDate") or "", reverse=True)


def parse_sprints(data: dict, projects: list) -> list:
    """Every iteration of every project's sprint field, newest first, completed ones marked. A
    title that several boards share is one sprint (it filters each of them)."""
    found: list = []
    for owner in (data or {}).values():
        if not isinstance(owner, dict):
            continue
        for alias, proj in owner.items():
            cfg = (((proj or {}).get("field") or {}).get("configuration") or {}) if isinstance(proj, dict) else {}
            key = config.project_key(projects[int(alias[1:])]) if alias[1:].isdigit() and int(alias[1:]) < len(projects) else None
            for done, lst in ((False, cfg.get("iterations")), (True, cfg.get("completedIterations"))):
                found += [dict(it, completed=done, projects=[key] if key else []) for it in lst or []
                          if isinstance(it.get("title"), str)]
    return merge_sprints(found)


def sprint_query(sprint: str, mine: bool) -> str:
    """The item-list filter for one sprint: @current, a sprint title, or none (no sprint)."""
    if '"' in sprint or "\\" in sprint:
        raise ValueError(f"bad sprint name: {sprint!r}")
    part = ("sprint:@current" if sprint == "@current" else "no:sprint" if sprint == "none"
            else f'sprint:"{sprint}"')
    return "is:issue " + ("assignee:@me " if mine else "") + part


def _names(v) -> list:
    return [x if isinstance(x, str) else (x or {}).get("name") for x in (v or []) if x]


def linked_prs(items: list) -> list:
    return [u for it in items for u in (it.get("linked pull requests") or []) if isinstance(u, str)]


def build(items: list, pr_details: dict, now_iso: str) -> dict:
    cards, statuses, sprint = [], [], None
    seen = set()
    for it in items:
        c = it.get("content") or {}
        if c.get("type") != "Issue" or not isinstance(c.get("number"), int):
            continue
        repo = c.get("repository") if isinstance(c.get("repository"), str) else None
        if not config.repo_allowed(repo):
            continue
        # The same issue on two boards is one card (the first board's status).
        k = ((repo or config.primary_repo()).lower(), c["number"])
        if k in seen:
            continue
        seen.add(k)
        status = it.get("status")
        if status and status not in statuses:
            statuses.append(status)
        sprint = sprint or (it.get("sprint") or {}).get("title")
        prs = []
        for u in it.get("linked pull requests") or []:
            m = PR_URL.match(u) if isinstance(u, str) else None
            if not m:
                continue
            d = pr_details.get(u) or {}
            prs.append({"url": u, "owner": m.group(1), "repo": m.group(2), "number": int(m.group(3)),
                        "state": d.get("state"), "ci": d.get("ci"), "unresolved": d.get("unresolved", 0)})
        ms = it.get("milestone")
        cards.append({"number": c["number"], "repo": repo or config.primary_repo() or None, "project": it.get("project"),
                      "title": c.get("title") or it.get("title") or "", "url": c.get("url") or "",
                      "status": status or None, "prs": prs,
                      "assignees": [a for a in it.get("assignees") or [] if isinstance(a, str)],
                      "labels": [n for n in _names(it.get("labels")) if isinstance(n, str)],
                      "milestone": ms if isinstance(ms, str) else (ms or {}).get("title") if isinstance(ms, dict) else None,
                      "type": it.get("issue type") if isinstance(it.get("issue type"), str) else None,
                      # The account whose read found it (two or more connected); absent with one.
                      **({"account": it["account"]} if isinstance(it.get("account"), str) else {})})
    base = [c for p in config.projects() for c in p["columns"]] or list(config.BOARD_COLUMNS)
    base = list(dict.fromkeys(base))
    columns = base + [s for s in statuses if s not in base]
    # Each board's own columns, for a view that shows only some boards.
    boards = [{"key": config.project_key(p), "title": p["title"], "columns": p["columns"]} for p in config.projects()]
    return {"taken_at": now_iso, "sprint": sprint, "columns": columns, "cards": cards, "projects": boards}

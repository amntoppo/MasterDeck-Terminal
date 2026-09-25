# lib/master/board.py
"""The current-sprint board for MasterDeck's Board View: issue cards by status, each with its
linked PRs' state. Read-only; the network calls live in collect.py."""
from __future__ import annotations

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


SPRINTS_QUERY = """
query {
  %s(login: "%s") {
    projectV2(number: %d) {
      field(name: "%s") {
        ... on ProjectV2IterationField {
          configuration {
            iterations { id title startDate duration }
            completedIterations { id title startDate duration }
          }
        }
      }
    }
  }
}
""" % (config.OWNER_TYPE, config.OWNER, config.PROJECT, config.SPRINT_FIELD)


def sprint_query(sprint: str, mine: bool) -> str:
    """The item-list filter for one sprint: @current, a sprint title, or none (no sprint)."""
    if '"' in sprint or "\\" in sprint:
        raise ValueError(f"bad sprint name: {sprint!r}")
    part = ("sprint:@current" if sprint == "@current" else "no:sprint" if sprint == "none"
            else f'sprint:"{sprint}"')
    return "is:issue " + ("assignee:@me " if mine else "") + part


def parse_sprints(data: dict) -> list:
    """Every iteration of the Sprint field, newest first, completed ones marked."""
    cfg = ((((data or {}).get(config.OWNER_TYPE) or {}).get("projectV2") or {}).get("field") or {}).get("configuration") or {}
    out = [dict(s, completed=False) for s in cfg.get("iterations") or []]
    out += [dict(s, completed=True) for s in cfg.get("completedIterations") or []]
    out = [s for s in out if isinstance(s.get("title"), str)]
    return sorted(out, key=lambda s: s.get("startDate") or "", reverse=True)


def _names(v) -> list:
    return [x if isinstance(x, str) else (x or {}).get("name") for x in (v or []) if x]


def linked_prs(items: list) -> list:
    return [u for it in items for u in (it.get("linked pull requests") or []) if isinstance(u, str)]


def build(items: list, pr_details: dict, now_iso: str) -> dict:
    cards, statuses, sprint = [], [], None
    for it in items:
        c = it.get("content") or {}
        if c.get("type") != "Issue" or not isinstance(c.get("number"), int):
            continue
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
            prs.append({"url": u, "repo": m.group(2), "number": int(m.group(3)),
                        "state": d.get("state"), "ci": d.get("ci"), "unresolved": d.get("unresolved", 0)})
        ms = it.get("milestone")
        cards.append({"number": c["number"], "title": c.get("title") or it.get("title") or "", "url": c.get("url") or "",
                      "status": status or None, "prs": prs,
                      "assignees": [a for a in it.get("assignees") or [] if isinstance(a, str)],
                      "labels": [n for n in _names(it.get("labels")) if isinstance(n, str)],
                      "milestone": ms if isinstance(ms, str) else (ms or {}).get("title") if isinstance(ms, dict) else None,
                      "type": it.get("issue type") if isinstance(it.get("issue type"), str) else None})
    columns = list(config.BOARD_COLUMNS) + [s for s in statuses if s not in config.BOARD_COLUMNS]
    return {"taken_at": now_iso, "sprint": sprint, "columns": columns, "cards": cards}

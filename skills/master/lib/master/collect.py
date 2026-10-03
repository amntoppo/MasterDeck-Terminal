from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from urllib.parse import quote

from . import config

PR_QUERY = """
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        url number title updatedAt headRefName body
        repository { name nameWithOwner }
        author { login }
        reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { createdAt author { login } } } } }
        comments(last: 30) { nodes { updatedAt author { login } } }
        reviews(last: 30) { nodes { state submittedAt body author { login } } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      }
    }
  }
}
"""

def _mine_query(p: dict) -> str:
    """My open work on one board: leaves out its finished statuses."""
    fin = p["statuses"].get("finished") or p["statuses"].get("done") or []
    return "is:issue assignee:@me" + (" -status:" + ",".join(json.dumps(x) for x in fin) if fin else "")


def _ready_query(p: dict) -> str:
    return f'is:issue status:{json.dumps(p["statuses"]["ready"])}'


# How long each kind of GitHub read may be reused from the shared cache (ghcache): the board
# and PR search change slowly relative to how often sessions and the app ask for them.
GH_TTL = {"user": 86_400, "project": 300, "graphql": 120, "commits": 60}


def _gh_ttl(cmd: list) -> int:
    if cmd[1:3] == ["api", "user"]:
        return GH_TTL["user"]
    if cmd[1:2] == ["project"]:
        return GH_TTL["project"]
    if cmd[1:3] == ["api", "graphql"]:
        return GH_TTL["graphql"]
    return GH_TTL["commits"]


def _run(cmd: list, timeout: int = 120) -> str:
    if cmd and cmd[0] == "gh" and os.environ.get("MASTER_NO_GH_CACHE") != "1":
        # Every GitHub read goes through the cache shared with the babysit skills and MasterDeck.
        from . import ghcache
        code, out, err = ghcache.run(cmd[1:], ttl=_gh_ttl(cmd))
        if code != 0:
            raise RuntimeError((err.decode(errors="replace") or out.decode(errors="replace") or f"exit {code}").strip())
        return out.decode(errors="replace")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or f"exit {r.returncode}").strip())
    return r.stdout


def local_branch_head(repos_root: Path, branch_key: str) -> "str | None":
    """SHA of the branch in the local clone at <repos_root>/<repo name>, or None."""
    repo, branch = branch_key.split("@", 1)
    path = repos_root / repo.split("/", 1)[1]
    if not (path / ".git").exists():
        return None
    r = subprocess.run(["git", "-C", str(path), "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
                       capture_output=True, text=True, timeout=30)
    return (r.stdout.strip() or None) if r.returncode == 0 else None


def links_state(home: Path) -> dict:
    """Session <-> ticket links: MasterDeck's ticket-links.json (it imported babysit-ticket's
    state.json once; master never reads that file)."""
    try:
        raw = json.loads((home / "ticket-links.json").read_text())
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    return {"sessions": raw.get("sessions") or {}, "branches": raw.get("branches") or {}}


class Live:
    """Reads the real system. Read-only: never writes to GitHub or messages a session."""

    def me(self) -> str:
        return _run(["gh", "api", "user", "--jq", ".login"]).strip()

    def project_items(self, reqs: list, max_pages: int = 20) -> dict:
        """Items of every (alias, project, filter) at once: one GraphQL call per page round,
        every project and filter in it; later rounds only for the ones with more pages.
        Each item carries its project's key."""
        from . import board
        pending = {alias: (p, flt, None) for alias, p, flt in reqs}
        out: dict = {alias: [] for alias, _, _ in reqs}
        for _ in range(max_pages):
            if not pending:
                break
            query, variables = board.items_query([(a, p, f, c) for a, (p, f, c) in pending.items()])
            args = ["gh", "api", "graphql", "-f", f"query={query}"]
            for k, v in variables.items():
                args += ["-f", f"{k}={v}"]
            data = json.loads(_run(args)).get("data") or {}
            for alias in list(pending):
                p, flt, _ = pending[alias]
                items, cursor = board.items_page(data, alias)
                key = config.project_key(p)
                out[alias] += [dict(it, project=key) for it in items]
                if cursor:
                    pending[alias] = (p, flt, cursor)
                else:
                    del pending[alias]
        return out

    def board_mine_ready(self) -> "tuple[list, list]":
        """My open issues and the ready ones, on every board, in one round of GraphQL."""
        ps = config.projects()
        got = self.project_items([(f"m{i}", p, _mine_query(p)) for i, p in enumerate(ps)] +
                                 [(f"r{i}", p, _ready_query(p)) for i, p in enumerate(ps)])
        mine = [it for i in range(len(ps)) for it in got[f"m{i}"]]
        ready = [it for i in range(len(ps)) for it in got[f"r{i}"]]
        return mine, ready

    def board_mine(self) -> list:
        return self.board_mine_ready()[0]

    def board_ready(self) -> list:
        return self.board_mine_ready()[1]

    def board_sprint(self, query: str = config.BOARD_SPRINT_QUERY) -> list:
        ps = config.projects()
        got = self.project_items([(f"b{i}", p, query) for i, p in enumerate(ps)])
        return [it for i in range(len(ps)) for it in got[f"b{i}"]]

    def sprints(self) -> list:
        from . import board
        ps = config.projects()
        query = board.sprints_query(ps)
        if not query:
            return []
        out = json.loads(_run(["gh", "api", "graphql", "-f", f"query={query}"]))
        return board.parse_sprints(out.get("data") or {}, ps)

    def pr_details(self, urls: list) -> dict:
        from . import board
        query, keys = board.pr_query(urls)
        if not keys:
            return {}
        out = json.loads(_run(["gh", "api", "graphql", "-f", f"query={query}"]))
        return board.parse_pr_details(out.get("data") or {}, keys)

    def _prs(self, q: str) -> list:
        out = _run(["gh", "api", "graphql", "-f", f"q={q}", "-f", f"query={PR_QUERY}"])
        return json.loads(out)["data"]["search"]["nodes"]

    def _owners_qualifier(self) -> str:
        """org:a user:b ... for every owner of a selected repo or board (GitHub ORs them)."""
        owners = {}
        for r in config.repos():
            owners.setdefault(r.split("/", 1)[0], "org" if config.OWNER_TYPE != "user" or r.split("/", 1)[0] != config.OWNER else "user")
        for p in config.projects():
            owners.setdefault(p["owner"], "user" if p["ownerType"] == "user" else "org")
        return " ".join(f"{k}:{o}" for o, k in owners.items()) or config.OWNER_QUALIFIER

    def prs_mine(self) -> list:
        return self._prs(f"{self._owners_qualifier()} is:pr is:open author:@me")

    def prs_review(self) -> list:
        return self._prs(f"{self._owners_qualifier()} is:pr is:open review-requested:@me")

    def agents(self) -> list:
        return json.loads(_run(["claude", "agents", "--json"]))

    def state(self) -> dict:
        return links_state(config.masterdeck_home())

    def branch_head(self, branch_key: str) -> str:
        # Local first: unpushed commits are real progress, and a branch deleted on GitHub
        # after merge may still exist locally. GitHub covers repos not cloned beside the workspace.
        local = local_branch_head(config.workspace().parent, branch_key)
        if local:
            return local
        repo, branch = branch_key.split("@", 1)
        return _run(["gh", "api", f"repos/{repo}/commits/{quote(branch, safe='')}", "--jq", ".sha"]).strip()

    def session_cwd(self, session_id: str) -> "str | None":
        for f in (Path.home() / ".claude" / "projects").glob(f"*/{session_id}.jsonl"):
            with f.open() as fh:
                for line in fh:
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(d, dict) and d.get("cwd"):
                        return d["cwd"]
        return None


class Fixtures:
    """Reads canned data from a directory, for tests and dry runs."""

    def __init__(self, directory: Path):
        self.dir = Path(directory)

    def _json(self, name: str):
        return json.loads((self.dir / name).read_text())

    def me(self) -> str: return (self.dir / "me.txt").read_text().strip()
    def board_mine(self) -> list: return self._json("board_mine.json")
    def board_ready(self) -> list: return self._json("board_ready.json")
    def board_mine_ready(self) -> "tuple[list, list]": return self.board_mine(), self.board_ready()
    def board_sprint(self, query: str = "") -> list: return self._json("board_sprint.json")
    def sprints(self) -> list: return self._json("sprints.json")
    def pr_details(self, urls: list) -> dict: return self._json("board_prs.json")
    def prs_mine(self) -> list: return self._json("prs_mine.json")
    def prs_review(self) -> list: return self._json("prs_review.json")
    def agents(self) -> list: return self._json("agents.json")
    def state(self) -> dict: return self._json("state.json")
    def branch_head(self, branch_key: str) -> str: return self._json("branch_heads.json")[branch_key]

    def session_cwd(self, session_id: str) -> "str | None":
        p = self.dir / "cwds.json"
        return json.loads(p.read_text()).get(session_id) if p.exists() else None

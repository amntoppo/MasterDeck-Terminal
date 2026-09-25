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
        repository { name }
        author { login }
        reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { createdAt author { login } } } } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      }
    }
  }
}
"""

BOARD_MINE_QUERY = ('is:issue assignee:@me -status:"QA Done","Qa Done Prod","Invalid",'
                    '"Stage Done","Dev Deployed"')
BOARD_READY_QUERY = f'is:issue status:"{config.READY_STATUS}"'


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


class Live:
    """Reads the real system. Read-only: never writes to GitHub or messages a session."""

    def me(self) -> str:
        return _run(["gh", "api", "user", "--jq", ".login"]).strip()

    def _board(self, query: str) -> list:
        out = _run(["gh", "project", "item-list", str(config.PROJECT), "--owner", config.OWNER,
                    "--limit", "500", "--format", "json", "--query", query])
        return json.loads(out)["items"]

    def board_mine(self) -> list:
        return self._board(BOARD_MINE_QUERY)

    def board_ready(self) -> list:
        return self._board(BOARD_READY_QUERY)

    def board_sprint(self, query: str = config.BOARD_SPRINT_QUERY) -> list:
        return self._board(query)

    def sprints(self) -> list:
        from . import board
        out = json.loads(_run(["gh", "api", "graphql", "-f", f"query={board.SPRINTS_QUERY}"]))
        return board.parse_sprints(out.get("data") or {})

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

    def prs_mine(self) -> list:
        return self._prs(f"{config.OWNER_QUALIFIER} is:pr is:open author:@me")

    def prs_review(self) -> list:
        return self._prs(f"{config.OWNER_QUALIFIER} is:pr is:open review-requested:@me")

    def agents(self) -> list:
        return json.loads(_run(["claude", "agents", "--json"]))

    def state(self) -> dict:
        p = Path.home() / ".claude" / "babysit-ticket" / "state.json"
        return json.loads(p.read_text()) if p.exists() else {"sessions": {}}

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

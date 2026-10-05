from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from datetime import date
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


def account_token(login: str, runner=subprocess.run) -> "str | None":
    """gh's stored token for one of its logins (gh auth token --user), or None. Never logged."""
    try:
        r = runner(["gh", "auth", "token", "--hostname", "github.com", "--user", login],
                   capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    tok = (r.stdout or "").strip()
    return tok if r.returncode == 0 and tok else None


def _has_data(out: str) -> bool:
    """A GraphQL answer that still carries data: gh exits 1 on a partial error (one repository of
    several is gone) but prints what it got."""
    try:
        got = json.loads(out)
        data = got.get("data")
    except (ValueError, AttributeError):
        return False
    if not isinstance(data, dict):
        return False
    if any(v is not None for v in data.values()):
        return True
    # Every repository gone: GitHub says so with NOT_FOUND errors and nothing else.
    errs = got.get("errors")
    return bool(data) and isinstance(errs, list) and bool(errs) and all(
        isinstance(e, dict) and e.get("type") == "NOT_FOUND" for e in errs)


MISSING_TTL = 3600  # seconds a repository GitHub answered nothing for stays out of the query


def _missing_file() -> Path:
    return config.masterdeck_home() / "missing-repos.json"


def _load_missing(key: str) -> dict:
    try:
        got = json.loads(_missing_file().read_text()).get(key)
        return {r: t for r, t in got.items() if isinstance(t, (int, float))} if isinstance(got, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def _save_missing(key: str, repos: dict) -> None:
    """Remember the repositories that came back null. A partial answer makes gh exit 1 and the
    cache stores only exit 0, so without this a stale repository would defeat the cache."""
    try:
        path = _missing_file()
        try:
            allm = json.loads(path.read_text())
            allm = allm if isinstance(allm, dict) else {}
        except (OSError, ValueError):
            allm = {}
        allm[key] = repos
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".missing-")
        with os.fdopen(fd, "w") as f:
            json.dump(allm, f)
        os.replace(tmp, path)
    except OSError:
        pass  # only an optimisation


def _run(cmd: list, timeout: int = 120, env: "dict | None" = None, partial: bool = False) -> str:
    """`env`: one account's GH_TOKEN and GHC_ACCOUNT (None: the inherited environment, as before).
    `partial`: a GraphQL answer that carries data is returned even when gh exits 1."""
    if cmd and cmd[0] == "gh" and os.environ.get("MASTER_NO_GH_CACHE") != "1":
        # Every GitHub read goes through the cache shared with the babysit skills and MasterDeck.
        from . import ghcache
        code, out, err = ghcache.run(cmd[1:], ttl=_gh_ttl(cmd), env=env)
        text = out.decode(errors="replace")
        if code != 0 and not (partial and _has_data(text)):
            raise RuntimeError((err.decode(errors="replace") or text or f"exit {code}").strip())
        return text
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, **env} if env else None)
    if r.returncode != 0 and not (partial and _has_data(r.stdout)):
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
    """Reads the real system. Read-only: never writes to GitHub or messages a session. `cfg`: one
    account's view (its repos and boards; None: the whole config); `env`: its GH_TOKEN and
    GHC_ACCOUNT; `error`: why its GitHub reads can't run (gh has no token for it)."""

    def __init__(self, cfg: "dict | None" = None, env: "dict | None" = None, error: "str | None" = None):
        self.cfg, self.env, self.error = cfg, env, error

    @classmethod
    def for_account(cls, view: dict, runner=subprocess.run) -> "Live":
        tok = account_token(view["login"], runner)
        if not tok:
            return cls(view, None, f"gh is not logged in to {view['login']}")
        return cls(view, {"GH_TOKEN": tok, "GHC_ACCOUNT": view["login"]})

    def _gh(self, cmd: list, partial: bool = False) -> str:
        if self.error:
            raise RuntimeError(self.error)
        return _run(cmd, env=self.env, partial=True) if partial else _run(cmd, env=self.env)

    def me(self) -> str:
        return self._gh(["gh", "api", "user", "--jq", ".login"]).strip()

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
            data = json.loads(self._gh(args)).get("data") or {}
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
        ps = config.projects(self.cfg)
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
        from . import board
        ps = config.projects(self.cfg)
        # A board with no sprint field (MasterDeck made it): the sprint part would match nothing.
        got = self.project_items([(f"b{i}", p, board.sprintless_query(query) if p.get("sprintless") else query)
                                  for i, p in enumerate(ps)])
        return [it for i in range(len(ps)) for it in got[f"b{i}"]]

    def repo_issues(self, today: date) -> dict:
        """The issues of this account's ticked repositories, for an account with no board: open
        ones and the ones closed lately. {"items", "total" (open issues GitHub counts), "repos"
        (read), "skipped" (past DERIVED_MAX_REPOS), "missing" (GitHub answered nothing for), "unread"
        ({repo: GraphQL error type} of the missing ones not remembered: asked again next call)}.
        One GraphQL call for every repository; up to two more for repositories with further
        pages, while fewer than DERIVED_MAX_CARDS open issues were read."""
        from . import board
        ticked = config.repos(self.cfg)
        repos = ticked[:config.DERIVED_MAX_REPOS]
        since = board.done_since(today)
        key, now = (self.cfg or {}).get("login") or "", time.time()
        # A forced read (the Board's Refresh or Retry: GHC_FORCE=1) asks for every repository again;
        # one still NOT_FOUND is remembered from now, one that answers is forgotten.
        forced = os.environ.get("GHC_FORCE") == "1"
        known = {} if forced else {r: t for r, t in _load_missing(key).items() if now - t < MISSING_TTL}
        pending = {f"r{i}": (r, None) for i, r in enumerate(repos) if r not in known}
        items, total, missing, first = [], 0, [r for r in repos if r in known], True
        found, unread = {}, {}
        for _ in range(3):
            if not pending:
                break
            query, variables = board.repo_issues_query([(a, r, c, first) for a, (r, c) in pending.items()], since)
            args = ["gh", "api", "graphql", "-f", f"query={query}"]
            for k, v in variables.items():
                args += ["-f", f"{k}={v}"]
            answer = json.loads(self._gh(args, partial=True))
            data = answer.get("data") or {}
            # Only GitHub saying NOT_FOUND for that alias is remembered; a null from a rate limit,
            # a forbidden or a timeout must not hide a healthy repository for an hour.
            gone = {e["path"][0]: e.get("type") for e in answer.get("errors") or []
                    if isinstance(e, dict) and isinstance(e.get("path"), list) and e["path"]}
            for alias in list(pending):
                repo, _cursor = pending[alias]
                got, cursor, count = board.repo_issues_page(data, alias, repo)
                if first:
                    total += count
                    if not isinstance(data.get(alias), dict):
                        missing.append(repo)
                        if gone.get(alias) == "NOT_FOUND":
                            found[repo] = now
                        else:
                            unread[repo] = gone.get(alias) or "unknown"
                items += got
                if cursor and sum(1 for it in items if it["state"] == "OPEN") < config.DERIVED_MAX_CARDS:
                    pending[alias] = (repo, cursor)
                else:
                    del pending[alias]
            first = False
        if found or known != _load_missing(key):
            _save_missing(key, {**known, **found})
        return {"items": items, "total": total, "repos": repos, "skipped": ticked[len(repos):], "missing": missing,
                "unread": unread}

    def sprints(self) -> list:
        from . import board
        ps = config.projects(self.cfg)
        query = board.sprints_query(ps)
        if not query:
            return []
        out = json.loads(self._gh(["gh", "api", "graphql", "-f", f"query={query}"]))
        return board.parse_sprints(out.get("data") or {}, ps)

    def pr_details(self, urls: list) -> dict:
        from . import board
        query, keys = board.pr_query(urls)
        if not keys:
            return {}
        out = json.loads(self._gh(["gh", "api", "graphql", "-f", f"query={query}"]))
        return board.parse_pr_details(out.get("data") or {}, keys)

    def _prs(self, q: str) -> list:
        out = self._gh(["gh", "api", "graphql", "-f", f"q={q}", "-f", f"query={PR_QUERY}"])
        return json.loads(out)["data"]["search"]["nodes"]

    def _owners_qualifier(self) -> str:
        """org:a user:b ... for every owner of a selected repo or board (GitHub ORs them)."""
        view = self.cfg or config.CONFIG
        user_owner = view.get("owner") if view.get("ownerType") == "user" else None
        owners: dict = {}
        for r in config.repos(self.cfg):
            o = r.split("/", 1)[0]
            owners.setdefault(o, "user" if o == user_owner else "org")
        for p in config.projects(self.cfg):
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
        return self._gh(["gh", "api", f"repos/{repo}/commits/{quote(branch, safe='')}", "--jq", ".sha"]).strip()

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
    def repo_issues(self, today=None) -> dict: return self._json("repo_issues.json")
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

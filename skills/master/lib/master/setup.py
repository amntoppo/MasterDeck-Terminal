# lib/master/setup.py
"""`master config ...`: read, detect and save the per-user config (see config.py).

    master config show                 the config as JSON, with "configured" and "path"
    master config get <key>            one value (dotted: statuses.inProgress); strings print bare
    master config shell                shell assignments and functions for tt.sh (eval them)
    master config detect --owner O [--project N]
                                       what GitHub has: owner type, repos, projects, and for a
                                       project its status options, ids and a guessed mapping
    master config detect --all         every owner gh can reach (the user and their orgs), with
                                       their repos and projects (status options, guessed
                                       mapping, sprint field): two GraphQL calls in all
    master config save < json          merge JSON from stdin into the saved config
"""
from __future__ import annotations

import copy
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

from . import config


def _gh_json(args: list) -> "object | None":
    try:
        r = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None


def _match(cols: list, pattern: str, default: "str | None" = None) -> "str | None":
    rx = re.compile(pattern, re.I)
    return next((c for c in cols if rx.search(c)), default)


def guess_statuses(cols: list) -> dict:
    """A best guess at what each board status means, from its name and position."""
    if not cols:
        return dict(config.DEFAULTS["statuses"])
    ready = _match(cols, r"ready") or _match(cols, r"to ?do|backlog", cols[0])
    in_progress = _match(cols, r"in ?dev|in ?progress|doing|progress|develop", ready)
    pr_raised = _match(cols, r"\bpr\b|review", in_progress)
    dev_done = _match(cols, r"dev ?done|^done$|complete|merged|done", cols[-1])
    reopen = [c for c in cols if re.search(r"re-?open", c, re.I)]
    blocked = [c for c in cols if re.search(r"block", c, re.I)]
    invalid = [c for c in cols if re.search(r"invalid|won'?t|cancel|duplicate", c, re.I)]
    i_done = cols.index(dev_done)
    done = [c for c in cols[i_done:] if c not in reopen and c not in blocked] + [c for c in invalid if c not in cols[i_done:]]
    i_prog = cols.index(in_progress)
    assignable = [c for c in cols[:i_prog] if c not in blocked] + [c for c in reopen if c not in cols[:i_prog]]
    resumable = list(dict.fromkeys([in_progress, pr_raised, *reopen]))
    # Forward-only order: board position, except that re-open and blocked sit with "ready".
    rank = {c: i for i, c in enumerate(cols)}
    for c in reopen + blocked:
        rank[c] = rank[ready]
    for c in invalid:
        rank[c] = 99
    finished = [c for c in done if c != dev_done] or done
    return {"ready": ready, "inProgress": in_progress, "prRaised": pr_raised, "devDone": dev_done,
            "blocked": blocked, "done": done, "finished": finished, "assignable": assignable, "resumable": resumable, "rank": rank}


def detect(owner: str, project: "int | None") -> dict:
    out: dict = {"owner": owner}
    user = _gh_json(["api", f"users/{owner}"])
    if not isinstance(user, dict):
        return {**out, "error": f"GitHub has no account named {owner!r}, or gh is not logged in (run: gh auth login)"}
    out["ownerType"] = "user" if user.get("type") == "User" else "organization"
    repos = _gh_json(["repo", "list", owner, "--limit", "300", "--json", "name,pushedAt"])
    out["repos"] = sorted((r["name"] for r in repos or [] if isinstance(r, dict) and r.get("name")), key=str.lower)
    projects = _gh_json(["project", "list", "--owner", owner, "--format", "json", "--limit", "100"])
    plist = (projects or {}).get("projects", []) if isinstance(projects, dict) else []
    out["projects"] = [{"number": p.get("number"), "title": p.get("title"), "id": p.get("id")} for p in plist if p.get("number")]
    if not out["projects"] and projects is None:
        out["projectsError"] = "could not list projects (gh needs the 'project' scope: gh auth refresh -s project)"
    if project:
        fields = _gh_json(["project", "field-list", str(project), "--owner", owner, "--format", "json", "--limit", "100"])
        flist = (fields or {}).get("fields", []) if isinstance(fields, dict) else []
        status = next((f for f in flist if f.get("name") == "Status" and f.get("options")), None) \
            or next((f for f in flist if f.get("options")), None)
        cols = [o["name"] for o in (status or {}).get("options", [])]
        iteration = next((f for f in flist if f.get("type") == "ProjectV2IterationField"), None)
        proj = next((p for p in out["projects"] if p["number"] == project), {})
        out["board"] = {
            "project": project,
            "projectId": proj.get("id", ""),
            "statusFieldId": (status or {}).get("id", ""),
            "statusOptions": {o["name"]: o["id"] for o in (status or {}).get("options", [])},
            "columns": cols,
            "statuses": guess_statuses(cols),
            "sprintField": (iteration or {}).get("name", ""),
        }
        if not status:
            out["board"]["error"] = "no single-select Status field found on that project"
    return out


_LOGIN = re.compile(r"[A-Za-z0-9-]{1,39}")

_OWNER_FIELDS = """
  login
  repositories(first: 100, %s orderBy: {field: PUSHED_AT, direction: DESC}) {
    nodes { name nameWithOwner isArchived hasIssuesEnabled issues(states: OPEN) { totalCount } }
  }
  projectsV2(first: 50) {
    nodes {
      number title id closed
      items { totalCount }
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2SingleSelectField { id name options { id name } }
          ... on ProjectV2IterationField { id name }
        }
      }
    }
  }
"""


def owners_query(owners: list) -> str:
    """One query for every owner: a user's own repos, an org's repos, and their projects."""
    parts = []
    for i, (login, kind) in enumerate(owners):
        if not _LOGIN.fullmatch(login):
            raise ValueError(f"not a GitHub login: {login!r}")
        root = "user" if kind == "user" else "organization"
        aff = "ownerAffiliations: OWNER," if kind == "user" else ""
        parts.append(f'o{i}: {root}(login: "{login}") {{ {_OWNER_FIELDS % aff} }}')
    return "query { " + " ".join(parts) + " }"


def _board_of(p: dict, owner: str, kind: str) -> dict:
    fields = [f for f in (p.get("fields") or {}).get("nodes") or [] if isinstance(f, dict)]
    selects = [f for f in fields if f.get("__typename") == "ProjectV2SingleSelectField" and f.get("options")]
    status = next((f for f in selects if f.get("name") == "Status"), None) or (selects[0] if selects else None)
    iteration = next((f for f in fields if f.get("__typename") == "ProjectV2IterationField"), None)
    cols = [o["name"] for o in (status or {}).get("options") or []]
    out = {
        "owner": owner, "ownerType": kind, "number": p["number"], "title": p.get("title") or "",
        "id": p.get("id") or "", "closed": bool(p.get("closed")),
        "items": ((p.get("items") or {}).get("totalCount")) or 0,
        "statusField": (status or {}).get("name") or "Status",
        "statusFieldId": (status or {}).get("id") or "",
        "statusOptions": {o["name"]: o["id"] for o in (status or {}).get("options") or []},
        "columns": cols,
        "statuses": guess_statuses(cols),
        "sprintField": (iteration or {}).get("name") or "",
    }
    if not status:
        out["error"] = "no single-select Status field"
    return out


def parse_owners(data: dict, owners: list) -> list:
    out = []
    for i, (login, kind) in enumerate(owners):
        node = (data or {}).get(f"o{i}")
        if not isinstance(node, dict):
            continue
        repos = [{"repo": r["nameWithOwner"], "openIssues": ((r.get("issues") or {}).get("totalCount")) or 0}
                 for r in (node.get("repositories") or {}).get("nodes") or []
                 if isinstance(r, dict) and r.get("nameWithOwner") and not r.get("isArchived") and r.get("hasIssuesEnabled", True)]
        projects = [_board_of(p, login, kind) for p in (node.get("projectsV2") or {}).get("nodes") or []
                    if isinstance(p, dict) and p.get("number") and not p.get("closed")]
        out.append({"login": login, "type": kind, "repos": repos, "projects": projects})
    return out


def detect_all() -> dict:
    """Every owner gh can reach, with their repos and project boards: two GraphQL calls."""
    me = _gh_json(["api", "graphql", "-f", "query=query { viewer { login organizations(first: 100) { nodes { login } } } }"])
    viewer = ((me or {}).get("data") or {}).get("viewer") if isinstance(me, dict) else None
    if not isinstance(viewer, dict) or not viewer.get("login"):
        return {"owners": [], "error": "gh is not logged in (run: gh auth login)"}
    owners = [(viewer["login"], "user")] + [(o["login"], "organization") for o in (viewer.get("organizations") or {}).get("nodes") or []
                                             if isinstance(o, dict) and o.get("login")]
    data = _gh_json(["api", "graphql", "-f", f"query={owners_query(owners)}"])
    if not isinstance(data, dict):
        return {"user": viewer["login"], "owners": [], "error": "could not read repositories and projects (gh needs the 'project' and 'read:org' scopes: gh auth refresh -s project,read:org)"}
    return {"user": viewer["login"], "owners": parse_owners(data.get("data") or {}, owners)}


def _validate(cfg: dict) -> "str | None":
    if not isinstance(cfg.get("owner"), str) or not re.fullmatch(r"[A-Za-z0-9-]{0,39}", cfg["owner"]):
        return "owner must be a GitHub login"
    if not isinstance(cfg.get("issueRepo"), str) or not re.fullmatch(r"[A-Za-z0-9._-]{0,100}", cfg["issueRepo"]):
        return "issueRepo must be a repository name"
    if not isinstance(cfg.get("columns"), list) or not all(isinstance(c, str) for c in cfg["columns"]):
        return "columns must be a list of status names"
    if not isinstance(cfg.get("statuses"), dict):
        return "statuses must be an object"
    if not isinstance(cfg.get("masterEnabled", True), bool):
        return "masterEnabled must be true or false"
    if not isinstance(cfg.get("repos", []), list) or not all(isinstance(r, str) and re.fullmatch(config.REPO_RE, r) for r in cfg.get("repos", [])):
        return "repos must be a list of owner/name"
    ps = cfg.get("projects", [])
    if not isinstance(ps, list) or not all(isinstance(p, dict) and isinstance(p.get("number"), int) and _LOGIN.fullmatch(str(p.get("owner") or "")) for p in ps):
        return "projects must be a list of {owner, number, ...}"
    accs = cfg.get("accounts", [])
    if not isinstance(accs, list) or not all(isinstance(a, dict) and _LOGIN.fullmatch(str(a.get("login") or "")) for a in accs):
        return "accounts must be a list of {login, ...}"
    for a in accs:
        if not isinstance(a.get("repos", []), list) or not all(isinstance(r, str) and re.fullmatch(config.REPO_RE, r) for r in a.get("repos", [])):
            return f"accounts: {a['login']}'s repos must be a list of owner/name"
        if not isinstance(a.get("email", ""), str) or not isinstance(a.get("name", ""), str):
            return f"accounts: {a['login']}'s name and email must be text"
        if not isinstance(a.get("workspace", ""), str):
            return f"accounts: {a['login']}'s workspace must be a folder path"
    return None


def _mirror(cfg: dict) -> dict:
    """The primary account's repos and boards also go in the top-level fields (older readers, tt.sh),
    with exactly one account marked primary; then the first repo and project also go in the
    single-repo fields."""
    accs = config.accounts(cfg) if cfg.get("accounts") else []
    if accs:
        p = accs[0]
        cfg["accounts"] = [{**{k: v for k, v in a.items() if k != "primary"}, **({"primary": True} if a.get("login") == p["login"] else {})}
                           for a in cfg["accounts"] if isinstance(a, dict)]
        cfg.update(owner=p["owner"], ownerType=p["ownerType"], issueRepo=p["issueRepo"], repos=p["repos"],
                   allRepos=p["allRepos"], projects=p["projects"], allProjects=p["allProjects"])
        if p["workspace"]:  # the primary's own workspace is the config's
            cfg["workspace"] = p["workspace"]
        if not p["projects"]:  # no board on the primary: the top level mirrors that, not the previous board
            cfg.update({k: copy.deepcopy(config.DEFAULTS[k]) for k in
                        ("project", "projectId", "statusFieldId", "statusOptions", "columns", "statuses", "sprintField")})
    repos = cfg.get("repos") or []
    if repos and not (cfg.get("owner") and cfg.get("issueRepo")):
        cfg["owner"], cfg["issueRepo"] = repos[0].split("/", 1)
    ps = config.projects(cfg) if cfg.get("projects") else []
    if ps:
        p = ps[0]
        cfg.update(project=p["number"], projectId=p["id"], statusFieldId=p["statusFieldId"],
                   statusOptions=p["statusOptions"], columns=p["columns"], statuses=p["statuses"],
                   sprintField=p["sprintField"])
        if cfg.get("owner") == p["owner"] or not cfg.get("owner"):
            cfg["ownerType"] = p["ownerType"]
    return cfg


def save(patch: dict, path: "Path | None" = None) -> dict:
    path = path or config.config_path()
    cfg = config._merge(config.load(path), patch)
    if isinstance(patch.get("workspace"), str) and "accounts" not in patch:
        # The config's workspace is the primary account's: one that carries its own follows the
        # patch (the mirror below would undo it otherwise).
        for a in cfg.get("accounts") or []:
            if isinstance(a, dict) and a.get("primary") is True and a.get("workspace"):
                a["workspace"] = patch["workspace"]
    cfg = _mirror(cfg)
    err = _validate(cfg)
    if err:
        raise ValueError(err)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n")
    os.replace(tmp, path)
    return cfg


def _get(cfg: dict, key: str):
    cur = cfg
    for part in key.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def shell(cfg: dict, project: "str | None" = None) -> str:
    """Assignments and two functions (option_id, rank) for tt.sh to eval. `project` (owner/number)
    gives that board's status field, options and meanings; otherwise the primary board's.
    REPOS_JSON and PROJECTS_JSON list every selected repo and board (key, owner, number, id)."""
    cfg = {k: v for k, v in cfg.items() if k != "accounts"}  # tt.sh stays on the primary account
    q = shlex.quote
    boards = config.projects(cfg)
    if project:
        pick = next((p for p in boards if config.project_key(p) == project), None)
        if pick is None:
            raise ValueError(f"no such project in the config: {project}")
        cfg = dict(cfg, project=pick["number"], projectId=pick["id"], statusFieldId=pick["statusFieldId"],
                   statusOptions=pick["statusOptions"], columns=pick["columns"], statuses=pick["statuses"])
        cfg["projectOwner"] = pick["owner"]
    st = cfg["statuses"]
    fin = st.get("finished") or st["done"]
    lines = [
        f"CFG_CONFIGURED={1 if config.is_configured(cfg) else 0}",
        f"OWNER={q(cfg['owner'])}",
        f"ISSUE_REPO={q(cfg['issueRepo'])}",
        f"PROJECT_NUMBER={int(cfg.get('project') or 0)}",
        f"PROJECT_OWNER={q(cfg.get('projectOwner') or cfg['owner'])}",
        f"REPOS_JSON={q(json.dumps(config.repos(cfg)))}",
        f"ALL_REPOS={1 if cfg.get('allRepos') else 0}",
        f"PROJECTS_JSON={q(json.dumps([{'key': config.project_key(p), 'owner': p['owner'], 'number': p['number'], 'id': p['id']} for p in boards]))}",
        f"PROJECT_ID={q(cfg.get('projectId') or '')}",
        f"STATUS_FIELD_ID={q(cfg.get('statusFieldId') or '')}",
        f"ST_READY={q(st['ready'])}",
        f"ST_IN_PROGRESS={q(st['inProgress'])}",
        f"ST_PR_RAISED={q(st['prRaised'])}",
        f"ST_DEV_DONE={q(st['devDone'])}",
        # Statuses a session may pick up (candidates): resumable plus assignable, as a JSON array.
        # Outside the current sprint, a session may pick up work in these statuses.
        f"ST_PICKABLE_JSON={q(json.dumps(list(dict.fromkeys([*st['resumable'], st['ready']]))))}",
        f"ST_DONE_JSON={q(json.dumps(list(fin)))}",
        # Search filter that leaves finished items out: -status:"QA Done","Invalid"
        f"ST_DONE_QUERY={q(('-status:' + ','.join(json.dumps(x) for x in fin)) if fin else '')}",
    ]
    opts = cfg.get("statusOptions") or {}
    lines.append("option_id() {\n  case \"$1\" in")
    for name, oid in opts.items():
        lines.append(f"    {q(name)}) echo {q(oid)} ;;")
    lines.append("    *) return 1 ;;\n  esac\n}")
    names = list(dict.fromkeys([*cfg.get("columns", []), *(st.get("rank") or {}).keys()]))
    lines.append("rank() {\n  case \"$1\" in")
    for name in names:
        lines.append(f"    {q(name)}) echo {config.rank(cfg, name)} ;;")
    lines.append("    *) echo -1 ;;\n  esac\n}")
    return "\n".join(lines) + "\n"


def main(argv: list) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    cfg = config.load()
    if cmd == "show":
        print(json.dumps({"configured": config.is_configured(cfg), "path": str(config.config_path()), "config": cfg}, indent=2))
        return 0
    if cmd == "get":
        if not rest:
            print("usage: master config get <key>", file=sys.stderr)
            return 2
        v = _get(cfg, rest[0])
        if v is None:
            return 1
        print(v if isinstance(v, str) else json.dumps(v))
        return 0
    if cmd == "shell":
        project = rest[1] if rest[:1] == ["--project"] and len(rest) > 1 else None
        try:
            sys.stdout.write(shell(cfg, project))
        except ValueError as e:
            print(f"master config shell: {e}", file=sys.stderr)
            return 1
        return 0
    if cmd == "detect" and rest[:1] == ["--all"]:
        print(json.dumps(detect_all(), indent=2))
        return 0
    if cmd == "detect":
        owner, project = None, None
        i = 0
        while i < len(rest):
            if rest[i] == "--owner" and i + 1 < len(rest):
                owner, i = rest[i + 1], i + 2
            elif rest[i] == "--project" and i + 1 < len(rest):
                project, i = int(rest[i + 1]), i + 2
            else:
                i += 1
        if not owner:
            print("usage: master config detect --owner <login> [--project <number>]", file=sys.stderr)
            return 2
        print(json.dumps(detect(owner, project), indent=2))
        return 0
    if cmd == "save":
        try:
            patch = json.loads(sys.stdin.read() or "{}")
            if not isinstance(patch, dict):
                raise ValueError("expected a JSON object")
            saved = save(patch)
        except ValueError as e:
            print(f"master config save: {e}", file=sys.stderr)
            return 1
        print(json.dumps({"configured": config.is_configured(saved), "path": str(config.config_path())}))
        return 0
    print(f"unknown: master config {cmd}", file=sys.stderr)
    return 2

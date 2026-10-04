from __future__ import annotations

from datetime import date

from . import config, join, normalize, refs

SOURCES = ("gh", "board", "prs", "agents", "state")


def build(src, *, now_iso: str, today: date, master_name: str = config.MASTER_NAME,
          with_sessions: bool = True) -> dict:
    """`with_sessions` False: GitHub only (a second account's read; the sessions come with the primary's)."""
    errors: list = []
    sources: dict = {}

    def guard(name, fn, default):
        try:
            value = fn()
        except Exception as e:  # any source failure makes a partial snapshot, never a crash
            err = {"source": name, "message": str(e)[:300]}
            if isinstance(getattr(e, "account", None), str):
                err["account"] = e.account  # read as another account than this part's (a session's branch)
            errors.append(err)
            sources[name] = False
            return default
        sources.setdefault(name, True)
        return value

    def cwd_lookup(sid):
        try:
            return src.session_cwd(sid)
        except Exception:
            return None

    # Before setup (no owner/repo) there is nothing to ask GitHub; sessions still work.
    cfg = getattr(src, "cfg", None)  # one account's view, or None: the whole config
    has_repo = bool(config.repos(cfg))
    has_board = bool(config.projects(cfg))
    me = guard("gh", src.me, None)
    # Both lists, every board, in one round of GitHub calls.
    both = getattr(src, "board_mine_ready", None) or (lambda: (src.board_mine(), src.board_ready()))
    mine, ready = guard("board", both, ([], [])) if has_board else ([], [])
    prs_mine = guard("prs", src.prs_mine, []) if has_repo else []
    prs_review = guard("prs", src.prs_review, []) if has_repo else []
    agents = guard("agents", src.agents, []) if with_sessions else []
    state = guard("state", src.state, {"sessions": {}}) if with_sessions else {"sessions": {}}

    for name in SOURCES:
        sources.setdefault(name, True)
    if not sources["gh"]:
        sources["prs"] = False  # without knowing who I am, author_is_me is meaningless

    sessions = join.sessions(agents, state, master_name, cwd_lookup, config.superseded_ids())
    for s in sessions:
        s["branch_head"] = None
        if s["branch"]:
            s["branch_head"] = guard("branches", lambda b=s["branch"]: src.branch_head(b), None)
    sources.pop("branches", None)

    return {
        "taken_at": now_iso,
        "issues": normalize.issues(mine, ready, today),
        "prs": normalize.prs(prs_mine, prs_review, me),
        "sessions": sessions,
        "errors": errors,
        "sources": {k: sources[k] for k in SOURCES},
    }


def merge(parts: list) -> dict:
    """One snapshot from one per account [(login, snapshot)], the primary's first (it has the
    sessions). Issues and PRs from all, each tagged with its account; errors say whose; `sources`
    is ok only where every account's is; `accounts` keeps each one's, so MasterDeck keeps a failed
    account's last part."""
    first = parts[0][1]
    issues, prs, errors = [], [], []
    seen_i, seen_p = set(), set()
    for login, s in parts:
        for i in s["issues"]:
            k = refs.key(i.get("repo"), i["number"])
            if k not in seen_i:
                seen_i.add(k)
                issues.append(dict(i, account=login))
        for p in s["prs"]:
            if p["url"] not in seen_p:
                seen_p.add(p["url"])
                prs.append(dict(p, account=login))
        errors += [{"account": login, **e} for e in s["errors"]]
    return {**first, "issues": issues, "prs": prs, "errors": errors,
            "sources": {k: all(s["sources"][k] for _, s in parts) for k in SOURCES},
            "accounts": [{"login": login, "sources": s["sources"]} for login, s in parts]}

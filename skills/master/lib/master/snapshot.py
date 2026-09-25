from __future__ import annotations

from datetime import date

from . import config, join, normalize

SOURCES = ("gh", "board", "prs", "agents", "state")


def build(src, *, now_iso: str, today: date, master_name: str = config.MASTER_NAME) -> dict:
    errors: list = []
    sources: dict = {}

    def guard(name, fn, default):
        try:
            value = fn()
        except Exception as e:  # any source failure makes a partial snapshot, never a crash
            errors.append({"source": name, "message": str(e)[:300]})
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
    has_repo = bool(config.OWNER and config.ISSUE_REPO)
    has_board = has_repo and config.PROJECT > 0
    me = guard("gh", src.me, None)
    mine = guard("board", src.board_mine, []) if has_board else []
    ready = guard("board", src.board_ready, []) if has_board else []
    prs_mine = guard("prs", src.prs_mine, []) if has_repo else []
    prs_review = guard("prs", src.prs_review, []) if has_repo else []
    agents = guard("agents", src.agents, [])
    state = guard("state", src.state, {"sessions": {}})

    for name in SOURCES:
        sources.setdefault(name, True)
    if not sources["gh"]:
        sources["prs"] = False  # without knowing who I am, author_is_me is meaningless

    sessions = join.sessions(agents, state, master_name, cwd_lookup)
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

# lib/master/refs.py
"""Tickets across repositories: an issue is (repo, number), repo being "owner/name". A bare number
(the ledger's and babysit-ticket's older records) means the primary issue repo, and records for
it keep the bare number, so older readers still read them right."""
from __future__ import annotations

import re

from . import config

_REF = re.compile(r"^\s*(?:(?:([A-Za-z0-9-]{1,39})/)?([A-Za-z0-9._-]{1,100})#|#)?(\d+)\s*$")


def primary() -> str:
    return config.primary_repo()


def same(a: "str | None", b: "str | None") -> bool:
    return (a or primary()).lower() == (b or primary()).lower()


def full(repo: "str | None") -> str:
    """owner/name; None means the primary repo."""
    return repo or primary()


def stored(repo: "str | None") -> "str | None":
    """What records keep: None for the primary repo (so a bare number), else owner/name."""
    return None if not repo or same(repo, None) else repo


def key(repo: "str | None", n: int) -> tuple:
    return (full(repo).lower(), int(n))


def label(repo: "str | None", n: int) -> str:
    """How messages name it: #12 in the primary repo, name#12 in another (owner left out)."""
    return f"#{n}" if stored(repo) is None else f"{repo.split('/', 1)[1]}#{n}"


def ref(repo: "str | None", n: int) -> str:
    """owner/name#12: unambiguous, for prompts and links."""
    return f"{full(repo)}#{n}"


def parse(text: "str | int") -> "tuple[str | None, int]":
    """12, #12, name#12 or owner/name#12 → (stored repo, number). A name alone resolves among the
    selected repos (then the primary owner). Raises ValueError otherwise."""
    if isinstance(text, int):
        return None, text
    m = _REF.match(str(text))
    if not m:
        raise ValueError(f"not an issue reference: {text!r}")
    owner, name, n = m.group(1), m.group(2), int(m.group(3))
    if name is None:
        return None, n
    if owner:
        return stored(f"{owner}/{name}"), n
    hit = next((r for r in config.repos() if r.split("/", 1)[1].lower() == name.lower()), None)
    return stored(hit or f"{config.OWNER}/{name}"), n

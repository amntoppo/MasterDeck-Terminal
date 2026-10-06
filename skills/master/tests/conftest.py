import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
# This checkout's lib/ first, whatever PYTHONPATH says (an installed copy must not shadow it).
sys.path.insert(0, os.path.join(os.path.dirname(_here), "lib"))
# Tests run against a fixed, fictional config (org "acme", issue repo "tracker").
os.environ["MASTER_CONFIG"] = os.path.join(_here, "config.json")

# No test may touch the developer's machine. Before anything of `master` is imported, HOME and every
# folder the CLI derives from it point into one temp sandbox, whatever the shell exports:
# - HOME: the backstop. Anything that falls back to ~ (masterdeck_home, master_home, the gh
#   cache, ~/.claude/projects) lands in the sandbox even when a test removes a variable.
# - MASTERDECK_HOME: `master spawn` writes parked-sessions.json, session-accounts.json there.
# - MASTER_HOME: the ledger. MASTER_WORKSPACE: `checkout.resolve` (behind rules.propose, `master
#   add`, `master spawn`, draft-assign) scans it; it starts empty.
# - git reads no user or system config.
# - CLAUDE_CONFIG_DIR is unset: `master.trust` reads Claude Code's `.claude.json` from HOME, so
#   from the sandbox (there is none until a test writes one).
# The fixture below puts them back before every test (a test may change them for itself) and
# fails a test that left a `master` path pointing into the real home.
import atexit
import shutil
import tempfile

import pytest

REAL_HOME = os.path.realpath(os.path.expanduser("~"))
SANDBOX = os.path.realpath(tempfile.mkdtemp(prefix="master-tests-"))
atexit.register(shutil.rmtree, SANDBOX, True)
_ENV = {
    "HOME": os.path.join(SANDBOX, "home"),
    "USERPROFILE": os.path.join(SANDBOX, "home"),
    "MASTERDECK_HOME": os.path.join(SANDBOX, "masterdeck"),
    "MASTER_HOME": os.path.join(SANDBOX, "master"),
    "MASTER_WORKSPACE": os.path.join(SANDBOX, "workspace"),
    "GH_CACHE_DIR": os.path.join(SANDBOX, "gh-cache"),
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}
for _d in ("home", "workspace"):
    os.makedirs(os.path.join(SANDBOX, _d), exist_ok=True)
os.environ.update(_ENV)
# Claude Code's own config (`.claude.json`, read by master.trust) is looked for in HOME only.
os.environ.pop("CLAUDE_CONFIG_DIR", None)


def _under(p: str, root: str) -> bool:
    return p == root or p.startswith(root + os.sep)


def _in_real_home(p) -> bool:
    # The sandbox itself can sit inside the real home (on Windows the temp folder does): that is fine.
    p = os.path.realpath(str(p))
    return _under(p, REAL_HOME) and not _under(p, SANDBOX)


@pytest.fixture(autouse=True)
def _sandboxed_home():
    os.environ.update(_ENV)
    os.environ.pop("CLAUDE_CONFIG_DIR", None)
    yield
    from master import config
    leaked = {k: str(v) for k, v in (("HOME", os.path.expanduser("~")), ("masterdeck_home", config.masterdeck_home()),
                                     ("master_home", config.master_home())) if _in_real_home(v)}
    os.environ.update(_ENV)
    assert not leaked, f"a test left paths in the real home: {leaked}"

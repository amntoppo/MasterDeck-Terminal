import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
# This checkout's lib/ first, whatever PYTHONPATH says (an installed copy must not shadow it).
sys.path.insert(0, os.path.join(os.path.dirname(_here), "lib"))
# Tests run against a fixed, fictional config (org "acme", issue repo "tracker").
os.environ["MASTER_CONFIG"] = os.path.join(_here, "config.json")

# No suite may look for checkouts in a real folder: `checkout.resolve` (behind rules.propose,
# `master add`, `master spawn`, draft-assign) scans the workspace. Whatever the developer's shell
# exports, every test starts from an empty temp workspace and a git that reads no user config;
# tests that need a workspace set their own.
import atexit
import shutil
import tempfile

_ws = tempfile.mkdtemp(prefix="master-test-ws-")
atexit.register(shutil.rmtree, _ws, True)
os.environ["MASTER_WORKSPACE"] = _ws
os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
if "MASTER_HOME" not in os.environ:
    os.environ["MASTER_HOME"] = os.path.join(_ws, ".master-home")

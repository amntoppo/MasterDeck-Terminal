"""No test may read or write the developer's real home: conftest.py points HOME, MASTER_HOME,
MASTERDECK_HOME and MASTER_WORKSPACE at temp folders before anything is imported, and checks after
every test that nothing resolves under the real home."""
import os
import tempfile
import unittest
from pathlib import Path

from master import config, ledger, spawn
from tests import conftest
from tests.test_spawn import FakeRunner


def inside(p, root) -> bool:
    p, root = os.path.realpath(str(p)), os.path.realpath(str(root))
    return p == root or p.startswith(root + os.sep)


class IsolationTest(unittest.TestCase):
    def test_every_home_is_a_temp_folder(self):
        root = conftest.SANDBOX
        self.assertTrue(inside(root, tempfile.gettempdir()))
        for what, p in (("HOME", Path.home()), ("~", os.path.expanduser("~")), ("masterdeck_home", config.masterdeck_home()),
                        ("master_home", config.master_home()), ("workspace", config.workspace()),
                        ("ledger", ledger.ledger_path() if hasattr(ledger, "ledger_path") else config.master_home())):
            self.assertTrue(inside(p, root), f"{what} is {p}, not under the test sandbox {root}")
            self.assertFalse(inside(p, conftest.REAL_HOME), what)

    def test_without_the_variables_the_defaults_are_still_in_the_sandbox(self):
        saved = {k: os.environ.pop(k, None) for k in ("MASTERDECK_HOME", "MASTER_HOME")}
        try:
            self.assertTrue(inside(config.masterdeck_home(), conftest.SANDBOX))
            self.assertTrue(inside(config.master_home(), conftest.SANDBOX))
        finally:
            os.environ.update({k: v for k, v in saved.items() if v is not None})

    def test_a_spawn_that_patches_nothing_writes_its_record_in_the_sandbox(self):
        with tempfile.TemporaryDirectory() as d:
            led = ledger.empty()
            p = ledger.add(led, kind="ASSIGN", issue=981, source="issue:981", target={"spawn": {"name": "981-iso", "cwd": d, "prompt": "go"}},
                           message="m", summary="s", now="2026-09-24T10:00:00Z")
            ledger.transition(led, p["id"], "approved", now="2026-09-24T10:00:00Z")
            spawn.spawn(led, p["id"], now="2026-09-24T10:00:01Z", runner=FakeRunner())
        f = config.masterdeck_home() / "parked-sessions.json"
        self.assertTrue(f.is_file())
        self.assertTrue(inside(f, conftest.SANDBOX))

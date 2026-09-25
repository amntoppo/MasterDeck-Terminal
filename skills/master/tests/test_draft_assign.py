from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from master import cli, ledger, rules

ISSUE = {"number": 42, "title": "Fix upload retry", "status": "To Do", "sprint": None,
         "current_sprint": True, "assigned_to_me": True,
         "url": "https://github.com/acme/tracker/issues/42"}


class DraftAssignTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._env = {k: os.environ.get(k) for k in ("MASTER_HOME", "MASTER_WORKSPACE")}
        os.environ["MASTER_HOME"] = str(Path(self.tmp.name) / "home")
        os.environ["MASTER_WORKSPACE"] = "/ws"
        with ledger.locked() as led:
            led["last_snapshot"] = {"taken_at": "x", "issues": [ISSUE], "prs": [], "sessions": [],
                                    "errors": [], "sources": {}}

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def _fixtures(self) -> Path:
        from tests.test_cli import write_fixtures
        fx = Path(self.tmp.name) / "fx-plain"
        fx.mkdir(exist_ok=True)
        write_fixtures(fx)
        return fx

    def run_cli(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(list(argv))
        return code, buf.getvalue()

    def test_prints_the_assign_draft_from_the_last_snapshot(self):
        code, out = self.run_cli("draft-assign", "42")
        self.assertEqual(code, 0)
        got = json.loads(out)
        want = rules._assign(ISSUE)
        self.assertEqual(got["issue"], 42)
        self.assertEqual(got["name"], want["target"]["spawn"]["name"])
        self.assertEqual(got["cwd"], "/ws")
        self.assertEqual(got["prompt"], want["target"]["spawn"]["prompt"])
        self.assertEqual(got["summary"], want["summary"])
        self.assertEqual(got["title"], "Fix upload retry")
        self.assertEqual(got["url"], ISSUE["url"])

    def test_falls_back_to_a_live_snapshot_for_an_issue_newer_than_the_last_sweep(self):
        from tests.test_cli import write_fixtures
        fx = Path(self.tmp.name) / "fx"
        fx.mkdir()
        write_fixtures(fx)
        code, out = self.run_cli("draft-assign", "981", "--fixtures", str(fx), "--now", "2026-09-24T10:00:00Z")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out)["name"], "981-issue-981")

    def test_unknown_issue_exits_1(self):
        code, out = self.run_cli("draft-assign", "999", "--fixtures", str(self._fixtures()))
        self.assertEqual(code, 1)
        self.assertIn("issue 999 not found", out)

    def test_is_a_read_command(self):
        args = cli.parser().parse_args(["draft-assign", "42"])
        self.assertFalse(cli._is_write(args))


if __name__ == "__main__":
    unittest.main()

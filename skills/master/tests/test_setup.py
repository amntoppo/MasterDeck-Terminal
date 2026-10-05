from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from master import config, setup


class GuessTest(unittest.TestCase):
    def test_default_github_template(self):
        g = setup.guess_statuses(["Todo", "In Progress", "Done"])
        self.assertEqual((g["ready"], g["inProgress"], g["prRaised"], g["devDone"]), ("Todo", "In Progress", "In Progress", "Done"))
        self.assertEqual(g["done"], ["Done"])
        self.assertEqual(g["assignable"], ["Todo"])

    def test_richer_board(self):
        cols = ["To Do", "Ready For Dev", "In Dev", "PR Raised", "Dev Done", "In QA", "QA Done", "Re-Open", "Blocked", "Invalid"]
        g = setup.guess_statuses(cols)
        self.assertEqual((g["ready"], g["inProgress"], g["prRaised"], g["devDone"]), ("Ready For Dev", "In Dev", "PR Raised", "Dev Done"))
        self.assertIn("Re-Open", g["assignable"])
        self.assertIn("Re-Open", g["resumable"])
        self.assertEqual(g["blocked"], ["Blocked"])
        self.assertNotIn("Re-Open", g["done"])
        self.assertIn("Invalid", g["done"])
        self.assertLess(g["rank"]["Re-Open"], g["rank"]["In Dev"])


class SaveAndShellTest(unittest.TestCase):
    def test_save_merges_and_validates(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.json"
            setup.save({"owner": "acme", "issueRepo": "tracker"}, p)
            cfg = setup.save({"statuses": {"inProgress": "Doing"}}, p)
            self.assertEqual(cfg["owner"], "acme")
            self.assertEqual(cfg["statuses"]["inProgress"], "Doing")
            self.assertEqual(cfg["statuses"]["ready"], config.DEFAULTS["statuses"]["ready"])
            with self.assertRaises(ValueError):
                setup.save({"owner": "bad owner!"}, p)

    def test_save_keeps_a_board_masterdeck_made_sprintless(self):
        made = {"owner": "globex", "ownerType": "organization", "number": 7, "id": "PVT_7", "title": "App board",
                "columns": ["Todo", "In Dev", "PR Raised", "Done"], "sprintField": "", "sprintless": True}
        acct = {"login": "bob-work", "primary": True, "name": "Bob", "email": "b@globex.test", "owner": "globex",
                "ownerType": "organization", "issueRepo": "app", "repos": ["globex/app"], "projects": [made]}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.json"
            for patch in ({"accounts": [acct]}, {"workspace": "/tmp/w"}, {"accounts": [dict(acct, name="Bob B")]}):
                cfg = setup.save(patch, p)
                self.assertTrue(cfg["accounts"][0]["projects"][0]["sprintless"], patch)
                self.assertTrue(cfg["projects"][0]["sprintless"], patch)  # the mirrored top-level list
                self.assertTrue(json.loads(p.read_text())["projects"][0]["sprintless"])
                self.assertTrue(config.projects(cfg)[0]["sprintless"])
            # A config from before accounts: the top-level list alone.
            q = Path(d) / "old.json"
            setup.save({"owner": "globex", "issueRepo": "app", "projects": [made]}, q)
            cfg = setup.save({"masterEnabled": False}, q)
            self.assertTrue(cfg["projects"][0]["sprintless"])
            self.assertEqual(cfg["sprintField"], "")
            # Other boards never get the mark.
            self.assertNotIn("sprintless", config.projects({"owner": "acme", "projects": [{"number": 1}]})[0])

    @unittest.skipIf(sys.platform == "win32", "bash on Windows runners is WSL")
    def test_shell_output_evaluates_in_bash(self):
        cfg = config._merge(config.DEFAULTS, {"owner": "acme", "issueRepo": "tracker", "project": 3,
                                             "statusOptions": {"In Progress": "abc", "It's done": "x'y"}})
        script = setup.shell(cfg) + 'echo "$OWNER|$ISSUE_REPO|$PROJECT_NUMBER|$(option_id "In Progress")|$(option_id "It\'s done")|$(rank Done)"'
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "acme|tracker|3|abc|x'y|3")


if __name__ == "__main__":
    unittest.main()

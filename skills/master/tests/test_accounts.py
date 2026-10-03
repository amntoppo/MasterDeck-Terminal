"""Several GitHub accounts in the config: the primary's fields stay at the top level for older
readers; repos and boards of every account count; a repo belongs to the first account listing it."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from master import config, setup

A = {"login": "alice", "primary": True, "name": "Alice", "email": "a@acme.test", "owner": "acme", "ownerType": "organization",
     "issueRepo": "tracker", "repos": ["acme/tracker", "acme/api"],
     "projects": [{"owner": "acme", "ownerType": "organization", "number": 1, "title": "Delivery", "columns": ["To Do", "In Dev"],
                   "statuses": {"ready": "To Do", "inProgress": "In Dev"}}]}
B = {"login": "bob-work", "name": "Bob", "email": "b@globex.test", "owner": "globex", "ownerType": "organization",
     "issueRepo": "app", "repos": ["globex/app", "acme/api"],
     "projects": [{"owner": "globex", "ownerType": "organization", "number": 7, "title": "Globex", "columns": ["Todo", "Done"],
                   "statuses": {"ready": "Todo", "inProgress": "Todo", "done": ["Done"]}}]}


class AccountsConfigTest(unittest.TestCase):
    def test_no_accounts_is_as_before(self):
        self.assertEqual(config.accounts(), [])
        self.assertFalse(config.is_multi())
        self.assertEqual(config.repos(), ["acme/tracker"])
        self.assertEqual([config.project_key(p) for p in config.projects()], ["acme/1"])
        self.assertIsNone(config.account_for_repo("acme/tracker"))

    def test_union_primary_first(self):
        with mock.patch.dict(config.CONFIG, {"accounts": [B, A]}):
            self.assertTrue(config.is_multi())
            self.assertEqual([a["login"] for a in config.accounts()], ["alice", "bob-work"])
            self.assertEqual([a["primary"] for a in config.accounts()], [True, False])
            self.assertEqual(config.repos(), ["acme/tracker", "acme/api", "globex/app"])
            self.assertEqual([config.project_key(p) for p in config.projects()], ["acme/1", "globex/7"])
            self.assertEqual(config.statuses_for("globex/7")["ready"], "Todo")
            self.assertTrue(config.repo_allowed("GLOBEX/app"))
            self.assertFalse(config.repo_allowed("initech/x"))

    def test_repo_under_two_accounts_belongs_to_the_first(self):
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}):
            self.assertEqual(config.accounts()[1]["repos"], ["globex/app"])
            self.assertEqual(config.account_for_repo("acme/api"), "alice")
            self.assertEqual(config.account_for_repo("GLOBEX/APP"), "bob-work")
            self.assertEqual(config.account_for_repo(None), "alice")
            self.assertEqual(config.account_for_repo("initech/x"), "alice")

    def test_one_account_sets_no_account(self):
        with mock.patch.dict(config.CONFIG, {"accounts": [A]}):
            self.assertFalse(config.is_multi())
            self.assertIsNone(config.account_for_repo("acme/api"))


class AccountsSaveTest(unittest.TestCase):
    def test_save_mirrors_the_primary_and_keeps_one_primary(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.json"
            cfg = setup.save({"accounts": [dict(B, primary=True), dict(A, primary=False)]}, p)
            self.assertEqual((cfg["owner"], cfg["issueRepo"]), ("globex", "app"))
            self.assertEqual(cfg["repos"], ["globex/app", "acme/api"])
            self.assertEqual(cfg["project"], 7)
            saved = json.loads(p.read_text())
            self.assertEqual([a["login"] for a in saved["accounts"] if a.get("primary")], ["bob-work"])
            cfg = setup.save({"accounts": [A, B]}, p)
            self.assertEqual((cfg["owner"], cfg["issueRepo"], cfg["project"]), ("acme", "tracker", 1))

    def test_save_refuses_bad_accounts(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                setup.save({"accounts": [{"login": "bad login!"}]}, Path(d) / "config.json")
            with self.assertRaises(ValueError):
                setup.save({"accounts": [dict(A, repos=["not a repo"])]}, Path(d) / "config.json")

    @unittest.skipIf(sys.platform == "win32", "bash on Windows runners is WSL")
    def test_shell_stays_on_the_primary(self):
        cfg = setup._mirror(config._merge(config.DEFAULTS, {"accounts": [A, B]}))
        out = subprocess.run(["bash", "-c", setup.shell(cfg) + 'echo "$OWNER|$REPOS_JSON"'], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, 'acme|["acme/tracker", "acme/api"]')


if __name__ == "__main__":
    unittest.main()

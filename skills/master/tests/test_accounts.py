"""Several GitHub accounts in the config: the primary's fields stay at the top level for older
readers; repos and boards of every account count; a repo belongs to the first account listing it."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from master import config, ledger, rules, setup, spawn
from tests.test_spawn import FakeRunner

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

    def test_primary_without_a_board_leaves_no_stale_board(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.json"
            setup.save({"accounts": [dict(A, projects=[dict(A["projects"][0], id="PVT_x", statusFieldId="F1", statusOptions={"To Do": "o1"})])]}, p)
            cfg = setup.save({"accounts": [dict(A, projects=[])]}, p)
            for k in ("project", "projectId", "statusFieldId", "statusOptions", "columns", "statuses", "sprintField"):
                self.assertEqual(cfg[k], config.DEFAULTS[k], k)
            sh = setup.shell(cfg)
            self.assertIn("PROJECT_NUMBER=0", sh)
            self.assertIn("PROJECT_ID=''", sh)
            self.assertNotIn("o1", sh)

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


class MigratedLegacyProjectTest(unittest.TestCase):
    def test_migrated_single_project_keeps_top_level_board(self):
        """An older config with one `project` becomes one account (as the app's migrationAccount
        writes it); saving it leaves the top-level board fields exactly as they were."""
        legacy = {"owner": "acme", "ownerType": "organization", "issueRepo": "tracker", "repos": ["acme/tracker"],
                  "project": 5, "projectId": "PVT_5", "statusFieldId": "PVTF_1",
                  "statusOptions": {"Todo": "o1", "Done": "o2"}, "columns": ["Todo", "Done"],
                  "statuses": {"ready": "Todo", "inProgress": "Todo", "done": ["Done"]}}
        migrated = {"login": "alice", "primary": True, "name": "Alice", "email": "a@acme.test", "owner": "acme",
                    "ownerType": "organization", "issueRepo": "tracker", "repos": ["acme/tracker"], "allRepos": False,
                    "projects": [{"owner": "acme", "ownerType": "organization", "number": 5, "id": "PVT_5",
                                  "title": "Project 5", "statusField": "Status", "statusFieldId": "PVTF_1",
                                  "statusOptions": {"Todo": "o1", "Done": "o2"}, "columns": ["Todo", "Done"],
                                  "statuses": legacy["statuses"], "sprintField": "Sprint"}],
                    "allProjects": False}
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "config.json"
            path.write_text(json.dumps(legacy))
            before = config.load(path)
            after = setup.save({"accounts": [migrated]}, path)
        for k in ("owner", "issueRepo", "repos", "project", "projectId", "statusFieldId", "statusOptions", "columns", "statuses"):
            self.assertEqual(after[k], before[k], k)


NOW = "2026-10-03T10:00:00Z"


class SpawnAccountTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"MASTERDECK_HOME": self.tmp.name})
        self.env.start()
        self.multi = mock.patch.dict(config.CONFIG, {"accounts": [A, B]})

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_settings_only_with_an_account_and_its_file(self):
        sp = {"name": "3-x", "cwd": "/w", "prompt": "go"}
        f = Path(self.tmp.name) / "accounts" / "bob-work.settings.json"
        f.parent.mkdir()
        f.write_text("{}")
        # One account: the same command as before, an account in the target or not.
        self.assertEqual(spawn.command({"spawn": dict(sp, account="bob-work")}), ["claude", "--bg", "-n", "3-x", "go"])
        with self.multi:
            self.assertEqual(spawn.command({"spawn": sp}), ["claude", "--bg", "-n", "3-x", "go"])
            self.assertEqual(spawn.command({"spawn": dict(sp, account="bob-work")}),
                             ["claude", "--bg", "--settings", str(f), "-n", "3-x", "go"])
            valid = "4f2a9c1e-1234-4abc-9def-0123456789ab"
            self.assertEqual(spawn.command({"spawn": {"name": "3-x", "resume": valid, "account": "bob-work"}}),
                             ["claude", "--bg", "--settings", str(f), "--resume", valid])
            with self.assertRaises(spawn.SpawnError):
                spawn.command({"spawn": dict(sp, account="bad login!")})

    def test_missing_account_file_holds_the_proposal(self):
        led = ledger.empty()
        p = ledger.add(led, kind="ASSIGN", issue=3, source="issue:3",
                       target={"spawn": {"name": "3-x", "cwd": self.tmp.name, "prompt": "go", "account": "carol"}},
                       message="m", summary="s", now=NOW)
        ledger.transition(led, p["id"], "approved", now=NOW)
        run = FakeRunner()
        with self.multi, self.assertRaises(spawn.SpawnError):
            spawn.spawn(led, p["id"], now=NOW, runner=run)
        self.assertEqual(p["status"], "held")
        self.assertIn("GitHub account carol has no settings file", p["note"])
        self.assertEqual(run.calls, [])


    def _old(self, led, repo, n):
        # A proposal from before accounts (or `master add` without --account): no spawn.account.
        p = ledger.add(led, kind="ASSIGN", issue=n, repo=repo, source=f"issue:{repo}#{n}",
                       target={"spawn": {"name": f"{n}-x", "cwd": self.tmp.name, "prompt": "go"}},
                       message="m", summary="s", now=NOW)
        ledger.transition(led, p["id"], "approved", now=NOW)
        return p

    def test_no_account_in_multi_mode_spawns_as_the_repo_account_else_the_primary(self):
        d = Path(self.tmp.name) / "accounts"
        d.mkdir()
        for login in ("alice", "bob-work"):
            (d / f"{login}.settings.json").write_text("{}")
        led = ledger.empty()
        globex, other = self._old(led, "globex/app", 3), self._old(led, "initech/x", 4)
        run = FakeRunner()
        with self.multi:
            spawn.spawn(led, globex["id"], now=NOW, runner=run)
            spawn.spawn(led, other["id"], now=NOW, runner=run)
        self.assertEqual([c[0][:4] for c in run.calls],
                         [["claude", "--bg", "--settings", str(d / "bob-work.settings.json")],
                          ["claude", "--bg", "--settings", str(d / "alice.settings.json")]])
        self.assertNotIn("account", globex["target"]["spawn"])  # the ledger keeps what master wrote
        # One account: the same command as before.
        single = self._old(led, "globex/app", 5)
        spawn.spawn(led, single["id"], now=NOW, runner=run)
        self.assertEqual(run.calls[-1][0], ["claude", "--bg", "-n", "5-x", "go"])

    def test_no_account_in_multi_mode_with_a_missing_file_holds(self):
        led = ledger.empty()
        p = self._old(led, "globex/app", 3)
        run = FakeRunner()
        with self.multi, self.assertRaises(spawn.SpawnError):
            spawn.spawn(led, p["id"], now=NOW, runner=run)
        self.assertEqual(p["status"], "held")
        self.assertIn("GitHub account bob-work has no settings file", p["note"])
        self.assertEqual(run.calls, [])

class RulesAccountTest(unittest.TestCase):
    ISSUE = {"number": 3, "repo": "globex/app", "title": "Fix it", "url": "https://github.com/globex/app/issues/3"}

    def test_assign_names_the_account_only_with_two(self):
        self.assertNotIn("account", rules._assign(self.ISSUE)["target"]["spawn"])
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}):
            self.assertEqual(rules._assign(self.ISSUE)["target"]["spawn"]["account"], "bob-work")
            self.assertEqual(rules._assign(dict(self.ISSUE, repo=None, url="https://github.com/acme/tracker/issues/3"))["target"]["spawn"]["account"], "alice")

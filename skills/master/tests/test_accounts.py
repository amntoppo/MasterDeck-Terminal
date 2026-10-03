"""Several GitHub accounts in the config: the primary's fields stay at the top level for older
readers; repos and boards of every account count; a repo belongs to the first account listing it."""
import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from master import board, cli, collect, config, ledger, rules, setup, snapshot, spawn
from tests.helpers import board_item, pr_node
from tests.test_snapshot import FakeSource, NOW as SNAP_NOW, TODAY
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
        # The ledger records the account it started as (the app attributes the session by it).
        self.assertEqual((globex["target"]["spawn"]["account"], other["target"]["spawn"]["account"]), ("bob-work", "alice"))
        # One account: the same command as before.
        single = self._old(led, "globex/app", 5)
        spawn.spawn(led, single["id"], now=NOW, runner=run)
        self.assertEqual(run.calls[-1][0], ["claude", "--bg", "-n", "5-x", "go"])
        self.assertNotIn("account", single["target"]["spawn"])

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

class OrphanAccountTest(unittest.TestCase):
    """An ORPHAN resume works as the account the session was started as (session-accounts.json)."""
    SID = "4f2a9c1e-1234-4abc-9def-0123456789ab"
    ISSUE = {"number": 3, "repo": None, "title": "Fix it", "status": "In Dev"}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"MASTERDECK_HOME": self.tmp.name})
        self.env.start()
        self.s = {"session_id": self.SID, "cwd": self.tmp.name, "name": "3-fix-it"}

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def record(self, text):
        (Path(self.tmp.name) / "session-accounts.json").write_text(text)

    def test_resumes_as_the_recorded_account(self):
        self.record(json.dumps({self.SID: "bob-work", "a1b2c3d4": "bob-work"}))
        (Path(self.tmp.name) / "accounts").mkdir()
        f = Path(self.tmp.name) / "accounts" / "bob-work.settings.json"
        f.write_text("{}")
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}):
            o = rules._orphan(self.s, self.ISSUE)  # acme/tracker: alice's repo
            self.assertEqual(o["target"]["spawn"]["account"], "bob-work")
            self.assertEqual(spawn.command(o["target"]), ["claude", "--bg", "--settings", str(f), "--resume", self.SID])
        self.assertNotIn("account", rules._orphan(self.s, self.ISSUE)["target"]["spawn"])  # one account

    def test_no_usable_record_leaves_the_default(self):
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}):
            for text in (None, "not json", "[]", json.dumps({self.SID: "bad login!"}), json.dumps({self.SID: "carol"})):
                if text is not None:
                    self.record(text)
                self.assertNotIn("account", rules._orphan(self.s, self.ISSUE)["target"]["spawn"], text)



class Bob(FakeSource):
    def me(self): return "bob-work"
    def board_mine(self): return [board_item(940, "In Dev", "2026-09-21")]
    def prs_mine(self): return []
    def agents(self): raise AssertionError("sessions are read once, with the primary")


class CollectAccountTest(unittest.TestCase):
    def test_token_per_login(self):
        calls = []

        def runner(cmd, **kw):
            calls.append(cmd)
            ok = cmd[-1] == "alice"
            return subprocess.CompletedProcess(cmd, 0 if ok else 1, "gho_tok\n" if ok else "", "")
        self.assertEqual(collect.account_token("alice", runner), "gho_tok")
        self.assertIsNone(collect.account_token("bob-work", runner))
        self.assertEqual(calls[0], ["gh", "auth", "token", "--hostname", "github.com", "--user", "alice"])

    def test_live_reads_only_its_account(self):
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}):
            bob = config.accounts()[1]
            self.assertEqual(collect.Live(bob)._owners_qualifier(), "org:globex")
            with self.assertRaises(RuntimeError):
                collect.Live(bob, None, "gh is not logged in to bob-work").me()
            live = collect.Live.for_account(bob, runner=lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "gho_b\n", ""))
            self.assertEqual(live.env, {"GH_TOKEN": "gho_b", "GHC_ACCOUNT": "bob-work"})
            none = collect.Live.for_account(bob, runner=lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", "no token"))
            self.assertEqual(none.error, "gh is not logged in to bob-work")

    def test_snapshot_per_account_sessions_once(self):
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}), \
                mock.patch.object(collect.Live, "for_account", side_effect=lambda v, runner=None: FakeSource() if v["login"] == "alice" else Bob()):
            snap = cli._snap(types.SimpleNamespace(fixtures=None, now=SNAP_NOW))
        self.assertEqual(sorted(i["number"] for i in snap["issues"]), [939, 940])
        self.assertEqual([a["login"] for a in snap["accounts"]], ["alice", "bob-work"])
        self.assertEqual(snap["errors"], [])
        self.assertTrue(all(snap["sources"].values()))
        self.assertEqual([s["name"] for s in snap["sessions"]], [s["name"] for s in snapshot.build(FakeSource(), now_iso=SNAP_NOW, today=TODAY)["sessions"]])
        # Each issue and PR says whose read found it.
        self.assertEqual(sorted((i["number"], i["account"]) for i in snap["issues"]), [(939, "alice"), (940, "bob-work")])
        self.assertEqual([p["account"] for p in snap["prs"]], ["alice"])

    def test_one_account_failing_keeps_the_others(self):
        m = snapshot.merge([("alice", snapshot.build(FakeSource(), now_iso=SNAP_NOW, today=TODAY)),
                            ("bob-work", snapshot.build(FakeSource(fail={"board_mine", "me"}), now_iso=SNAP_NOW, today=TODAY, with_sessions=False))])
        self.assertFalse(m["sources"]["board"])
        self.assertEqual([a["sources"]["board"] for a in m["accounts"]], [True, False])
        self.assertTrue(m["errors"] and all(e["account"] == "bob-work" for e in m["errors"]))
        self.assertEqual([i["number"] for i in m["issues"]], [939])

    def test_each_accounts_login_is_me(self):
        """F24: a PR by bob-work is mine under bob-work's read, not under alice's; so is a thread he answered last."""
        node = pr_node(77, repo="app", author="bob-work", threads=[(False, "2026-09-24T08:00:00Z", "bob-work")])

        class BobPr(Bob):
            def prs_mine(self): return [node]

        class AlicePr(FakeSource):
            def prs_mine(self): return [node]
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}):
            mine = snapshot.build(BobPr(), now_iso=SNAP_NOW, today=TODAY, with_sessions=False)["prs"][0]
            alices = snapshot.build(AlicePr(), now_iso=SNAP_NOW, today=TODAY)["prs"][0]
        self.assertEqual((mine["author_is_me"], mine["unresolved_threads"]), (True, 0))
        self.assertEqual((alices["author_is_me"], alices["unresolved_threads"]), (False, 1))

    def test_one_account_reads_as_before(self):
        """One connected account: no token lookup, no env on gh, today's cache keys (env=None)."""
        calls = []

        def fake_ghcache(args, ttl=0, env="unset", **kw):
            calls.append((args, env))
            return 0, b"alice\n", b""
        with mock.patch.dict(config.CONFIG, {"accounts": [A]}), \
                mock.patch.object(collect.Live, "for_account", side_effect=AssertionError("no per-account read")), \
                mock.patch("master.ghcache.run", side_effect=fake_ghcache), mock.patch.dict(os.environ, {"MASTER_NO_GH_CACHE": ""}):
            (src,) = cli._sources(types.SimpleNamespace(fixtures=None))
            self.assertEqual((src.cfg, src.env, src.error), (None, None, None))
            self.assertEqual(src.me(), "alice")
        self.assertEqual(calls, [(["api", "user", "--jq", ".login"], None)])
        with mock.patch.dict(os.environ, {"MASTER_NO_GH_CACHE": "1"}), mock.patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "alice\n", "")
            collect.Live().me()
        self.assertIsNone(run.call_args.kwargs["env"])

    def test_account_env_reaches_gh_without_the_cache(self):
        with mock.patch.dict(os.environ, {"MASTER_NO_GH_CACHE": "1"}), mock.patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "bob-work\n", "")
            collect.Live(None, {"GH_TOKEN": "gho_b", "GHC_ACCOUNT": "bob-work"}).me()
        env = run.call_args.kwargs["env"]
        self.assertEqual((env["GH_TOKEN"], env["GHC_ACCOUNT"], env["MASTER_NO_GH_CACHE"]), ("gho_b", "bob-work", "1"))


class BoardAccountTest(unittest.TestCase):
    class Src:
        def __init__(self, items, fail=False):
            self.items, self.fail = items, fail

        def board_sprint(self, q):
            if self.fail:
                raise RuntimeError("HTTP 401: Bad credentials")
            return self.items

        def pr_details(self, urls):
            return {}

        def sprints(self):
            if self.fail:
                raise RuntimeError("HTTP 401: Bad credentials")
            return [{"title": "Sprint 6"}]

    def board(self, pick):
        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}), mock.patch.object(collect.Live, "for_account", side_effect=pick), redirect_stdout(buf):
            code = cli.main(["board"])
        return code, buf.getvalue()

    def test_board_per_account_survives_one_failing(self):
        alice = self.Src([dict(board_item(939, "In Dev", "2026-09-21"), project="acme/1")])
        code, out = self.board(lambda v, runner=None: alice if v["login"] == "alice" else self.Src([], True))
        self.assertEqual(code, 0)
        b = json.loads(out)
        self.assertEqual([c["number"] for c in b["cards"]], [939])
        self.assertEqual(b["errors"], ["HTTP 401: Bad credentials"])
        self.assertEqual([c["account"] for c in b["cards"]], ["alice"])
        code, out = self.board(lambda v, runner=None: self.Src([], True))
        self.assertEqual((code, out.strip()), (1, "HTTP 401: Bad credentials"))

    def test_one_account_cards_have_no_account(self):
        b = board.build([board_item(939, "In Dev")], {}, SNAP_NOW)
        self.assertNotIn("account", b["cards"][0])
        self.assertNotIn("errors", b)

    def test_sprints_per_account(self):
        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}), \
                mock.patch.object(collect.Live, "for_account", side_effect=lambda v, runner=None: self.Src([], v["login"] == "bob-work")), redirect_stdout(buf):
            self.assertEqual(cli.main(["sprints"]), 0)
        self.assertEqual(json.loads(buf.getvalue()), [{"title": "Sprint 6"}])


if __name__ == "__main__":
    unittest.main()

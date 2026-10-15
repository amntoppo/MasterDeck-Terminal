from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from master import cli, ledger, spawn, start
from tests.helpers import agent, board_item
from tests.test_cli import write_fixtures

NOW = "2026-10-16T10:00:00Z"


def api_issue(n, title, body="", state="open", repo="acme/tracker", pr=False, assignees=()):
    raw = {"number": n, "title": title, "body": body, "state": state,
           "html_url": f"https://github.com/{repo}/issues/{n}",
           "assignees": [{"login": a} for a in assignees], "labels": [{"name": "bug"}]}
    if pr:
        raw["pull_request"] = {"url": "x"}
    return raw


def card(n, status, assignees=("alice",), labels=(), repo="acme/tracker"):
    it = board_item(n, status, "2026-10-12", assignees=assignees)
    it["content"]["repository"] = repo
    it["labels"] = list(labels)
    it["project"] = "acme/1"
    return it


class StartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fx = Path(self.tmp.name) / "fx"
        self.fx.mkdir()
        write_fixtures(self.fx)
        self.ws = Path(self.tmp.name) / "ws"
        (self.ws / "tracker" / ".git").mkdir(parents=True)
        (self.ws / "tracker" / ".git" / "config").write_text('[remote "origin"]\n\turl = https://github.com/acme/tracker.git\n')
        (self.ws / "tracker" / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        self._env = {k: os.environ.get(k) for k in ("MASTER_HOME", "MASTER_WORKSPACE", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID")}
        os.environ["MASTER_HOME"] = str(Path(self.tmp.name) / "home")
        os.environ["MASTER_WORKSPACE"] = str(self.ws)
        os.environ.pop("CLAUDECODE", None)
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
        from master import checkout
        checkout.forget()
        self.write("issues.json", {
            "acme/tracker#42": api_issue(42, "Fix upload retry", body="Uploads fail on a slow line.\n\n- retry 3 times"),
            "acme/tracker#57": api_issue(57, "Dark mode"),
            "acme/tracker#60": api_issue(60, "Old thing", state="closed"),
            "acme/tracker#61": api_issue(61, "A PR", pr=True),
            # 939 is owned by the running session "paywall" (state.json of write_fixtures).
            "acme/tracker#939": api_issue(939, "Paywall"),
        })
        self.write("sub_issues.json", {"acme/tracker#42": [
            {"number": 43, "title": "Retry in the client", "state": "closed", "repository_url": "https://api.github.com/repos/acme/tracker"},
            {"number": 44, "title": "Retry on the server", "state": "open", "repository_url": "https://api.github.com/repos/acme/tracker"}]})
        self.write("board_sprint.json", [card(42, "Ready For Dev", labels=["bug"]), card(57, "Ready For Dev", assignees=("bob",)),
                                         card(58, "To Do", labels=["bug"]), card(59, "Dev Done")])

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def write(self, name, data):
        (self.fx / name).write_text(json.dumps(data))

    def run_cli(self, *argv, stdin=None):
        buf = io.StringIO()
        with redirect_stdout(buf), mock.patch("sys.stdin", io.StringIO(stdin or "")):
            code = cli.main([*argv, "--fixtures", str(self.fx), "--now", NOW])
        return code, buf.getvalue()

    def proposals(self):
        return ledger.load()["proposals"]

    # --- from scratch ---

    def test_scratch_start_is_a_start_proposal_waiting_for_the_user(self):
        code, out = self.run_cli("start", "--prompt", "fix the flaky tests in upload", "--repo", "acme/tracker")
        self.assertEqual(code, 0, out)
        [p] = self.proposals()
        self.assertEqual((p["kind"], p["issue"], p["status"]), ("START", 0, "proposed"))
        sp = p["target"]["spawn"]
        self.assertEqual(sp["name"], "fix-flaky-tests-upload")
        self.assertEqual(sp["cwd"], str(self.ws / "tracker"))
        self.assertIn("fix the flaky tests in upload", sp["prompt"])
        self.assertIn("This folder is a checkout of acme/tracker", sp["prompt"])
        self.assertIn("'fix-flaky-tests-upload: done'", sp["prompt"])
        self.assertIn("waiting for your yes", out)
        self.assertIn("from scratch → fix-flaky-tests-upload", out)
        self.assertIn(f"folder: {self.ws / 'tracker'}", out)

    def test_scratch_options_reach_the_spawn_command(self):
        code, out = self.run_cli("start", "--prompt", "-", "--name", "flaky", "--model", "opus", "--permission-mode", "plan",
                                 "--worktree", stdin="fix the flaky tests")
        self.assertEqual(code, 0, out)
        [p] = self.proposals()
        sp = p["target"]["spawn"]
        self.assertEqual((sp["name"], sp["worktree"], sp["cwd"]), ("flaky", "flaky", str(self.ws)))
        cmd = spawn.command(p["target"])
        self.assertEqual(cmd[:2], ["claude", "--bg"])
        self.assertIn("--worktree", cmd)
        self.assertEqual(cmd[cmd.index("--worktree") + 1], "flaky")
        self.assertEqual(cmd[cmd.index("--permission-mode") + 1], "plan")
        self.assertEqual(cmd[cmd.index("--model") + 1], "opus")
        self.assertEqual(cmd[-1], sp["prompt"])

    def test_scratch_without_a_checkout_says_so(self):
        code, out = self.run_cli("start", "--prompt", "look at the api", "--repo", "acme/api")
        self.assertEqual(code, 0, out)
        self.assertIn("warning: no checkout of acme/api found", out)
        self.assertEqual(self.proposals()[0]["target"]["spawn"]["cwd"], str(self.ws))

    def test_a_running_name_gets_a_suffix(self):
        code, out = self.run_cli("start", "--prompt", "x", "--name", "paywall")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.proposals()[0]["target"]["spawn"]["name"], "paywall-2")

    def test_needs_a_task_or_tickets(self):
        code, out = self.run_cli("start")
        self.assertEqual(code, 2)
        self.assertIn("needs a task", out)
        self.assertEqual(self.proposals(), [])

    def test_bad_options_are_refused_before_anything_is_added(self):
        for argv in (["--prompt", "x", "--permission-mode", "bypassPermissions"], ["--prompt", "x", "--model=--x"],
                     ["--prompt", "x", "--worktree", "a b"], ["--prompt=-x"], ["--prompt", "x", "--cwd", "/no/such/dir"],
                     ["42", "--repo", "acme/api"], ["42", "--column", "To Do"]):
            code, out = self.run_cli("start", *argv)
            self.assertEqual(code, 2, (argv, out))
        self.assertEqual(self.proposals(), [])

    def test_dry_run_adds_nothing_and_is_a_read(self):
        code, out = self.run_cli("start", "42", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("dry run", out)
        self.assertEqual(self.proposals(), [])
        self.assertFalse(cli._is_write(cli.parser().parse_args(["start", "42", "--dry-run"])))
        self.assertTrue(cli._is_write(cli.parser().parse_args(["start", "42"])))

    # --- tickets ---

    def test_ticket_start_is_an_assign_with_the_ticket_context(self):
        code, out = self.run_cli("start", "#42", "--prompt", "keep it small")
        self.assertEqual(code, 0, out)
        [p] = self.proposals()
        self.assertEqual((p["kind"], p["issue"], p["status"]), ("ASSIGN", 42, "proposed"))
        self.assertTrue(p["source"].startswith("start:acme/tracker#42:"))
        sp = p["target"]["spawn"]
        self.assertEqual(sp["name"], "42-fix-upload-retry")
        self.assertEqual(sp["cwd"], str(self.ws / "tracker"))
        self.assertTrue(sp["assignMe"])
        self.assertIn("You own acme/tracker#42 (Fix upload retry)", sp["prompt"])
        self.assertIn("instead of stopping to ask in step 2", sp["prompt"])
        self.assertIn("## The ticket's description\n\nUploads fail on a slow line.", sp["prompt"])
        self.assertIn("- [x] acme/tracker#43 Retry in the client", sp["prompt"])
        self.assertIn("- [ ] acme/tracker#44 Retry on the server", sp["prompt"])
        self.assertIn("## The user's first instructions\n\nkeep it small", sp["prompt"])
        self.assertEqual(p["message"], sp["prompt"])
        self.assertIn("#42 → 42-fix-upload-retry", out)
        self.assertIn("assigns you and moves the card to In Dev", out)

    def test_ticket_failures_are_reported_and_not_added(self):
        code, out = self.run_cli("start", "#99", "#60", "#61", "#939", "other/x#1", "--no-assign")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.proposals(), [])
        self.assertIn("#99: not found", out)
        self.assertIn("#60: is closed", out)
        self.assertIn("#61: is a pull request", out)
        self.assertIn("#939: already has a session: paywall", out)
        self.assertIn("x#1: other/x is not selected in Setup", out)

    def test_a_batch_adds_each_and_keeps_the_good_ones(self):
        code, out = self.run_cli("start", "#42,#57", "#939", "--no-assign")
        self.assertEqual(code, 0, out)
        self.assertEqual([p["issue"] for p in self.proposals()], [42, 57])
        self.assertNotIn("assignMe", self.proposals()[0]["target"]["spawn"])
        self.assertIn("2 starts waiting for your yes", out)
        self.assertIn("#939: already has a session", out)

    def test_the_sweeps_proposal_for_the_ticket_is_replaced(self):
        with ledger.locked() as led:
            old = ledger.add(led, kind="ASSIGN", issue=42, source="issue:42", target={"spawn": {"name": "42-x", "prompt": "p"}},
                             message="p", summary="s", now=NOW)
        code, out = self.run_cli("start", "42")
        self.assertEqual(code, 0, out)
        got = {p["id"]: p for p in self.proposals()}
        self.assertEqual(got[old["id"]]["status"], "rejected")
        self.assertIn("replaced by start proposal 2", got[old["id"]]["note"])
        self.assertIn("replaces proposal 1", out)

    def test_an_approved_proposal_for_the_ticket_refuses_the_start(self):
        with ledger.locked() as led:
            old = ledger.add(led, kind="ASSIGN", issue=42, source="issue:42", target={"spawn": {"name": "42-x", "prompt": "p"}},
                             message="p", summary="s", now=NOW)
            ledger.transition(led, old["id"], "approved", now=NOW)
        code, out = self.run_cli("start", "42")
        self.assertEqual(code, 1, out)
        self.assertIn("proposal 1 for it is approved and about to start", out)

    def test_board_filters_pick_by_column_assignee_and_label(self):
        code, out = self.run_cli("start", "--column", "ready for dev", "--assignee", "@me", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("#42 →", out)
        self.assertNotIn("#57 →", out)  # bob's
        code, out = self.run_cli("start", "--label", "bug", "--dry-run")
        self.assertIn("#42 →", out)
        self.assertNotIn("#59", out)   # Dev Done: finished cards only when their column is named
        self.assertIn("#58: not found", out)  # on the board, but GitHub's read has no #58 here

    def test_board_filter_limit(self):
        code, out = self.run_cli("start", "--assignee", "alice", "--limit", "1", "--dry-run")
        self.assertIn("more tickets matched; only the first 1", out)

    def test_board_filter_with_no_match(self):
        code, out = self.run_cli("start", "--column", "In QA")
        self.assertEqual(code, 1)
        self.assertIn("no ticket on the board matches", out)

    # --- start it now ---

    def _fake_spawn(self, rc=0, out="backgrounded · ab12cd34\n  claude attach ab12cd34\n", err=""):
        calls = []
        real = spawn.spawn

        def runner(cmd, **kw):
            calls.append((cmd, kw.get("cwd")))
            return subprocess.CompletedProcess(cmd, rc, out, err)

        return calls, mock.patch.object(spawn, "spawn", side_effect=lambda led, pid, now, **k: real(led, pid, now=now, runner=runner))

    def test_yes_approves_and_spawns_at_once(self):
        calls, patch = self._fake_spawn()
        with patch:
            code, out = self.run_cli("start", "--prompt", "fix the flaky tests", "--yes")
        self.assertEqual(code, 0, out)
        [p] = self.proposals()
        self.assertEqual(p["status"], "sent")
        self.assertEqual(calls[0][0][:4], ["claude", "--bg", "-n", "fix-flaky-tests"])
        self.assertIn("started fix-flaky-tests (proposal 1) — claude attach ab12cd34", out)

    def test_yes_reports_a_refused_start_and_leaves_it_held(self):
        calls, patch = self._fake_spawn(rc=1, out="", err="Workspace not trusted. Run claude in this folder first.")
        with patch:
            code, out = self.run_cli("start", "42", "--yes")
        [p] = self.proposals()
        self.assertEqual(p["status"], "held")
        self.assertEqual(len(calls), 1)
        self.assertIn("42-fix-upload-retry did not start", out)
        self.assertIn("say retry", out)


class StartHelpersTest(unittest.TestCase):
    def test_scratch_name(self):
        self.assertEqual(start.scratch_name("Fix the flaky tests in MasterDeck-Terminal"), "fix-flaky-tests-masterdeck-terminal")
        self.assertEqual(start.scratch_name("!!!"), "session")

    def test_board_match(self):
        c = {"status": "Ready For Dev", "assignees": ["alice"], "labels": ["Bug", "ui"]}
        self.assertTrue(start.board_match(c, "ready for dev", "@me", ["bug"], "alice"))
        self.assertFalse(start.board_match(c, None, "@me", [], None))  # nobody known as me
        self.assertFalse(start.board_match(c, None, "none", [], "alice"))
        self.assertTrue(start.board_match({**c, "assignees": []}, None, "none", [], "alice"))
        self.assertFalse(start.board_match(c, None, None, ["bug", "api"], "alice"))

    def test_long_descriptions_and_many_sub_issues_are_cut(self):
        issue = {"number": 1, "repo": None, "title": "t", "url": "u", "body": "x" * (start.DESC_MAX + 5)}
        subs = [{"number": i, "repo": "acme/tracker", "title": "s", "state": "open"} for i in range(start.SUBS_MAX + 3)]
        got = start.context_block(issue, subs)
        self.assertIn("cut at", got)
        self.assertIn("and 3 more", got)


if __name__ == "__main__":
    unittest.main()

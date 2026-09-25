from __future__ import annotations

import io
import json
import os
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest import mock

from master import cli, inbox, ledger
from tests.helpers import ME, agent, board_item, pr_node

NOW = "2026-09-24T10:00:00Z"
BRANCH = "acme/mobile-app@feat/x"


def write_fixtures(d: Path, prs=None):
    files = {
        "board_mine.json": [board_item(939, "In Dev", "2026-09-21"), board_item(981, "To Do", "2026-09-21")],
        "board_ready.json": [],
        "prs_mine.json": prs if prs is not None else [
            pr_node(55, threads=[(False, "2026-09-24T09:40:00Z")], body="Refs acme/tracker#939")],
        "prs_review.json": [],
        "agents.json": [agent("s1", "paywall", status="blocked"), agent("m", "master-agent"),
                        # Real `claude agents` background rows: no pid, no status, a `state`.
                        # The app decides fresh vs stale from the transcript's last write.
                        agent("b1000000-0000-4000-8000-000000000001", "fresh-bg", kind="background",
                              state="blocked", bg_id="a08022cf"),
                        agent("b2000000-0000-4000-8000-000000000002", "stale-bg", kind="background",
                              state="blocked", bg_id="b19933de"),
                        agent("b3000000-0000-4000-8000-000000000003", "done-bg", kind="background",
                              state="done", bg_id="c2aa4410")],
        "state.json": {"sessions": {"s1": {"issue": 939, "branch": BRANCH, "linked_at": "x", "prs": []}}},
        "branch_heads.json": {BRANCH: "abc"},
    }
    for name, data in files.items():
        (d / name).write_text(json.dumps(data))
    (d / "me.txt").write_text(ME)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.fx = Path(self.tmp.name) / "fx"
        self.fx.mkdir()
        write_fixtures(self.fx)
        self._env = {k: os.environ.get(k) for k in
                     ("MASTER_HOME", "MASTER_WORKSPACE", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID")}
        os.environ["MASTER_HOME"] = str(self.home)
        os.environ["MASTER_WORKSPACE"] = "/ws"
        # The test runner itself may be launched from inside a Claude Code session — clear
        # the guard's env vars so these tests exercise the read/plain-terminal path unless
        # a test explicitly sets them.
        os.environ.pop("CLAUDECODE", None)
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def run_cli(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(list(argv))
        return code, buf.getvalue()

    def run_cli_as(self, session_id, agents_loader, *argv):
        buf = io.StringIO()
        os.environ["CLAUDECODE"] = "1"
        os.environ["CLAUDE_CODE_SESSION_ID"] = session_id
        try:
            with redirect_stdout(buf):
                code = cli.main(list(argv), agents_loader=agents_loader)
        finally:
            os.environ.pop("CLAUDECODE", None)
            os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
        return code, buf.getvalue()

    def sweep(self, *extra):
        return self.run_cli("sweep", "--fixtures", str(self.fx), "--now", NOW, *extra)

    def test_sweep_proposes_and_saves(self):
        code, out = self.sweep()
        self.assertEqual(code, 0)
        self.assertIn("2 proposals", out)
        self.assertIn("ASSIGN  #981 → spawn 981-issue-981", out)
        self.assertIn("REVIEW  #939 → paywall", out)
        led = ledger.load()
        self.assertEqual(len(led["proposals"]), 2)
        self.assertEqual(led["cursor"]["snapshot_at"], NOW)
        self.assertEqual(led["last_snapshot"]["taken_at"], NOW)

    def test_second_sweep_is_silent(self):
        self.sweep()
        _, out = self.sweep()
        self.assertEqual(out.strip(), "no new proposals")

    def test_dry_run_saves_nothing(self):
        _, out = self.sweep("--dry-run")
        self.assertIn("2 proposals", out)
        self.assertFalse(ledger.ledger_path().exists())

    def test_missing_source_is_reported(self):
        (self.fx / "prs_mine.json").unlink()
        _, out = self.sweep()
        self.assertIn("sources missing: prs", out)
        self.assertNotIn("REVIEW", out)

    def test_sweep_prints_errors_even_without_a_missing_source(self):
        # branch_heads.json exists but doesn't cover the branch: branch_head() raises,
        # which is filed under "branches" — a key that's popped out of `sources` entirely,
        # so "sources missing" never fires even though there was a real error to report.
        (self.fx / "branch_heads.json").write_text(json.dumps({}))
        _, out = self.sweep()
        self.assertNotIn("sources missing", out)
        self.assertIn("branches:", out)

    def test_approve_reject_mark_list(self):
        self.sweep()
        self.assertEqual(self.run_cli("approve", "1")[0], 0)
        self.assertEqual(self.run_cli("reject", "2")[0], 0)
        self.assertEqual(self.run_cli("mark", "1", "sent", "--note", "sent via SendMessage")[0], 0)
        _, out = self.run_cli("list", "--status", "sent")
        rows = [json.loads(line) for line in out.strip().splitlines()]
        self.assertEqual([(r["id"], r["status"], r["note"]) for r in rows], [(1, "sent", "sent via SendMessage")])
        self.assertIn("message", rows[0])

    def test_mark_question(self):
        self.sweep()
        self.run_cli("approve", "2")
        self.run_cli("mark", "2", "sent")
        code, out = self.run_cli("mark", "2", "question", "--note", "which approach?")
        self.assertEqual((code, out), (0, "2: question\n"))
        p = ledger.load()["proposals"][1]
        self.assertEqual((p["status"], p["note"]), ("question", "which approach?"))

    def test_mark_question_on_a_done_proposal_reopens_it_and_clears_closed_at(self):
        self.sweep()
        self.run_cli("approve", "2")
        self.run_cli("mark", "2", "sent")
        self.run_cli("mark", "2", "done")
        p = ledger.load()["proposals"][1]
        self.assertEqual(p["status"], "done")
        self.assertIsNotNone(p["closed_at"])
        code, out = self.run_cli("mark", "2", "question", "--note", "one more thing?")
        self.assertEqual((code, out), (0, "2: question\n"))
        p = ledger.load()["proposals"][1]
        self.assertEqual((p["status"], p["note"], p["closed_at"]), ("question", "one more thing?", None))

    def test_mark_sent_on_a_done_proposal_shows_it_working_again(self):
        self.sweep()
        self.run_cli("approve", "2")
        self.run_cli("mark", "2", "sent")
        self.run_cli("mark", "2", "done")
        code, out = self.run_cli("mark", "2", "sent")
        self.assertEqual((code, out), (0, "2: sent\n"))
        p = ledger.load()["proposals"][1]
        self.assertEqual((p["status"], p["closed_at"]), ("sent", None))

    def test_mark_note_from_stdin(self):
        self.sweep()
        self.run_cli("approve", "1")
        code, out = self.run_cli_stdin("held because `rm -rf /` was in the notice",
                                       "mark", "1", "held", "--note", "-")
        self.assertEqual((code, out), (0, "1: held\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["note"], "held because `rm -rf /` was in the notice")

    def test_illegal_mark_fails_cleanly(self):
        self.sweep()
        code, out = self.run_cli("mark", "1", "done")
        self.assertEqual(code, 1)
        self.assertIn("not allowed", out)

    def test_unknown_id_fails_cleanly(self):
        code, out = self.run_cli("approve", "42")
        self.assertEqual(code, 1)
        self.assertIn("no proposal 42", out)

    def test_add_meeting_proposal_with_dedup(self):
        args = ["add", "--kind", "MEETING", "--issue", "939", "--source", "fathom:123:a1",
                "--summary", "skip step 3 on Android", "--session", "paywall",
                "--message", "#939: from standup 09-24 — skip step 3 on Android"]
        self.assertEqual(self.run_cli(*args), (0, "added 1\n"))
        self.assertEqual(self.run_cli(*args), (0, "duplicate\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual((p["kind"], p["target"]), ("MEETING", {"session": "paywall"}))

    def test_add_derives_summary_from_message_with_issue_prefix(self):
        code, out = self.run_cli("add", "--kind", "MEETING", "--issue", "939", "--source", "fathom:123:a1",
                                 "--session", "paywall",
                                 "--message", "#939: from standup 09-24 — skip step 3 on Android")
        self.assertEqual((code, out), (0, "added 1\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["summary"], "from standup 09-24 — skip step 3 on Android")

    def test_add_derives_summary_from_message_without_prefix(self):
        code, out = self.run_cli("add", "--kind", "CHAT", "--issue", "0", "--source", "chat:1",
                                 "--session", "paywall", "--message", "tell paywall to skip the web half")
        self.assertEqual((code, out), (0, "added 1\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["summary"], "tell paywall to skip the web half")

    def test_add_derived_summary_is_truncated(self):
        long_first_line = "x" * 90
        code, out = self.run_cli("add", "--kind", "CHAT", "--issue", "0", "--source", "chat:2",
                                 "--session", "paywall", "--message", long_first_line + "\nrest of message")
        self.assertEqual((code, out), (0, "added 1\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["summary"], "x" * 60 + "…")

    def test_add_explicit_summary_still_works(self):
        code, out = self.run_cli("add", "--kind", "CHAT", "--issue", "0", "--source", "chat:3",
                                 "--session", "paywall", "--summary", "custom summary",
                                 "--message", "whatever this says")
        self.assertEqual((code, out), (0, "added 1\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["summary"], "custom summary")

    def test_add_spawn_target_defaults_cwd_to_workspace(self):
        self.run_cli("add", "--kind", "MEETING", "--issue", "5", "--source", "f:1", "--summary", "s",
                     "--message", "m", "--spawn-name", "5-x", "--prompt", "do it")
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["target"], {"spawn": {"name": "5-x", "cwd": str(Path("/ws")), "prompt": "do it"}})

    def test_add_spawn_hostile_prompt_refused(self):
        code, out = self.run_cli("add", "--kind", "MEETING", "--issue", "5", "--source", "f:1",
                                 "--summary", "s", "--message", "m", "--spawn-name", "5-x",
                                 "--prompt", "--dangerously-skip-permissions do x")
        self.assertEqual(code, 2)
        self.assertIn("must not start with", out)
        self.assertEqual(ledger.load()["proposals"], [])

    def test_add_spawn_hostile_name_refused(self):
        code, out = self.run_cli("add", "--kind", "MEETING", "--issue", "5", "--source", "f:1",
                                 "--summary", "s", "--message", "m", "--spawn-name=-x",
                                 "--prompt", "do it")
        self.assertEqual(code, 2)
        self.assertIn("invalid session name", out)
        self.assertEqual(ledger.load()["proposals"], [])

    def test_write_from_other_claude_session_is_refused(self):
        loader = lambda: [{"name": "master-agent", "sessionId": "master-sid"}]
        code, out = self.run_cli_as("other-sid", loader, "say", "hi", "--now", NOW)
        self.assertEqual(code, 3)
        self.assertIn("refused", out)
        self.assertEqual(inbox.read(inbox.INBOX), [])

    def test_write_from_master_session_is_allowed(self):
        loader = lambda: [{"name": "master-agent", "sessionId": "master-sid"}]
        code, out = self.run_cli_as("master-sid", loader, "say", "hi", "--now", NOW)
        self.assertEqual(code, 0)
        self.assertEqual(out, "inbox 1\n")

    def test_read_commands_never_call_the_agents_loader(self):
        def boom():
            raise AssertionError("agents_loader must not be called for a read command")

        for argv in (
            ["status", "--fixtures", str(self.fx), "--now", NOW],
            ["list"],
            ["snapshot", "--fixtures", str(self.fx), "--now", NOW],
            ["sweep", "--fixtures", str(self.fx), "--now", NOW, "--dry-run"],
            ["cursor"],
            ["watch", "--iterations", "0"],
        ):
            with self.subTest(argv=argv):
                code, _ = self.run_cli_as("some-sid", boom, *argv)
                self.assertEqual(code, 0)
        with mock.patch("sys.stdin", io.StringIO("hi")):
            code, _ = self.run_cli_as("some-sid", boom, "key")
            self.assertEqual(code, 0)

    def run_cli_stdin(self, stdin_text, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf), mock.patch("sys.stdin", io.StringIO(stdin_text)):
            code = cli.main(list(argv))
        return code, buf.getvalue()

    def test_add_message_from_stdin(self):
        code, out = self.run_cli_stdin(
            "`rm -rf /` in backticks",
            "add", "--kind", "MEETING", "--issue", "5", "--source", "f:1",
            "--summary", "s", "--message", "-", "--session", "paywall")
        self.assertEqual((code, out), (0, "added 1\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["message"], "`rm -rf /` in backticks")

    def test_add_prompt_from_stdin(self):
        code, out = self.run_cli_stdin(
            "do the thing",
            "add", "--kind", "MEETING", "--issue", "5", "--source", "f:1",
            "--summary", "s", "--message", "m", "--spawn-name", "5-x", "--prompt", "-")
        self.assertEqual((code, out), (0, "added 1\n"))
        p = ledger.load()["proposals"][0]
        self.assertEqual(p["target"]["spawn"]["prompt"], "do the thing")

    def test_add_two_dash_fields_is_refused(self):
        code, out = self.run_cli_stdin(
            "x",
            "add", "--kind", "MEETING", "--issue", "5", "--source", "f:1",
            "--summary", "-", "--message", "-", "--session", "paywall")
        self.assertEqual(code, 2)
        self.assertIn("only one of", out)
        self.assertEqual(ledger.load()["proposals"], [])

    def test_say_text_from_stdin(self):
        code, out = self.run_cli_stdin("has `backticks` and $(danger)", "say", "-", "--now", NOW)
        self.assertEqual((code, out), (0, "inbox 1\n"))

    def test_say_to_writes_send_entry(self):
        code, out = self.run_cli("say", "--to", "paywall", "please rebase on main", "--now", NOW)
        self.assertEqual((code, out), (0, "inbox 1\n"))
        self.assertEqual(inbox.read(inbox.INBOX),
                         [{"id": 1, "at": NOW, "kind": "send", "to": "paywall", "text": "please rebase on main"}])

    def test_say_without_to_is_unchanged(self):
        code, out = self.run_cli("say", "hello", "--now", NOW)
        self.assertEqual((code, out), (0, "inbox 1\n"))
        self.assertEqual(inbox.read(inbox.INBOX)[0]["kind"], "say")
        self.assertNotIn("to", inbox.read(inbox.INBOX)[0])

    def test_say_to_text_from_stdin(self):
        code, out = self.run_cli_stdin("please rebase\non main", "say", "--to", "paywall", "-", "--now", NOW)
        self.assertEqual((code, out), (0, "inbox 1\n"))
        self.assertEqual(inbox.read(inbox.INBOX)[0]["text"], "please rebase\non main")

    def test_say_to_name_with_spaces_is_allowed(self):
        code, out = self.run_cli("say", "--to", "my session", "hi", "--now", NOW)
        self.assertEqual(code, 0)
        self.assertEqual(inbox.read(inbox.INBOX)[0]["to"], "my session")

    def test_say_to_invalid_names_write_nothing(self):
        for name in ("", "x" * 101, "bad\nname", "bad\rname", "-leading-dash"):
            with self.subTest(name=name):
                code, out = self.run_cli("say", f"--to={name}", "text", "--now", NOW)
                self.assertEqual(code, 2)
                self.assertEqual(inbox.read(inbox.INBOX), [])

    def test_reply_text_from_stdin(self):
        self.run_cli("say", "q", "--now", NOW)
        code, out = self.run_cli_stdin("free `text` here", "reply", "1", "-", "--now", NOW)
        self.assertEqual((code, out), (0, "outbox 1\n"))

    def test_status_roster(self):
        _, out = self.run_cli("status", "--fixtures", str(self.fx), "--now", NOW)
        self.assertIn("paywall", out)
        self.assertIn("#939 [In Dev]", out)
        self.assertIn("needs input", out)
        self.assertNotIn("master-agent", out)

    def test_cursor(self):
        self.run_cli("cursor", "--meetings-since", "2026-09-24T00:00:00Z")
        _, out = self.run_cli("cursor")
        self.assertEqual(json.loads(out)["meetings_since"], "2026-09-24T00:00:00Z")

    def test_today_uses_explicit_now_date(self):
        args = types.SimpleNamespace(now="2029-03-15T00:00:00Z")
        self.assertEqual(cli._today(args), date(2029, 3, 15))

    def test_today_falls_back_to_local_date_when_now_absent(self):
        args = types.SimpleNamespace(now=None)
        with mock.patch("master.cli.date") as mock_date:
            mock_date.today.return_value = date(2029, 1, 1)
            self.assertEqual(cli._today(args), date(2029, 1, 1))
            mock_date.today.assert_called_once()
            mock_date.fromisoformat.assert_not_called()

    def test_snapshot_prints_json(self):
        _, out = self.run_cli("snapshot", "--fixtures", str(self.fx), "--now", NOW)
        self.assertEqual(json.loads(out)["taken_at"], NOW)

    def _key(self, text):
        with mock.patch("sys.stdin", io.StringIO(text)):
            _, out = self.run_cli("key")
        return out.strip()

    def test_key_whitespace_and_case_variants_collide(self):
        a = self._key("Skip step 3  on Android\n")
        b = self._key("skip   step 3 on android")
        self.assertEqual(a, b)
        self.assertEqual(len(a), 12)

    def test_key_same_first_8_chars_still_differ(self):
        text_a, text_b = "skip step 3 on Android", "skip step 4 on Android"
        self.assertEqual(text_a[:8], text_b[:8])  # sanity: same raw prefix
        self.assertNotEqual(self._key(text_a), self._key(text_b))


if __name__ == "__main__":
    unittest.main()

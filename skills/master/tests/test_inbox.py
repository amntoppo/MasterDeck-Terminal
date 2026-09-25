from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from master import cli, inbox, ledger

NOW = "2026-09-24T10:00:00Z"


class InboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._env = {k: os.environ.get(k) for k in ("MASTER_HOME", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID")}
        os.environ["MASTER_HOME"] = self.tmp.name
        # The test runner itself may run inside a Claude Code session; clear the guard's
        # env vars so these tests exercise the plain-terminal path.
        os.environ.pop("CLAUDECODE", None)
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_say_appends_with_increasing_ids(self):
        a = inbox.say("hello", now=NOW)
        b = inbox.say("", now=NOW, kind="sweep")
        self.assertEqual((a["id"], b["id"]), (1, 2))
        self.assertEqual(inbox.read(inbox.INBOX), [
            {"id": 1, "at": NOW, "kind": "say", "text": "hello"},
            {"id": 2, "at": NOW, "kind": "sweep", "text": ""}])

    def test_say_with_to_writes_send_kind(self):
        entry = inbox.say("please rebase on main", now=NOW, to="paywall")
        self.assertEqual(entry, {"id": 1, "at": NOW, "kind": "send", "to": "paywall",
                                  "text": "please rebase on main"})
        self.assertEqual(inbox.read(inbox.INBOX), [entry])

    def test_read_skips_malformed_lines(self):
        (Path(self.tmp.name) / "inbox.jsonl").write_text(
            '{"id": 1, "at": "x", "kind": "say", "text": "a"}\nnot json\n\n')
        self.assertEqual([e["id"] for e in inbox.read(inbox.INBOX)], [1])

    def test_read_missing_file(self):
        self.assertEqual(inbox.read(inbox.OUTBOX), [])

    def test_corrupt_middle_line_does_not_cause_id_reuse(self):
        path = Path(self.tmp.name) / inbox.INBOX
        path.write_text('{"id": 1, "at": "x", "kind": "say", "text": "a"}\n'
                        'not json\n'
                        '{"id": 3, "at": "x", "kind": "say", "text": "c"}\n')
        entry = inbox.say("d", now=NOW)
        self.assertEqual(entry["id"], 4)

    def test_reply_needs_an_existing_entry(self):
        inbox.say("q", now=NOW)
        self.assertEqual(inbox.reply(1, "a", now=NOW), {"id": 1, "at": NOW, "in_reply_to": 1, "text": "a"})
        with self.assertRaises(KeyError):
            inbox.reply(9, "a", now=NOW)

    def test_ack_is_idempotent_and_checked(self):
        inbox.say("q", now=NOW)
        inbox.ack(1)
        inbox.ack(1)
        self.assertEqual(ledger.load()["acked"], [1])
        with self.assertRaises(KeyError):
            inbox.ack(2)

    def test_watch_lines_backlog_then_only_new(self):
        inbox.say("one", now=NOW)
        with ledger.locked() as led:
            p = ledger.add(led, kind="REVIEW", issue=939, source="s", target={"session": "paywall"},
                           message="m", summary="2 threads", now=NOW)
            ledger.transition(led, p["id"], "approved", now=NOW)
            ledger.add(led, kind="CI", issue=1, source="t", target={"session": "x"},
                       message="m", summary="still proposed", now=NOW)
        seen: set = set()
        self.assertEqual(inbox.watch_lines(ledger.load(), seen),
                         ["inbox 1 say: one", "approved 1 REVIEW #939: 2 threads"])
        self.assertEqual(inbox.watch_lines(ledger.load(), seen), [])
        inbox.say("two", now=NOW)
        self.assertEqual(inbox.watch_lines(ledger.load(), seen), ["inbox 2 say: two"])

    def test_held_proposal_is_not_emitted_while_approved_one_is(self):
        with ledger.locked() as led:
            held = ledger.add(led, kind="ASSIGN", issue=981, source="s1", target={"session": "paywall"},
                              message="m", summary="held one", now=NOW)
            ledger.transition(led, held["id"], "approved", now=NOW)
            ledger.transition(led, held["id"], "held", now=NOW, note="cwd does not exist")
            approved = ledger.add(led, kind="ASSIGN", issue=982, source="s2", target={"session": "paywall"},
                                  message="m", summary="approved one", now=NOW)
            ledger.transition(led, approved["id"], "approved", now=NOW)
        lines = inbox.watch_lines(ledger.load(), set())
        self.assertEqual(lines, [f"approved {approved['id']} ASSIGN #982: approved one"])

    def test_acked_entries_are_not_emitted(self):
        inbox.say("one", now=NOW)
        inbox.ack(1)
        self.assertEqual(inbox.watch_lines(ledger.load(), set()), [])

    def test_sweep_and_multiline_formats(self):
        inbox.say("", now=NOW, kind="sweep")
        inbox.say("a\nb", now=NOW)
        self.assertEqual(inbox.watch_lines(ledger.load(), set()), ["inbox 1 sweep", "inbox 2 say: a ⏎ b"])

    def test_crlf_and_lone_cr_become_one_line(self):
        inbox.say("a\r\nb\rc", now=NOW)
        self.assertEqual(inbox.watch_lines(ledger.load(), set()), ["inbox 1 say: a ⏎ b ⏎ c"])

    def test_watch_line_for_send_entry(self):
        inbox.say("please rebase on main", now=NOW, to="paywall")
        self.assertEqual(inbox.watch_lines(ledger.load(), set()),
                         ["inbox 1 send → paywall: please rebase on main"])

    def test_watch_line_for_send_entry_single_lines_text(self):
        inbox.say("line one\nline two", now=NOW, to="paywall")
        self.assertEqual(inbox.watch_lines(ledger.load(), set()),
                         ["inbox 1 send → paywall: line one ⏎ line two"])

    def test_multiline_proposal_summary_becomes_one_line(self):
        with ledger.locked() as led:
            p = ledger.add(led, kind="REVIEW", issue=939, source="s", target={"session": "paywall"},
                           message="m", summary="line one\nline two", now=NOW)
            ledger.transition(led, p["id"], "approved", now=NOW)
        [line] = inbox.watch_lines(ledger.load(), set())
        self.assertEqual(line, "approved 1 REVIEW #939: line one line two")

    def test_watch_loop_picks_up_new_entries(self):
        inbox.say("one", now=NOW)
        out: list = []

        def fake_sleep(_seconds):
            inbox.say("two", now=NOW)

        inbox.watch(interval=0, iterations=2, sleep=fake_sleep, out=out.append)
        self.assertEqual(out, ["inbox 1 say: one", "inbox 2 say: two"])

    def test_cli_commands(self):
        def run(*argv):
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = cli.main(list(argv))
            return code, buf.getvalue()

        self.assertEqual(run("say", "hello", "--now", NOW), (0, "inbox 1\n"))
        self.assertEqual(run("sweep-request", "--now", NOW), (0, "inbox 2\n"))
        self.assertEqual(run("reply", "1", "hi", "--now", NOW), (0, "outbox 1\n"))
        self.assertEqual(run("ack", "1"), (0, "acked 1\n"))
        self.assertEqual(run("watch", "--iterations", "1"), (0, "inbox 2 sweep\n"))
        self.assertEqual(run("ack", "7"), (1, "no inbox entry 7\n"))


if __name__ == "__main__":
    unittest.main()

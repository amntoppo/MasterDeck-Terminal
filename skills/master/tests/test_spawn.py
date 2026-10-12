from __future__ import annotations

import subprocess
import tempfile
import json
import os
from pathlib import Path
import unittest
from unittest import mock

from master import config, ledger, spawn

NOW = "2026-09-24T10:00:00Z"


class FakeRunner:
    def __init__(self, code=0, out="started 4f2a9c1e\n", err=""):
        self.code, self.out, self.err = code, out, err
        self.calls = []

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, self.code, self.out, self.err)


class SpawnTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.led = ledger.empty()

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, target, approve=True):
        p = ledger.add(self.led, kind="ASSIGN", issue=981, source="issue:981", target=target,
                       message="m", summary="s", now=NOW)
        if approve:
            ledger.transition(self.led, p["id"], "approved", now=NOW)
        return p

    def test_permission_mode_goes_before_the_prompt_and_is_validated(self):
        self.assertEqual(spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go", "model": "opus", "permissionMode": "plan"}}),
                         ["claude", "--bg", "-n", "981-x", "--model", "opus", "--permission-mode", "plan", "go"])
        # None named: the command is the one it always was.
        self.assertEqual(spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go"}}),
                         ["claude", "--bg", "-n", "981-x", "go"])
        for bad in ("bypassPermissions", "plan;rm", "--plan", "Plan"):
            with self.assertRaises(spawn.SpawnError):
                spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go", "permissionMode": bad}})

    def test_model_goes_before_the_prompt_and_is_validated(self):
        self.assertEqual(spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go", "model": "opus[1m]"}}),
                         ["claude", "--bg", "-n", "981-x", "--model", "opus[1m]", "go"])
        self.assertEqual(spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go", "model": "claude-opus-5-5"}})[4:6],
                         ["--model", "claude-opus-5-5"])
        for bad in ("--dangerously-skip-permissions", "", "opus x", "a;b"):
            with self.assertRaises(spawn.SpawnError):
                spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go", "model": bad}})

    def test_command_shapes(self):
        self.assertEqual(spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go"}}),
                         ["claude", "--bg", "-n", "981-x", "go"])
        valid = "4f2a9c1e-1234-4abc-9def-0123456789ab"
        self.assertEqual(spawn.command({"spawn": {"name": "5-y", "cwd": "/w", "resume": valid}}),
                         ["claude", "--bg", "--resume", valid])

    def test_new_session_runs_in_cwd_and_marks_sent(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": self.tmp.name, "prompt": "go"}})
        run = FakeRunner()
        spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        cmd, kw = run.calls[0]
        self.assertEqual(cmd, ["claude", "--bg", "-n", "981-x", "go"])
        self.assertEqual(kw["cwd"], self.tmp.name)
        self.assertEqual((p["status"], p["note"]), ("sent", "started 4f2a9c1e"))

    def test_never_skips_permissions(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": self.tmp.name, "prompt": "go"}})
        run = FakeRunner()
        spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        self.assertFalse(any("skip-permissions" in part for part in run.calls[0][0]))

    def test_failure_moves_approved_to_held_with_note(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": self.tmp.name, "prompt": "go"}})
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner(code=1, out="", err="boom\n"))
        self.assertEqual((p["status"], p["note"]), ("held", "boom"))

    def test_os_error_moves_approved_to_held_with_note(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": self.tmp.name, "prompt": "go"}})

        def missing_binary(cmd, **kw):
            raise OSError("[Errno 2] No such file or directory: 'claude'")

        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=missing_binary)
        self.assertEqual(p["status"], "held")
        self.assertIn("No such file", p["note"])

    def test_held_proposal_can_be_respawned_successfully(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": self.tmp.name, "prompt": "go"}})
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner(code=1, out="", err="boom\n"))
        self.assertEqual(p["status"], "held")
        spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner())
        self.assertEqual((p["status"], p["note"]), ("sent", "started 4f2a9c1e"))

    def test_held_proposal_stays_held_with_updated_note_on_repeat_failure(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": self.tmp.name, "prompt": "go"}})
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner(code=1, out="", err="boom\n"))
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner(code=1, out="", err="boom again\n"))
        self.assertEqual((p["status"], p["note"]), ("held", "boom again"))

    def test_missing_cwd_fails_without_running(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": "/definitely/not/here", "prompt": "go"}})
        run = FakeRunner()
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        self.assertEqual(run.calls, [])
        self.assertIn("/definitely/not/here", p["note"])
        self.assertEqual(p["status"], "held")

    def test_hostile_prompt_refused_by_command(self):
        with self.assertRaises(spawn.SpawnError):
            spawn.command({"spawn": {"name": "981-x", "cwd": "/w",
                                     "prompt": "--dangerously-skip-permissions do x"}})

    def test_hostile_name_refused_by_command(self):
        with self.assertRaises(spawn.SpawnError):
            spawn.command({"spawn": {"name": "-x", "cwd": "/w", "prompt": "go"}})

    def test_bad_resume_refused_by_command(self):
        with self.assertRaises(spawn.SpawnError):
            spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "resume": "not-a-uuid"}})

    def test_valid_targets_still_pass_command(self):
        self.assertEqual(spawn.command({"spawn": {"name": "981-x", "cwd": "/w", "prompt": "go"}}),
                         ["claude", "--bg", "-n", "981-x", "go"])
        valid = "4f2a9c1e-1234-4abc-9def-0123456789ab"
        self.assertEqual(spawn.command({"spawn": {"name": "5-y", "cwd": "/w", "resume": valid}}),
                         ["claude", "--bg", "--resume", valid])

    def test_resume_of_a_running_session_is_not_started_twice(self):
        sid = "4f2a9c1e-1234-4abc-9def-0123456789ab"
        p = self.add({"spawn": {"name": "5-y", "cwd": self.tmp.name, "resume": sid}})
        run = FakeRunner(out='[{"sessionId": "%s", "pid": 42, "kind": "background"}]' % sid)
        got = spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        self.assertEqual(got["status"], "sent")
        self.assertIn("already running", got["note"])
        self.assertEqual([c[0][:2] for c in run.calls], [["claude", "agents"]])  # no --bg --resume

    def test_resume_of_a_stopped_session_runs_claude_bg_resume(self):
        sid = "4f2a9c1e-1234-4abc-9def-0123456789ab"
        p = self.add({"spawn": {"name": "5-y", "cwd": self.tmp.name, "resume": sid}})
        run = FakeRunner(out='[{"sessionId": "%s", "pid": null}]' % sid)
        spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        self.assertEqual(run.calls[-1][0], ["claude", "--bg", "--resume", sid])

    # Claude Code 2.1.288, real output: any flag on a resume starts a copy; none wakes the session.
    COPY_OUT = ("note: background session e168c2bf keeps its own saved options, so the flags you passed started a copy "
                "as 6d996951. Without flags, the same command continues e168c2bf itself.\n"
                "backgrounded · 6d996951 · dupprobe-md (idle — send a prompt to start)\n")
    WOKE_OUT = ("note: woke session e168c2bf with its saved options (-n, --model, --permission-mode).\n"
                "backgrounded · e168c2bf · dupprobe-md (idle — send a prompt to start)\n")

    def test_copy_of_reads_the_ids_only_from_a_copy_note(self):
        self.assertEqual(spawn.copy_of(self.COPY_OUT), ("e168c2bf", "6d996951"))
        self.assertIsNone(spawn.copy_of(self.WOKE_OUT))
        self.assertIsNone(spawn.copy_of("backgrounded · 1a2b3c4d\n"))
        self.assertIsNone(spawn.copy_of(""))

    # Claude Code 2.1.295, real output of `claude --bg -n probe59-a --model haiku "…"` with stdout
    # not a terminal (as spawn runs it): the id line carries the name, then four hint lines.
    BG_OUT = ("backgrounded · 582e44cc · probe59-a\n"
              "  claude agents             list sessions\n"
              "  claude attach 582e44cc    open in this terminal\n"
              "  claude logs 582e44cc      show recent output\n"
              "  claude stop 582e44cc      stop this session\n")

    def test_bg_id_reads_the_real_start_output(self):
        self.assertEqual(spawn.bg_id(self.BG_OUT), "582e44cc")
        self.assertEqual(spawn.bg_id(self.COPY_OUT), "6d996951")
        self.assertEqual(spawn.bg_id(self.WOKE_OUT), "e168c2bf")
        # The hint lines alone (the id line lost): the attach line still names it.
        self.assertEqual(spawn.bg_id("\n".join(self.BG_OUT.splitlines()[1:])), "582e44cc")
        self.assertIsNone(spawn.bg_id("started\n"))
        self.assertIsNone(spawn.bg_id(""))

    def test_a_bare_resume_wakes_the_session(self):
        sid = "e168c2bf-1234-4abc-9def-0123456789ab"
        p = self.add({"spawn": {"name": "5-y", "cwd": self.tmp.name, "resume": sid}})
        run = FakeRunner(out=self.WOKE_OUT)
        with mock.patch.object(spawn, "running", return_value=False):
            got = spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        self.assertEqual([c[0] for c in run.calls], [["claude", "--bg", "--resume", sid]])
        self.assertEqual(got["status"], "sent")

    def test_a_copy_is_never_removed_it_is_recorded_and_the_old_one_superseded(self):
        sid = "e168c2bf-1234-4abc-9def-0123456789ab"
        home = Path(self.tmp.name) / "md"
        home.mkdir()
        (home / "session-accounts.json").write_text(json.dumps({"s1": "alice"}))
        p = self.add({"spawn": {"name": "5-y", "cwd": self.tmp.name, "resume": sid, "account": "bob-work"}})
        run = FakeRunner(out=self.COPY_OUT)
        with mock.patch.dict(os.environ, {"MASTERDECK_HOME": str(home)}), \
                mock.patch.object(spawn, "running", return_value=False), \
                mock.patch.object(spawn, "command", return_value=["claude", "--bg", "--settings", "/f", "--resume", sid]):
            got = spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        # MasterDeck never removes a session: `claude rm` also deletes its worktree.
        self.assertEqual([c[0][:2] for c in run.calls], [["claude", "--bg"]])
        self.assertEqual(got["status"], "sent")
        # The app's files: the copy's account (so the app does not copy it again), and the old side.
        self.assertEqual(json.loads((home / "session-accounts.json").read_text()), {"s1": "alice", "6d996951": "bob-work"})
        self.assertEqual(json.loads((home / "superseded-sessions.json").read_text()), ["e168c2bf", sid])

    def test_merge_json_leaves_an_unreadable_file_alone(self):
        f = Path(self.tmp.name) / "x.json"
        spawn.merge_json(f, lambda d: {**(d or {}), "a": 1})  # missing: created
        self.assertEqual(json.loads(f.read_text()), {"a": 1})
        spawn.merge_json(f, lambda d: {**d, "b": 2})
        self.assertEqual(json.loads(f.read_text()), {"a": 1, "b": 2})
        f.write_text('{"a": 1, half')  # broken (or half-written by someone else): not replaced
        spawn.merge_json(f, lambda d: {"b": 2})
        self.assertEqual(f.read_text(), '{"a": 1, half')
        self.assertEqual([p.name for p in Path(self.tmp.name).iterdir()], ["x.json"])

    def test_superseded_ids_reads_the_apps_list(self):
        with mock.patch.dict(os.environ, {"MASTERDECK_HOME": self.tmp.name}):
            self.assertEqual(config.superseded_ids(), set())
            (Path(self.tmp.name) / "superseded-sessions.json").write_text(json.dumps(["e168c2bf", 7, "s-old"]))
            self.assertEqual(config.superseded_ids(), {"e168c2bf", "s-old"})
            (Path(self.tmp.name) / "superseded-sessions.json").write_text("{nope")
            self.assertEqual(config.superseded_ids(), set())

    def test_running_is_true_false_or_unknown(self):
        sid = "4f2a9c1e-1234-4abc-9def-0123456789ab"
        rows = lambda *r: FakeRunner(out=json.dumps(list(r)))
        self.assertIs(spawn.running(sid, rows({"sessionId": sid, "pid": 42})), True)
        # Resumed under a new session id (claude attach): the same background id.
        self.assertIs(spawn.running(sid, rows({"sessionId": "other", "id": "4f2a9c1e", "pid": 42})), True)
        self.assertIs(spawn.running(sid, rows({"sessionId": sid, "pid": None}, {"sessionId": "x", "id": "aaaa1111", "pid": 7})), False)
        self.assertIs(spawn.running(sid, rows()), False)
        # `claude agents` failed or printed something else: not known.
        self.assertIsNone(spawn.running(sid, FakeRunner(code=1, out="")))
        self.assertIsNone(spawn.running(sid, FakeRunner(out="not json")))
        self.assertIsNone(spawn.running(sid, FakeRunner(out='{"a": 1}')))

    def test_resume_is_held_when_it_is_not_known_whether_the_session_runs(self):
        sid = "4f2a9c1e-1234-4abc-9def-0123456789ab"
        p = self.add({"spawn": {"name": "5-y", "cwd": self.tmp.name, "resume": sid}})
        run = FakeRunner(code=1, out="", err="daemon not reachable")
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=run)
        self.assertEqual(p["status"], "held")
        self.assertIn("claude agents", p["note"])
        self.assertEqual([c[0][:2] for c in run.calls], [["claude", "agents"]])  # nothing resumed

    def test_refuses_unapproved_and_session_targets(self):
        p = self.add({"spawn": {"name": "a", "cwd": self.tmp.name, "prompt": "go"}}, approve=False)
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner())
        q = ledger.add(self.led, kind="REVIEW", issue=1, source="x", target={"session": "paywall"},
                       message="m", summary="s", now=NOW)
        ledger.transition(self.led, q["id"], "approved", now=NOW)
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, q["id"], now=NOW, runner=FakeRunner())

    def test_timeout_keeps_approved_with_a_warning_note(self):
        p = self.add({"spawn": {"name": "981-x", "cwd": self.tmp.name, "prompt": "go"}})

        def slow(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])

        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=slow)
        self.assertEqual(p["status"], "held")
        self.assertIn("claude agents", p["note"])


if __name__ == "__main__":
    unittest.main()

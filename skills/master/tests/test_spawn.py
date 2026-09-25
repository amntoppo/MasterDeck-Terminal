from __future__ import annotations

import subprocess
import tempfile
import unittest

from master import ledger, spawn

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

"""The app's contract with the CLI: free text goes on stdin to `say -` / `say --to NAME -`.

Runs the real `master` launcher as a child process (as the app does), against a temporary
MASTER_HOME, with CLAUDECODE cleared — text that looks like an option must land verbatim.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

MASTER = Path(__file__).resolve().parent.parent / "master"


class SayOverStdinContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID")}
        self.env["MASTER_HOME"] = str(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def run_master(self, *argv, stdin):
        return subprocess.run([str(MASTER), *argv], input=stdin, env=self.env,
                              capture_output=True, text=True, timeout=30)

    def inbox(self):
        lines = (self.home / "inbox.jsonl").read_text().splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def test_say_and_say_to_take_option_looking_text_from_stdin(self):
        first = self.run_master("say", "-", stdin="--help me with #939\nsecond line")
        self.assertEqual((first.returncode, first.stdout.strip()), (0, "inbox 1"), first.stderr)
        second = self.run_master("say", "--to", "paywall", "-", stdin="--help --to other")
        self.assertEqual((second.returncode, second.stdout.strip()), (0, "inbox 2"), second.stderr)
        entries = self.inbox()
        self.assertEqual([(e["id"], e["kind"], e["text"], e.get("to")) for e in entries], [
            (1, "say", "--help me with #939\nsecond line", None),
            (2, "send", "--help --to other", "paywall"),
        ])


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "app" / "resources" / "statusline_tee.py"


class StatuslineTeeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_tee(self, stdin: str) -> subprocess.CompletedProcess:
        env = {**os.environ, "MASTERDECK_HOME": str(self.home)}
        return subprocess.run([sys.executable, str(SCRIPT)], input=stdin, capture_output=True, text=True, env=env,
                              timeout=20)

    def test_saves_stats_and_forwards_the_original_output(self):
        (self.home / "statusline-original.json").write_text(json.dumps({"command": "cat"}))
        payload = json.dumps({"session_id": "abc-123", "cost": {"total_cost_usd": 1.5}})
        r = self.run_tee(payload)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, payload)
        self.assertEqual(json.loads((self.home / "stats" / "abc-123.json").read_text())["cost"]["total_cost_usd"], 1.5)

    def test_prints_nothing_without_an_original_command(self):
        r = self.run_tee(json.dumps({"session_id": "abc"}))
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_refuses_unsafe_session_ids_and_bad_json(self):
        self.run_tee(json.dumps({"session_id": "../../etc/passwd"}))
        self.run_tee("{not json")
        self.assertFalse((self.home / "stats").exists() and any((self.home / "stats").glob("*.json")))


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import proof  # noqa: E402


class StepsTest(unittest.TestCase):
    def test_steps_from_maestro_debug_output(self):
        with tempfile.TemporaryDirectory() as d:
            t = 1_790_000_000_000
            cmds = [
                {"command": {"defineVariablesCommand": {"env": {}}}, "metadata": {"status": "COMPLETED", "timestamp": t, "duration": 1, "sequenceNumber": 0}},
                {"command": {"tapOnElementCommand": {"selector": {"textRegex": "Log in"}}}, "metadata": {"status": "COMPLETED", "timestamp": t + 2000, "duration": 1000, "sequenceNumber": 2}},
                {"command": {"launchAppCommand": {"appId": "com.example.app"}}, "metadata": {"status": "COMPLETED", "timestamp": t + 500, "duration": 500, "sequenceNumber": 1}},
                {"command": {"assertConditionCommand": {}}, "metadata": {"status": "FAILED", "timestamp": t + 4000, "duration": 500, "sequenceNumber": 3}},
                {"command": {"tapOnElementCommand": {}}, "metadata": {"status": "SKIPPED"}},  # never ran: no timestamp
            ]
            Path(d, "commands-(login.yaml).json").write_text(json.dumps(cmds))
            steps = proof.steps_from_debug(Path(d))
        self.assertEqual([s["label"] for s in steps], ["launch app com.example.app", "tap on element Log in", "assert condition"])
        self.assertEqual([s["end_ms"] for s in steps], [t + 1000, t + 3000, t + 4500])
        self.assertEqual(steps[-1]["status"], "FAILED")
        self.assertEqual({s["flow"] for s in steps}, {"login.yaml"})

    def test_slug(self):
        self.assertEqual(proof.slug('click getByRole button "Add"'), "click-getByRole-button-Add")
        self.assertEqual(proof.slug("///"), "step")


class ResultsTest(unittest.TestCase):
    def test_results_markdown(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d)
            proof.record_result(run, "playwright", 0, {"stats": {"expected": 3, "unexpected": 0, "flaky": 1, "skipped": 0}})
            proof.record_result(run, "maestro", 1, {"steps": 12, "failed_steps": 1, "platform": "ios"})
            md = proof.results_md(run)
        self.assertIn("✅ Playwright: 3 passed, 0 failed, 1 flaky, 0 skipped", md)
        self.assertIn("❌ Maestro (ios): 12 steps, 1 failed", md)


if __name__ == "__main__":
    unittest.main()

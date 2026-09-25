from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import date
from pathlib import Path

from master import collect, snapshot
from tests.helpers import ME, agent, board_item, pr_node

NOW = "2026-09-24T10:00:00Z"
TODAY = date(2026, 9, 24)
BRANCH = "acme/mobile-app@feat/x"


class FakeSource:
    def __init__(self, fail=()):
        self.fail = set(fail)

    def _maybe(self, name, value):
        if name in self.fail:
            raise RuntimeError(f"{name} exploded")
        return value

    def me(self): return self._maybe("me", ME)
    def board_mine(self): return self._maybe("board_mine", [board_item(939, "In Dev", "2026-09-21")])
    def board_ready(self): return self._maybe("board_ready", [])
    def prs_mine(self): return self._maybe("prs_mine", [pr_node(55, body="Refs acme/tracker#939")])
    def prs_review(self): return self._maybe("prs_review", [])
    def agents(self): return self._maybe("agents", [agent("s1", "paywall"), agent("m", "master-agent")])
    def state(self): return self._maybe("state", {"sessions": {
        "s1": {"issue": 939, "branch": BRANCH, "linked_at": "x", "prs": []}}})
    def branch_head(self, key): return self._maybe("branch_head", {BRANCH: "abc123"}[key])
    def session_cwd(self, sid): return self._maybe("session_cwd", None)


class BuildTest(unittest.TestCase):
    def test_happy_path(self):
        snap = snapshot.build(FakeSource(), now_iso=NOW, today=TODAY)
        self.assertEqual(snap["taken_at"], NOW)
        self.assertEqual([i["number"] for i in snap["issues"]], [939])
        self.assertEqual([p["number"] for p in snap["prs"]], [55])
        self.assertEqual([s["name"] for s in snap["sessions"]], ["paywall"])
        self.assertEqual(snap["sessions"][0]["branch_head"], "abc123")
        self.assertEqual(snap["errors"], [])
        self.assertEqual(snap["sources"], {"gh": True, "board": True, "prs": True, "agents": True, "state": True})

    def test_prs_failure_is_partial_not_fatal(self):
        snap = snapshot.build(FakeSource(fail={"prs_mine"}), now_iso=NOW, today=TODAY)
        self.assertEqual(snap["prs"], [])
        self.assertFalse(snap["sources"]["prs"])
        self.assertTrue(snap["sources"]["board"])
        self.assertEqual(snap["errors"], [{"source": "prs", "message": "prs_mine exploded"}])

    def test_gh_failure_marks_prs_unusable(self):
        snap = snapshot.build(FakeSource(fail={"me"}), now_iso=NOW, today=TODAY)
        self.assertFalse(snap["sources"]["gh"])
        self.assertFalse(snap["sources"]["prs"])

    def test_branch_head_failure_leaves_none(self):
        snap = snapshot.build(FakeSource(fail={"branch_head"}), now_iso=NOW, today=TODAY)
        self.assertIsNone(snap["sessions"][0]["branch_head"])
        self.assertEqual(snap["errors"][0]["source"], "branches")

    def test_session_cwd_failure_is_swallowed_as_none(self):
        class DeadSource(FakeSource):
            def agents(self): return []
        snap = snapshot.build(DeadSource(fail={"session_cwd"}), now_iso=NOW, today=TODAY)
        self.assertEqual((snap["sessions"][0]["status"], snap["sessions"][0]["cwd"]), ("dead", None))


class FixturesTest(unittest.TestCase):
    def test_reads_every_file_and_missing_file_raises(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / "me.txt").write_text(ME + "\n")
            (p / "board_mine.json").write_text(json.dumps([board_item(1, "To Do")]))
            (p / "branch_heads.json").write_text(json.dumps({BRANCH: "sha1"}))
            (p / "cwds.json").write_text(json.dumps({"s1": "/repo"}))
            src = collect.Fixtures(p)
            self.assertEqual(src.me(), ME)
            self.assertEqual(src.board_mine()[0]["content"]["number"], 1)
            self.assertEqual(src.branch_head(BRANCH), "sha1")
            self.assertEqual(src.session_cwd("s1"), "/repo")
            self.assertIsNone(src.session_cwd("nope"))
            with self.assertRaises(FileNotFoundError):
                src.prs_mine()


class LocalBranchHeadTest(unittest.TestCase):
    def test_reads_local_clone_and_misses_cleanly(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d) / "mobile-app"
            repo.mkdir()

            def git(*args):
                return subprocess.run(["git", "-C", str(repo), *args], check=True,
                                      capture_output=True, text=True).stdout.strip()

            git("init", "-q", "-b", "main")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x")
            git("branch", "feat/x")
            sha = git("rev-parse", "main")
            self.assertEqual(collect.local_branch_head(Path(d), "acme/mobile-app@feat/x"), sha)
            self.assertIsNone(collect.local_branch_head(Path(d), "acme/mobile-app@nope"))
            self.assertIsNone(collect.local_branch_head(Path(d), "acme/not-cloned@feat/x"))


if __name__ == "__main__":
    unittest.main()

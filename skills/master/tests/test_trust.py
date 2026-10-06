"""Whether Claude Code has been allowed to work in a folder (`master.trust`): read from Claude
Code's own `.claude.json`, here always one in the test sandbox's HOME or a temp folder."""
from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from master import cli, ledger, spawn, trust
from tests import conftest
from tests.test_spawn import FakeRunner

NOW = "2026-10-06T10:00:00Z"
# What `claude --bg` prints in a folder whose trust prompt was never accepted (the folder varies).
REFUSAL = "Workspace not trusted. Run `claude` in {} once and accept the trust prompt, then retry."


class TrustFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.tmp.name))
        self.file = self.root / ".claude.json"
        self.repo = self.root / "code" / "api"
        self.repo.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, projects, **rest):
        self.file.write_text(json.dumps({**rest, "projects": projects}), encoding="utf-8")

    def test_the_file_is_claude_codes_own_in_the_home_folder(self):
        self.assertEqual(trust.claude_json(), Path(os.path.expanduser("~")) / ".claude.json")
        self.assertTrue(str(trust.claude_json()).startswith(conftest.SANDBOX))
        os.environ["CLAUDE_CONFIG_DIR"] = str(self.root)
        try:
            self.assertEqual(trust.claude_json(), self.root / ".claude.json")
        finally:
            del os.environ["CLAUDE_CONFIG_DIR"]

    def test_a_folder_whose_prompt_was_accepted_is_trusted(self):
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), True)

    def test_a_folder_not_listed_or_not_accepted_is_not_trusted(self):
        self.write({str(self.root / "code"): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), False, "a trusted parent does not carry over")
        self.write({str(self.repo): {"hasTrustDialogAccepted": False}})
        self.assertIs(trust.trusted(str(self.repo), self.file), False)
        self.write({str(self.repo): {"allowedTools": []}})
        self.assertIs(trust.trusted(str(self.repo), self.file), False)
        self.write({str(self.repo): {"hasTrustDialogAccepted": "yes"}})
        self.assertIs(trust.trusted(str(self.repo), self.file), False, "only true counts")

    def test_unknown_when_the_file_is_missing_broken_or_not_what_is_expected(self):
        self.assertIsNone(trust.trusted(str(self.repo), self.file))
        for text in ("", "{not json", "[]", '"x"', "{}", '{"projects": []}', '{"projects": null}', "[" * 100000):
            self.file.write_text(text, encoding="utf-8")
            self.assertIsNone(trust.trusted(str(self.repo), self.file), text[:20])
        self.file.write_bytes(b"\xff\xfe\x00{")
        self.assertIsNone(trust.trusted(str(self.repo), self.file))
        self.file.unlink()
        self.file.mkdir()
        self.assertIsNone(trust.trusted(str(self.repo), self.file), "a folder of that name")

    def test_a_huge_file_is_not_read(self):
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIsNone(trust.trusted(str(self.repo), self.file, max_bytes=10))

    def test_the_file_is_never_written(self):
        self.write({str(self.repo): {"hasTrustDialogAccepted": False}}, numStartups=3)
        before = self.file.read_bytes(), os.stat(self.file).st_mtime_ns
        trust.trusted(str(self.repo), self.file)
        trust.wait(str(self.repo), 0, self.file)
        self.assertEqual((self.file.read_bytes(), os.stat(self.file).st_mtime_ns), before)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), [".claude.json", "code"])

    def test_the_folder_is_compared_as_claude_code_stores_it(self):
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo) + os.sep, self.file), True, "a trailing separator")
        self.assertIs(trust.trusted(os.path.join(str(self.repo), "..", "api"), self.file), True)
        self.assertIs(trust.trusted(str(self.repo) + "-two", self.file), False, "never by prefix")
        # Claude Code stores Windows paths with forward slashes.
        self.write({str(self.repo).replace("\\", "/"): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), True)

    def test_a_link_to_the_folder_is_the_folder_it_leads_to(self):
        link = self.root / "link"
        try:
            os.symlink(self.repo, link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("no symlinks here")
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(link), self.file), True)

    def test_wait_returns_as_soon_as_the_folder_is_trusted(self):
        self.write({})
        naps = []

        def nap(s):
            naps.append(s)
            if len(naps) == 2:
                self.write({str(self.repo): {"hasTrustDialogAccepted": True}})

        self.assertIs(trust.wait(str(self.repo), 30, self.file, sleep=nap, clock=lambda: len(naps) * 2.0), True)
        self.assertEqual(len(naps), 2)

    def test_wait_gives_up_after_its_time_and_reads_only_a_changed_file(self):
        self.write({})
        naps, reads = [], []
        real = trust._projects
        trust._projects = lambda *a, **k: (reads.append(1), real(*a, **k))[1]
        try:
            self.assertIs(trust.wait(str(self.repo), 6, self.file, sleep=naps.append, clock=lambda: len(naps) * 2.0), False)
        finally:
            trust._projects = real
        self.assertEqual((len(naps), len(reads)), (3, 1))

    def test_wait_on_a_trusted_folder_does_not_sleep(self):
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.wait(str(self.repo), 30, self.file, sleep=lambda s: self.fail("slept")), True)

    def test_wait_sees_the_file_appear(self):
        naps = []

        def nap(s):
            naps.append(s)
            self.write({str(self.repo): {"hasTrustDialogAccepted": True}})

        self.assertIs(trust.wait(str(self.repo), 30, self.file, sleep=nap, clock=lambda: len(naps) * 2.0), True)


class RefusalTextTest(unittest.TestCase):
    def test_claude_codes_refusal_is_recognised(self):
        self.assertTrue(trust.not_trusted(REFUSAL.format("a-folder")))
        self.assertTrue(trust.not_trusted("proposal 85: " + REFUSAL.format("a-folder")))
        self.assertTrue(trust.not_trusted("Error: workspace is not trusted"))
        self.assertTrue(trust.not_trusted("This workspace isn't trusted yet."))
        for other in ("", None, "cwd does not exist: a-folder", "claude: command not found", "not logged in", "trusted workspace"):
            self.assertFalse(trust.not_trusted(other), other)


class CliTest(unittest.TestCase):
    """The CLI reads the sandbox HOME's `.claude.json` (conftest), never the machine's."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(os.path.realpath(self.tmp.name), "api")
        os.makedirs(self.repo)
        self.file = trust.claude_json()
        self.assertTrue(str(self.file).startswith(conftest.SANDBOX))
        self._env = {k: os.environ.get(k) for k in ("MASTER_HOME", "MASTER_WORKSPACE")}
        os.environ["MASTER_HOME"] = os.path.join(self.tmp.name, "master")

    def tearDown(self):
        if self.file.exists():
            self.file.unlink()
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

    def allow(self, folder, yes=True):
        self.file.write_text(json.dumps({"projects": {folder: {"hasTrustDialogAccepted": yes}}}), encoding="utf-8")

    def test_trust_prints_what_is_known_of_a_folder(self):
        self.assertEqual(self.run_cli("trust", self.repo), (0, json.dumps({"cwd": self.repo, "trusted": None}) + "\n"))
        self.allow(self.repo, False)
        self.assertEqual(json.loads(self.run_cli("trust", self.repo)[1])["trusted"], False)
        self.allow(self.repo)
        self.assertEqual(json.loads(self.run_cli("trust", self.repo, "--wait", "20")[1])["trusted"], True)

    def test_a_draft_says_whether_its_folder_is_trusted(self):
        draft = lambda: json.loads(self.run_cli("draft-assign", "42", "--title", "Fix upload retry", "--url",
                                                "https://github.com/acme/tracker/issues/42", "--cwd", self.repo)[1])
        self.assertEqual((draft()["cwd"], draft()["trusted"]), (self.repo, None))
        self.allow(self.repo, False)
        self.assertIs(draft()["trusted"], False)
        self.allow(self.repo)
        self.assertIs(draft()["trusted"], True)

    def test_checkout_says_whether_its_folder_is_trusted(self):
        os.environ["MASTER_WORKSPACE"] = self.repo
        got = json.loads(self.run_cli("checkout", "acme/api")[1])
        self.assertEqual((got["cwd"], got["trusted"]), (self.repo, None))
        self.allow(self.repo)
        self.assertIs(json.loads(self.run_cli("checkout", "acme/api")[1])["trusted"], True)


class HeldForTrustTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.realpath(self.tmp.name)
        self.led = ledger.empty()

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, sp):
        p = ledger.add(self.led, kind="ASSIGN", issue=85, source="issue:85", target={"spawn": sp},
                       message="m", summary="s", now=NOW)
        ledger.transition(self.led, p["id"], "approved", now=NOW)
        return p

    def test_a_refused_start_is_held_and_started_again_once_as_the_same_proposal(self):
        p = self.add({"name": "85-x", "cwd": self.dir, "prompt": "go"})
        refuse = FakeRunner(code=1, err=REFUSAL.format(self.dir))
        with self.assertRaises(spawn.SpawnError) as e:
            spawn.spawn(self.led, p["id"], now=NOW, runner=refuse)
        self.assertEqual(str(e.exception), f"proposal {p['id']}: {REFUSAL.format(self.dir)}")
        self.assertEqual((p["status"], p["note"]), ("held", REFUSAL.format(self.dir)))
        ok = FakeRunner()
        spawn.spawn(self.led, p["id"], now=NOW, runner=ok)
        self.assertEqual(p["status"], "sent")
        self.assertEqual([(c[0], c[1]["cwd"]) for c in ok.calls], [(["claude", "--bg", "-n", "85-x", "go"], self.dir)])
        self.assertEqual(len(self.led["proposals"]), 1, "the same proposal, not another")
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=ok)
        self.assertEqual(len(ok.calls), 1, "a sent proposal is not started a second time")

    def test_a_refused_start_records_the_folder_it_was_tried_in(self):
        ws = os.environ["MASTER_WORKSPACE"]
        p = self.add({"name": "85-x", "prompt": "go"})  # no folder: the resolver picks it at start
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner(code=1, err=REFUSAL.format(ws)))
        self.assertEqual(p["target"]["spawn"]["cwd"], ws, "the app shows this folder, and the retry starts there")

    def test_another_failure_leaves_the_proposal_without_a_folder(self):
        p = self.add({"name": "85-x", "prompt": "go"})
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=FakeRunner(code=1, err="not logged in"))
        self.assertNotIn("cwd", p["target"]["spawn"])


if __name__ == "__main__":
    unittest.main()

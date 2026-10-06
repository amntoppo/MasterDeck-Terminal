"""Whether Claude Code has been allowed to work in a folder (`master.trust`): read from Claude
Code's own `.claude.json`, here always one in the test sandbox's HOME or a temp folder."""
from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock
from contextlib import redirect_stdout
from pathlib import Path

from master import cli, ledger, spawn, trust
from tests import conftest

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

    def git(self, folder, as_file=False):
        g = Path(folder) / ".git"
        if as_file:
            g.write_text("gitdir: elsewhere\n", encoding="utf-8")
        else:
            g.mkdir()

    # Claude Code looks at the folder and its parents: inside a git repository up to and including
    # the repository's root, outside one all the way up.
    def test_a_sub_folder_of_a_trusted_repository_is_trusted(self):
        self.git(self.repo)
        sub = self.repo / "src" / "deep"
        sub.mkdir(parents=True)
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(sub), self.file), True)

    def test_a_plain_folder_under_a_trusted_parent_is_trusted(self):
        self.write({str(self.root / "code"): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), True)
        self.write({str(self.root): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), True)

    def test_a_repository_under_a_trusted_plain_parent_is_not_trusted(self):
        self.git(self.repo)
        sub = self.repo / "src"
        sub.mkdir()
        self.write({str(self.root / "code"): {"hasTrustDialogAccepted": True}, str(self.root): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), False, "the walk stops at the repository's root")
        self.assertIs(trust.trusted(str(sub), self.file), False)
        self.write({str(self.root / "code"): {"hasTrustDialogAccepted": True}, str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(sub), self.file), True)

    def test_a_linked_worktree_that_is_not_listed_is_not_known(self):
        # Its `.git` is a file: Claude Code may count the main repository's answer. Never a no on a guess.
        self.git(self.repo, as_file=True)
        self.write({str(self.root / "code"): {"hasTrustDialogAccepted": True}})
        self.assertIsNone(trust.trusted(str(self.repo), self.file))
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), True)

    def test_a_folder_that_is_not_there_is_not_known(self):
        self.write({str(self.root): {"hasTrustDialogAccepted": True}})
        self.assertIsNone(trust.trusted(str(self.root / "gone"), self.file))
        self.assertIsNone(trust.trusted("", self.file))

    def test_a_folder_not_listed_or_not_accepted_is_not_trusted(self):
        self.write({str(self.root / "elsewhere"): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(self.repo), self.file), False)
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
        self.assertEqual(trust.MAX_BYTES, 8 * 1024 * 1024)
        self.write({str(self.repo): {"hasTrustDialogAccepted": True}}, pad="x" * (trust.MAX_BYTES + 1))
        self.assertIsNone(trust.trusted(str(self.repo), self.file))

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
        os.mkdir(str(self.repo) + "-two")
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
        # Claude Code keys real paths only: an entry spelled with the link is not this folder's.
        self.write({str(link): {"hasTrustDialogAccepted": True}})
        self.assertIs(trust.trusted(str(link), self.file), False)
        self.assertIs(trust.trusted(str(self.repo), self.file), False)

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


class Runner:
    """A fake `claude`: `agents --json` prints `rows`; anything else answers like FakeRunner."""

    def __init__(self, code=0, out="backgrounded · 4f2a9c1e\n", err="", rows=(), agents_code=0):
        self.code, self.out, self.err, self.rows, self.agents_code = code, out, err, list(rows), agents_code
        self.calls = []

    def __call__(self, cmd, **kw):
        if cmd[:2] == ["claude", "agents"]:
            return subprocess.CompletedProcess(cmd, self.agents_code, json.dumps(self.rows), "")
        self.calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, self.code, self.out, self.err)


class HeldForTrustTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.realpath(self.tmp.name)
        self.led = ledger.empty()

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, sp=None, source="issue:85"):
        p = ledger.add(self.led, kind="ASSIGN", issue=85, source=source,
                       target={"spawn": sp or {"name": "85-x", "cwd": self.dir, "prompt": "go"}},
                       message="m", summary="s", now=NOW)
        ledger.transition(self.led, p["id"], "approved", now=NOW)
        return p

    def refuse(self, p):
        with self.assertRaises(spawn.SpawnError) as e:
            spawn.spawn(self.led, p["id"], now=NOW, runner=Runner(code=1, err=REFUSAL.format(self.dir)))
        return str(e.exception)

    def retry(self, p, run):
        return spawn.spawn(self.led, p["id"], now=NOW, runner=run, held_for_trust=True)

    def test_a_refused_start_is_held_for_trust_and_started_again_once_as_the_same_proposal(self):
        p = self.add()
        self.assertEqual(self.refuse(p), f"proposal {p['id']}: {REFUSAL.format(self.dir)}")
        self.assertEqual((p["status"], p["note"], p["held_for"]), ("held", REFUSAL.format(self.dir), "trust"))
        ok = Runner()
        self.retry(p, ok)
        self.assertEqual(p["status"], "sent")
        self.assertNotIn("held_for", p)
        self.assertEqual([(c[0], c[1]["cwd"]) for c in ok.calls], [(["claude", "--bg", "-n", "85-x", "go"], self.dir)])
        self.assertEqual(len(self.led["proposals"]), 1, "the same proposal, not another")
        with self.assertRaises(spawn.SpawnError):
            self.retry(p, ok)
        self.assertEqual(len(ok.calls), 1, "a sent proposal is not started a second time")

    def test_a_retry_that_is_refused_again_stays_held_for_trust(self):
        p = self.add()
        self.refuse(p)
        with self.assertRaises(spawn.SpawnError):
            self.retry(p, Runner(code=1, err=REFUSAL.format(self.dir)))
        self.assertEqual((p["status"], p["held_for"]), ("held", "trust"))

    def test_only_a_start_that_spawn_itself_held_for_trust_is_retried(self):
        run = Runner()
        # Held for another reason.
        a = self.add(source="a")
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, a["id"], now=NOW, runner=Runner(code=1, err="not logged in"))
        self.assertNotIn("held_for", a)
        # Held by hand, with a note that only reads like the refusal (master-agent can write any note).
        b = self.add(source="b")
        ledger.transition(self.led, b["id"], "sent", now=NOW)
        ledger.transition(self.led, b["id"], "held", now=NOW, note=REFUSAL.format(self.dir))
        # Approved, proposed.
        c = self.add(source="c")
        for p in (a, b, c):
            before = dict(p)
            with self.assertRaises(spawn.SpawnError) as e:
                self.retry(p, run)
            self.assertIn("not a start held because Claude Code refused its folder", str(e.exception))
            self.assertEqual(p, before, "nothing changes")
        self.assertEqual(run.calls, [])

    def test_a_retry_that_timed_out_cannot_be_retried_again(self):
        p = self.add()
        self.refuse(p)

        def slow(cmd, **kw):
            if cmd[:2] == ["claude", "agents"]:
                return subprocess.CompletedProcess(cmd, 0, "[]", "")
            raise subprocess.TimeoutExpired(cmd, 60)

        with self.assertRaises(spawn.SpawnError):
            self.retry(p, slow)
        self.assertEqual(p["status"], "held")
        self.assertIn("may still have started a session", p["note"])
        self.assertNotIn("held_for", p)
        run = Runner()
        with self.assertRaises(spawn.SpawnError):
            self.retry(p, run)
        self.assertEqual(run.calls, [], "it may be running already")

    def test_a_retry_while_a_session_of_that_name_runs_closes_the_held_start_instead(self):
        p = self.add()
        self.refuse(p)
        run = Runner(rows=[{"id": "4f2a9c1e", "pid": 4242, "name": "85-x", "sessionId": "s"}])
        with self.assertRaises(spawn.SpawnError) as e:
            self.retry(p, run)
        self.assertEqual(run.calls, [], "no second session of the same name")
        self.assertEqual(p["status"], "rejected")
        self.assertEqual(p["note"], "a session named 85-x is already running; this held start was closed")
        self.assertIn(p["note"], str(e.exception))
        self.assertNotIn("held_for", p)

    def test_a_stopped_session_of_that_name_does_not_count(self):
        p = self.add()
        self.refuse(p)
        run = Runner(rows=[{"id": "4f2a9c1e", "name": "85-x", "sessionId": "s"}, {"id": "aaaa0000", "pid": 7, "name": "other"}])
        self.retry(p, run)
        self.assertEqual((p["status"], len(run.calls)), ("sent", 1))

    def test_a_retry_does_not_start_when_it_is_not_known_what_runs(self):
        p = self.add()
        self.refuse(p)
        run = Runner(agents_code=1)
        with self.assertRaises(spawn.SpawnError) as e:
            self.retry(p, run)
        self.assertIn("not known", str(e.exception))
        self.assertEqual((run.calls, p["status"], p["held_for"]), ([], "held", "trust"), "it can be tried again")

    def test_a_plain_spawn_of_a_held_proposal_is_as_before(self):
        p = self.add()
        self.refuse(p)
        run = Runner(rows=[{"id": "4f2a9c1e", "pid": 4242, "name": "85-x"}])
        spawn.spawn(self.led, p["id"], now=NOW, runner=run)  # master, told to retry: no new check
        self.assertEqual((p["status"], len(run.calls)), ("sent", 1))
        self.assertNotIn("held_for", p)

    def test_leaving_held_any_other_way_drops_the_mark(self):
        p = self.add()
        self.refuse(p)
        ledger.transition(self.led, p["id"], "rejected", now=NOW)
        self.assertNotIn("held_for", p)

    def test_a_refused_start_records_the_folder_it_was_tried_in(self):
        ws = os.environ["MASTER_WORKSPACE"]
        p = self.add({"name": "85-x", "prompt": "go"})  # no folder: the resolver picks it at start
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=Runner(code=1, err=REFUSAL.format(ws)))
        self.assertEqual(p["target"]["spawn"]["cwd"], ws, "the app shows this folder, and the retry starts there")

    def test_another_failure_leaves_the_proposal_without_a_folder(self):
        p = self.add({"name": "85-x", "prompt": "go"})
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(self.led, p["id"], now=NOW, runner=Runner(code=1, err="not logged in"))
        self.assertNotIn("cwd", p["target"]["spawn"])

    def test_reject_can_say_why(self):
        saved = {k: os.environ.pop(k, None) for k in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID")}
        home = os.environ.get("MASTER_HOME")
        os.environ["MASTER_HOME"] = os.path.join(self.dir, "master")
        try:
            with ledger.locked() as led:
                for src in ("x", "y"):
                    ledger.add(led, kind="ASSIGN", issue=85, source=src, target={"spawn": {"name": "85-x", "cwd": self.dir, "prompt": "go"}},
                               message="m", summary="s", now=NOW)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["reject", "1", "--note", "closed: it runs already"], agents_loader=lambda: []), 0)
                self.assertEqual(cli.main(["reject", "2"], agents_loader=lambda: []), 0)
            self.assertEqual([(p["status"], p["note"]) for p in ledger.load()["proposals"]],
                             [("rejected", "closed: it runs already"), ("rejected", None)])
        finally:
            os.environ.update({k: v for k, v in saved.items() if v is not None})
            if home is None:
                os.environ.pop("MASTER_HOME", None)
            else:
                os.environ["MASTER_HOME"] = home

    def test_the_cli_retries_only_with_the_flag(self):
        # As from the app: a plain process, not a Claude session (the CLI's write guard).
        saved = {k: os.environ.pop(k, None) for k in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID")}
        home = os.environ.get("MASTER_HOME")
        os.environ["MASTER_HOME"] = os.path.join(self.dir, "master")
        try:
            with ledger.locked() as led:
                p = ledger.add(led, kind="ASSIGN", issue=85, source="x", target={"spawn": {"name": "85-x", "cwd": self.dir, "prompt": "go"}},
                               message="m", summary="s", now=NOW)
                ledger.transition(led, p["id"], "approved", now=NOW)
                ledger.transition(led, p["id"], "sent", now=NOW)
                ledger.transition(led, p["id"], "held", now=NOW, note="parked by hand")
            buf = io.StringIO()
            # Refused before anything runs: no runner is ever reached.
            with redirect_stdout(buf), mock.patch.object(spawn.subprocess, "run", side_effect=AssertionError("ran a process")):
                code = cli.main(["spawn", "1", "--held-for-trust"], agents_loader=lambda: [])
            self.assertEqual(code, 1)
            self.assertIn("not a start held because Claude Code refused its folder", buf.getvalue())
            self.assertEqual(ledger.load()["proposals"][0]["status"], "held")
        finally:
            os.environ.update({k: v for k, v in saved.items() if v is not None})
            if home is None:
                os.environ.pop("MASTER_HOME", None)
            else:
                os.environ["MASTER_HOME"] = home


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import os
import tempfile
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from master import ghcache

FAKE_GH = """#!/usr/bin/env python3
import os, sys, time, json
log = os.environ["FAKE_LOG"]
with open(log, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
mode = open(os.environ["FAKE_MODE"]).read().strip() if os.path.exists(os.environ["FAKE_MODE"]) else "ok"
if mode == "slow":
    time.sleep(0.5)
if mode == "ratelimit":
    sys.stderr.write("GraphQL: API rate limit exceeded for user ID 1.\\n")
    sys.exit(1)
if mode == "fail":
    sys.stderr.write("HTTP 404: Not Found\\n")
    sys.exit(1)
sys.stdout.write("out:" + " ".join(sys.argv[1:]) + "\\n")
"""


@unittest.skipIf(sys.platform == "win32", "the cache needs fcntl (POSIX)")
class GhCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.fake = d / "gh"
        self.fake.write_text(FAKE_GH)
        self.fake.chmod(0o755)
        self.log = d / "calls.log"
        self.mode = d / "mode"
        self._env = {k: os.environ.get(k) for k in ("GH_CACHE_DIR", "GHC_GH", "FAKE_LOG", "FAKE_MODE")}
        os.environ.update({"GH_CACHE_DIR": str(d / "cache"), "GHC_GH": str(self.fake), "FAKE_LOG": str(self.log), "FAKE_MODE": str(self.mode)})

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def calls(self) -> int:
        return len(self.log.read_text().splitlines()) if self.log.exists() else 0

    def set_mode(self, m: str):
        self.mode.write_text(m)

    def test_account_is_part_of_the_key_and_has_its_own_pause(self):
        k0 = ghcache.cache_key(["api", "user"], "/w")
        with mock.patch.dict(os.environ, {"GHC_ACCOUNT": "bob-work"}):
            k1 = ghcache.cache_key(["api", "user"], "/w")
        self.assertNotEqual(k0, k1)
        self.assertEqual(ghcache.cache_key(["api", "user"], "/w", account=""), k0)  # no account: today's key
        ghcache.pause(1000.0, reason="x", account="bob-work")
        self.assertTrue((Path(os.environ["GH_CACHE_DIR"]) / "paused-bob-work.json").exists())
        self.assertEqual(ghcache.paused_until(1001.0), 0.0)
        self.assertGreater(ghcache.paused_until(1001.0, account="bob-work"), 0)
        ghcache.invalidate({"all"})
        self.assertTrue((Path(os.environ["GH_CACHE_DIR"]) / "paused-bob-work.json").exists())

    def test_env_reaches_gh_and_gets_its_own_entry(self):
        d = Path(self.tmp.name)
        echo = d / "gh-echo"
        echo.write_text("#!/usr/bin/env python3\nimport os, sys\nopen(os.environ['FAKE_LOG'], 'a').write('x\\n')\n"
                        "sys.stdout.write('token=' + os.environ.get('GH_TOKEN', '') + '\\n')\n")
        echo.chmod(0o755)
        os.environ["GHC_GH"] = str(echo)
        with mock.patch.dict(os.environ):
            # The developer's own GH_TOKEN must neither leak into the output nor change the keys.
            os.environ.pop("GH_TOKEN", None)
            os.environ.pop("GHC_ACCOUNT", None)
            code, out, _ = ghcache.run(["api", "user"], env={"GH_TOKEN": "t-bob", "GHC_ACCOUNT": "bob-work"})
            self.assertEqual((code, out), (0, b"token=t-bob\n"))
            _, out2, _ = ghcache.run(["api", "user"])
            self.assertEqual(out2, b"token=\n")  # another key: not bob's cached answer
            _, out3, _ = ghcache.run(["api", "user"], env={"GH_TOKEN": "t-bob", "GHC_ACCOUNT": "bob-work"})
            self.assertEqual(out3, b"token=t-bob\n")
        self.assertEqual(self.calls(), 2)

    def test_account_must_be_a_login(self):
        # No path traversal through a file name; an invalid value is no account (today's key and pause).
        k0 = ghcache.cache_key(["api", "user"], "/w")
        with mock.patch.dict(os.environ, {"GHC_ACCOUNT": "../../x"}):
            self.assertEqual(ghcache.cache_key(["api", "user"], "/w"), k0)
            self.assertEqual(ghcache._account(), "")
        self.assertEqual(ghcache._account({"GHC_ACCOUNT": "a/b"}), "")
        self.assertEqual(ghcache._account({"GHC_ACCOUNT": "bob-work"}), "bob-work")
        with self.assertRaises(ValueError):
            ghcache.pause(1.0, account="../x")

    def test_a_token_without_an_account_keys_on_its_hash(self):
        # A hand-run tool with GH_TOKEN but no GHC_ACCOUNT: never another identity's cached answers.
        with mock.patch.dict(os.environ):
            os.environ.pop("GH_TOKEN", None)
            os.environ.pop("GHC_ACCOUNT", None)
            k0 = ghcache.cache_key(["api", "user"], "/w")
            self.assertEqual(ghcache._account(), "")  # one account, no GH_TOKEN: today's keys and pause
            self.assertEqual(ghcache.cache_key(["api", "user"], "/w", account=""), k0)
            os.environ["GH_TOKEN"] = "gho_SECRET_one"
            a1 = ghcache._account()
            k1 = ghcache.cache_key(["api", "user"], "/w")
            os.environ["GH_TOKEN"] = "gho_SECRET_two"
            k2 = ghcache.cache_key(["api", "user"], "/w")
            self.assertEqual(len({k0, k1, k2}), 3)
            self.assertNotIn("SECRET", a1)
            self.assertRegex(a1, r"^-t[0-9a-f]{16}$")  # not a GitHub login (none starts with "-")
            # GHC_ACCOUNT wins over the token; an env passed in is used before os.environ.
            os.environ["GHC_ACCOUNT"] = "bob-work"
            self.assertEqual(ghcache._account(), "bob-work")
            self.assertEqual(ghcache._account({"GH_TOKEN": "gho_SECRET_one"}), a1)
            # Its pause has its own hashed file, and the token is never written anywhere.
            ghcache.pause(1000.0, reason="x", account=a1)
            files = {f.name: f.read_text() for f in Path(os.environ["GH_CACHE_DIR"]).iterdir()}
            self.assertIn(f"paused-{a1}.json", files)
            self.assertFalse(any("SECRET" in n or "SECRET" in t for n, t in files.items()))

    # classification ---------------------------------------------------------------------------

    def test_reads_and_writes(self):
        R, W = ghcache.is_read, lambda a: not ghcache.is_read(a)
        self.assertTrue(R(["pr", "view", "1", "--json", "state"]))
        self.assertTrue(R(["api", "graphql", "-f", "query={ viewer { login } }"]))
        self.assertTrue(W(["api", "graphql", "-f", "query=mutation { x }"]))
        self.assertTrue(R(["api", "repos/o/r/issues/1/comments", "--jq", ".[]"]))
        self.assertTrue(W(["api", "repos/o/r/issues/1/comments", "-f", "body=hi"]))  # fields → POST
        self.assertTrue(W(["api", "-X", "DELETE", "repos/o/r/issues/1/assignees"]))
        self.assertTrue(R(["project", "item-list", "1", "--owner", "o"]))
        self.assertTrue(W(["project", "item-edit", "--id", "x"]))
        self.assertTrue(W(["pr", "create", "--fill"]))
        self.assertTrue(W(["pr", "merge", "1"]))
        self.assertTrue(R(["search", "prs", "is:open"]))

    def test_categories(self):
        self.assertEqual(ghcache.categories(["project", "item-edit"]), {"project"})
        self.assertEqual(ghcache.categories(["pr", "view", "1"]), {"pr"})
        self.assertIn("issue", ghcache.categories(["api", "graphql", "-f", "query=query{repository{issue(number:1){id}}}"]))
        self.assertEqual(ghcache.categories(["auth", "status"]), {"all"})
        # Assigning an issue changes the board too.
        self.assertIn("project", ghcache.categories(["api", "-X", "POST", "repos/o/r/issues/5/assignees"]))

    def test_cwd_matters_only_for_repo_inferring_commands(self):
        a = ghcache.cache_key(["pr", "view", "--json", "url"], "/r1")
        b = ghcache.cache_key(["pr", "view", "--json", "url"], "/r2")
        self.assertNotEqual(a, b)
        self.assertEqual(ghcache.cache_key(["pr", "view", "1", "-R", "o/r"], "/r1"), ghcache.cache_key(["pr", "view", "1", "-R", "o/r"], "/r2"))
        self.assertEqual(ghcache.cache_key(["api", "user"], "/r1"), ghcache.cache_key(["api", "user"], "/r2"))

    # behaviour --------------------------------------------------------------------------------

    def test_force_skips_an_answer_cached_before_the_call_and_caches_the_new_one(self):
        args = ["project", "item-list", "1", "--owner", "o"]
        ghcache.run(args, ttl=300, now_fn=lambda: 1000.0)
        ghcache.run(args, ttl=300, now_fn=lambda: 1010.0)
        self.assertEqual(self.calls(), 1)
        ghcache.run(args, ttl=300, now_fn=lambda: 1020.0, force=True)
        self.assertEqual(self.calls(), 2)
        ghcache.run(args, ttl=300, now_fn=lambda: 1030.0)  # the forced answer is shared
        self.assertEqual(self.calls(), 2)

    def test_force_from_the_environment(self):
        args = ["api", "graphql", "-f", "query={ viewer { login } }"]
        ghcache.run(args, ttl=300, now_fn=lambda: 1000.0)
        os.environ["GHC_FORCE"] = "1"
        self.addCleanup(os.environ.pop, "GHC_FORCE", None)
        ghcache.run(args, ttl=300, now_fn=lambda: 1010.0)
        self.assertEqual(self.calls(), 2)


    def test_identical_reads_within_ttl_call_github_once(self):
        a = ghcache.run(["api", "user"], ttl=60, cwd="/w")
        b = ghcache.run(["api", "user"], ttl=60, cwd="/w")
        self.assertEqual(a, b)
        self.assertEqual(a[0], 0)
        self.assertEqual(self.calls(), 1)

    def test_expired_entries_are_fetched_again(self):
        t = [1000.0]
        ghcache.run(["api", "user"], ttl=60, cwd="/w", now_fn=lambda: t[0])
        t[0] += 61
        ghcache.run(["api", "user"], ttl=60, cwd="/w", now_fn=lambda: t[0])
        self.assertEqual(self.calls(), 2)

    def test_writes_pass_through_and_drop_related_reads(self):
        ghcache.run(["project", "item-list", "1"], ttl=300, cwd="/w")
        ghcache.run(["api", "user"], ttl=300, cwd="/w")
        ghcache.run(["project", "item-edit", "--id", "x"], cwd="/w")
        ghcache.run(["project", "item-list", "1"], ttl=300, cwd="/w")  # refetched
        ghcache.run(["api", "user"], ttl=300, cwd="/w")  # still cached (unrelated)
        self.assertEqual(self.calls(), 4)

    def test_failures_are_not_cached(self):
        self.set_mode("fail")
        code, _, err = ghcache.run(["pr", "view", "9"], ttl=60, cwd="/w")
        self.assertEqual(code, 1)
        self.assertIn(b"404", err)
        self.set_mode("ok")
        self.assertEqual(ghcache.run(["pr", "view", "9"], ttl=60, cwd="/w")[0], 0)
        self.assertEqual(self.calls(), 2)

    def test_rate_limit_pauses_everyone_and_serves_stale(self):
        t = [1000.0]
        ghcache.run(["api", "user"], ttl=10, cwd="/w", now_fn=lambda: t[0])  # cached
        t[0] += 20
        self.set_mode("ratelimit")
        code, out, err = ghcache.run(["api", "user"], ttl=10, cwd="/w", now_fn=lambda: t[0])
        self.assertEqual(code, 0)  # the stale answer, not the error
        self.assertIn(b"out:api user", out)
        self.assertTrue(ghcache.paused_until(t[0]) > t[0])
        before = self.calls()
        # While paused: no GitHub calls at all; cached reads served stale, others refused.
        code, out, err = ghcache.run(["api", "user"], ttl=10, cwd="/w", now_fn=lambda: t[0] + 5)
        self.assertEqual((code, self.calls()), (0, before))
        self.assertIn(b"paused until", err)
        code, _, err = ghcache.run(["api", "rate_limit_other"], ttl=10, cwd="/w", now_fn=lambda: t[0] + 5)
        self.assertEqual(code, 1)
        self.assertIn(b"rate limit", err)
        self.assertEqual(self.calls(), before)

    def test_concurrent_identical_reads_single_flight(self):
        self.set_mode("slow")
        results = []
        threads = [threading.Thread(target=lambda: results.append(ghcache.run(["api", "user"], ttl=60, cwd="/w"))) for _ in range(5)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(len(results), 5)
        self.assertEqual(self.calls(), 1)

    def test_cli_passes_output_and_exit_code(self):
        import io
        import sys
        from contextlib import redirect_stdout
        buf = io.BytesIO()

        class Out:
            buffer = buf

        old = sys.stdout
        sys.stdout = Out()  # type: ignore
        try:
            code = ghcache.main(["--ttl", "30", "gh", "api", "user"])
        finally:
            sys.stdout = old
        self.assertEqual(code, 0)
        self.assertEqual(buf.getvalue(), b"out:api user\n")
        _ = redirect_stdout


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import os
import tempfile
import sys
import threading
import time
import unittest
from pathlib import Path

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

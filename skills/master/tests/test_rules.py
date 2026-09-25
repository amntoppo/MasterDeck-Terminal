from __future__ import annotations

import os
import unittest

from master import rules

NOW = "2026-09-24T14:00:00Z"
OK = {"gh": True, "board": True, "prs": True, "agents": True, "state": True}


def issue(n, status="In Dev", current=True):
    return {"number": n, "title": f"Coupon expiry banner {n}", "status": status, "sprint": "S",
            "current_sprint": current, "assigned_to_me": True,
            "url": f"https://github.com/acme/tracker/issues/{n}"}


def sess(name, issue_n, status="idle", link="explicit", sid=None, head="h1", idle_since=None, cwd="/w",
         branch="acme/mobile-app@feat/x", prs=()):
    return {"name": name, "session_id": sid or f"id-{name}", "pid": 1, "bg_id": None, "kind": "interactive",
            "status": status, "cwd": cwd, "issue": issue_n, "link": link, "branch": branch,
            "prs": list(prs), "branch_head": head, "idle_since": idle_since}


def pr(n=55, threads=0, last=None, ci=None, refs=939, mine=True, oid="o1"):
    return {"url": f"https://github.com/acme/mobile-app/pull/{n}", "repo": "mobile-app",
            "number": n, "title": f"PR {n}", "author_is_me": mine, "review_requested": False,
            "unresolved_threads": threads, "last_unresolved_at": last, "ci": ci, "head_oid": oid,
            "head_ref": "feat/x", "refs_issue": refs, "updated_at": NOW}


def snap(issues=(), prs=(), sessions=(), sources=None):
    return {"taken_at": NOW, "issues": list(issues), "prs": list(prs), "sessions": list(sessions),
            "errors": [], "sources": dict(sources or OK)}


def kinds(cands):
    return sorted((c["kind"], c["issue"]) for c in cands)


class CarryIdleTest(unittest.TestCase):
    def test_new_idle_starts_now_and_continuing_idle_keeps_start(self):
        prev = snap(sessions=[sess("a", 1, idle_since="2026-09-24T08:00:00Z")])
        cur = snap(sessions=[sess("a", 1), sess("b", 2), sess("c", 3, status="busy")])
        rules.carry_idle(prev, cur, NOW)
        got = {s["name"]: s["idle_since"] for s in cur["sessions"]}
        self.assertEqual(got, {"a": "2026-09-24T08:00:00Z", "b": NOW, "c": None})

    def test_busy_in_between_resets(self):
        prev = snap(sessions=[sess("a", 1, status="busy")])
        cur = snap(sessions=[sess("a", 1)])
        rules.carry_idle(prev, cur, NOW)
        self.assertEqual(cur["sessions"][0]["idle_since"], NOW)

    def test_no_prev(self):
        cur = snap(sessions=[sess("a", 1)])
        rules.carry_idle(None, cur, NOW)
        self.assertEqual(cur["sessions"][0]["idle_since"], NOW)


class AssignTest(unittest.TestCase):
    def test_unowned_current_sprint_todo_is_assigned(self):
        old = os.environ.get("MASTER_WORKSPACE")
        self.addCleanup(lambda: os.environ.__setitem__("MASTER_WORKSPACE", old) if old is not None
                        else os.environ.pop("MASTER_WORKSPACE", None))
        os.environ["MASTER_WORKSPACE"] = "/ws"
        [c] = rules.propose(None, snap(issues=[issue(981, "To Do")]), NOW)
        self.assertEqual((c["kind"], c["issue"], c["source"]), ("ASSIGN", 981, "issue:981"))
        sp = c["target"]["spawn"]
        self.assertEqual((sp["name"], sp["cwd"]), ("981-coupon-expiry-banner-981", "/ws"))
        self.assertIn("acme/tracker#981", sp["prompt"])
        self.assertIn("babysit-ticket", sp["prompt"])
        self.assertIn("babysit-worktree", sp["prompt"])
        self.assertIn("babysit-pr", sp["prompt"])
        self.assertIn("ask the user for instructions", sp["prompt"])
        self.assertIn("#981: question — ready for instructions", sp["prompt"])
        self.assertNotIn("issue-to-pr", sp["prompt"])
        self.assertIn("master-agent", sp["prompt"])
        self.assertEqual(c["summary"], '"Coupon expiry banner 981"')

    def test_not_assigned_when_owned_old_sprint_or_in_dev(self):
        cur = snap(issues=[issue(1, "To Do"), issue(2, "To Do", current=False), issue(3, "In Dev"),
                           issue(4, None)],
                   sessions=[sess("a", 1)])
        self.assertEqual([c for c in rules.propose(None, cur, NOW) if c["kind"] == "ASSIGN"], [])

    def test_owned_by_dead_session_is_not_assigned(self):
        cur = snap(issues=[issue(1, "Re-Open")], sessions=[sess("d", 1, status="dead")])
        self.assertEqual(kinds(rules.propose(None, cur, NOW)), [("ORPHAN", 1)])

    def test_board_source_down_blocks_assign(self):
        cur = snap(issues=[issue(1, "To Do")], sources={**OK, "board": False})
        self.assertEqual(rules.propose(None, cur, NOW), [])


class ReviewAndCiTest(unittest.TestCase):
    def test_review_goes_to_live_owner(self):
        cur = snap(issues=[issue(939)], prs=[pr(threads=2, last="2026-09-24T09:40:00Z")],
                   sessions=[sess("paywall", 939, status="busy")])
        [c] = rules.propose(None, cur, NOW)
        self.assertEqual((c["kind"], c["target"], c["source"]),
                         ("REVIEW", {"session": "paywall"}, "mobile-app#55:threads:2026-09-24T09:40:00Z"))
        self.assertTrue(c["message"].startswith("#939: address 2 unresolved review threads on mobile-app#55\n"))
        self.assertIn("SendMessage", c["message"])

    def test_ci_failure(self):
        cur = snap(issues=[issue(939)], prs=[pr(ci="failure", oid="o9")], sessions=[sess("paywall", 939)])
        [c] = rules.propose(None, cur, NOW)
        self.assertEqual((c["kind"], c["source"]), ("CI", "mobile-app#55:ci:o9"))

    def test_error_state_counts_as_ci_failure(self):
        cur = snap(issues=[issue(939)], prs=[pr(ci="error")], sessions=[sess("paywall", 939)])
        self.assertEqual(kinds(rules.propose(None, cur, NOW)), [("CI", 939)])

    def test_issue_found_via_session_prs_when_body_has_no_ref(self):
        p = pr(threads=1, last="t", refs=None)
        cur = snap(issues=[issue(939)], prs=[p], sessions=[sess("paywall", 939, prs=[p["url"]])])
        self.assertEqual(kinds(rules.propose(None, cur, NOW)), [("REVIEW", 939)])

    def test_skipped_for_dead_owner_no_owner_or_not_mine(self):
        cur = snap(issues=[issue(1), issue(2)],
                   prs=[pr(1, threads=1, last="t", refs=1), pr(2, threads=1, last="t", refs=2),
                        pr(3, threads=1, last="t", refs=1, mine=False)],
                   sessions=[sess("d", 1, status="dead")])
        self.assertEqual([c for c in rules.propose(None, cur, NOW) if c["kind"] in ("REVIEW", "CI")], [])

    def test_prs_source_down_blocks_review(self):
        cur = snap(issues=[issue(939)], prs=[pr(threads=1, last="t")], sessions=[sess("p", 939)],
                   sources={**OK, "prs": False})
        self.assertEqual(rules.propose(None, cur, NOW), [])


class StaleAndOrphanTest(unittest.TestCase):
    def test_stale_after_four_hours_with_unchanged_head(self):
        prev = snap(sessions=[sess("p", 939, head="h1")])
        cur = snap(issues=[issue(939)], sessions=[sess("p", 939, head="h1", idle_since="2026-09-24T09:59:00Z")])
        [c] = rules.propose(prev, cur, NOW)
        self.assertEqual((c["kind"], c["source"], c["target"]),
                         ("STALE", "stale:id-p:2026-09-24T09:59:00Z", {"session": "p"}))
        self.assertTrue(c["message"].startswith("#939: status check from master-agent — where does this issue stand?"))
        self.assertTrue(c["message"].endswith(rules.REPLY.format(n=939)))

    def test_not_stale_when_recent_moved_no_prev_or_not_in_dev(self):
        prev = snap(sessions=[sess("p", 939, head="h1")])
        recent = snap(issues=[issue(939)], sessions=[sess("p", 939, head="h1", idle_since="2026-09-24T10:01:00Z")])
        moved = snap(issues=[issue(939)], sessions=[sess("p", 939, head="h2", idle_since="2026-09-24T09:00:00Z")])
        todo = snap(issues=[issue(939, "PR Raised")], sessions=[sess("p", 939, head="h1", idle_since="2026-09-24T09:00:00Z")])
        self.assertEqual(rules.propose(prev, recent, NOW), [])
        self.assertEqual(rules.propose(prev, moved, NOW), [])
        self.assertEqual(rules.propose(None, moved, NOW), [])
        self.assertEqual(rules.propose(prev, todo, NOW), [])

    def test_orphan_resumes_dead_explicit_owner(self):
        cur = snap(issues=[issue(939, "PR Raised")], sessions=[sess("dead-994e", 939, status="dead", sid="994e-full", cwd="/repo")])
        [c] = rules.propose(None, cur, NOW)
        self.assertEqual((c["kind"], c["source"]), ("ORPHAN", "orphan:994e-full"))
        self.assertEqual(c["target"], {"spawn": {"name": "939-coupon-expiry-banner-939", "cwd": "/repo", "resume": "994e-full"}})

    def test_no_orphan_when_live_owner_exists_or_issue_not_resumable(self):
        live = snap(issues=[issue(939)], sessions=[sess("p", 939), sess("d", 939, status="dead")])
        self.assertEqual([c for c in rules.propose(None, live, NOW) if c["kind"] == "ORPHAN"], [])
        todo = snap(issues=[issue(939, "To Do")], sessions=[sess("d", 939, status="dead")])
        self.assertEqual(kinds(rules.propose(None, todo, NOW)), [])

    def test_sessions_for_issues_outside_snapshot_are_ignored(self):
        cur = snap(sessions=[sess("d", 5, status="dead")])
        self.assertEqual(rules.propose(None, cur, NOW), [])


class ReplyTemplateTest(unittest.TestCase):
    def test_reply_template_offers_question(self):
        text = rules.REPLY.format(n=939)
        self.assertIn("'#939: done'", text)
        self.assertIn("'#939: blocked — <reason>'", text)
        self.assertIn("'#939: question — <question>'", text)

    def test_reply_template_asks_user_directly_and_offers_answered(self):
        text = rules.REPLY.format(n=939)
        self.assertIn("ask the user directly in this session", text)
        self.assertIn("wait for the answer from either place", text)
        self.assertIn("'#939: answered — <answer>'", text)


class FormatTest(unittest.TestCase):
    def test_spawn_name_slug(self):
        self.assertEqual(rules.spawn_name({"number": 7, "title": "Fix: Stripe  checkout (web) — v2!"}),
                         "7-fix-stripe-checkout-web-v2")
        self.assertEqual(len(rules.spawn_name({"number": 7, "title": "x" * 80})), len("7-") + 30)

    def test_format_batch(self):
        ps = [
            {"id": 1, "kind": "REVIEW", "issue": 939, "target": {"session": "paywall"}, "summary": "2 threads"},
            {"id": 12, "kind": "ASSIGN", "issue": 981, "target": {"spawn": {"name": "981-x", "cwd": "/w", "prompt": "p"}}, "summary": '"X"'},
            {"id": 3, "kind": "ORPHAN", "issue": 5, "target": {"spawn": {"name": "5-y", "cwd": "/w", "resume": "s"}}, "summary": "resume"},
        ]
        self.assertEqual(rules.format_batch(ps), "\n".join([
            "3 proposals",
            "  1 REVIEW  #939 → paywall: 2 threads",
            " 12 ASSIGN  #981 → spawn 981-x: \"X\"",
            "  3 ORPHAN  #5 → resume 5-y: resume",
        ]))

    def test_format_single(self):
        p = {"id": 1, "kind": "CI", "issue": 1, "target": {"session": "a"}, "summary": "s"}
        self.assertTrue(rules.format_batch([p]).startswith("1 proposal\n"))


if __name__ == "__main__":
    unittest.main()

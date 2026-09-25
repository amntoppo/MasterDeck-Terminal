from __future__ import annotations

import unittest

from master import join
from tests.helpers import agent

MASTER = "master-agent"


def link(issue, adopted=False, branch="acme/mobile-app@feat/x", prs=()):
    e = {"issue": issue, "branch": branch, "prs": list(prs)}
    if adopted:
        e["adopted"] = True
    else:
        e["linked_at"] = "2026-09-22T15:00:00Z"
    return e


def no_cwd(_sid):
    return None


class SessionsTest(unittest.TestCase):
    def test_live_explicit_owner(self):
        out = join.sessions([agent("s1", "paywall")], {"sessions": {"s1": link(939, prs=["u1"])}}, MASTER, no_cwd)
        self.assertEqual(out, [{
            "name": "paywall", "session_id": "s1", "pid": 1, "bg_id": None, "kind": "interactive",
            "status": "idle", "cwd": "/w", "issue": 939, "link": "explicit",
            "branch": "acme/mobile-app@feat/x", "prs": ["u1"]}])

    def test_live_session_without_link(self):
        [s] = join.sessions([agent("s1", "scratch", status="busy")], {"sessions": {}}, MASTER, no_cwd)
        self.assertEqual((s["issue"], s["link"], s["status"]), (None, None, "busy"))

    def test_master_is_excluded_from_agents_and_state(self):
        agents = [agent("m", MASTER), agent("s1", "paywall")]
        out = join.sessions(agents, {"sessions": {"m": link(938, adopted=True)}}, MASTER, no_cwd)
        self.assertEqual([s["name"] for s in out], ["paywall"])

    def test_adopted_link_dropped_when_explicit_owner_is_live(self):
        agents = [agent("s1", "walkthrough-expo"), agent("s2", "workspace-53")]
        state = {"sessions": {"s1": link(938), "s2": link(938, adopted=True)}}
        by = {s["name"]: s for s in join.sessions(agents, state, MASTER, no_cwd)}
        self.assertEqual(by["walkthrough-expo"]["issue"], 938)
        self.assertEqual((by["workspace-53"]["issue"], by["workspace-53"]["link"]), (None, None))

    def test_adopted_link_kept_when_it_is_the_only_live_owner(self):
        state = {"sessions": {"s2": link(938, adopted=True)}}
        [s] = join.sessions([agent("s2", "x")], state, MASTER, no_cwd)
        self.assertEqual((s["issue"], s["link"]), (938, "adopted"))

    def test_dead_explicit_link_is_reported_with_cwd(self):
        out = join.sessions([], {"sessions": {"deadbeef-1": link(939)}}, MASTER, lambda sid: "/repo")
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["name"], out[0]["status"], out[0]["cwd"], out[0]["issue"]),
                         ("dead-deadbeef", "dead", "/repo", 939))

    def test_dead_adopted_link_is_dropped(self):
        self.assertEqual(join.sessions([], {"sessions": {"d": link(1, adopted=True)}}, MASTER, no_cwd), [])

    def test_state_entry_without_issue_is_ignored(self):
        self.assertEqual(join.sessions([], {"sessions": {"d": {"branch": "x"}}}, MASTER, no_cwd), [])

    def test_background_sessions(self):
        agents = [agent("b1", "981-coupon", kind="background", state="blocked", bg_id="b1short"),
                  agent("b2", "old", kind="background", state="done"),
                  agent("b3", None, kind="background", bg_id="b3short")]
        out = join.sessions(agents, {"sessions": {}}, MASTER, no_cwd)
        by = {s["session_id"]: s for s in out}
        self.assertNotIn("b2", by)
        self.assertEqual((by["b1"]["status"], by["b1"]["bg_id"], by["b1"]["kind"]), ("blocked", "b1short", "background"))
        self.assertEqual(by["b3"]["name"], "b3short")

    def test_dead_sort_last(self):
        out = join.sessions([agent("s1", "zeta")], {"sessions": {"d": link(5)}}, MASTER, no_cwd)
        self.assertEqual([s["status"] for s in out], ["idle", "dead"])


class OwnerTest(unittest.TestCase):
    def rec(self, name, issue, status="idle", link_="explicit", prs=()):
        return {"name": name, "issue": issue, "status": status, "link": link_, "prs": list(prs)}

    def test_prefers_live_then_explicit(self):
        sess = [self.rec("dead", 1, status="dead"), self.rec("adopt", 1, link_="adopted"), self.rec("exp", 1)]
        self.assertEqual(join.owner_of(sess, 1)["name"], "exp")
        self.assertEqual(join.owner_of(sess[:2], 1)["name"], "adopt")
        self.assertEqual(join.owner_of(sess[:1], 1)["name"], "dead")

    def test_none_when_unowned_or_issue_none(self):
        self.assertIsNone(join.owner_of([self.rec("a", 1)], 2))
        self.assertIsNone(join.owner_of([self.rec("a", None)], None))

    def test_issue_for_pr_prefers_body_ref(self):
        sess = [self.rec("a", 7, prs=["u"])]
        self.assertEqual(join.issue_for_pr({"url": "u", "refs_issue": 9}, sess), 9)
        self.assertEqual(join.issue_for_pr({"url": "u", "refs_issue": None}, sess), 7)
        self.assertIsNone(join.issue_for_pr({"url": "v", "refs_issue": None}, sess))


if __name__ == "__main__":
    unittest.main()

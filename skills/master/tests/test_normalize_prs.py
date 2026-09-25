from __future__ import annotations

import unittest

from master import normalize
from tests.helpers import ME, pr_node


class PrsTest(unittest.TestCase):
    def test_unresolved_threads_and_latest_comment(self):
        node = pr_node(55, threads=[(True, "2026-09-24T08:00:00Z"),
                                    (False, "2026-09-24T09:00:00Z"),
                                    (False, "2026-09-24T09:40:00Z")])
        [pr] = normalize.prs([node], [], ME)
        self.assertEqual(pr["unresolved_threads"], 2)
        self.assertEqual(pr["last_unresolved_at"], "2026-09-24T09:40:00Z")

    def test_no_unresolved_threads(self):
        [pr] = normalize.prs([pr_node(1, threads=[(True, "2026-09-24T08:00:00Z")])], [], ME)
        self.assertEqual((pr["unresolved_threads"], pr["last_unresolved_at"]), (0, None))

    def test_full_record(self):
        node = pr_node(55, ci="FAILURE", body="Fixes it.\n\nRefs acme/tracker#939", head_oid="def456")
        [pr] = normalize.prs([node], [], ME)
        self.assertEqual(pr, {
            "url": "https://github.com/acme/mobile-app/pull/55", "repo": "mobile-app",
            "number": 55, "title": "PR 55", "author_is_me": True, "review_requested": False,
            "unresolved_threads": 0, "last_unresolved_at": None, "ci": "failure",
            "head_oid": "def456", "head_ref": "feat/x", "refs_issue": 939,
            "updated_at": "2026-09-24T09:00:00Z"})

    def test_no_ci_and_no_ref(self):
        [pr] = normalize.prs([pr_node(2)], [], ME)
        self.assertEqual((pr["ci"], pr["refs_issue"]), (None, None))

    def test_ref_match_is_case_insensitive(self):
        [pr] = normalize.prs([pr_node(3, body="refs ACME/Tracker#12")], [], ME)
        self.assertEqual(pr["refs_issue"], 12)

    def test_review_requested_merges_with_authored(self):
        mine = pr_node(4)
        other = pr_node(5, author="someone")
        out = normalize.prs([mine], [pr_node(4), other], ME)
        by = {p["number"]: p for p in out}
        self.assertEqual((by[4]["author_is_me"], by[4]["review_requested"]), (True, True))
        self.assertEqual((by[5]["author_is_me"], by[5]["review_requested"]), (False, True))

    def test_ghost_author_and_empty_nodes(self):
        out = normalize.prs([pr_node(6, author=None), {}], [], ME)
        self.assertEqual([p["author_is_me"] for p in out], [False])

    def test_unknown_me(self):
        [pr] = normalize.prs([pr_node(7)], [], None)
        self.assertFalse(pr["author_is_me"])

    def test_thread_whose_last_comment_is_mine_is_not_counted(self):
        node = pr_node(8, threads=[(False, "2026-09-24T09:00:00Z", ME)])
        [pr] = normalize.prs([node], [], ME)
        self.assertEqual((pr["unresolved_threads"], pr["last_unresolved_at"]), (0, None))

    def test_mixed_threads_counts_only_the_ones_waiting_on_me(self):
        node = pr_node(9, threads=[(False, "2026-09-24T09:00:00Z", ME),
                                   (False, "2026-09-24T09:30:00Z", "reviewer")])
        [pr] = normalize.prs([node], [], ME)
        self.assertEqual((pr["unresolved_threads"], pr["last_unresolved_at"]),
                         (1, "2026-09-24T09:30:00Z"))

    def test_unknown_me_still_counts_all_unresolved_threads(self):
        node = pr_node(10, threads=[(False, "2026-09-24T09:00:00Z", ME),
                                    (False, "2026-09-24T09:30:00Z", "reviewer")])
        [pr] = normalize.prs([node], [], None)
        self.assertEqual(pr["unresolved_threads"], 2)


if __name__ == "__main__":
    unittest.main()

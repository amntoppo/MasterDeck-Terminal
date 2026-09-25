from __future__ import annotations

import unittest
from datetime import date

from master import normalize
from tests.helpers import board_item

TODAY = date(2026, 9, 24)


class CurrentSprintTest(unittest.TestCase):
    def test_inside_sprint(self):
        self.assertTrue(normalize.in_current_sprint({"startDate": "2026-09-21", "duration": 14}, TODAY))

    def test_first_day_counts(self):
        self.assertTrue(normalize.in_current_sprint({"startDate": "2026-09-24", "duration": 14}, TODAY))

    def test_day_after_last_day_does_not(self):
        # starts 09-10, 14 days: last day 09-23
        self.assertFalse(normalize.in_current_sprint({"startDate": "2026-09-10", "duration": 14}, TODAY))

    def test_future_sprint_does_not(self):
        self.assertFalse(normalize.in_current_sprint({"startDate": "2026-10-05", "duration": 14}, TODAY))

    def test_no_sprint(self):
        self.assertFalse(normalize.in_current_sprint(None, TODAY))


class IssuesTest(unittest.TestCase):
    def test_mine_keeps_unfinished_and_drops_done(self):
        out = normalize.issues(
            [board_item(1, "In Dev", "2026-09-21"), board_item(2, "Dev Done", "2026-09-21"),
             board_item(3, "To Do"), board_item(4, "Invalid")],
            [], TODAY)
        self.assertEqual([i["number"] for i in out], [1, 3])
        self.assertEqual(out[0], {
            "number": 1, "title": "Issue 1", "status": "In Dev", "sprint": "Sprint 6",
            "current_sprint": True, "assigned_to_me": True,
            "url": "https://github.com/acme/tracker/issues/1"})
        self.assertEqual((out[1]["sprint"], out[1]["current_sprint"]), (None, False))

    def test_pull_requests_on_the_board_are_ignored(self):
        out = normalize.issues([board_item(5, "In Dev", typ="PullRequest")], [], TODAY)
        self.assertEqual(out, [])

    def test_missing_status_is_kept_as_none(self):
        out = normalize.issues([board_item(6, None)], [], TODAY)
        self.assertIsNone(out[0]["status"])

    def test_ready_unassigned_current_sprint_is_included(self):
        out = normalize.issues([], [board_item(7, "Ready For Dev", "2026-09-21", assignees=())], TODAY)
        self.assertEqual([(i["number"], i["assigned_to_me"]) for i in out], [(7, False)])

    def test_ready_filters(self):
        ready = [
            board_item(8, "Ready For Dev", "2026-09-21", assignees=("someone",)),  # assigned
            board_item(9, "Ready For Dev", "2026-09-10", assignees=()),            # old sprint
            board_item(10, "To Do", "2026-09-21", assignees=()),                   # wrong status
        ]
        self.assertEqual(normalize.issues([], ready, TODAY), [])

    def test_mine_wins_over_ready_duplicate(self):
        mine = [board_item(11, "Ready For Dev", "2026-09-21")]
        ready = [board_item(11, "Ready For Dev", "2026-09-21", assignees=())]
        out = normalize.issues(mine, ready, TODAY)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["assigned_to_me"])


if __name__ == "__main__":
    unittest.main()

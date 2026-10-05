"""The Board's repository view: the issues of the repositories picked in a tab's Repos filter,
whether or not a project board holds them. Never GitHub in these tests: fake runners and fixtures only."""
from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest import mock

from master import board, cli, collect, config, rules, snapshot

NOW = "2026-09-25T10:00:00Z"
TODAY = date(2026, 9, 25)
SINCE = "2026-09-11T00:00:00Z"
PR = "https://github.com/acme/tracker/pull/"
BOARDS = [{"owner": "acme", "ownerType": "organization", "number": 1, "title": "Delivery", "statusField": "Status",
           "columns": ["To Do", "In QA"]},
          {"owner": "acme", "ownerType": "organization", "number": 2, "title": "Platform", "statusField": "Stage",
           "columns": ["Backlog"]}]
TWO_REPOS = {"repos": ["acme/tracker", "acme/api"], "projects": BOARDS}


def node(n, state="OPEN", closed=None, updated="2026-09-25T09:00:00Z", held=None):
    """An issue as GitHub's GraphQL returns it. held: [(owner, number, {alias: status name})]."""
    got = {"number": n, "title": f"Issue {n}", "url": f"https://github.com/acme/tracker/issues/{n}",
           "state": state, "closedAt": closed, "updatedAt": updated,
           "assignees": {"nodes": []}, "labels": {"nodes": []}, "milestone": None, "issueType": None,
           "closedByPullRequestsReferences": {"nodes": []}}
    if held is not None:
        got["projectItems"] = {"nodes": [{"project": {"number": num, "owner": {"login": owner}},
                                          **{a: ({"name": s} if s else None) for a, s in st.items()}}
                                         for owner, num, st in held]}
    return got


def ritem(n, repo="acme/tracker", state="OPEN", closed=None, updated="2026-09-25T09:00:00Z", prs=None, held=None):
    """The same issue as `repo_issues_page` hands it on."""
    prs = prs or {}
    it = {"content": {"type": "Issue", "number": n, "title": f"Issue {n}",
                      "url": f"https://github.com/{repo}/issues/{n}", "repository": repo},
          "status": None, "sprint": None, "assignees": ["alice"], "labels": [], "milestone": None, "issue type": None,
          "linked pull requests": list(prs), "pr states": dict(prs), "state": state, "closed_at": closed,
          "updated_at": updated, "derived": True}
    if held:
        it["on boards"] = held
    return it


def conn(nodes, total=None, cursor=None):
    return {"totalCount": len(nodes) if total is None else total,
            "pageInfo": {"hasNextPage": bool(cursor), "endCursor": cursor}, "nodes": nodes}


class QueryTest(unittest.TestCase):
    def test_without_fields_the_query_is_the_board_reads_own(self):
        reqs = [("r0", "acme/tracker", None, True)]
        self.assertEqual(board.repo_issues_query(reqs, SINCE, None), board.repo_issues_query(reqs, SINCE))
        self.assertEqual(board.repo_issues_query(reqs, SINCE, []), board.repo_issues_query(reqs, SINCE))
        self.assertNotIn("projectItems", board.repo_issues_query(reqs, SINCE)[0])

    def test_with_fields_each_issue_says_which_boards_hold_it(self):
        q, v = board.repo_issues_query([("r0", "acme/tracker", None, True)], SINCE, ["Status", "Stage"])
        self.assertEqual(q.count("projectItems(first: 5)"), 2)  # open and closed issues alike
        self.assertIn('s0: fieldValueByName(name: "Status")', q)
        self.assertIn('s1: fieldValueByName(name: "Stage")', q)
        self.assertNotIn("mutation", q)  # the shared cache reads that word as a write
        self.assertEqual(v, {"since": SINCE})

    def test_status_fields_are_the_selected_boards_once_each(self):
        with mock.patch.dict(config.CONFIG, {"projects": BOARDS + [dict(BOARDS[0], number=3)]}):
            self.assertEqual(board.status_fields(), ["Status", "Stage"])

    def test_page_reads_the_selected_boards_and_their_status(self):
        held = [("acme", 1, {"s0": "In QA", "s1": None}), ("ACME", 2, {"s0": None, "s1": "Backlog"}),
                ("other-org", 9, {"s0": "Doing"}), ("acme", 1, {"s0": "Twice"})]
        data = {"r0": {"open": conn([node(1, held=held), node(2, held=[]), node(3)]), "closed": {"nodes": []}}}
        with mock.patch.dict(config.CONFIG, {"projects": BOARDS}):
            items, _, _ = board.repo_issues_page(data, "r0", "acme/tracker", ["Status", "Stage"])
            plain, _, _ = board.repo_issues_page(data, "r0", "acme/tracker")
        # A board not selected in Setup is left out; the same board twice counts once; no status is None.
        self.assertEqual(items[0]["on boards"], [{"key": "acme/1", "status": "In QA"}, {"key": "acme/2", "status": "Backlog"}])
        self.assertNotIn("on boards", items[1])
        self.assertNotIn("on boards", items[2])
        self.assertTrue(all("on boards" not in it for it in plain))  # the board read never carries it

    def test_build_hands_the_boards_on_only_for_a_repository_issue(self):
        held = [{"key": "acme/1", "status": "In QA"}]
        cards = board.build([ritem(1, held=held), ritem(2)], {}, NOW)["cards"]
        self.assertEqual(cards[0]["onBoards"], held)
        self.assertNotIn("onBoards", cards[1])
        real = {"content": {"type": "Issue", "number": 5, "title": "T", "url": ""}, "status": "In Dev", "on boards": held}
        self.assertNotIn("onBoards", board.build([real], {}, NOW)["cards"][0])


class LiveOnlyTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        p = mock.patch.dict(os.environ, {"MASTERDECK_HOME": self.home.name})
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self.home.cleanup)

    def run_live(self, answers, only, boards=True, cfg=TWO_REPOS):
        calls = []

        def fake_run(cmd, timeout=120, env=None, partial=False):
            calls.append(" ".join(cmd))
            return json.dumps(answers[min(len(calls), len(answers)) - 1])

        with mock.patch.dict(config.CONFIG, cfg), mock.patch.object(collect, "_run", side_effect=fake_run):
            got = collect.Live().repo_issues(TODAY, only=only, boards=boards)
        return got, calls

    def test_only_the_asked_repositories_are_read_in_their_configured_spelling(self):
        got, calls = self.run_live([{"data": {"r0": {"open": conn([node(1)], total=7), "closed": {"nodes": []}}}}], ["ACME/API"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].count("repository("), 1)
        self.assertIn('name: "api"', calls[0])
        self.assertEqual((got["repos"], got["totals"], got["total"], got["skipped"]), (["acme/api"], {"acme/api": 7}, 7, []))
        self.assertEqual([i["content"]["repository"] for i in got["items"]], ["acme/api"])

    def test_without_only_every_ticked_repository_is_read_and_no_board_is_asked_for(self):
        both = {"data": {a: {"open": conn([]), "closed": {"nodes": []}} for a in ("r0", "r1")}}
        got, calls = self.run_live([both], None, boards=False)
        self.assertEqual(calls[0].count("repository("), 2)
        self.assertNotIn("projectItems", calls[0])
        self.assertEqual((got["repos"], got["boards_unread"]), (["acme/tracker", "acme/api"], None))

    def test_boards_are_asked_for_only_when_the_account_has_one(self):
        ok = {"data": {"r0": {"open": conn([node(1, held=[("acme", 1, {"s0": "In QA"})])]), "closed": {"nodes": []}}}}
        got, calls = self.run_live([ok], ["acme/api"])
        self.assertIn("projectItems", calls[0])
        self.assertEqual(got["items"][0]["on boards"], [{"key": "acme/1", "status": "In QA"}])
        _, calls = self.run_live([ok], ["acme/api"], cfg={"repos": ["acme/tracker", "acme/api"], "project": 0, "projects": []})
        self.assertNotIn("projectItems", calls[0])  # no board: its token may not read projects at all

    def test_each_asked_repository_pages_to_its_own_limit(self):
        # The board read stops once 300 open issues were read over all repositories; here each
        # repository gets its three rounds of 100.
        page = lambda a, cur: {a: {"open": conn([node(i) for i in range(100)], total=900, cursor=cur), "closed": {"nodes": []}}}
        answers = [{"data": {**page("r0", "A1"), **page("r1", "B1")}}, {"data": {**page("r0", "A2"), **page("r1", "B2")}},
                   {"data": {**page("r0", "A3"), **page("r1", "B3")}}]
        got, calls = self.run_live(answers, ["acme/tracker", "acme/api"], boards=False)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[2].count("repository("), 2)
        self.assertEqual(len(got["items"]), 600)

    def test_a_refused_board_read_is_asked_again_without_the_boards(self):
        # A token without the project scope: the error sits on projectItems, and GitHub hands back
        # a null issue. The issues must still show.
        refused = {"data": {"r0": {"open": conn([None], total=1), "closed": {"nodes": []}}},
                   "errors": [{"type": "INSUFFICIENT_SCOPES", "path": ["r0", "open", "nodes", 0, "projectItems"]}]}
        plain = {"data": {"r0": {"open": conn([node(1)], total=1), "closed": {"nodes": []}}}}
        got, calls = self.run_live([refused, plain], ["acme/api"])
        self.assertEqual(len(calls), 2)
        self.assertIn("projectItems", calls[0])
        self.assertNotIn("projectItems", calls[1])
        self.assertIn("since=", calls[1])  # the same round again: closed issues are still asked for
        self.assertEqual(([i["content"]["number"] for i in got["items"]], got["boards_unread"]), ([1], "INSUFFICIENT_SCOPES"))

    def test_a_repository_past_ten_is_named_not_read(self):
        repos = [f"acme/r{i}" for i in range(12)]
        ten = {"data": {f"r{i}": {"open": conn([]), "closed": {"nodes": []}} for i in range(10)}}
        got, calls = self.run_live([ten], repos, cfg={"repos": repos, "projects": BOARDS})
        self.assertEqual(calls[0].count("repository("), 10)
        self.assertEqual(got["skipped"], ["acme/r10", "acme/r11"])

    def test_fixtures_narrow_too(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "repo_issues.json").write_text(json.dumps(
                {"items": [ritem(1), ritem(2, repo="acme/api")], "total": 2, "repos": ["acme/tracker", "acme/api"],
                 "skipped": [], "missing": []}))
            got = collect.Fixtures(Path(d)).repo_issues(TODAY, only=["ACME/api"], boards=True)
            self.assertEqual(([i["content"]["number"] for i in got["items"]], got["repos"]), ([2], ["ACME/api"]))
            self.assertEqual(len(collect.Fixtures(Path(d)).repo_issues(TODAY)["items"]), 2)

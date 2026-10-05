"""An account with repositories but no project board: `master board` and `master snapshot` read its
repositories' issues instead. Never GitHub in these tests: fake runners and fixtures only."""
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

from master import board, cli, collect, config

NOW = "2026-09-25T10:00:00Z"
TODAY = date(2026, 9, 25)
SINCE = "2026-09-11T00:00:00Z"
NO_BOARD = {"project": 0, "projects": []}
PR = "https://github.com/acme/tracker/pull/"


def node(n, state="OPEN", closed=None, updated="2026-09-25T09:00:00Z", assignees=("alice",), prs=()):
    """An issue as GitHub's GraphQL returns it. prs: [(number, state, is_draft)]."""
    return {"number": n, "title": f"Issue {n}", "url": f"https://github.com/acme/tracker/issues/{n}",
            "state": state, "closedAt": closed, "updatedAt": updated,
            "assignees": {"nodes": [{"login": a} for a in assignees]}, "labels": {"nodes": [{"name": "bug"}]},
            "milestone": {"title": "Oct"}, "issueType": {"name": "Bug"},
            "closedByPullRequestsReferences": {"nodes": [{"url": PR + str(p), "state": st, "isDraft": d} for p, st, d in prs]}}


def ritem(n, state="OPEN", closed=None, updated="2026-09-25T09:00:00Z", assignees=("alice",), prs=None, repo="acme/tracker"):
    """The same issue as `repo_issues_page` hands it on. prs: {url: OPEN | DRAFT | MERGED | CLOSED}."""
    prs = prs or {}
    return {"content": {"type": "Issue", "number": n, "title": f"Issue {n}",
                        "url": f"https://github.com/{repo}/issues/{n}", "repository": repo},
            "status": None, "sprint": None, "assignees": list(assignees), "labels": ["bug"],
            "milestone": {"title": "Oct"}, "issue type": "Bug", "linked pull requests": list(prs),
            "pr states": dict(prs), "state": state, "closed_at": closed, "updated_at": updated, "derived": True}


def read(items, total=None):
    return {"items": items, "total": len(items) if total is None else total, "repos": ["acme/tracker"],
            "skipped": [], "missing": []}


class ConfigTest(unittest.TestCase):
    def test_boardless_needs_repos_and_no_board(self):
        self.assertFalse(config.boardless())  # the test config has a board
        with mock.patch.dict(config.CONFIG, NO_BOARD):
            self.assertTrue(config.boardless())
        with mock.patch.dict(config.CONFIG, {**NO_BOARD, "owner": "", "issueRepo": ""}):
            self.assertFalse(config.boardless())  # before Setup: nothing to read
        view = {"login": "bob-work", "owner": "globex", "ownerType": "organization", "issueRepo": "app",
                "repos": ["globex/app"], "projects": []}
        self.assertTrue(config.boardless(view))
        self.assertFalse(config.boardless(dict(view, projects=[{"owner": "globex", "number": 7}])))

    def test_sprintless_is_carried_only_when_set(self):
        ps = [{"owner": "acme", "ownerType": "organization", "number": 1, "title": "A"},
              {"owner": "acme", "ownerType": "organization", "number": 2, "title": "B", "sprintless": True, "sprintField": ""}]
        with mock.patch.dict(config.CONFIG, {"projects": ps}):
            self.assertNotIn("sprintless", config.projects()[0])
            self.assertTrue(config.sprintless("acme/2"))
            self.assertFalse(config.sprintless("acme/1"))
            self.assertFalse(config.sprintless(None))


class QueryTest(unittest.TestCase):
    def test_one_query_for_every_repo_and_closed_only_in_the_first_round(self):
        q, v = board.repo_issues_query([("r0", "acme/tracker", None, True), ("r1", "acme/api", None, True)], SINCE)
        self.assertEqual(q.count("repository("), 2)
        self.assertIn('r1: repository(owner: "acme", name: "api")', q)
        self.assertEqual(q.count("closed: issues(states: CLOSED"), 2)
        self.assertEqual(v, {"since": SINCE})
        self.assertNotIn("mutation", q)  # ghcache treats any GraphQL text with that word as a write
        q, v = board.repo_issues_query([("r0", "acme/tracker", "CUR", False)], SINCE)
        self.assertNotIn("closed:", q)
        self.assertNotIn("$since", q)  # declared but unused is a GraphQL error
        self.assertEqual(v, {"c_r0": "CUR"})

    def test_page_reads_issues_pr_states_cursor_and_count(self):
        data = {"r0": {"open": {"totalCount": 7, "pageInfo": {"hasNextPage": True, "endCursor": "C"},
                                "nodes": [node(1, prs=[(5, "OPEN", True), (6, "MERGED", False)]), None, {"title": "no number"}]},
                       "closed": {"nodes": [node(2, "CLOSED", closed="2026-09-20T08:00:00Z")]}}}
        items, cursor, count = board.repo_issues_page(data, "r0", "acme/tracker")
        self.assertEqual((cursor, count), ("C", 7))
        self.assertEqual([i["content"]["number"] for i in items], [1, 2])
        self.assertEqual(items[0], ritem(1, prs={PR + "5": "DRAFT", PR + "6": "MERGED"}))
        self.assertEqual((items[1]["state"], items[1]["closed_at"]), ("CLOSED", "2026-09-20T08:00:00Z"))
        self.assertEqual(board.repo_issues_page({"r0": None}, "r0", "acme/tracker"), ([], None, 0))

    def test_done_since_is_a_whole_day(self):
        self.assertEqual(board.done_since(TODAY), SINCE)


class DerivedStatusTest(unittest.TestCase):
    def test_derived_status_table(self):
        st = lambda **kw: board.derived_status(ritem(1, **kw))
        self.assertEqual(st(), "Todo")
        self.assertEqual(st(assignees=()), "Todo")  # nobody assigned: the same rules
        self.assertEqual(st(state="CLOSED", closed="2026-09-20T08:00:00Z", prs={PR + "5": "OPEN"}), "Done")
        self.assertEqual(st(prs={PR + "5": "OPEN"}), "PR Raised")
        self.assertEqual(st(prs={PR + "5": "MERGED", PR + "6": "OPEN"}), "PR Raised")  # merged + open: not done
        self.assertEqual(st(prs={PR + "5": "DRAFT"}), "In Dev")
        self.assertEqual(st(prs={PR + "5": "MERGED", PR + "6": "DRAFT"}), "In Dev")
        self.assertEqual(st(prs={PR + "5": "MERGED", PR + "6": "CLOSED"}), "Done")
        self.assertEqual(st(prs={PR + "5": "CLOSED"}), "Todo")  # closed without merging counts for nothing
        self.assertEqual(st(prs={PR + "5": None}), "Todo")  # a state GitHub did not give


class TrimTest(unittest.TestCase):
    ITEMS = [ritem(1, updated="2026-09-25T09:00:00Z"), ritem(2, updated="2026-09-25T10:00:00Z"),
             ritem(3, "CLOSED", closed="2026-09-20T08:00:00Z"), ritem(4, "CLOSED", closed="2026-09-10T23:59:59Z"),
             ritem(5, "CLOSED", closed="2026-09-24T08:00:00Z"), ritem(6, "CLOSED"), ritem(1)]

    def test_open_first_newest_first_then_recently_closed(self):
        items, shown = board.trim_repo_issues(self.ITEMS, SINCE)
        self.assertEqual([i["content"]["number"] for i in items], [2, 1, 5, 3])  # 4: too old; 6: no closing time
        self.assertEqual(shown, 2)

    def test_caps(self):
        with mock.patch.object(config, "DERIVED_MAX_CARDS", 1), mock.patch.object(config, "DERIVED_MAX_DONE", 1):
            items, shown = board.trim_repo_issues(self.ITEMS, SINCE)
        self.assertEqual(([i["content"]["number"] for i in items], shown), ([2, 5], 1))


class LiveRepoIssuesTest(unittest.TestCase):
    VIEW = {"login": "bob-work", "owner": "globex", "ownerType": "organization", "issueRepo": "app",
            "repos": ["globex/app", "globex/gone"], "projects": []}

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        p = mock.patch.dict(os.environ, {"MASTERDECK_HOME": self.home.name})
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self.home.cleanup)

    def test_one_call_for_every_repo_then_only_the_ones_with_more_pages(self):
        calls = []

        def fake_run(cmd, timeout=120, env=None, partial=False):
            calls.append((cmd, env, partial))
            if len(calls) == 1:
                return json.dumps({"data": {"r0": {"open": {"totalCount": 101, "pageInfo": {"hasNextPage": True, "endCursor": "C1"},
                                                                "nodes": [node(1)]},
                                                       "closed": {"nodes": [node(9, "CLOSED", closed="2026-09-24T10:00:00Z")]}},
                                            "r1": None}})
            return json.dumps({"data": {"r0": {"open": {"totalCount": 101, "pageInfo": {"hasNextPage": False}, "nodes": [node(2)]}}}})

        env = {"GH_TOKEN": "x", "GHC_ACCOUNT": "bob-work"}
        with mock.patch.object(collect, "_run", side_effect=fake_run):
            got = collect.Live(self.VIEW, env).repo_issues(TODAY)
        self.assertEqual(len(calls), 2)
        first, second = (" ".join(c[0]) for c in calls)
        self.assertIn("r0: repository(", first)
        self.assertIn("r1: repository(", first)
        self.assertIn(f"since={SINCE}", first)
        self.assertNotIn("r1: repository(", second)  # only the repo with another page
        self.assertNotIn("closed:", second)
        self.assertIn("c_r0=C1", second)
        self.assertTrue(all(c[1] == env and c[2] is True for c in calls))  # as the account, partial answers kept
        self.assertEqual([i["content"]["number"] for i in got["items"]], [1, 9, 2])
        self.assertEqual({i["content"]["repository"] for i in got["items"]}, {"globex/app"})
        self.assertEqual((got["total"], got["repos"], got["skipped"], got["missing"]),
                         (101, ["globex/app", "globex/gone"], [], ["globex/gone"]))

    def test_repos_past_the_limit_are_named_not_read(self):
        view = dict(self.VIEW, repos=[f"globex/r{i}" for i in range(12)], issueRepo="r0")
        seen = []

        def fake_run(cmd, timeout=120, env=None, partial=False):
            seen.append(" ".join(cmd))
            return json.dumps({"data": {f"r{i}": {"open": {"totalCount": 0, "pageInfo": {}, "nodes": []}, "closed": {"nodes": []}}
                                        for i in range(10)}})

        with mock.patch.object(collect, "_run", side_effect=fake_run):
            got = collect.Live(view, {}).repo_issues(TODAY)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].count("repository("), 10)
        self.assertEqual(got["skipped"], ["globex/r10", "globex/r11"])

    def _gone_runner(self, calls):
        def fake_run(cmd, timeout=120, env=None, partial=False):
            calls.append(" ".join(cmd))
            data = {"r0": {"open": {"totalCount": 0, "pageInfo": {}, "nodes": []}, "closed": {"nodes": []}}}
            if "r1: repository(" in calls[-1]:
                data["r1"] = None
            return json.dumps({"data": data})
        return fake_run

    def test_a_missing_repo_is_left_out_of_the_query_for_an_hour(self):
        calls = []
        env = {"GH_TOKEN": "x"}
        with mock.patch.object(collect, "_run", side_effect=self._gone_runner(calls)), \
                mock.patch.object(collect.time, "time", return_value=1000.0):
            first = collect.Live(self.VIEW, env).repo_issues(TODAY)
        self.assertIn("r1: repository(", calls[0])
        self.assertEqual(first["missing"], ["globex/gone"])
        self.assertTrue((Path(self.home.name) / "missing-repos.json").exists())
        with mock.patch.object(collect, "_run", side_effect=self._gone_runner(calls)), \
                mock.patch.object(collect.time, "time", return_value=1000.0 + 3599):
            second = collect.Live(self.VIEW, env).repo_issues(TODAY)
        self.assertNotIn("globex/gone", calls[1])
        self.assertEqual(calls[1].count("repository("), 1)
        self.assertEqual((second["missing"], second["repos"]), (["globex/gone"], ["globex/app", "globex/gone"]))
        with mock.patch.object(collect, "_run", side_effect=self._gone_runner(calls)), \
                mock.patch.object(collect.time, "time", return_value=1000.0 + 3601):
            collect.Live(self.VIEW, env).repo_issues(TODAY)
        self.assertEqual(calls[2].count("repository("), 2)  # an hour later: tried again

    def test_when_every_repo_is_remembered_missing_nothing_is_sent(self):
        (Path(self.home.name) / "missing-repos.json").write_text(json.dumps({"bob-work": {"globex/app": 1000, "globex/gone": 1000}}))
        with mock.patch.object(collect, "_run", side_effect=AssertionError("no call")), \
                mock.patch.object(collect.time, "time", return_value=1001.0):
            got = collect.Live(self.VIEW, {}).repo_issues(TODAY)
        self.assertEqual((got["items"], got["missing"]), ([], ["globex/app", "globex/gone"]))

    def test_the_only_repo_gone_is_missing_not_an_error(self):
        view = dict(self.VIEW, repos=["globex/gone"], issueRepo="gone")
        gone = json.dumps({"data": {"r0": None}, "errors": [{"type": "NOT_FOUND"}]})
        with mock.patch.object(collect, "_run", return_value=gone):
            got = collect.Live(view, {}).repo_issues(TODAY)
        self.assertEqual((got["items"], got["missing"]), ([], ["globex/gone"]))

    def test_an_account_gh_has_no_token_for_fails_with_the_reason(self):
        with self.assertRaisesRegex(RuntimeError, "not logged in to bob-work"):
            collect.Live(self.VIEW, None, "gh is not logged in to bob-work").repo_issues(TODAY)


class RunPartialTest(unittest.TestCase):
    def test_a_partial_graphql_answer_is_data_not_an_error(self):
        from master import ghcache
        some = json.dumps({"data": {"r0": {"open": {}}, "r1": None}, "errors": [{"type": "NOT_FOUND"}]}).encode()
        none = json.dumps({"data": None, "errors": [{"type": "RATE_LIMITED"}]}).encode()
        with mock.patch.dict(os.environ, {"MASTER_NO_GH_CACHE": ""}):
            with mock.patch.object(ghcache, "run", return_value=(1, some, b"gh: Could not resolve to a Repository")):
                self.assertIsNone(json.loads(collect._run(["gh", "api", "graphql"], partial=True))["data"]["r1"])
                with self.assertRaisesRegex(RuntimeError, "Could not resolve"):
                    collect._run(["gh", "api", "graphql"])  # every other read keeps failing on exit 1
            allgone = json.dumps({"data": {"r0": None}, "errors": [{"type": "NOT_FOUND"}]}).encode()
            with mock.patch.object(ghcache, "run", return_value=(1, allgone, b"gh: Could not resolve to a Repository")):
                self.assertIsNone(json.loads(collect._run(["gh", "api", "graphql"], partial=True))["data"]["r0"])
            with mock.patch.object(ghcache, "run", return_value=(1, none, b"gh: API rate limit exceeded")):
                with self.assertRaisesRegex(RuntimeError, "rate limit"):
                    collect._run(["gh", "api", "graphql"], partial=True)  # no data at all is still an error


class BoardCommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fx = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_board(self, got, prs=None, cfg=NO_BOARD):
        (self.fx / "repo_issues.json").write_text(json.dumps(got))
        (self.fx / "board_sprint.json").write_text("[]")
        (self.fx / "board_prs.json").write_text(json.dumps(prs or {}))
        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, cfg), redirect_stdout(buf):
            code = cli.main(["board", "--fixtures", str(self.fx), "--now", NOW])
        return code, json.loads(buf.getvalue())

    def test_cards_come_from_the_repos_with_facts_and_no_status(self):
        got = read([ritem(1, updated="2026-09-25T09:30:00Z"), ritem(2, prs={PR + "5": "OPEN"}, updated="2026-09-25T08:00:00Z"),
                    ritem(3, "CLOSED", closed="2026-09-20T08:00:00Z", prs={PR + "4": "MERGED"}),
                    ritem(4, "CLOSED", closed="2026-09-01T08:00:00Z")], total=2)
        code, b = self.run_board(got, {PR + "5": {"state": "OPEN", "ci": "success", "unresolved": 1}})
        self.assertEqual(code, 0)
        self.assertEqual([c["number"] for c in b["cards"]], [1, 2, 3])
        self.assertTrue(all(c["derived"] is True and c["status"] is None and c["project"] is None for c in b["cards"]))
        self.assertEqual([(c["state"], c["closedAt"]) for c in b["cards"]],
                         [("OPEN", None), ("OPEN", None), ("CLOSED", "2026-09-20T08:00:00Z")])
        self.assertEqual(b["cards"][1]["prs"], [{"url": PR + "5", "owner": "acme", "repo": "tracker", "number": 5,
                                                 "state": "OPEN", "ci": "success", "unresolved": 1}])
        self.assertEqual(b["cards"][2]["prs"][0]["state"], "MERGED")  # known from the issue read itself
        self.assertEqual(b["cards"][0]["assignees"], ["alice"])
        self.assertEqual(b["derived"], [{"repos": ["acme/tracker"], "total": 2, "shown": 2, "skipped": [],
                                         "missing": [], "account": None}])
        self.assertNotIn("account", b["cards"][0])  # one account: cards are not tagged, as before

    def test_a_failing_pr_read_keeps_the_cards(self):
        with mock.patch.object(collect.Fixtures, "pr_details", side_effect=RuntimeError("boom")):
            code, b = self.run_board(read([ritem(2, prs={PR + "5": "DRAFT"})]))
        self.assertEqual((code, b["cards"][0]["prs"][0]["state"], b["cards"][0]["prs"][0]["ci"]), (0, "DRAFT", None))

    def test_no_pr_read_without_an_open_pr(self):
        with mock.patch.object(collect.Fixtures, "pr_details", side_effect=AssertionError("no PR is open: no read")):
            code, _b = self.run_board(read([ritem(1), ritem(3, "CLOSED", closed="2026-09-20T08:00:00Z", prs={PR + "4": "MERGED"})]))
        self.assertEqual(code, 0)

    def test_mine_keeps_only_issues_assigned_to_the_account(self):
        fx = self.fx
        (fx / "me.txt").write_text("alice")
        (fx / "repo_issues.json").write_text(json.dumps(read([ritem(1), ritem(2, assignees=("carol",)), ritem(3, assignees=())])))
        (fx / "board_prs.json").write_text("{}")
        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, NO_BOARD), redirect_stdout(buf):
            cli.main(["board", "--fixtures", str(fx), "--now", NOW, "--mine"])
        self.assertEqual([c["number"] for c in json.loads(buf.getvalue())["cards"]], [1])

    def test_a_failing_pr_read_is_noted_not_hidden(self):
        with mock.patch.object(collect.Fixtures, "pr_details", side_effect=RuntimeError("HTTP 401: Bad credentials")):
            _code, b = self.run_board(read([ritem(2, prs={PR + "5": "DRAFT"})]))
        self.assertEqual(len(b["cards"]), 1)
        self.assertEqual(b["notes"], ["Pull request details not read: HTTP 401: Bad credentials"])

    def test_a_config_with_a_board_never_reads_repo_issues(self):
        with mock.patch.object(collect.Fixtures, "repo_issues", side_effect=AssertionError("it has a board")):
            code, b = self.run_board(read([ritem(1)]), cfg={})
        self.assertEqual((code, b["cards"]), (0, []))
        self.assertNotIn("derived", b)

    def test_a_failed_read_is_the_command_failing_as_before(self):
        (self.fx / "board_prs.json").write_text("{}")
        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, NO_BOARD), redirect_stdout(buf), \
                mock.patch.object(collect.Fixtures, "repo_issues", side_effect=RuntimeError("HTTP 401: Bad credentials")):
            code = cli.main(["board", "--fixtures", str(self.fx), "--now", NOW])
        self.assertEqual((code, buf.getvalue().strip()), (1, "HTTP 401: Bad credentials"))


class MixedAccountsTest(unittest.TestCase):
    def test_one_account_with_a_board_one_without(self):
        from tests.helpers import board_item
        from tests.test_accounts import A, B

        class Boarded:
            def board_sprint(self, q):
                return [dict(board_item(939, "In Dev", "2026-09-21"), project="acme/1")]

            def pr_details(self, urls):
                return {}

        class Loose:
            def __init__(self, view):
                self.cfg = view

            def repo_issues(self, today):
                return {"items": [ritem(3, repo="globex/app")], "total": 1, "repos": ["globex/app"], "skipped": [], "missing": []}

            def pr_details(self, urls):
                raise AssertionError("no open PR: no PR read")

        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, {"accounts": [A, dict(B, projects=[])]}), \
                mock.patch.object(collect.Live, "for_account",
                                  side_effect=lambda v, runner=None: Boarded() if v["login"] == "alice" else Loose(v)), \
                redirect_stdout(buf):
            self.assertEqual(cli.main(["board"]), 0)
        b = json.loads(buf.getvalue())
        self.assertEqual([(c["number"], c["account"], c.get("derived")) for c in b["cards"]],
                         [(939, "alice", None), (3, "bob-work", True)])
        self.assertEqual([d["account"] for d in b["derived"]], ["bob-work"])


class SprintlessBoardTest(unittest.TestCase):
    def test_the_sprint_part_is_dropped(self):
        self.assertEqual(board.sprintless_query("is:issue assignee:@me sprint:@current"), "is:issue assignee:@me")
        self.assertEqual(board.sprintless_query('is:issue sprint:"Sprint 6"'), "is:issue")
        self.assertEqual(board.sprintless_query("is:issue no:sprint"), "is:issue")

    def test_only_marked_boards_get_it(self):
        ps = [{"owner": "acme", "ownerType": "organization", "number": 1, "title": "A"},
              {"owner": "acme", "ownerType": "organization", "number": 2, "title": "B", "sprintless": True, "sprintField": ""}]
        seen = {}

        def items(reqs):
            seen.update({alias: flt for alias, _p, flt in reqs})
            return {alias: [] for alias, _p, _f in reqs}

        with mock.patch.dict(config.CONFIG, {"projects": ps}), mock.patch.object(collect.Live, "project_items", side_effect=items):
            collect.Live().board_sprint("is:issue sprint:@current")
        self.assertEqual(seen, {"b0": "is:issue sprint:@current", "b1": "is:issue"})


if __name__ == "__main__":
    unittest.main()

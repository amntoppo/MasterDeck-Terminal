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


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fx = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def run_cmd(self, repos, got, prs=None, cfg=TWO_REPOS):
        (self.fx / "repo_issues.json").write_text(json.dumps(got))
        (self.fx / "board_prs.json").write_text(json.dumps(prs or {}))
        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, cfg), redirect_stdout(buf):
            code = cli.main(["repo-issues", "--repos", repos, "--fixtures", str(self.fx), "--now", NOW])
        return code, buf.getvalue()

    def read(self, items, **more):
        return {"items": items, "total": len(items), "totals": {}, "repos": [], "skipped": [], "missing": [], "unread": {}, **more}

    def test_every_issue_of_the_asked_repositories_board_or_not(self):
        held = [{"key": "acme/1", "status": "In QA"}]
        got = self.read([ritem(1, held=held), ritem(2, prs={PR + "5": "OPEN"}), ritem(3, repo="acme/api"),
                         ritem(4, state="CLOSED", closed="2026-09-20T08:00:00Z"), ritem(5, state="CLOSED", closed="2026-09-01T08:00:00Z")],
                        totals={"acme/tracker": 40, "acme/api": 1})
        code, out = self.run_cmd("acme/tracker,ACME/api", got,
                                 prs={PR + "5": {"state": "OPEN", "ci": "success", "unresolved": 2}})
        self.assertEqual(code, 0)
        b = json.loads(out)
        self.assertEqual(b["taken_at"], NOW)
        self.assertEqual([(c["number"], c["repo"]) for c in b["cards"]],
                         [(1, "acme/tracker"), (2, "acme/tracker"), (4, "acme/tracker"), (3, "acme/api")])  # #5 closed too long ago
        one, two, done = b["cards"][0], b["cards"][1], b["cards"][2]
        self.assertEqual((one["derived"], one["status"], one["project"], one["state"], one["onBoards"]), (True, None, None, "OPEN", held))
        self.assertNotIn("onBoards", two)
        self.assertEqual(two["prs"][0], {"url": PR + "5", "owner": "acme", "repo": "tracker", "number": 5,
                                         "state": "OPEN", "ci": "success", "unresolved": 2})
        self.assertEqual((done["state"], done["closedAt"]), ("CLOSED", "2026-09-20T08:00:00Z"))
        self.assertEqual(b["repos"], [{"repo": "acme/tracker", "account": None, "ok": True, "shown": 2, "total": 40},
                                      {"repo": "acme/api", "account": None, "ok": True, "shown": 1, "total": 1}])

    def test_a_repository_not_selected_in_setup_is_refused_not_read(self):
        code, out = self.run_cmd("acme/tracker,acme/secret,acme/tracker", self.read([ritem(1), ritem(9, repo="acme/secret")]))
        b = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual([c["number"] for c in b["cards"]], [1])
        self.assertEqual([(p["repo"], p["ok"], p.get("note")) for p in b["repos"]],
                         [("acme/tracker", True, None), ("acme/secret", False, "acme/secret is not selected in Setup")])

    def test_missing_unread_and_skipped_repositories_say_why(self):
        got = self.read([ritem(1)], missing=["acme/api", "acme/web"], unread={"acme/web": "RATE_LIMITED"}, skipped=["acme/ten"])
        cfg = {"repos": ["acme/tracker", "acme/api", "acme/web", "acme/ten"], "projects": BOARDS}
        _, out = self.run_cmd("acme/tracker,acme/api,acme/web,acme/ten", got, cfg=cfg)
        self.assertEqual([(p["repo"], p["ok"], p.get("note")) for p in json.loads(out)["repos"]],
                         [("acme/tracker", True, None), ("acme/api", False, "Not found: acme/api"),
                          ("acme/web", False, "acme/web not read: RATE_LIMITED"),
                          ("acme/ten", False, "acme/ten not read: more than 10 repositories at once")])

    def test_what_the_read_could_not_do_is_a_note_on_the_parts_that_show(self):
        (self.fx / "repo_issues.json").write_text(json.dumps(self.read([ritem(1, prs={PR + "5": "OPEN"})], boards_unread="INSUFFICIENT_SCOPES")))
        buf = io.StringIO()  # no board_prs.json: the PR read fails
        with mock.patch.dict(config.CONFIG, TWO_REPOS), redirect_stdout(buf):
            self.assertEqual(cli.main(["repo-issues", "--repos", "acme/tracker", "--fixtures", str(self.fx), "--now", NOW]), 0)
        b = json.loads(buf.getvalue())
        self.assertEqual(b["cards"][0]["prs"][0]["state"], "OPEN")  # the state came with the issue
        note = b["repos"][0]["note"]
        self.assertTrue(note.startswith("Pull request details not read: "), note)
        self.assertTrue(note.endswith("; Board columns not read: INSUFFICIENT_SCOPES"), note)

    def test_bad_arguments_are_refused(self):
        for repos in ("", " , ", "tracker", "acme/tracker,not a repo"):
            code, out = self.run_cmd(repos, self.read([]))
            self.assertEqual((code, out.strip()), (2, "--repos takes owner/name, comma separated"), repos)

    def test_it_is_a_read_no_guard_and_no_ledger(self):
        args = cli.parser().parse_args(["repo-issues", "--repos", "acme/tracker"])
        self.assertFalse(cli._is_write(args))
        self.assertNotIn("repo-issues", cli.WRITE_CMDS)


class AccountsTest(unittest.TestCase):
    def run_cmd(self, repos, sources):
        from tests.test_accounts import A, B
        asked = []

        def for_account(view, runner=None):
            asked.append(view["login"])
            return sources[view["login"]]

        buf = io.StringIO()
        with mock.patch.dict(config.CONFIG, {"accounts": [A, B]}), \
                mock.patch.object(collect.Live, "for_account", side_effect=for_account), redirect_stdout(buf):
            code = cli.main(["repo-issues", "--repos", repos, "--now", NOW])
        return code, json.loads(buf.getvalue()), asked

    def source(self, items, seen, fail=None):
        class Src:
            def repo_issues(self, today, only=None, boards=False):
                seen.append((list(only), boards))
                if fail:
                    raise RuntimeError(fail)
                return {"items": [it for it in items if it["content"]["repository"] in only], "total": 0, "totals": {},
                        "repos": list(only), "skipped": [], "missing": [], "unread": {}}

            def pr_details(self, urls):
                return {}
        return Src()

    def test_each_repository_is_read_as_its_own_account(self):
        a_seen, b_seen = [], []
        code, b, asked = self.run_cmd("globex/app,acme/api,acme/tracker",
                                      {"alice": self.source([ritem(1), ritem(2, repo="acme/api")], a_seen),
                                       "bob-work": self.source([ritem(3, repo="globex/app")], b_seen)})
        self.assertEqual(code, 0)
        self.assertEqual(sorted(asked), ["alice", "bob-work"])
        self.assertEqual((a_seen, b_seen), ([(["acme/api", "acme/tracker"], True)], [(["globex/app"], True)]))
        self.assertEqual(sorted((c["number"], c["account"]) for c in b["cards"]), [(1, "alice"), (2, "alice"), (3, "bob-work")])
        self.assertEqual([(p["repo"], p["account"], p["ok"]) for p in b["repos"]],
                         [("globex/app", "bob-work", True), ("acme/api", "alice", True), ("acme/tracker", "alice", True)])

    def test_only_the_accounts_asked_about_are_read(self):
        seen = []
        _, _, asked = self.run_cmd("globex/app", {"bob-work": self.source([], seen)})
        self.assertEqual(asked, ["bob-work"])  # alice's token is never fetched

    def test_one_accounts_failure_leaves_the_other_showing(self):
        code, b, _ = self.run_cmd("acme/tracker,globex/app",
                                  {"alice": self.source([ritem(1)], []),
                                   "bob-work": self.source([], [], fail="gh: API rate limit exceeded for user ID 1")})
        self.assertEqual(code, 0)
        self.assertEqual([c["number"] for c in b["cards"]], [1])
        self.assertEqual([(p["repo"], p["ok"], p.get("note")) for p in b["repos"]],
                         [("acme/tracker", True, None),
                          ("globex/app", False, "globex/app not read: gh: API rate limit exceeded for user ID 1")])


class MasterUnchangedTest(unittest.TestCase):
    """The repository view is the Board's: master's snapshot and proposals never see it."""

    def test_an_account_with_a_board_still_reads_only_its_board(self):
        from tests.test_snapshot import FakeSource

        class Never(FakeSource):
            def repo_issues(self, today, only=None, boards=False):
                raise AssertionError("master never reads repository issues for an account with a board")

        s = snapshot.build(Never(), now_iso=NOW, today=TODAY)
        self.assertEqual([i["number"] for i in s["issues"]], [939])

    def test_a_session_on_an_issue_no_board_holds_gets_no_proposal(self):
        from tests.test_rules import sess, snap
        # Started from the repository view: linked to #77, which the snapshot (the board) does not list.
        cur = snap(issues=[], sessions=[sess("off-board", 77, status="dead"), sess("idle-one", 78)])
        self.assertEqual(rules.propose(None, cur, NOW), [])

    def test_master_board_cards_never_carry_on_boards(self):
        from tests.helpers import board_item
        items = [dict(board_item(939, "In Dev", "2026-09-21"), project="acme/1")]
        self.assertTrue(all("onBoards" not in c and "derived" not in c for c in board.build(items, {}, NOW)["cards"]))

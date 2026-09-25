from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from master import board, cli, config

NOW = "2026-09-25T10:00:00Z"
EXPO = "https://github.com/acme/mobile-app/pull/"
BACK = "https://github.com/acme/api-server/pull/"


def item(n, status, prs=(), typ="Issue"):
    it = {"assignees": ["alice"],
          "content": {"number": n, "title": f"Issue {n}", "type": typ,
                      "url": f"https://github.com/acme/tracker/issues/{n}", "repository": "acme/tracker"},
          "sprint": {"title": "Sprint 6", "startDate": "2026-09-21", "duration": 14},
          "title": f"Issue {n}"}
    if status is not None:
        it["status"] = status
    if prs:
        it["linked pull requests"] = list(prs)
    return it


def pr_node(number, url, state="OPEN", draft=False, ci=None, threads=()):
    return {"number": number, "url": url, "state": state, "isDraft": draft, "merged": state == "MERGED",
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": ci} if ci else None}}]},
            "reviewThreads": {"nodes": [{"isResolved": r} for r in threads]}}


class PrQueryTest(unittest.TestCase):
    def test_groups_prs_by_repo(self):
        q, keys = board.pr_query([EXPO + "137", EXPO + "46", BACK + "605"])
        self.assertEqual(q.count("repository("), 2)
        self.assertEqual(sorted(keys.values()), sorted([EXPO + "137", EXPO + "46", BACK + "605"]))
        self.assertIn("pullRequest(number: 137)", q)

    def test_ignores_non_pr_urls(self):
        q, keys = board.pr_query(["https://example.com/x", "not a url"])
        self.assertEqual(keys, {})

    def test_parse_maps_state_ci_and_threads(self):
        q, keys = board.pr_query([EXPO + "1", EXPO + "2", EXPO + "3", BACK + "4", BACK + "5"])
        by_url = {v: k for k, v in keys.items()}

        def put(data, url, node):
            r, p = by_url[url]
            data.setdefault(r, {})[p] = node

        data: dict = {}
        put(data, EXPO + "1", pr_node(1, EXPO + "1", ci="SUCCESS", threads=(False, True, False)))
        put(data, EXPO + "2", pr_node(2, EXPO + "2", draft=True, ci="PENDING"))
        put(data, EXPO + "3", pr_node(3, EXPO + "3", state="MERGED", ci="FAILURE"))
        put(data, BACK + "4", pr_node(4, BACK + "4", state="CLOSED"))
        put(data, BACK + "5", None)  # deleted or no access
        got = board.parse_pr_details(data, keys)
        self.assertEqual(got[EXPO + "1"], {"state": "OPEN", "ci": "success", "unresolved": 2})
        self.assertEqual(got[EXPO + "2"], {"state": "DRAFT", "ci": "pending", "unresolved": 0})
        self.assertEqual(got[EXPO + "3"], {"state": "MERGED", "ci": "failure", "unresolved": 0})
        self.assertEqual(got[BACK + "4"]["state"], "CLOSED")
        self.assertNotIn(BACK + "5", got)


class BuildTest(unittest.TestCase):
    def test_cards_columns_and_prs(self):
        items = [item(1036, "In Dev", [EXPO + "137"]), item(967, "Dev Done"), item(5, "Weird New Status"),
                 item(6, None), item(7, "In Dev", typ="PullRequest")]
        details = {EXPO + "137": {"state": "OPEN", "ci": "success", "unresolved": 1}}
        b = board.build(items, details, NOW)
        self.assertEqual(b["taken_at"], NOW)
        self.assertEqual(b["sprint"], "Sprint 6")
        self.assertEqual([c["number"] for c in b["cards"]], [1036, 967, 5, 6])
        self.assertEqual(b["columns"][:5], config.BOARD_COLUMNS[:5])
        self.assertEqual(b["columns"][-1], "Weird New Status")
        c = b["cards"][0]
        self.assertEqual(c["prs"], [{"url": EXPO + "137", "repo": "mobile-app", "number": 137,
                                     "state": "OPEN", "ci": "success", "unresolved": 1}])
        self.assertIsNone(b["cards"][3]["status"])

    def test_unresolved_pr_is_kept_with_null_state(self):
        b = board.build([item(1, "In Dev", [BACK + "9"])], {}, NOW)
        self.assertEqual(b["cards"][0]["prs"][0], {"url": BACK + "9", "repo": "api-server", "number": 9,
                                                   "state": None, "ci": None, "unresolved": 0})


class BoardCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._env = os.environ.get("MASTER_HOME")
        os.environ["MASTER_HOME"] = str(Path(self.tmp.name) / "home")
        self.fx = Path(self.tmp.name) / "fx"
        self.fx.mkdir()
        (self.fx / "board_sprint.json").write_text(json.dumps([item(1036, "In Dev", [EXPO + "137"])]))
        (self.fx / "board_prs.json").write_text(json.dumps({EXPO + "137": {"state": "MERGED", "ci": None, "unresolved": 0}}))

    def tearDown(self):
        if self._env is None:
            os.environ.pop("MASTER_HOME", None)
        else:
            os.environ["MASTER_HOME"] = self._env
        self.tmp.cleanup()

    def test_prints_board_json(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(["board", "--fixtures", str(self.fx), "--now", NOW])
        self.assertEqual(code, 0)
        got = json.loads(buf.getvalue())
        self.assertEqual(got["cards"][0]["prs"][0]["state"], "MERGED")

    def test_is_a_read_command(self):
        self.assertFalse(cli._is_write(cli.parser().parse_args(["board"])))


if __name__ == "__main__":
    unittest.main()


class SprintAndFieldsTest(unittest.TestCase):
    def test_sprint_query(self):
        self.assertEqual(board.sprint_query("@current", mine=True), "is:issue assignee:@me sprint:@current")
        self.assertEqual(board.sprint_query("@current", mine=False), "is:issue sprint:@current")
        self.assertEqual(board.sprint_query("Sprint 5", mine=False), 'is:issue sprint:"Sprint 5"')
        self.assertEqual(board.sprint_query("none", mine=False), "is:issue no:sprint")
        with self.assertRaises(ValueError):
            board.sprint_query('bad"quote', mine=False)

    def test_cards_carry_assignees_labels_milestone_type(self):
        it = item(5, "In Dev")
        it["assignees"] = ["erin", "alice"]
        it["labels"] = ["bug", {"name": "mobile"}]
        it["milestone"] = {"title": "Oct release"}
        it["issue type"] = "Bug"
        c = board.build([it], {}, NOW)["cards"][0]
        self.assertEqual(c["assignees"], ["erin", "alice"])
        self.assertEqual(c["labels"], ["bug", "mobile"])
        self.assertEqual(c["milestone"], "Oct release")
        self.assertEqual(c["type"], "Bug")
        bare = board.build([item(6, "In Dev")], {}, NOW)["cards"][0]
        self.assertEqual((bare["labels"], bare["milestone"], bare["type"]), ([], None, None))

    def test_parse_sprints(self):
        data = {"organization": {"projectV2": {"field": {"configuration": {
            "iterations": [{"id": "b", "title": "Sprint 6", "startDate": "2026-09-21", "duration": 14},
                           {"id": "c", "title": "Sprint 7", "startDate": "2026-10-05", "duration": 14}],
            "completedIterations": [{"id": "a", "title": "Sprint 5", "startDate": "2026-09-07", "duration": 14}]}}}}}
        got = board.parse_sprints(data)
        self.assertEqual([s["title"] for s in got], ["Sprint 7", "Sprint 6", "Sprint 5"])
        self.assertEqual([s["completed"] for s in got], [False, False, True])
        self.assertEqual(board.parse_sprints({}), [])


class DraftAssignDirectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._env = {k: os.environ.get(k) for k in ("MASTER_HOME", "MASTER_WORKSPACE")}
        os.environ["MASTER_HOME"] = str(Path(self.tmp.name) / "home")
        os.environ["MASTER_WORKSPACE"] = "/ws"

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_title_and_url_skip_the_snapshot(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(["draft-assign", "4242", "--title", "Brand new", "--url",
                             "https://github.com/acme/tracker/issues/4242"])
        self.assertEqual(code, 0)
        got = json.loads(buf.getvalue())
        self.assertEqual(got["name"], "4242-brand-new")
        self.assertIn("acme/tracker#4242 (Brand new)", got["prompt"])

"""Several repositories and project boards: tickets are (repo, number); the primary repo keeps bare
numbers so older records and readers still work."""
import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from master import board, config, join, ledger, normalize, refs, rules, setup

# acme/tracker (primary, from tests/config.json) plus acme/api; a second board with other statuses.
BOARD2 = {"owner": "acme", "ownerType": "organization", "number": 2, "id": "PVT_2", "title": "Platform",
          "statusField": "Stage", "statusFieldId": "F2", "statusOptions": {"Backlog": "o1", "Doing": "o2", "Shipped": "o3"},
          "columns": ["Backlog", "Doing", "Shipped"], "sprintField": "",
          "statuses": {"ready": "Backlog", "inProgress": "Doing", "prRaised": "Doing", "devDone": "Shipped",
                       "blocked": [], "done": ["Shipped"], "finished": ["Shipped"], "assignable": ["Backlog"],
                       "resumable": ["Doing"]}}
MULTI = {"repos": ["acme/tracker", "acme/api"],
         "projects": [{"owner": "acme", "ownerType": "organization", "number": 1, "title": "Delivery",
                       "columns": config.CONFIG["columns"], "statuses": config.CONFIG["statuses"], "sprintField": "Sprint"}, BOARD2]}
TODAY = date(2026, 9, 25)


def item(n, status, repo="acme/tracker", project="acme/1", assignees=None):
    return {"content": {"type": "Issue", "number": n, "title": f"Issue {n}", "url": f"https://github.com/{repo}/issues/{n}",
                        "repository": repo},
            "status": status, "sprint": {"title": "Sprint 6", "startDate": "2026-09-21", "duration": 14},
            "assignees": assignees or [], "project": project}


class MultiTest(unittest.TestCase):
    def setUp(self):
        self.p = mock.patch.dict(config.CONFIG, MULTI)
        self.p.start()

    def tearDown(self):
        self.p.stop()

    def test_refs(self):
        self.assertEqual(refs.parse("12"), (None, 12))
        self.assertEqual(refs.parse("api#12"), ("acme/api", 12))
        self.assertEqual(refs.parse("acme/tracker#12"), (None, 12))
        self.assertEqual(refs.parse("other/x#3"), ("other/x", 3))
        self.assertEqual((refs.label(None, 12), refs.label("acme/api", 12)), ("#12", "api#12"))
        self.assertEqual(refs.ref("acme/api", 12), "acme/api#12")
        with self.assertRaises(ValueError):
            refs.parse("api")

    def test_config_lists_repos_and_boards(self):
        self.assertEqual(config.repos(), ["acme/tracker", "acme/api"])
        self.assertEqual([config.project_key(p) for p in config.projects()], ["acme/1", "acme/2"])
        self.assertEqual(config.statuses_for("acme/2")["ready"], "Backlog")
        self.assertTrue(config.repo_allowed("ACME/API"))
        self.assertFalse(config.repo_allowed("acme/secret"))
        with mock.patch.dict(config.CONFIG, {"allRepos": True}):
            self.assertTrue(config.repo_allowed("acme/secret"))

    def test_same_number_in_two_repos_is_two_issues(self):
        out = normalize.issues([item(5, "In Dev"), item(5, "Doing", "acme/api", "acme/2")], [], TODAY)
        self.assertEqual([(i["repo"], i["number"]) for i in out], [(None, 5), ("acme/api", 5)])

    def test_each_board_decides_done_and_ready(self):
        mine = [item(1, "Shipped", "acme/api", "acme/2"), item(2, "Doing", "acme/api", "acme/2")]
        ready = [item(3, "Backlog", "acme/api", "acme/2"), item(4, "Ready For Dev")]
        out = normalize.issues(mine, ready, TODAY)
        self.assertEqual([(i["repo"], i["number"]) for i in out], [(None, 4), ("acme/api", 2), ("acme/api", 3)])

    def test_unselected_repos_are_left_out(self):
        out = normalize.issues([item(7, "In Dev", "acme/secret")], [], TODAY)
        self.assertEqual(out, [])
        b = board.build([item(7, "In Dev", "acme/secret"), item(8, "Doing", "acme/api", "acme/2")], {}, "t")
        self.assertEqual([(c["repo"], c["number"], c["project"]) for c in b["cards"]], [("acme/api", 8, "acme/2")])
        self.assertIn("Backlog", b["columns"])
        self.assertEqual([p["key"] for p in b["projects"]], ["acme/1", "acme/2"])

    def test_pr_body_refs_across_repos(self):
        self.assertEqual(normalize.issue_ref_in("Refs acme/api#9", "acme/web"), ("acme/api", 9))
        self.assertEqual(normalize.issue_ref_in("Refs acme/tracker#9", "acme/web"), (None, 9))
        self.assertIsNone(normalize.issue_ref_in("Refs acme/secret#9", "acme/web"))
        self.assertEqual(normalize.issue_ref_in("Closes #4", "acme/api"), ("acme/api", 4))
        self.assertIsNone(normalize.issue_ref_in("Closes #4", "acme/web"))

    def test_sessions_own_issues_by_repo_and_number(self):
        state = {"sessions": {"s1": {"issue": 5, "repo": "acme/api"}, "s2": {"issue": 5}}}
        agents = [{"sessionId": "s1", "name": "a", "kind": "interactive", "status": "idle"},
                  {"sessionId": "s2", "name": "b", "kind": "interactive", "status": "idle"}]
        sess = join.sessions(agents, state, "master-agent", lambda _: None)
        self.assertEqual(join.owner_of(sess, 5, "acme/api")["name"], "a")
        self.assertEqual(join.owner_of(sess, 5)["name"], "b")
        self.assertEqual(join.owner_of(sess, 5, "acme/tracker")["name"], "b")

    def test_ledger_keeps_bare_numbers_for_the_primary_repo(self):
        led = ledger.empty()
        a = ledger.add(led, kind="ASSIGN", issue=5, source="s", target={}, message="m", summary="x", now="t")
        b = ledger.add(led, kind="ASSIGN", issue=5, repo="acme/api", source="s", target={}, message="m", summary="x", now="t")
        self.assertNotIn("repo", a)
        self.assertEqual(b["repo"], "acme/api")
        self.assertIsNone(ledger.add(led, kind="ASSIGN", issue=5, repo="acme/api", source="s", target={}, message="m", summary="x", now="t"))

    def test_assign_for_another_repo(self):
        a = rules._assign({"number": 5, "repo": "acme/api", "title": "Fix login", "url": "https://github.com/acme/api/issues/5"})
        self.assertEqual((a["issue"], a["repo"], a["source"]), (5, "acme/api", "issue:acme/api#5"))
        self.assertEqual(a["target"]["spawn"]["name"], "api-5-fix-login")
        self.assertIn("You own acme/api#5 (Fix login)", a["message"])
        self.assertIn("links this session to acme/api#5", a["message"])
        self.assertIn("'api#5: done'", a["message"])
        prim = rules._assign({"number": 5, "title": "Fix login", "url": "u"})
        self.assertEqual((prim["repo"], prim["source"], prim["target"]["spawn"]["name"]), (None, "issue:5", "5-fix-login"))
        self.assertIn("'#5: done'", prim["message"])


class SaveTest(unittest.TestCase):
    def test_save_mirrors_the_first_repo_and_board(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "config.json"
            cfg = setup.save({"owner": "", "issueRepo": "", "repos": ["acme/api", "acme/web"], "projects": [BOARD2]}, path)
            self.assertEqual((cfg["owner"], cfg["issueRepo"], cfg["project"], cfg["columns"]), ("acme", "api", 2, BOARD2["columns"]))
            with self.assertRaises(ValueError):
                setup.save({"repos": ["not a repo"]}, path)

    def test_shell_for_one_board(self):
        with mock.patch.dict(config.CONFIG, MULTI):
            out = setup.shell(dict(config.CONFIG, **MULTI), "acme/2")
        self.assertIn("PROJECT_NUMBER=2", out)
        self.assertIn("ST_READY=Backlog", out)
        self.assertIn("Doing) echo o2", out)
        self.assertIn('REPOS_JSON=\'["acme/tracker", "acme/api"]\'', out)


if __name__ == "__main__":
    unittest.main()

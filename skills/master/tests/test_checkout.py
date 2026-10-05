"""Where a ticket's session starts: the checkout of the ticket's repository under its account's
workspace, else that workspace. Checkouts here are `git init` + `git remote add origin` in a temp
folder: no network, and git reads no user or system config."""
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from master import checkout, cli, config, ledger, rules, setup, spawn
from tests.test_spawn import FakeRunner

GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

A = {"login": "alice", "primary": True, "name": "Alice", "email": "", "owner": "acme", "ownerType": "organization",
     "issueRepo": "tracker", "repos": ["acme/tracker", "acme/api"], "projects": []}
B = {"login": "bob-work", "name": "Bob", "email": "", "owner": "globex", "ownerType": "organization",
     "issueRepo": "app", "repos": ["globex/app"], "projects": []}


def clone(folder: Path, url: "str | None") -> Path:
    """A git checkout whose `origin` is `url` (None: no remote)."""
    folder.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(folder)], check=True, capture_output=True)
    if url:
        subprocess.run(["git", "-C", str(folder), "remote", "add", "origin", url], check=True, capture_output=True)
    return folder


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(os.path.realpath(tmp.name))
        env = mock.patch.dict(os.environ, {**GIT_ENV, "MASTER_HOME": str(self.tmp / "home")})
        env.start()
        self.addCleanup(env.stop)
        # Restored by the patch above. The runner may itself be a Claude Code session (the write guard).
        for k in ("MASTER_WORKSPACE", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"):
            os.environ.pop(k, None)
        checkout.forget()
        self.addCleanup(checkout.forget)
        self.ws = self.tmp / "ws"
        self.ws.mkdir()

    def cfg(self, **over):
        p = mock.patch.dict(config.CONFIG, {"workspace": str(self.ws), **over})
        p.start()
        self.addCleanup(p.stop)


class WorkspaceForTest(Base):
    def test_no_accounts_is_the_config_workspace(self):
        self.cfg()
        self.assertEqual(config.workspace_for("acme/tracker"), self.ws)
        self.assertEqual(config.workspace_for(None), self.ws)
        self.assertEqual(config.workspace_for("initech/x"), self.ws)

    def test_an_account_without_one_uses_the_config_workspace(self):
        self.cfg(accounts=[A, B])
        self.assertEqual(config.workspace_for("globex/app"), self.ws)

    def test_each_account_has_its_own(self):
        self.cfg(accounts=[A, dict(B, workspace=str(self.tmp / "globex"))])
        self.assertEqual(config.workspace_for("GLOBEX/app"), self.tmp / "globex")
        self.assertEqual(config.workspace_for("acme/api"), self.ws)
        self.assertEqual(config.workspace_for(None), self.ws)        # the primary issue repo
        self.assertEqual(config.workspace_for("initech/x"), self.ws)  # no account's: the primary's

    def test_one_account_with_its_own(self):
        self.cfg(accounts=[dict(A, workspace=str(self.tmp / "acme"))])
        self.assertEqual(config.workspace_for("acme/api"), self.tmp / "acme")

    def test_home_is_expanded(self):
        self.cfg(accounts=[A, dict(B, workspace="~/globex")])
        self.assertEqual(config.workspace_for("globex/app"), Path(os.path.expanduser("~/globex")))

    def test_master_workspace_overrides_every_account(self):
        self.cfg(accounts=[A, dict(B, workspace=str(self.tmp / "globex"))])
        with mock.patch.dict(os.environ, {"MASTER_WORKSPACE": str(self.tmp / "forced")}):
            self.assertEqual(config.workspace_for("globex/app"), self.tmp / "forced")


class SaveTest(Base):
    def test_an_account_workspace_survives_saves(self):
        p = self.tmp / "config.json"
        b = dict(B, workspace="/code/globex")
        for patch in ({"accounts": [A, b], "workspace": "/code/acme"}, {"masterEnabled": False}, {"workspace": "/code/acme2"}):
            cfg = setup.save(patch, p)
            self.assertEqual(cfg["accounts"][1]["workspace"], "/code/globex", patch)
            self.assertNotIn("workspace", cfg["accounts"][0])
        self.assertEqual(json.loads(p.read_text())["workspace"], "/code/acme2")
        self.assertEqual(config.accounts(cfg)[1]["workspace"], "/code/globex")
        self.assertEqual(config.accounts(cfg)[0]["workspace"], "")

    def test_the_top_level_mirrors_the_primary(self):
        p = self.tmp / "config.json"
        cfg = setup.save({"workspace": "/code/old", "accounts": [dict(A, workspace="/code/acme"), B]}, p)
        self.assertEqual(cfg["workspace"], "/code/acme")
        # A later top-level patch is the primary's too (it must not be undone by the mirror).
        cfg = setup.save({"workspace": "/code/new"}, p)
        self.assertEqual((cfg["workspace"], cfg["accounts"][0]["workspace"]), ("/code/new", "/code/new"))

    def test_a_workspace_must_be_text(self):
        with self.assertRaises(ValueError):
            setup.save({"accounts": [A, dict(B, workspace=5)]}, self.tmp / "config.json")

    def test_a_config_without_accounts_is_saved_as_before(self):
        cfg = setup.save({"owner": "acme", "issueRepo": "tracker", "workspace": "/code"}, self.tmp / "config.json")
        self.assertEqual(cfg["workspace"], "/code")
        self.assertNotIn("accounts", cfg)


class ScanTest(Base):
    def setUp(self):
        super().setUp()
        self.cfg()

    def found(self, repo):
        r = checkout.resolve(repo)
        return r["cwd"] if r["found"] else None

    def test_https_ssh_alias_and_case(self):
        for i, url in enumerate(("https://github.com/acme/api.git", "https://github.com/acme/api",
                                 "git@github.com:acme/api.git", "git@github-acme:Acme/API.git",
                                 "ssh://git@github.com/acme/api.git", "https://alice@github.com/ACME/api/")):
            with self.subTest(url=url):
                ws = self.tmp / f"w{i}"
                clone(ws / "the-api", url)
                with mock.patch.dict(config.CONFIG, {"workspace": str(ws)}):
                    self.assertEqual(self.found("acme/API"), str(ws / "the-api"))

    def test_instead_of_rewrites_count(self):
        clone(self.ws / "api", "gh:acme/api")
        subprocess.run(["git", "-C", str(self.ws / "api"), "config", "url.git@github.com:.insteadOf", "gh:"], check=True)
        self.assertEqual(self.found("acme/api"), str(self.ws / "api"))

    def test_another_repository_or_host_is_not_a_match(self):
        clone(self.ws / "api", "https://github.com/acme/api-docs.git")
        clone(self.ws / "api2", "https://gitlab.example/acme/api.git")
        clone(self.ws / "api3", None)
        (self.ws / "api4").mkdir()
        r = checkout.resolve("acme/api")
        self.assertEqual((r["found"], r["cwd"], r["workspace"], r["repo"]), (False, str(self.ws), str(self.ws), "acme/api"))

    def test_the_workspace_itself(self):
        clone(self.ws, "git@github.com:acme/tracker.git")
        clone(self.ws / "api", "git@github.com:acme/api.git")
        self.assertEqual(self.found("acme/tracker"), str(self.ws))
        self.assertEqual(self.found("acme/api"), str(self.ws / "api"))  # its subfolders are still looked at

    def test_no_repo_is_the_primary_issue_repo(self):
        clone(self.ws / "t", "git@github.com:acme/tracker.git")
        r = checkout.resolve(None)
        self.assertEqual((r["cwd"], r["repo"]), (str(self.ws / "t"), "acme/tracker"))

    def test_depth_two_but_not_three_and_never_inside_a_checkout(self):
        clone(self.ws / "acme" / "api", "git@github.com:acme/api.git")
        clone(self.ws / "a" / "b" / "web", "git@github.com:acme/web.git")
        clone(self.ws / "mono" / "vendor", "git@github.com:acme/vendor.git")
        clone(self.ws / "mono", "git@github.com:acme/mono.git")
        self.assertEqual(self.found("acme/api"), str(self.ws / "acme" / "api"))
        self.assertIsNone(self.found("acme/web"))
        self.assertIsNone(self.found("acme/vendor"))

    def test_depth_one_wins_over_depth_two(self):
        clone(self.ws / "aaa" / "api", "git@github.com:acme/api.git")
        clone(self.ws / "zzz", "git@github.com:acme/api.git")
        self.assertEqual(self.found("acme/api"), str(self.ws / "zzz"))

    def test_hidden_folders_and_linked_worktrees_are_skipped(self):
        clone(self.ws / ".cache", "git@github.com:acme/api.git")
        wt = self.ws / "api-wt"  # a linked worktree has a .git file, not a folder
        wt.mkdir()
        (wt / ".git").write_text("gitdir: /elsewhere\n")
        self.assertIsNone(self.found("acme/api"))

    def test_a_link_out_of_the_workspace_is_never_followed(self):
        outside = clone(self.tmp / "outside" / "api", "git@github.com:acme/api.git")
        os.symlink(outside, self.ws / "api")
        os.symlink(self.tmp / "outside", self.ws / "more")
        self.assertIsNone(self.found("acme/api"))
        checkout.forget()
        inside = clone(self.ws / "real" / "web", "git@github.com:acme/web.git")
        os.symlink(inside, self.ws / "web")  # a link that stays inside is fine
        self.assertEqual(self.found("acme/web"), str(self.ws / "web"))

    def test_at_most_max_folders_are_looked_at(self):
        for n in range(6):
            clone(self.ws / f"r{n}", f"git@github.com:acme/r{n}.git")
        asked = []

        def origin(d):
            asked.append(d)
            return config.origin_repo(d)

        with mock.patch.object(checkout, "MAX_FOLDERS", 4):
            got = checkout.scan(self.ws, origin=origin)
        self.assertEqual(sorted(got), ["acme/r0", "acme/r1", "acme/r2"])  # the workspace counts as one
        self.assertEqual(len(asked), 3)

    def test_a_scan_is_remembered_briefly(self):
        clone(self.ws / "api", "git@github.com:acme/api.git")
        calls = []

        def origin(d):
            calls.append(d)
            return config.origin_repo(d)

        clock = [100.0]
        for _ in range(3):
            self.assertEqual(checkout.scan(self.ws, origin=origin, now=lambda: clock[0]), {"acme/api": str(self.ws / "api")})
        self.assertEqual(len(calls), 1)
        clock[0] += checkout.TTL + 1
        checkout.scan(self.ws, origin=origin, now=lambda: clock[0])
        self.assertEqual(len(calls), 2)

    def test_a_missing_workspace_finds_nothing(self):
        with mock.patch.dict(config.CONFIG, {"workspace": str(self.tmp / "nope")}):
            r = checkout.resolve("acme/api")
        self.assertEqual((r["found"], r["cwd"]), (False, str(self.tmp / "nope")))

    def test_a_git_that_hangs_is_no_match(self):
        clone(self.ws / "api", "git@github.com:acme/api.git")

        def slow(*a, **kw):
            self.assertLessEqual(kw["timeout"], 5)
            raise subprocess.TimeoutExpired(a[0], kw["timeout"])

        with mock.patch.object(subprocess, "run", slow):
            self.assertIsNone(self.found("acme/api"))

    def test_each_account_is_looked_up_in_its_own_workspace(self):
        other = self.tmp / "globex"
        clone(other / "app", "git@github-bob:globex/app.git")
        clone(self.ws / "app", "git@github.com:globex/app.git")      # a stray copy under alice's
        clone(other / "api", "git@github.com:acme/api.git")          # and alice's repo under bob's
        with mock.patch.dict(config.CONFIG, {"accounts": [A, dict(B, workspace=str(other))]}):
            r = checkout.resolve("globex/app")
            self.assertEqual((r["cwd"], r["workspace"], r["found"]), (str(other / "app"), str(other), True))
            r = checkout.resolve("acme/api")
            self.assertEqual((r["cwd"], r["workspace"], r["found"]), (str(self.ws), str(self.ws), False))

    def test_a_chosen_folder_is_used_as_it_is(self):
        mine = clone(self.tmp / "elsewhere" / "api", "git@github.com:acme/api.git")
        r = checkout.resolve("acme/api", cwd=str(mine))
        self.assertEqual((r["cwd"], r["found"], r["workspace"]), (str(mine), True, str(self.ws)))
        r = checkout.resolve("acme/api", cwd=str(self.tmp))
        self.assertEqual((r["cwd"], r["found"]), (str(self.tmp), False))


def issue(n, repo=None, title="Fix upload retry"):
    return {"number": n, "title": title, "repo": repo,
            "url": f"https://github.com/{repo or 'acme/tracker'}/issues/{n}"}


class AssignTest(Base):
    def setUp(self):
        super().setUp()
        self.other = self.tmp / "globex"
        self.cfg(accounts=[A, dict(B, workspace=str(self.other))])

    def test_assign_starts_in_the_checkout_and_says_so(self):
        clone(self.other / "app", "git@github.com:globex/app.git")
        a = rules._assign(issue(7, "globex/app"))
        sp = a["target"]["spawn"]
        self.assertEqual((sp["cwd"], sp["account"]), (str(self.other / "app"), "bob-work"))
        self.assertIn("This folder is your checkout of globex/app", sp["prompt"])
        self.assertIn("EnterWorktree", sp["prompt"])
        self.assertNotIn("pick the repo it belongs to", sp["prompt"])
        self.assertEqual(a["message"], sp["prompt"])

    def test_assign_without_a_checkout_is_as_before_in_the_account_workspace(self):
        self.other.mkdir()
        a = rules._assign(issue(7, "globex/app"))
        sp = a["target"]["spawn"]
        self.assertEqual((sp["cwd"], sp["account"]), (str(self.other), "bob-work"))
        self.assertIn("pick the repo it belongs to", sp["prompt"])
        self.assertNotIn("This folder is your checkout", sp["prompt"])
        # The primary repo's ticket: alice's workspace, and alice.
        sp = rules._assign(issue(42))["target"]["spawn"]
        self.assertEqual((sp["cwd"], sp["account"]), (str(self.ws), "alice"))

    def test_the_account_does_not_follow_the_folder(self):
        # A checkout under bob's workspace of a repository that is alice's: looked up under alice's only.
        clone(self.other / "api", "git@github.com:acme/api.git")
        sp = rules._assign(issue(3, "acme/api"))["target"]["spawn"]
        self.assertEqual((sp["cwd"], sp["account"]), (str(self.ws), "alice"))

    def test_propose_uses_it(self):
        clone(self.ws / "tracker", "https://github.com/acme/tracker")
        cur = {"sources": {"board": True, "agents": True, "state": True, "prs": True}, "sessions": [], "prs": [],
               "issues": [dict(issue(42), status="To Do", current_sprint=True)]}
        [p] = rules.propose(None, cur, "2026-09-24T10:00:00Z")
        self.assertEqual(p["target"]["spawn"]["cwd"], str(self.ws / "tracker"))


class LegacyTest(Base):
    def test_a_config_without_accounts_and_no_checkout_is_exactly_as_before(self):
        self.cfg()
        a = rules._assign(issue(42))
        sp = a["target"]["spawn"]
        self.assertEqual(sp["cwd"], str(self.ws))
        self.assertNotIn("account", sp)
        self.assertIn("1. Read the issue, pick the repo it belongs to (the workspace CLAUDE.md may say), and work in a git "
                      "worktree there for #42 (use Claude Code's worktree support / EnterWorktree, branch named after the "
                      "ticket), so the main checkout stays clean.\n", sp["prompt"])


class CliTest(Base):
    def setUp(self):
        super().setUp()
        self.other = self.tmp / "globex"
        self.cfg(accounts=[A, dict(B, workspace=str(self.other))])
        clone(self.other / "app", "git@github.com:globex/app.git")

    def run_cli(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(list(argv))
        return code, buf.getvalue()

    def draft(self, *more):
        code, out = self.run_cli("draft-assign", "7", "--repo", "globex/app", "--title", "T", "--url",
                                 "https://github.com/globex/app/issues/7", *more)
        self.assertEqual(code, 0, out)
        return json.loads(out)

    def test_the_draft_says_where_and_whether_it_was_found(self):
        d = self.draft()
        self.assertEqual((d["cwd"], d["workspace"], d["found"], d["checkoutOf"]),
                         (str(self.other / "app"), str(self.other), True, "globex/app"))
        code, out = self.run_cli("draft-assign", "3", "--repo", "acme/api", "--title", "T", "--url", "https://github.com/acme/api/issues/3")
        d = json.loads(out)
        self.assertEqual((d["cwd"], d["workspace"], d["found"], d["checkoutOf"]), (str(self.ws), str(self.ws), False, "acme/api"))

    def test_the_draft_for_a_chosen_folder(self):
        d = self.draft("--cwd", str(self.tmp))
        self.assertEqual((d["cwd"], d["found"]), (str(self.tmp), False))
        self.assertIn("pick the repo it belongs to", d["prompt"])
        d = self.draft("--cwd", str(self.other / "app"))
        self.assertEqual((d["cwd"], d["found"]), (str(self.other / "app"), True))
        self.assertIn("This folder is your checkout of globex/app", d["prompt"])

    def test_checkout_prints_the_folder_of_a_repository(self):
        code, out = self.run_cli("checkout", "Globex/App")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out), {"cwd": str(self.other / "app"), "workspace": str(self.other),
                                           "repo": "Globex/App", "found": True})
        code, out = self.run_cli("checkout", "not a repo")
        self.assertEqual(code, 2)
        self.assertFalse(cli._is_write(cli.parser().parse_args(["checkout", "acme/api"])))

    def test_add_without_a_folder_starts_in_the_checkout(self):
        self.run_cli("add", "--kind", "ASSIGN", "--issue", "7", "--repo", "globex/app", "--source", "f:1", "--summary", "s",
                     "--message", "m", "--spawn-name", "app-7-x", "--prompt", "do it")
        self.run_cli("add", "--kind", "ASSIGN", "--issue", "8", "--repo", "globex/app", "--source", "f:2", "--summary", "s",
                     "--message", "m", "--spawn-name", "app-8-x", "--prompt", "do it", "--cwd", str(self.tmp))
        got = [p["target"]["spawn"]["cwd"] for p in ledger.load()["proposals"]]
        self.assertEqual(got, [str(self.other / "app"), str(self.tmp)])

    def test_spawn_of_a_proposal_without_a_folder_starts_in_the_checkout(self):
        (self.tmp / "home" / "md" / "accounts").mkdir(parents=True)
        (self.tmp / "home" / "md" / "accounts" / "bob-work.settings.json").write_text("{}")
        with mock.patch.dict(os.environ, {"MASTERDECK_HOME": str(self.tmp / "home" / "md")}), ledger.locked() as led:
            p = ledger.add(led, kind="ASSIGN", issue=7, repo="globex/app", source="f:1",
                           target={"spawn": {"name": "app-7-x", "prompt": "do it"}}, message="m", summary="s",
                           now="2026-09-24T10:00:00Z")
            ledger.transition(led, p["id"], "approved", now="2026-09-24T10:00:00Z")
            runner = FakeRunner()
            spawn.spawn(led, p["id"], now="2026-09-24T10:00:01Z", runner=runner)
        self.assertEqual(runner.calls[-1][1]["cwd"], str(self.other / "app"))


if __name__ == "__main__":
    unittest.main()

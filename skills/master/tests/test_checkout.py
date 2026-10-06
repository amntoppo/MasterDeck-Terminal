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

PROMPTS = Path(__file__).parent / "prompts"
MAIN_STEP_1 = ("1. Read the issue, pick the repo it belongs to (the workspace CLAUDE.md may say), and work in a git "
               "worktree there for {lab} (use Claude Code's worktree support / EnterWorktree, branch named after the ticket), "
               "so the main checkout stays clean.\n")
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

    def test_a_blank_workspace_is_none(self):
        self.cfg(accounts=[A, dict(B, workspace="   ")])
        self.assertEqual(config.accounts()[1]["workspace"], "")
        self.assertEqual(config.workspace_for("globex/app"), self.ws)
        with mock.patch.dict(config.CONFIG, {"accounts": [A, dict(B, workspace=f"  {self.tmp / 'globex'} ")]}):
            self.assertEqual(config.workspace_for("globex/app"), self.tmp / "globex")

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
        clone(self.ws / "aaa" / "copy", "git@github.com:acme/api.git")
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

    def test_three_hundred_plain_folders_do_not_hide_a_checkout_and_git_is_never_run(self):
        for n in range(300):
            (self.ws / f"notes-{n:03}").mkdir()
        clone(self.ws / "zzz-service", "git@github.com:acme/api.git")

        def no_git(*a, **kw):
            raise AssertionError(f"git was run: {a}")

        with mock.patch.object(subprocess, "run", no_git):
            r = checkout.resolve("acme/api")
        self.assertEqual((r["found"], r["cwd"]), (True, str(self.ws / "zzz-service")))
        self.assertNotIn("partial", r)

    def test_duplicates_prefer_the_folder_named_after_the_repository_then_the_shortest_path(self):
        for name in ("Api-backup", "api", "api-old"):
            clone(self.ws / name, "git@github.com:acme/api.git")
        self.assertEqual(self.found("acme/API"), str(self.ws / "api"))
        for name in ("web-second-copy", "web2", "team/web"):
            clone(self.ws / name, "git@github.com:acme/web.git")
        for name in ("docs-second-copy", "docs2", "team/docs-site"):
            clone(self.ws / name, "git@github.com:acme/docs.git")
        self.assertEqual(self.found("acme/web"), str(self.ws / "team" / "web"))  # named, one level down
        self.assertEqual(self.found("acme/docs"), str(self.ws / "docs2"))        # none named: the shortest path

    def test_the_folder_named_after_the_repository_is_found_without_listing_the_workspace(self):
        clone(self.ws / "api", "git@github.com:acme/api.git")
        with mock.patch.object(checkout, "_folders", side_effect=AssertionError("listed")):
            self.assertEqual(self.found("acme/api"), str(self.ws / "api"))

    def test_a_linked_worktree_is_not_descended_into(self):
        wt = self.ws / "wt"
        wt.mkdir()
        (wt / ".git").write_text("gitdir: /elsewhere\n")
        clone(wt / "inner", "git@github.com:acme/api.git")
        self.assertIsNone(self.found("acme/api"))

    def test_when_the_limit_is_reached_the_answer_says_so(self):
        for n in range(6):
            clone(self.ws / f"r{n}", f"git@github.com:acme/r{n}.git")
        with mock.patch.object(checkout, "MAX_FOLDERS", 4):
            got = checkout.scan(self.ws)
            self.assertEqual(sorted(got["repos"]), ["acme/r0", "acme/r1", "acme/r2"])  # the workspace counts as one
            self.assertEqual((got["searched"], got["partial"]), (4, True))
            r = checkout.resolve("acme/nope")
            self.assertEqual((r["found"], r["partial"], r["searched"]), (False, True, 4))
            # The folder named after the repository is found whatever the limit.
            self.assertEqual(checkout.resolve("acme/r5")["cwd"], str(self.ws / "r5"))
            self.assertNotIn("partial", checkout.resolve("acme/r1"))  # found: nothing to say
        checkout.forget()
        self.assertEqual((checkout.scan(self.ws)["partial"], checkout.resolve("acme/nope").get("partial")), (False, None))

    def test_git_is_asked_only_for_an_origin_the_config_does_not_spell_out_and_only_so_often(self):
        for n in range(4):
            c = clone(self.ws / f"r{n}", f"gh:acme/r{n}")
            subprocess.run(["git", "-C", str(c), "config", "url.git@github.com:.insteadOf", "gh:"], check=True)
        clone(self.ws / "plain", "https://gitlab.example/acme/plain.git")  # a full URL elsewhere: never asked
        asked = []

        def git(d):
            asked.append(Path(d).name)
            return config.origin_repo(d)

        with mock.patch.object(checkout, "MAX_GIT_CALLS", 3):
            got = checkout.scan(self.ws, git=git)
        self.assertEqual(asked, ["r0", "r1", "r2"])
        self.assertEqual((sorted(got["repos"]), got["partial"]), (["acme/r0", "acme/r1", "acme/r2"], True))

    def test_a_scan_is_remembered_briefly(self):
        c = clone(self.ws / "service", "gh:acme/api")
        subprocess.run(["git", "-C", str(c), "config", "url.git@github.com:.insteadOf", "gh:"], check=True)
        calls = []

        def git(d):
            calls.append(d)
            return config.origin_repo(d)

        clock = [100.0]
        for _ in range(3):
            self.assertEqual(checkout.scan(self.ws, git=git, now=lambda: clock[0])["repos"], {"acme/api": str(self.ws / "service")})
        self.assertEqual(len(calls), 1)
        clock[0] += checkout.TTL + 1
        checkout.scan(self.ws, git=git, now=lambda: clock[0])
        self.assertEqual(len(calls), 2)

    def test_a_git_that_hangs_is_no_match(self):
        clone(self.ws / "service", "gh:acme/api")

        def slow(*a, **kw):
            self.assertLessEqual(kw["timeout"], 5)
            raise subprocess.TimeoutExpired(a[0], kw["timeout"])

        with mock.patch.object(subprocess, "run", slow):
            self.assertIsNone(self.found("acme/api"))

    def test_a_missing_workspace_finds_nothing(self):
        with mock.patch.dict(config.CONFIG, {"workspace": str(self.tmp / "nope")}):
            r = checkout.resolve("acme/api")
        self.assertEqual((r["found"], r["cwd"]), (False, str(self.tmp / "nope")))

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
        want = (PROMPTS / "assign_main_other_repo.txt").read_text(encoding="utf-8").replace(MAIN_STEP_1.format(lab="app#7"), (
            f"1. Read the issue. This folder is a checkout of globex/app, where the issue is filed. If the work belongs in "
            f"another repository (the CLAUDE.md in {self.other} may say which), use that repository under {self.other} "
            f"instead; otherwise work in a git worktree here for app#7 (use Claude Code's worktree support / EnterWorktree, "
            f"branch named after the ticket), so the main checkout stays clean.\n"))
        self.assertNotEqual(want, (PROMPTS / "assign_main_other_repo.txt").read_text(encoding="utf-8"))
        self.assertEqual(sp["prompt"], want)  # only step 1 differs, and it asks nothing
        self.assertEqual(a["message"], sp["prompt"])

    def test_assign_without_a_checkout_is_as_before_in_the_account_workspace(self):
        self.other.mkdir()
        a = rules._assign(issue(7, "globex/app"))
        sp = a["target"]["spawn"]
        self.assertEqual((sp["cwd"], sp["account"]), (str(self.other), "bob-work"))
        self.assertEqual(sp["prompt"], (PROMPTS / "assign_main_other_repo.txt").read_text(encoding="utf-8"))
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
    """No checkout: the prompt is main's, byte for byte (stored copies made from main's rules.py)."""

    def test_a_config_without_accounts_and_no_checkout_is_exactly_as_before(self):
        self.cfg()
        sp = rules._assign(issue(42))["target"]["spawn"]
        self.assertEqual(sp["cwd"], str(self.ws))
        self.assertNotIn("account", sp)
        self.assertEqual(sp["prompt"], (PROMPTS / "assign_main.txt").read_text(encoding="utf-8"))
        self.assertEqual(rules._assign(issue(7, "globex/app"))["target"]["spawn"]["prompt"],
                         (PROMPTS / "assign_main_other_repo.txt").read_text(encoding="utf-8"))

    def test_without_a_master_agent_too(self):
        self.cfg(masterEnabled=False)
        self.assertEqual(rules._assign(issue(42))["target"]["spawn"]["prompt"], (PROMPTS / "assign_main_solo.txt").read_text(encoding="utf-8"))

    def test_a_chosen_folder_that_is_no_checkout_keeps_the_prompt(self):
        self.cfg()
        self.assertEqual(rules._assign(issue(42), str(self.tmp))["target"]["spawn"]["prompt"], (PROMPTS / "assign_main.txt").read_text(encoding="utf-8"))


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
        self.assertEqual(d["prompt"], d["genericPrompt"])
        d = self.draft("--cwd", str(self.other / "app"))
        self.assertEqual((d["cwd"], d["found"]), (str(self.other / "app"), True))
        self.assertIn("This folder is a checkout of globex/app, where the issue is filed", d["prompt"])
        self.assertEqual(d["genericPrompt"], (PROMPTS / "assign_main_other_repo.txt").read_text(encoding="utf-8").replace("Fix upload retry", "T"))

    def test_checkout_prints_the_folder_of_a_repository(self):
        code, out = self.run_cli("checkout", "Globex/App")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out), {"cwd": str(self.other / "app"), "workspace": str(self.other),
                                           "repo": "Globex/App", "found": True, "trusted": None})
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

    def test_the_draft_says_when_the_search_was_cut_short(self):
        (self.ws / "a").mkdir()
        (self.ws / "b").mkdir()
        with mock.patch.object(checkout, "MAX_FOLDERS", 1):
            code, out = self.run_cli("draft-assign", "3", "--repo", "acme/api", "--title", "T", "--url", "u")
        d = json.loads(out)
        self.assertEqual((d["found"], d["partial"], d["searched"]), (False, True, 1))
        self.assertNotIn("partial", self.draft())

    def test_only_ticket_work_is_looked_up(self):
        """A meeting's session, a proposal for no issue and anything else start in the workspace, as before."""
        clone(self.ws / "tracker", "git@github.com:acme/tracker.git")
        for i, (kind, n, want) in enumerate((("MEETING", "5", self.ws), ("CHAT", "5", self.ws), ("ASSIGN", "0", self.ws),
                                             ("ASSIGN", "5", self.ws / "tracker"), ("PRREVIEW", "5", self.ws / "tracker"))):
            self.run_cli("add", "--kind", kind, "--issue", n, "--source", f"f:{i}", "--summary", "s",
                         "--message", "m", "--spawn-name", f"x-{i}", "--prompt", "do it")
            self.assertEqual(ledger.load()["proposals"][-1]["target"]["spawn"]["cwd"], str(want), kind + n)

    def _spawned_in(self, kind, issue_n, repo, spawn_target):
        (self.tmp / "home" / "md" / "accounts").mkdir(parents=True, exist_ok=True)
        for login in ("alice", "bob-work"):
            (self.tmp / "home" / "md" / "accounts" / f"{login}.settings.json").write_text("{}")
        with mock.patch.dict(os.environ, {"MASTERDECK_HOME": str(self.tmp / "home" / "md")}), ledger.locked() as led:
            p = ledger.add(led, kind=kind, issue=issue_n, repo=repo, source=f"f:{kind}:{issue_n}",
                           target={"spawn": spawn_target}, message="m", summary="s", now="2026-09-24T10:00:00Z")
            ledger.transition(led, p["id"], "approved", now="2026-09-24T10:00:00Z")
            runner = FakeRunner(out="[]")
            spawn.spawn(led, p["id"], now="2026-09-24T10:00:01Z", runner=runner)
        return runner.calls[-1][1]["cwd"]

    def test_spawn_of_a_proposal_without_a_folder(self):
        clone(self.ws / "tracker", "git@github.com:acme/tracker.git")
        new = {"name": "x", "prompt": "do it"}
        self.assertEqual(self._spawned_in("ASSIGN", 7, "globex/app", dict(new)), str(self.other / "app"))
        self.assertEqual(self._spawned_in("PRREVIEW", 7, None, dict(new)), str(self.ws / "tracker"))
        self.assertEqual(self._spawned_in("MEETING", 7, None, dict(new)), str(self.ws))
        self.assertEqual(self._spawned_in("ASSIGN", 0, None, dict(new)), str(self.ws))
        # A resume with no folder (an ORPHAN): the workspace, never a lookup.
        self.assertEqual(self._spawned_in("ORPHAN", 7, None, {"name": "x", "resume": "4f2a9c1e-1234-4abc-9def-0123456789ab"}),
                         str(self.ws))


class ParkedTest(Base):
    """A ticket session MasterDeck starts in a checkout (not a workspace) is recorded as parked on the
    branch that checkout was on: the app then does not hand it that branch's PR."""

    def setUp(self):
        super().setUp()
        self.cfg()
        self.md = self.tmp / "home" / "md"
        env = mock.patch.dict(os.environ, {"MASTERDECK_HOME": str(self.md)})
        env.start()
        self.addCleanup(env.stop)
        self.api = clone(self.ws / "api", "git@github.com:acme/api.git")
        subprocess.run(["git", "-C", str(self.api), "symbolic-ref", "HEAD", "refs/heads/feat/someone-elses"], check=True)

    def start(self, kind, target, out="backgrounded · 4f2a9c1e\n", n=7):
        led = ledger.empty()
        p = ledger.add(led, kind=kind, issue=n, repo="acme/api", source=f"f:{kind}:{n}:{target.get('name')}",
                       target={"spawn": target}, message="m", summary="s", now="2026-09-24T10:00:00Z")
        ledger.transition(led, p["id"], "approved", now="2026-09-24T10:00:00Z")
        spawn.spawn(led, p["id"], now="2026-09-24T10:00:01Z", runner=FakeRunner(out=out))

    def parked(self):
        f = self.md / "parked-sessions.json"
        return json.loads(f.read_text()) if f.exists() else {}

    def test_branch_of_reads_head_without_git(self):
        with mock.patch.object(subprocess, "run", side_effect=AssertionError("git was run")):
            self.assertEqual(checkout.branch_of(str(self.api)), "feat/someone-elses")
            self.assertEqual(checkout.branch_of(str(self.ws)), "")
        (self.api / ".git" / "HEAD").write_text("0123456789abcdef0123456789abcdef01234567\n")  # detached
        self.assertEqual(checkout.branch_of(str(self.api)), "")

    def test_a_ticket_session_started_in_a_checkout_is_recorded_by_its_bg_id(self):
        self.start("ASSIGN", {"name": "api-7-x", "prompt": "go"})
        self.assertEqual(self.parked(), {"4f2a9c1e": {"dir": str(self.api), "branch": "feat/someone-elses", "review": False,
                                                      "name": "api-7-x", "at": "2026-09-24T10:00:01Z"}})

    def test_a_file_that_cannot_be_parsed_is_replaced_not_left_to_switch_the_record_off(self):
        self.md.mkdir(parents=True, exist_ok=True)
        (self.md / "parked-sessions.json").write_text("{ half a rec")
        self.start("ASSIGN", {"name": "api-7-x", "prompt": "go"})
        self.assertEqual(list(self.parked()), ["4f2a9c1e"])
        (self.md / "parked-sessions.json").write_text("[1, 2]")  # valid JSON of the wrong shape
        self.start("ASSIGN", {"name": "api-8-x", "prompt": "go"}, out="backgrounded · 0badc0de\n", n=8)
        self.assertEqual(list(self.parked()), ["0badc0de"])

    def test_a_review_session_is_marked_and_a_second_start_keeps_the_first(self):
        self.start("ASSIGN", {"name": "api-7-x", "prompt": "go"})
        self.start("PRREVIEW", {"name": "review-api-5", "prompt": "go", "cwd": str(self.api)}, out="claude attach 0badc0de\n")
        got = self.parked()
        self.assertEqual(sorted(got), ["0badc0de", "4f2a9c1e"])
        self.assertTrue(got["0badc0de"]["review"])

    def test_no_bg_id_in_the_output_falls_back_to_the_name(self):
        self.start("ASSIGN", {"name": "api-7-x", "prompt": "go"}, out="started\n")
        self.assertEqual(list(self.parked()), ["name:api-7-x"])

    def test_nothing_is_recorded_for_a_workspace_another_kind_or_a_resume(self):
        self.start("ASSIGN", {"name": "a", "prompt": "go", "cwd": str(self.ws)})          # the workspace
        self.start("MEETING", {"name": "b", "prompt": "go", "cwd": str(self.api)})        # not ticket work
        self.start("ORPHAN", {"name": "c", "cwd": str(self.api), "resume": "4f2a9c1e-1234-4abc-9def-0123456789ab"}, out="[]")
        other = self.tmp / "globex"
        other.mkdir()
        with mock.patch.dict(config.CONFIG, {"accounts": [A, dict(B, workspace=str(other))]}):
            (self.md / "accounts").mkdir(parents=True)
            for login in ("alice", "bob-work"):
                (self.md / "accounts" / f"{login}.settings.json").write_text("{}")
            self.start("ASSIGN", {"name": "d", "prompt": "go", "cwd": str(other)})         # another account's workspace
        self.assertEqual(self.parked(), {})

    def test_a_failed_start_records_nothing(self):
        led = ledger.empty()
        p = ledger.add(led, kind="ASSIGN", issue=7, repo="acme/api", source="f:x", target={"spawn": {"name": "x", "prompt": "go"}},
                       message="m", summary="s", now="2026-09-24T10:00:00Z")
        ledger.transition(led, p["id"], "approved", now="2026-09-24T10:00:00Z")
        with self.assertRaises(spawn.SpawnError):
            spawn.spawn(led, p["id"], now="2026-09-24T10:00:01Z", runner=FakeRunner(code=1, err="boom"))
        self.assertEqual(self.parked(), {})


if __name__ == "__main__":
    unittest.main()

# MasterDeck

A desktop app for people who run many [Claude Code](https://claude.com/claude-code) sessions at once.
It runs on macOS and Windows.

- **One window.** Every session is a tab with its real `claude` terminal. The **master-agent** is
  pinned on the right: a Claude session that watches the others and your GitHub.
- **Needs you.** Sessions waiting on a prompt, questions, failing CI, idle work, context and budget
  warnings. Each item has a one-click action.
- **Your GitHub.** A Kanban board of your sprint from GitHub Projects, and every PR in your org
  with filters. You can assign tickets, start sessions for them and review PRs.
- **Hygiene.** Costs per ticket, standup notes from your commits, a worktree janitor, history
  search, templates and broadcast.

MasterDeck ships with a set of Claude Code **skills** and installs them for you:

| Skill | What it does |
|---|---|
| `master` | The master-agent: turns issues, PRs and session messages into proposals and dispatches them after you approve. |
| `babysit-ticket` | Links a session to an issue and moves the board card as work progresses (in progress, then PR raised, then done). |
| `babysit-pr` | Runs a self-review before a PR is opened, then handles review comments and CI until it merges. |
| `babysit-worktree` / `kill-worktree` | Isolates a session in a git worktree, then folds the work back. |
| `worktree-janitor` | Cleans up finished worktrees across your repos. |
| `queue` | `/queue <prompt>` in any session queues a prompt to run after the current response; `/queue list`, `/queue clear`. **Queue Prompts** in a session's header opens a Queue panel under master that shows and edits it. |

Nothing is sent to a session or started without your yes. The skills never merge, never
force-push and never use `--dangerously-skip-permissions`.

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude` on your PATH, logged in)
- [GitHub CLI](https://cli.github.com) (`gh`), logged in with the `project` scope:
  `gh auth login`, then `gh auth refresh -s project`
- Python 3.9+ (`python3`; `python` on Windows)
- `git` and `jq`

## Install

Download the latest build from [Releases](https://github.com/amntoppo/MasterDeck-Terminal/releases):

- **macOS:** `MasterDeck-<version>-arm64.dmg` for Apple silicon, or `MasterDeck-<version>.dmg` for
  Intel. The app is not signed. On first launch, right-click the app and choose **Open**, or run
  `xattr -dr com.apple.quarantine /Applications/MasterDeck.app`.
- **Windows:** `MasterDeck Setup <version>.exe`. It is not signed, so SmartScreen asks you to
  confirm: **More info**, then **Run anyway**.

Or build it yourself (see [Develop](#develop)).

## First run

1. **Skills.** MasterDeck copies its skills into `~/.claude/skills/`. It skips any skill folder
   you already have. Settings lists each skill's state and can replace a copy with the bundled one.
2. **Setup** opens by itself, in four steps:
   1. **Tools.** Each of `claude`, `gh`, Python, `git` and `jq` is checked, with what to install if one is missing.
   2. **GitHub account.** Pick one of the accounts `gh` is logged in to; the choice becomes `gh`'s active
      account, which MasterDeck, master and your sessions share.
   3. **Organization.** Pick the organization (or your user) and the repository that holds your issues,
      then your project board. MasterDeck reads the board's statuses and guesses what each means (ready,
      in progress, PR raised, done); adjust the guesses if they are wrong. No board: you still get issues,
      PRs and sessions.
   4. **Workspace.** The folder master and new shells start in, where your repos are; whether to use a
      master-agent; and the **hooks** for `~/.claude/settings.json` (a backup is made first), which let
      babysit-ticket move the board, babysit-pr step in around `gh pr create`, and `/queue` work.

   **Skip for now** leaves GitHub unset: sessions work, and the Board and PRs views offer **Connect your
   GitHub**, which opens Setup again.
3. The master pane on the right offers **Start master**, which starts the master-agent session.
   Master is optional: untick **Master agent** in Setup and MasterDeck works without it. You lose
   what only master does: sweeps that propose work, the reports sessions send it (done, blocked,
   questions) and relaying text to sessions in other terminals. New sessions then ask you directly.

Setup saves everything to one file, `~/.claude/master/config.json`. The master CLI, babysit-ticket
and the app all read it. To change it later, open **Settings (⚙) → GitHub & board**, or edit it:

```bash
~/.claude/skills/master/master config show      # print the current config
~/.claude/skills/master/master config detect --owner acme --project 1   # what GitHub has
echo '{"workspace": "/Users/me/code"}' | ~/.claude/skills/master/master config save
```

<details>
<summary>The config fields</summary>

| Field | Meaning |
|---|---|
| `owner`, `ownerType` | GitHub organization or user that owns your repos and board |
| `issueRepo` | Repository that holds the issues |
| `project`, `projectId`, `statusFieldId`, `statusOptions` | The GitHub Projects (v2) board and its Status field; filled in by Setup (`0` = no board) |
| `columns` | The board's statuses, in order |
| `statuses.ready` / `inProgress` / `prRaised` / `devDone` | The status for new work, work in progress, a PR opened, and PRs merged |
| `statuses.done` / `finished` / `assignable` / `resumable` / `blocked` | Status sets: not new work; hidden from pick lists; master may assign; a session may resume; blocked |
| `statuses.rank` | Optional order for "forward only" moves; by default the column order |
| `sprintField`, `sprintQuery` | The board's iteration field and the filter for "my current sprint" |
| `workspace` | Folder where master and new sessions start |
| `masterName` | Name of the master session (default `master-agent`) |
| `masterEnabled` | `false` runs MasterDeck without a master-agent (Setup → Master agent) |

</details>

## Using it

See the [guide](docs/GUIDE.md) for every feature: Needs you, the board, PRs, starting and linking
sessions, costs, standups, the janitor, keyboard shortcuts, environment variables and Windows notes.

MasterDeck also shares one GitHub cache between the app, master and the babysit skills (`ghc`, in
`~/.claude/gh-cache`), so many sessions don't use up your GitHub rate limit.

## Develop

```bash
git clone https://github.com/amntoppo/MasterDeck-Terminal.git
cd MasterDeck-Terminal/app
npm install          # also rebuilds node-pty for Electron
npm run dev          # the app, with hot reload (bundles ../skills)
npm test             # Vitest
npm run typecheck
npm run dist:mac     # dist/*.dmg (arm64 and x64)
npm run dist:win     # dist/*.exe
```

Python tests for the master CLI: `python3 -m pytest skills/master/tests -q` from the repo root.

Layout:

```
app/            Electron + React + xterm.js app (main, preload, renderer, shared)
skills/         the Claude Code skills MasterDeck installs (master holds the CLI in lib/)
docs/GUIDE.md   feature guide
```

After `dist:mac` has built x64, run `npx electron-builder install-app-deps` to restore the arm64
node-pty for `npm run dev`.

## Privacy

MasterDeck runs entirely on your machine. It talks to GitHub through your own `gh` login and to
Claude through your own `claude`. It has no server and no telemetry. It stores its data in
`~/.claude/` (`master/`, `masterdeck/`, `gh-cache/`, `babysit-ticket/`).

## License

[MIT](LICENSE)

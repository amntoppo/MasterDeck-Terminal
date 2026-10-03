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
- **Automatic upkeep.** MasterDeck links a session to its issue and moves the board card (In Dev,
  PR Raised, Dev Done), stops the first `gh pr create` on each branch for a self-review, sends review
  comments, conflicts and the merge of a session's PRs back to that session, and runs `/queue`
  (the gate and `/queue` need its hook, so macOS only). No skill is needed for any of it.
- **From anywhere (optional).** Sign in, switch on Remote, and reach your Mac from a browser at
  [app.masterdeck.dev](https://app.masterdeck.dev), on a laptop or a phone: the same Tasks, Board,
  PRs and live terminals, end-to-end encrypted between the browser and your Mac. A blinking amber dot
  in the rail shows while something is connected.

MasterDeck ships with a set of Claude Code **skills** and installs them for you. Apart from `master`,
they are for use by hand; MasterDeck does not depend on them:

| Skill | What it does |
|---|---|
| `master` | The master-agent: turns issues, PRs and session messages into proposals and dispatches them after you approve. |
| `babysit-ticket` | Links a session to an issue by hand and moves its board card (MasterDeck does this itself for sessions it starts). |
| `babysit-pr` | A deeper self-review before a PR, then review comments, CI and deploy until it merges (MasterDeck's own gate and PR watch cover the basics). |
| `babysit-worktree` / `kill-worktree` | Isolates a session in a git worktree, then folds the work back. |
| `worktree-janitor` | Cleans up finished worktrees across your repos. |
| `queue` | Describes `/queue`. MasterDeck's own hook runs `/queue <prompt>` (run after the current response), `/queue list` and `/queue clear`; **Queue Prompts** in a session's header opens a Queue panel that shows and edits it. |

Nothing is sent to a session or started without your yes. The skills never merge, never
force-push and never use `--dangerously-skip-permissions`.

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude` on your PATH, logged in)
- [GitHub CLI](https://cli.github.com) (`gh`), logged in with the `project` scope:
  `gh auth login`, then `gh auth refresh -s project`
- Python 3.9+ (`python3`; `python` on Windows)
- `git` and `jq`

## Install

**macOS** (Apple silicon and Intel): run this in Terminal.

```bash
curl -fsSL https://raw.githubusercontent.com/amntoppo/MasterDeck-Terminal/main/install.sh | bash
```

It downloads the right build from the latest [release](https://github.com/amntoppo/MasterDeck-Terminal/releases),
installs it in `/Applications` and opens it. Run it again to update. The app is not signed by Apple;
a DMG downloaded in a browser is blocked until you allow it in **System Settings → Privacy & Security
→ Open Anyway**, but a download by `curl` is not, so this needs no such step. See [install.sh](install.sh).

Or download a build from [Releases](https://github.com/amntoppo/MasterDeck-Terminal/releases):

- **macOS:** `MasterDeck-<version>-arm64.dmg` for Apple silicon, or `MasterDeck-<version>.dmg` for
  Intel. macOS blocks it the first time: **System Settings → Privacy & Security → Open Anyway**.
- **Windows:** `MasterDeck Setup <version>.exe`. It is not signed, so SmartScreen asks you to
  confirm: **More info**, then **Run anyway**.

Or build it yourself (see [Develop](#develop)).

## First run

1. **Skills.** MasterDeck copies its skills into `~/.claude/skills/`. It skips any skill folder
   you already have. Settings lists each skill's state and can replace a copy with the bundled one.
2. **Setup** opens by itself, in four steps:
   1. **Tools.** Each of `claude`, `gh`, Python, `git` and `jq` is checked. Without Claude Code, the
      step shows its install command (`curl -fsSL https://claude.ai/install.sh | bash`, or the
      PowerShell one on Windows) with a Copy button. For the others, **Install now** opens a Claude
      session in the dialog that installs them (Homebrew on macOS, winget on Windows); you approve
      its steps there. Missing tools are checked again every few seconds and turn green once
      installed.
   2. **GitHub account.** Pick one of the accounts `gh` is logged in to; the choice becomes `gh`'s active
      account, which MasterDeck, master and your sessions share.
   3. **Repos & boards.** One read lists every organization `gh` can reach, with its repositories and
      project boards. Tick the repositories whose issues you work on and the boards that track them (or
      **Select all** for either), and pick the primary repository (a plain `#12` means an issue there).
      MasterDeck reads each board's statuses and guesses what each means (ready, in progress, PR raised,
      done); adjust the guesses per board if they are wrong. No board: you still get issues, PRs and
      sessions. Settings → Set up MasterDeck shows the same step.
   4. **Preferences.** The folder master and new shells start in (where your repos are), whether to
      use a master-agent, and notifications for new Needs-you items.

   Later, Settings → **Set up MasterDeck** opens the same sections as one page (Tools, GitHub account,
   Repos & boards, Preferences): change any of them and Save.

   Then the **Skills** popup (later: 🧩 Skills in the sidebar) lists the bundled skills: add or
   remove each one. They are optional, for use by hand: MasterDeck moves the board, watches PRs and
   runs `/queue` itself.

   **Skip for now** leaves GitHub unset: sessions work, and the Board and PRs views offer **Connect your
   GitHub**, which opens Setup again.
3. The master pane on the right offers **Start master**, which starts the master-agent session.
   Master is optional: untick **Master agent** in Setup and MasterDeck works without it. You lose
   what only master does: sweeps that propose work, the reports sessions send it (done, blocked,
   questions) and relaying text to sessions in other terminals. New sessions then ask you directly.

Setup saves everything to one file, `~/.claude/master/config.json`. The master CLI, the skills
and the app all read it. To change it later, open **Settings (⚙) → Set up MasterDeck**, or edit it:

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
| `issueRepo` | The primary repository: a plain issue number (`#12`) means an issue there |
| `repos`, `allRepos` | Every selected repository (`owner/name`, primary first); `allRepos: true` after "Select all" |
| `projects`, `allProjects` | Every selected board, each with its own `statusField`, `statusFieldId`, `statusOptions`, `columns`, `statuses` and `sprintField` |
| `project`, `projectId`, `statusFieldId`, `statusOptions` | The first board (kept for older readers); `0` = no board |
| `columns` | The board's statuses, in order |
| `statuses.ready` / `inProgress` / `prRaised` / `devDone` | The status for new work, work in progress, a PR opened, and PRs merged |
| `statuses.done` / `finished` / `assignable` / `resumable` / `blocked` | Status sets: not new work; hidden from pick lists; master may assign; a session may resume; blocked |
| `statuses.rank` | Optional order for "forward only" moves; by default the column order |
| `sprintField`, `sprintQuery` | The board's iteration field and the filter for "my current sprint" |
| `workspace` | Folder where master and new sessions start |
| `masterName` | Name of the master session (default `master-agent`) |
| `masterEnabled` | `false` runs MasterDeck without a master-agent (Setup → Master agent) |
| `accounts` | Connected GitHub accounts (Setup → GitHub accounts): each `login`, `name`/`email` for its commits, `primary` (exactly one), and its own `owner`, `issueRepo`, `repos`, `projects`. The top-level fields above are the primary account's. A repo belongs to one account |

</details>

## Using it

See the [guide](docs/GUIDE.md) for every feature: Needs you, the board, PRs, starting and linking
sessions, costs, standups, the janitor, keyboard shortcuts, environment variables and Windows notes.

MasterDeck also shares one GitHub cache between the app, master and the skills (`ghc`, in
`~/.claude/gh-cache`), so many sessions don't use up your GitHub rate limit.

### From a browser or a phone

1. In the desktop app, sign in under **Settings → Account** (Google, GitHub, or email and
   password), then switch on **Connect to the backend** under **Settings → Remote** (off by default).
2. Open [app.masterdeck.dev](https://app.masterdeck.dev) and sign in with the same account.
3. The Mac asks "Allow <browser> to control this Mac?" with three words. Allow it only if the
   browser shows the same three words. Settings → Remote → Browsers lists approved browsers and can
   revoke them.

On a phone (a screen 760 px wide or less) the web app switches to a phone layout: a tab bar
(Sessions, Tasks, Board, PRs, Master, More), one screen at a time, and a quick-key bar under the
terminal (Esc, Tab, ⇧Tab, ^C, arrows, Enter, y, n, /). Typing in a web terminal shows up at once
(Settings → General → Instant typing). The Mac must be on and MasterDeck running. Details:
[guide § Web app](docs/GUIDE.md#web-app-appmasterdeckdev).

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
npm run dev:web      # the web app (vite); /?preview shows it with sample data, no Mac or sign-in
npm run deploy:web   # publish the web app to app.masterdeck.dev (Cloudflare, needs wrangler login)
```

Python tests for the master CLI: `python3 -m pytest skills/master/tests -q` from the repo root.

Layout:

```
app/            Electron + React + xterm.js app (main, preload, renderer, shared; src/web = web app)
skills/         the Claude Code skills MasterDeck installs (master holds the CLI in lib/)
docs/           GUIDE.md (features), ARCHITECTURE.md, REMOTE.md, OPERATIONS.md, TODO.md
```

The backend for remote access (Cloudflare Worker at `dev.masterdeck.dev`) lives in a separate
repository; see [docs/REMOTE.md](docs/REMOTE.md).

After `dist:mac` has built x64, run `npx electron-builder install-app-deps` to restore the arm64
node-pty for `npm run dev`.

## Privacy

MasterDeck runs on your machine. It talks to GitHub through your own `gh` login and to Claude
through your own `claude`. It has no telemetry. It stores its data in `~/.claude/` (`master/`,
`masterdeck/`, `gh-cache/`).

Remote access is off until you sign in and switch on Settings → Remote. Then the Mac keeps a
connection to `dev.masterdeck.dev` and uploads a snapshot of Tasks, Needs you and the board (only the
changes after the first one), so the web app and the API can show them; never terminals or files.
Terminal output and anything typed in the web app travel end-to-end encrypted between the approved browser and your Mac; the
server relays them without being able to read them. Switching Remote off or signing out stops all of it.

## License

[MIT](LICENSE)

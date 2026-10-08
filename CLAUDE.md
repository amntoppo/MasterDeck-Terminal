# CLAUDE.md

MasterDeck: an Electron app (macOS and Windows) that puts every Claude Code session in one window,
plus the Claude Code skills it works with. Since 0.6.x it also has an account, a remote line to the
MasterDeck backend (phone/API/CI control) and a web app (app.masterdeck.dev) that drives the Mac
end-to-end encrypted.

Open source, public (github.com/amntoppo/MasterDeck-Terminal, default branch `main`): never add
company names, private repos, people, tokens or paths from a real machine (fixtures use the
fictional org `acme`).

Start here, then read what the task needs:

| Doc | What |
|---|---|
| [docs/README.md](docs/README.md) | Index of every doc |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Main process, IPC, shared modules, renderer, AppState, files on disk |
| [docs/REMOTE.md](docs/REMOTE.md) | Account, CloudSync, browser bridge, web app, instant typing, remote indicator, message tables |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Build/install/release, web deploy, isolated E2E recipe, measuring upload, troubleshooting |
| [docs/TODO.md](docs/TODO.md) | Open work, prioritized, and recently done (with commits) |
| [docs/GUIDE.md](docs/GUIDE.md) | The user guide: every feature as a user sees it |
| [TODO.md](TODO.md) | Older design note: supporting Codex / Copilot CLIs |

## Two repos, one product

| Repo | Where | What |
|---|---|---|
| MasterDeck (this) | `~/Documents/MasterDeck-Terminal`, public, `main` | Desktop app (`app/`), skills (`skills/`), web app source (`app/src/web` + the renderer) |
| masterdeck-backend | `~/Documents/masterdeck-backend`, private, `master` | Cloudflare Worker + Durable Objects (UserHub per user, SQLite), accounts (Better Auth), browser relay. API at https://dev.masterdeck.dev |

Specs, plans and reports for the remote/account/web work live in the **backend** repo:
`masterdeck-backend/docs/superpowers/{specs,plans,reports}` (plans A-G, 2026-10-02).

## Layout

- `app/` — the Electron app (electron-vite, React 19, xterm.js 6, node-pty, zod, ws, fast-json-patch).
  - `src/main/` — main process. `index.ts` (startup, IPC handlers, remote wiring), `sources.ts`
    (polling, builds `AppState`), `ptys.ts` (terminals), `send.ts` (typing into sessions),
    `inbox.ts` (Needs you store), `hooks.ts` / `deckHooks.ts` (Claude Code hooks), `watches.ts`
    (monitors), `workflow.ts`, `queue.ts`, `skills.ts`, `tokens.ts`, `summary.ts`, and the remote
    side: `account.ts` + `loopback.ts` (sign-in), `cloudSync.ts` (line to the backend),
    `remoteCommands.ts` (commands run once), `browserBridge.ts` + `browserStore.ts` + `macKey.ts`
    (web app), `ipcRegistry.ts`, `remoteGuards.ts`, `remoteToken.ts`.
  - `src/shared/` — pure logic and types used by main, renderer and web (`types.ts` has `AppState`,
    `ipc.ts` the channels `CH` and `DeckApi`, `remote.ts` the wire protocol, `remoteDeck.ts` the web
    allowlist, `e2e.ts` the crypto). Put testable logic here.
  - `src/preload/index.ts` — exposes `DeckApi` as `window.deck` in the Electron window.
  - `src/renderer/src/` — React UI (`App.tsx`, `components/`, one `styles.css`, `predictiveEcho.ts`,
    `web.ts` for web gating).
  - `src/web/` — the web app shell: `Gate.tsx` (sign-in, approval, socket, channel),
    `remoteDeck.ts` (`window.deck` over the encrypted channel), `approval.ts`, `keys.ts` (IndexedDB).
  - `web/wrangler.jsonc` — the `masterdeck-web` static Worker on app.masterdeck.dev.
  - `scripts/install-mac.sh` (copy the built app to /Applications), `scripts/sync-protocol.sh`.
  - `test/fixtures/` — `agents.json`, `board*.json`, `repo-issues.json`, `ledger.json`, `snapshot.json`, `claude-echo.json`.
- `skills/` — skills shipped with the app (master, babysit-ticket, babysit-pr, babysit-worktree,
  kill-worktree, worktree-janitor, queue). MasterDeck no longer depends on babysit-ticket,
  babysit-pr or queue — it does their automatic parts itself (PR watch, board moves, /queue hook) —
  they stay for use by hand. `skills/master/` is also the `master` CLI (Python,
  `lib/master/`) that the app calls for the ledger, snapshot, board, config and spawning.
  (`skills/babysit-proof/` on disk is a leftover `__pycache__` only; the skill was removed in 9329db4.)
- `docs/` — see the table above. `README.md` — install, first run, config fields.
- `install.sh` — the one-line macOS installer (downloads the latest release DMG).
- `.github/workflows/ci.yml` — Python tests, typecheck, vitest, DMG/EXE builds; tags publish a release.

## Commands

```bash
cd app
npm install          # postinstall runs electron-builder install-app-deps (node-pty for Electron)
npm run dev          # the app with hot reload
npm run typecheck    # tsconfig.node.json + tsconfig.web.json; must be clean
npm test             # vitest: ~1500 tests in ~133 files (~45 s); predictiveEcho alone ~30 s
npm run build        # electron-vite build → out/
npm run build:web    # web app → out/web (MD_API must be https:// in production)
npm run dev:web      # web app dev server (MD_API=http://localhost:8787 for a local backend)
npm run deploy:web   # build:web + wrangler deploy -c web/wrangler.jsonc (only when asked)

cd ..
PYTHONPATH=skills/master/lib python3 -m pytest skills/master/tests -q   # master CLI, ~226 tests
```

### Rebuild + reinstall the local app (after EVERY change)

```bash
cd app
rm -rf dist                                   # disk is often short
npm run build && npx electron-builder --mac dir --arm64
npx electron-builder install-app-deps         # ALWAYS: else node-pty stays x86_64 (tests/dev break)
osascript -e 'quit app "MasterDeck"'
while pgrep -f /Applications/MasterDeck.app >/dev/null; do sleep 1; done
./scripts/install-mac.sh
open /Applications/MasterDeck.app
```

Background Claude sessions survive the quit (they run under Claude Code's daemon). Details,
release steps and the full DMG build: [docs/OPERATIONS.md](docs/OPERATIONS.md).

Smoke test of a packaged app: `MASTERDECK_NO_SKILLS=1 MASTERDECK_SMOKE=1 MASTERDECK_USER_DATA=<tmp>
dist/mac-arm64/MasterDeck.app/Contents/MacOS/MasterDeck` prints `SMOKE OK sessions=… issues=…` and quits.

## Operating rules (from the user; follow exactly)

- **Never push** MasterDeck (or the backend) unless the user asks. `main` is ahead of `origin/main`
  (21 commits as of 2026-10-03). Never deploy the web app or the backend unless asked.
- **After every change: rebuild, reinstall and relaunch** the local app (recipe above).
- **No real GitHub writes in tests** (issues, comments, board moves, PRs): dry runs only.
- **Never type into the user's real Claude sessions**, and never answer their Needs-you items. For
  a live probe use a throwaway haiku session in a temp dir ([OPERATIONS](docs/OPERATIONS.md#a-throwaway-claude-session)).
- **Isolated test app** for anything that clicks: `MASTERDECK_HOME`, `MASTERDECK_USER_DATA`,
  `MASTERDECK_ISOLATED=1` in a temp dir, `npx electron . --remote-debugging-port=9333` from `app/`,
  drive it over CDP with `window.deck` ([recipe](docs/OPERATIONS.md#isolated-e2e-test-recipe)).
- **Cleanup deletes listed paths only**: never `rm -rf` a guessed folder under `~/.claude/projects`.
- Never commit `.superpowers/` (git-ignored). Backend secrets live in `~/.config/masterdeck-remote/`.
- Process for features: brainstorm → spec → plan → subagent-driven development with per-task
  reviews and a final review (superpowers skills); specs/plans go to the backend repo's
  `docs/superpowers/`.
- **Keep the docs current — part of every change, not a follow-up.** In the same commit as the code:
  update the doc that describes what you changed (`docs/ARCHITECTURE.md`, `docs/REMOTE.md`,
  `docs/OPERATIONS.md`, `docs/GUIDE.md` for anything user-facing), move finished items from
  `docs/TODO.md` to its "Recently done" list (with the commit) and add new open items you found,
  and refresh this file's "Current state and next steps". Protocol changes also update the
  backend's `docs/PROTOCOL.md`. Docs describe the code as it is: when they disagree, fix the doc.

## Protocol copy rule

`app/src/shared/remote.ts` is a **byte-for-byte copy** of `masterdeck-backend/src/protocol.ts`.
Never edit it by hand: change the backend file, then `app/scripts/sync-protocol.sh` (reads
`$MASTERDECK_BACKEND`, default `../../masterdeck-backend` from `app/scripts`). The drift test
`app/src/shared/remote.drift.test.ts` compares the two; it resolves the backend as the sibling
checkout (or `MASTERDECK_BACKEND`) and **skips** when that is missing (so it never runs in CI).
`session.start.account` (2026-10-03) is optional; desktops before it refuse a command that sets it.
It fails when the backend checkout is on a branch with a different `protocol.ts`.
`PROTOCOL_VERSION` is 3 (`MIN_PROTOCOL` 2); keep changes additive so old desktops, servers and
web tabs keep working.

## Where things live

| Subsystem | Code |
|---|---|
| Sessions, GitHub, board, polling, `AppState` | `main/sources.ts` (`Sources.build()`), `shared/derive.ts`, `shared/review.ts` |
| Needs you (inbox) | `shared/inbox.ts` (items), `main/inbox.ts` (store, events), `runInboxAction` in `main/index.ts` |
| Typing into sessions | `main/send.ts` (`Sender`), `shared/send.ts`, `shared/promptGuard.ts` |
| Terminals | `main/ptys.ts` (`PtyManager`), `shared/paneCommand.ts`, `renderer/.../TerminalView.tsx` |
| Hooks | `main/hooks.ts` (settings.json installs, `hookStatus`, one-time `migrateLegacyHooks` of the old skill hooks), `main/deckHooks.ts` (MasterDeck's hook script, incl. the master reports guard on `SendMessage`), `shared/deckHooks.ts` |
| Monitors / schedules | `main/watches.ts`, `shared/watches.ts`, `shared/schedules.ts` |
| PR watch | `main/prWatch.ts`, `shared/prWatch.ts` |
| Board moves | `main/boardOps.ts`, `main/boardFlow.ts`, `main/ticketLinks.ts`, `shared/ticketLinks.ts` |
| Board without a GitHub project | `shared/derivedBoard.ts` (`boardless`, `deriveBoard`, `tabBoard`, `boardEmpty`, `unreadRepos`, `awaitingRead`, `canMove`, `boardWanted`), `Sources.build()` / `refreshBoard`, `renderer/.../BoardView.tsx`, `skills/master` (`config.boardless`, `collect.Live.repo_issues`, `board.derived_status`, `normalize.repo_issues`) |
| Board repository view | `shared/repoView.ts` (`repoViewOn`, `askPlan` / `cleanRepos`, `repoPickable`, `repoRefusal`, `admitRepo`, `offBoardOk`, `reposFilterPick`, `applyRead`, `viewOf`, `repoViewDeriver`, `repoViewBoard`, `repoViewStatus`, `boardChips`), `main/repoIssues.ts` (`RepoIssues`: ask, refresh, cache), `Sources.askRepos` / `build()` / `refreshGithub(force, repoForce)`, `renderer/.../BoardView.tsx` (`repoMode`, `worked`, `boardTicketContext`), `skills/master` (`cli.cmd_repo_issues`, `collect.Live.repo_issues(only=, boards=)`) |
| Who can be assigned (Assign popup, Assignee filter) | `main/assignUsers.ts` (`AssignableUsers`: per repository, as its account, an hour), `GitHub.assignableUsers(force, repo)`, `shared/boardFilter.ts` (`assignChoices`, `assignSeed`, `tabFilterUsers`), `renderer/.../AssignPopup.tsx`; `state.users` is the primary issue repo's only. A card's GitHub calls go out as `accountClients.forCard` (its repository's account, else the account with that owner, else the account whose board holds it, else the primary; `cardBoardless` is the matching gate): use it, not `forRepo`, for anything done for a card |
| Create a GitHub board | `main/boardCreate.ts` (`BoardCreator`, `accountGh`, `columnsOf`), `shared/boardCreate.ts`, `renderer/.../CreateBoardDialog.tsx` |
| Create with Claude (Board ticket builder) | `main/ticketDirs.ts` (folders, one per tab with two or more accounts; request pump), `shared/ticketBuilder.ts`, `renderer/.../BoardView.tsx` |
| Workflows | `main/workflow.ts` (`WorkflowStore`), `shared/flow*.ts`, `renderer/.../FlowEditor.tsx` |
| Queue | `main/queue.ts`, `main/deckHooks.ts` (hook.sh `/queue` + Stop handshake) |
| master-agent | `main/masterCli.ts`, `main/assign.ts`, `skills/master` |
| The Start dialog's options (worktree made before the start, permission mode, remembered choices) and its Markdown preview | `shared/startOptions.ts`, `main/startWorktree.ts` (`worktreeInfo`, `createWorktree`), `worktreeFolder` in `main/remoteGuards.ts`, `AssignRequest.permissionMode` → `master add --permission-mode` → `spawn.command`, `shared/markdown.ts` + `renderer/.../MarkdownView.tsx` (reuse for any Markdown view), `renderer/.../AssignDialog.tsx` |
| Where a ticket's session starts (per-account workspace, the repository's checkout) | `skills/master/lib/master/checkout.py` (`resolve`, `scan`: the one implementation), `config.workspace_for`, `rules._assign`, `cli.cmd_draft_assign` / `cmd_checkout`; the app only shows it: `shared/startFolder.ts`, `renderer/.../AssignDialog.tsx` (`StartFolderLine`), `inRepoFolder` in `main/assign.ts` (PR review), `chosenFolder` in `main/remoteGuards.ts`; every account's repos on disk: `main/checkouts.ts` (`workspaceRepos`, behind `Ops.repos()`); whether a folder's branch is the session's: `ownsFolderBranch` in `shared/parked.ts`, `main/parked.ts` (`parked-sessions.json`, written by `master spawn`: `checkout.parked`), `Sources.ownsBranch`; Setup: `workspacesFromConfig` / `accountsFromSetup` / `swapPrimaryWorkspace` in `setupAccounts.ts` |
| Whether Claude Code may work in a folder (its trust prompt), and a start it refused | `skills/master/lib/master/trust.py` (the one reader of Claude Code's `.claude.json`, read only: `trusted`, `wait`, `not_trusted`; `master trust`, `trusted` in `draft-assign` / `checkout`), `MasterCli.trust`, `shared/trust.ts` (`isNotTrusted`, `trustView`, `startBlocked`, `heldForTrust`, `trustHeldAssign`, `startFlags`, `retryRequest`, `waitForTrust`), `renderer/.../TrustFix.tsx` (`useTrust`, `TrustNote`: Start dialog, `StartRefused` in `App.tsx`, the held `ProposalCard`), **Open Claude there…**: `openClaude` in `main/index.ts`, `claudeFolder` in `main/remoteGuards.ts`, the `claude-here` pane; Try again: `AssignRequest.retry` / `retryHeld` in `main/assign.ts` → `MasterCli.spawnHeld` (`master spawn --held-for-trust`, `held_for` in the ledger); who asked an inbox action: `inboxActCall` in `main/remoteGuards.ts` |
| GitHub accounts | `main/accountEnv.ts`, `main/sessionAccounts.ts` (also resume: `resumeAs`), `main/superseded.ts` + `shared/superseded.ts` (the old side of a copy, hidden), `main/accountClients.ts` (which account MasterDeck's own calls use), `shared/accounts.ts`, Setup's accounts step: `renderer/.../SetupDialog.tsx`, `renderer/.../setupAccounts.ts`, badges/pickers: `renderer/.../AccountBits.tsx` |
| Account | `main/account.ts`, `main/loopback.ts`, `shared/account.ts`, `renderer/.../AccountPanel.tsx` |
| Remote line | `main/cloudSync.ts`, `main/remoteCommands.ts`, `shared/remoteSnapshot.ts`, `shared/remoteGuard.ts`, `shared/remote.ts` |
| Web bridge | `main/browserBridge.ts`, `main/browserStore.ts`, `main/macKey.ts`, `main/ipcRegistry.ts`, `main/remoteGuards.ts`, `shared/{e2e,bridgeWire,remoteDeck}.ts` |
| Web app | `src/web/*`, `renderer/src/web.ts`, `renderer/src/webConfirm.ts`, `vite.web.config.ts`, `web/wrangler.jsonc` |
| Instant typing | `renderer/src/predictiveEcho.ts` (+ `.test.ts`, `test/fixtures/claude-echo.json`) |
| Notes | `shared/notes.ts` (types, limits, checks), `shared/noteEditor.ts` (`NoteEditor`: the editor's saves, switches, conflicts), `main/notes.ts` (`NotesStore`), `renderer/src/notes.ts` (`useNotes`, `ticketNote`), `renderer/.../NotesPanel.tsx`; entry points in `Rail.tsx`, `SessionDetails.tsx`, `BoardView.tsx` (`Card`) |
| Remote indicator | `renderer/.../Rail.tsx` (`RemoteIndicator`), `shared/remotePresence.ts`, `shared/deviceInfo.ts` |
| Working hours (Costs → Hours) | `shared/hours.ts` (`estimateHours`, `hoursAccount`, `hoursCsv`), activity spans in `shared/tokens.ts` / `main/tokens.ts` (`TokenIndex.activity`, `tokens.json` v2), `Sources.hoursActivity`, `CH.hoursActivity` / `CH.hoursExport` in `main/index.ts` (blocked on the web), `renderer/.../HoursView.tsx` |

## Adding a feature

- New data for the UI: compute it in `sources.ts` (or a module it calls), add it to `AppState`
  (`shared/types.ts`), and to the `AppState` fixture in `shared/notify.test.ts`. If it should reach
  the phone/API, add it to `toRemoteSnapshot` (`shared/remoteSnapshot.ts`) and the backend's
  `RemoteSnapshot` (protocol copy rule) — and to `volatileKey` if it ticks without meaning.
- New action: a channel in `CH` and a method on `DeckApi` (`shared/ipc.ts`), the handler in
  `main/index.ts` (`reg.handle`/`reg.on`, never `ipcMain` directly), the bridge in `preload/index.ts`,
  **and an entry in `DECK_ACCESS`** (`shared/remoteDeck.ts`: `remote`, `event`, `local` or `blocked`;
  `remoteDeck.test.ts` fails without one). Validate IPC input in main. A handler reachable from the
  web gets `e = {remote: true}` (`isRemote(e)`): native dialogs must be skipped there (the web asked
  with `webConfirm`), and settings/dirs/PTY sizes go through `remoteGuards.ts`.
- Anything written to the user's machine (settings.json, skills, config) keeps a backup and is
  written atomically (temp file + rename). Hooks MasterDeck installs carry a marker so they can be
  found, updated and removed again (`hooks.ts`, `shared/workflow.ts`).
- Update `docs/GUIDE.md` (and `README.md` when install/setup changes) with the feature.

## Testing without touching the real machine

Never run a test build against the real `~/.claude/settings.json` or skills: a click in its UI writes
there. Isolate with:

| Variable | Replaces |
|---|---|
| `MASTERDECK_CLAUDE_SETTINGS` | `~/.claude/settings.json` (point at a copy) |
| `MASTERDECK_HOME` | `~/.claude/masterdeck` (costs, tokens, summaries, workflow, restore list, remote files) |
| `MASTERDECK_ISOLATED=1` | with `MASTERDECK_HOME`: settings default to `<home>/claude-settings.json`, skills to `<home>/skills` (use for every isolated test launch) |
| `MASTERDECK_SKILLS_DIR` | `~/.claude/skills` |
| `MASTER_HOME` | `~/.claude/master` (config.json, ledger) — empty folder = first-run Setup |
| `MASTER_WORKSPACE` | the config's workspace, and every account's own (keeps Janitor/standup on a temp repo) |
| `MASTERDECK_USER_DATA` | Electron user data (window state, localStorage) |
| `MASTERDECK_REMOTE_URL` | backend address (https, or `http://localhost:<port>`; anything else silently falls back to dev.masterdeck.dev) |
| `MASTERDECK_NO_SKILLS=1`, `MASTERDECK_NO_HOOK=1` | skip installing skills / the status line and deck hooks |
| `MASTERDECK_SETUP_MISSING=jq,claude` | Setup's tools step reports these as missing (the install flow) |
| `MASTERDECK_TEST_NO_ATTACH=1`, `MASTERDECK_BOARD_FIXTURE=<json>`, `MASTERDECK_REPO_FIXTURE=<json>` | refuse `claude attach`; use a fixture board; use a fixture answer for the Board's repository view |

Note: an isolated app still lists the user's real sessions (`claude agents`, `~/.claude/projects`).
Look, don't touch.

To look at or drive the UI, launch with `--remote-debugging-port=<port>` and use the Chrome DevTools
Protocol (`Runtime.evaluate` on `window.deck…`, `Page.captureScreenshot`). DOM `click()` works for
buttons; it does not go through macOS window drag regions.

## Gotchas learned the hard way

- **node-pty architecture**: `electron-builder --mac` (x64 too) or a dir build leaves node-pty built
  for the wrong arch; run `npx electron-builder install-app-deps` after every packaging build.
- **Window drag regions**: headers use `-webkit-app-region: drag`. Electron applies drag/no-drag in
  DOM order, so an element floating over a header must come after it in the DOM to be clickable
  (the ★ Master button is the last child of `.app` for this reason).
- **Hooks that match a Bash command** must match a command that runs (start of line or after
  `; & | (`), with heredoc bodies stripped (`runsOrExit` in `shared/workflow.ts`); otherwise text
  written to a file that mentions `gh pr create` fires them.
- **Resume a background session with no flags**: `claude --bg --resume <id>` alone wakes the same
  session; any flag (`-n`, `--settings`, `--model` …) starts a copy and leaves the old one listed
  (duplicate sessions). Go through `resumeAs` (`main/sessionAccounts.ts`) / `spawn.command`; they
  pass flags only when the user picked another account or a name. MasterDeck never removes a
  session (`claude rm` deletes its worktree too): the old side of a copy is listed in
  `superseded-sessions.json` (`main/superseded.ts`) and hidden while it does not run.
- **Shell scripts run under macOS bash 3.2**: write `${var}` before non-ASCII text (`"$chip…"` breaks).
- **A ticket session MasterDeck starts sits in its repository's main checkout** until it makes its
  worktree (a PR review stays there), on whatever branch was left checked out. `master spawn`
  records it (`parked-sessions.json`); before giving a session anything that belongs to "the branch
  of its folder" (a PR, a branch link) ask `Sources.ownsBranch` / `ownsFolderBranch`
  (`shared/parked.ts`). A session with no record (started by hand) owns its folder's branch as
  always. And `rules.propose` reads the filesystem now (`checkout.resolve`), and `master spawn` writes
  under `MASTERDECK_HOME`: the Python tests' `conftest.py` puts HOME and every such folder in a
  temp sandbox (`test_isolation.py` guards it). Never run a Python test that bypasses it.
- **Tickets are (repo, number)** (`shared/ticket.ts`, Python `refs.py`). The primary repo (`issueRepo`)
  keeps bare numbers in every record (ledger, babysit-ticket state, snapshot), so older readers still
  work; other repos add a `repo` field. Compare with `ticketKey`/`sameTicket`, never `.number` alone.
- **Needs you is the inbox** (`shared/inbox.ts` builds items, `main/inbox.ts` stores them): add a new
  kind there (id, priority, actions, resolution reason, notice), and act only through `inboxAct` /
  `runInboxAction`, never from a card directly. Nothing resolves while the state is still loading.
- **macOS notifications need a whole-bundle signature.** Without one (only the executable's linker
  signature) macOS never registers the bundle id, so notifications silently never show and the app
  is missing from Settings → Notifications. The build ad-hoc signs (`identity: "-"`, no hardened
  runtime); install.sh re-signs older releases.
- **Claude session ids change on resume**; the background id (first 8 chars) does not. Key per-session
  data by `Session.key` where it must survive a resume.
- **Transcripts** repeat each assistant message on several lines (same `message.id`): count usage once
  per id. Claude Code writes a `pr-link` record for every PR a session creates.
- `claude --bg --resume <id>` on a session that is already running starts a copy: check `claude
  agents --json` first.
- An AskUserQuestion menu is not in the transcript until it is answered: read it from the screen
  (`claude logs <id>`, rendered with `@xterm/headless`; `shared/ask.ts` `parseMenuScreen`).
- The shared GitHub cache (`ghcache`) keys calls by account (`GHC_ACCOUNT`, two or more connected
  accounts): MasterDeck's own calls and every session started as an account (its settings file sets
  `GH_TOKEN` and `GHC_ACCOUNT`, so `ghc` in it never serves another account's answers). A `GH_TOKEN`
  without `GHC_ACCOUNT` keys on a short hash of the token (`-t<hash>`, pause `paused--t<hash>.json`);
  calls with neither (one account, plain shells) keep today's keys, which follow gh's active account.
- One account runs as gh's active account: when that is not MasterDeck's primary (`gh config get user`,
  each minute), Needs you says to `gh auth switch -u <primary>` (`accountNotices`). With two or more,
  a master-agent not recorded as started with the primary's `--settings` gets a "restart master-agent" notice.
- Tests that spawn bash/jq/git get a 20 s timeout; the full suite runs files in parallel.
- `claude -p` for app features (summaries): run from an empty temp folder with
  `--no-session-persistence`, tell the model the writing style, and remove the empty
  `~/.claude/projects/<folder>` it leaves.
- **`claude --bg` in a fresh temp dir** stops on "Workspace not trusted"; accepting writes the real
  `~/.claude.json`. For web E2E use a shell pane ("Terminal in a repo") unless the user agrees.
- **Claude Code's trust is per folder, and MasterDeck only reads it.** A session starts in the
  ticket's repository's checkout, which needs an accepted trust prompt for itself or a folder
  inside the repository above it (Claude Code walks up to the git root only; a trusted workspace
  above a repository does not count, while a plain folder is covered by any trusted parent). `trust.py` reads `.claude.json` and nothing in MasterDeck
  may write it or pass a flag that skips the prompt: the fix is always the user answering Claude
  Code's own prompt (**Open Claude there…**). Unknown is never shown as trusted. A new place that
  can show a failed start should go through `isNotTrusted` and `TrustNote`, and retry the held
  proposal (`retry: true` / `retryHeld`), never add a second one. What may be retried is decided by
  the CLI alone (`master spawn --held-for-trust`: the `held_for: "trust"` mark it wrote itself, and
  no live session of that name); never judge it by a proposal's note, and never open a retry path
  that calls the plain `spawn`. Opening Claude on the Mac is the window's only: anything reachable
  from the web checks `isRemote(e)` (the `inboxAct` handler refuses only `trust` for it; the web app's
  other inbox actions run as the window's).
- **Never launch the isolated app with a temp `HOME` on macOS** (a system keychain dialog blocks
  startup); use `CLAUDE_CONFIG_DIR` for a fake `.claude.json` and a stand-in `claude` on the PATH
  ([OPERATIONS](docs/OPERATIONS.md#isolated-e2e-test-recipe)). A test that touches `PtyManager`
  mocks `node-pty` for the whole file (`vi.mock`), and a Python test around `cli.main(["spawn", …])`
  patches `subprocess.run`: a red test must not be able to start a process either.
- **Remote text** may never start with `/` or `!` or contain control characters (`noEscape`), and
  remote sends are never relayed through master-agent (`sendMasterUp(true, …)` is false).
- **Claude Code's TUI runs on the alternate screen** (`?1049h`) with mouse/focus/bracketed-paste
  modes; instant typing only observes there until it has seen 3 exact echoes.
- **A Board tab without a GitHub board is derived, not stored.** `boardless(login, cfg)` (TS) /
  `config.boardless(view)` (Python) is the one check. `master board` sends such an account's
  repository issues as cards with `derived: true` and no status; `Sources.build()` gives them a column
  on every state (`deriveBoard`). Anything that reads `state.board` sees those columns but must not
  write them: `setStatus`, BoardFlow's moves and drags do nothing for a card with no `project`
  (`canMove` in the renderer, the `setStatus` handler in main). An issue that is on one account's
  board and in a ticked repository of an account with no board is always the board's card
  (`board.on_boards`, in `board.build` and `snapshot.merge`), whichever account is read first.
- **The Board's repository view never touches `state.board`.** A tab with repositories picked, on an
  account with a board (`repoViewOn`), shows `state.repoView`: issues read by `master repo-issues`
  only when a tab asks (`deck.boardRepos` → `RepoIssues.ask`). In `BoardView`, `worked`
  (`fallback || repoMode`) answers "are the columns MasterDeck's" (no drag, no sprint picker, no
  Summary) and `fallback` alone answers "has the account no board" (the hint, Create a GitHub board, a
  ticket with no board step): use the right one. Its cards are `derived`, so every guard against
  writing a derived card's status covers them. master never sees these issues. The state carries
  only the repositories on screen (asked within the hour), at most 1200 cards, 500 KB of JSON
  (`viewOf`: `REPO_VIEW_MAX_BYTES`) and 30 repositories. That bounds the view's share, not the
  state: the web bridge drops a whole state over about 1.05 MB of JSON, so anything new in the view
  must go through `viewOf`'s budget.
  What is never read and what the tab says about it come from one rule, `askPlan` (`cleanRepos` and
  `repoViewStatus` both use it): a new reason to drop a repository goes there, or the tab shows
  "Loading issues…" for ever. `RepoIssues` never drops a repository a tab still shows (asked within 25 minutes, `REPO_VIEW_HELD_MS`; published and refreshed for an hour, `REPO_VIEW_LIVE_MS`); a new one
  that finds no room is refused with a note (`admitRepo`).
  `master repo-issues` is the one place that cuts a long list into reads of ten per account.
  Only the Board's own Refresh / Retry forces the read past the gh cache (`refreshGithub(force,
  repoForce)`); the refresh after a ticket or an assign does not.
- **A session can be linked to an issue no board holds** when its repository is selected in Setup
  (`LinkDeps.offBoard`, decided by `offBoardOk`: listed in Setup, or, unlisted, a repository of the
  owner of an account that itself has Select all; the CLI's `config.repo_readable` is the same rule,
  and `repo_allowed` is the looser one for what GitHub returned). A linked ticket need not have a
  card: anything that wants its status must look for `card.project` first, as `BoardFlow.move` does.
  The session's PR is added to the issue as a closing reference (`linkPr`): merging it closes the
  issue, also one no board holds.
- **The isolated app rewrites `$MASTER_HOME/config.json` into the accounts form on first start**
  (with the machine's gh login). To change the repositories of a second run, edit
  `accounts[].repos` too, or start from a fresh `$MASTER_HOME`.
- **A project board with no sprint field matches nothing under `sprint:@current`.** Boards MasterDeck
  creates carry `sprintless: true` in the config: their filter drops the sprint part
  (`board.sprintless_query`) and what is mine on them counts as current. GitHub's detection never
  says so: anything that rebuilds a project entry from a detected board must carry the mark over
  (Setup: `markMade` and `withFound` in `setupAccounts.ts`), and only while the detected board has
  no sprint field: once GitHub reports one, the mark is dropped. Boards without a sprint field that were
  picked in Setup are not marked (see TODO).
- **The shared gh cache treats any GraphQL call with the word `mutation` in an argument as a write**
  (`ghcache.is_read`): never use that word in a read query (a field name, a comment), and every write
  document must contain it. Board creation passes variables with `-f` (raw strings), never `-F`.
- **Board creation is never run by a test or an agent.** `main/boardCreate.test.ts` uses a fake gh;
  the isolated app must not press **Create a GitHub board** (its plan read and native dialog run as
  the machine's real gh account). The first real run is the user's.

- **Notes are private and are not state.** They have their own channels (`notes:*`) and never enter
  `AppState`, `toRemoteSnapshot`, a prompt or a GitHub call; a new reader of `NotesStore` needs a
  decision first. A save carries `base`; never write a note without it except with the user's **Keep
  mine**. A web tab gets a 120-character preview with the list and the change event; a full text
  goes to it in two answers only: `notes:get`, and the conflict answer of `notes:save` (the stored
  note, to the tab that tried to save over it). A file in the notes folder that is not a note is
  never overwritten. A failed disk write is answered with `retry: true` and a message without the
  path (`diskError`): the editor retries those and only those on a timer; keep a new store failure
  on the right side of that line. The rail (z-index 41) is above the panel (40), and the phone's tab
  bar (47) above its sheets (45, 46): a popout of either must stay visible over an open panel.

## Style

- Code reads like the surrounding code; comments say why, not what. UI text is plain, short, active.
- Deliberate simplifications carry a `ponytail:` comment naming the ceiling and the upgrade path.
- Commits: a clear subject, then a body that explains the change and why; no ticket noise. Commit
  messages end with the `Co-Authored-By` line the session gives you.
- Releases: see [OPERATIONS § Release](docs/OPERATIONS.md#release) (only when the user asks).

## Current state and next steps (2026-10-09)

- **Working hours per account** (issue #64) are built on branch `worktree-MasterDeck-Terminal-64-hours`
  (not merged, not pushed): the Costs view's **Hours** estimates time per GitHub account, day and
  ticket from session activity on this Mac (idle gap 1 h by default, an account counts a minute once,
  each ticket its full time, unknown account listed), with CSV export; desktop only. Decisions are on
  the issue; the spec is in the backend repo (`docs/superpowers/specs/2026-10-09-working-hours-design.md`,
  branch `docs/working-hours-64`, not pushed). Open points: TODO ("Working hours: open points").

- **Notes** (issue #63) are built on branch `worktree-MasterDeck-Terminal-63-notes` (13 commits from
  0e93bb3: twelve to the docs commit 45b81dc, then the final review's fixes, the commit that carries
  this line): not merged, not pushed, **not installed** (Step 8, the rebuild and relaunch of the
  real app, waits for the user's word). A rail panel (under More on a phone) for the user's notes and
  one note per ticket (Details, a mark on the Board card), saved under `MASTERDECK_HOME/notes`, open to
  the web app over the bridge. Checked: typecheck, vitest (133 files passed, 2 skipped; 1515 tests
  passed, 4 skipped), the web build (`build:web`), the Python suite (450; three ghcache tests fail only when the shell has
  `GH_TOKEN` / `GHC_ACCOUNT` set, so run it with those unset), and the isolated app (a note typed and
  found after a restart, a ticket's note from a Board card and its removal when emptied, search, "Changed
  elsewhere" with Keep mine, nothing but `notes/*.json` holding note text, no `.tmp`, no note text in
  `getState()`). The final review's fixes (a save at the latest 2 s after the first unsaved key, a
  failed disk write retried and answered without its path, a flush when the tab is hidden, the rail
  above the panel, the phone's tab bar above the sheet) were checked by the suites, and on screen: a
  rail tooltip over the open panel in the isolated app, and the More menu over the open sheet (its
  items pressed with real pointer events) in the web preview at 390 x 844. Not checked: the native
  Delete dialog, the session Details entry on screen (no listed session had a ticket), the remote
  indicator's card over the panel (nothing was connected), the real web app over the real bridge, a
  real phone, Windows. The Python suite was not run again for the final fixes (no Python changed).
  Open points are in TODO ("Notes: open points").
- **Where things stand:** `main` is pushed and released as **v0.8.2** (2026-10-06; v0.8.0 and v0.8.1 had no Windows build): several GitHub
  accounts (plan I, merge 6a83862), the Board without a GitHub project (plan J, merge 7714ec8), the
  Board's repository view with assignable users per repository (plan K, merge e75ec9c) and a
  workspace per account (merge 660c726). Installed locally; the web app is redeployed from this
  `main`. The backend's `session.start.account` is merged and deployed (backend PR #10); specs and
  plans are on backend `master` (PR #11). The bullets below say what was checked for each feature
  before the release; where they say "not pushed", that was true then.
- **The Start dialog is redesigned (#66)** (branch `worktree-MasterDeck-Terminal-66-start-session`,
  not merged; see "The Start dialog's options" under Where things live): four groups, **Create
  worktree** with branch name and base branch (made before the session, the Mac's window only, only
  in the ticket's checkout or a chosen folder, never for a held refused start), **Permission mode**,
  **Assign to me**, **Remember these choices** per repository (never applied to a dialog opened from
  a proposal, so an unchanged proposal is still approved or tried again as it is), and the
  description's **Text / Preview**. Checked in an isolated app with a stand-in `claude`: the
  Preview, the "branch already exists" error (no worktree, no session), a start in a new worktree
  with `--permission-mode plan`. Not checked live: Assign to me (a real GitHub write), a real
  `claude --bg` in a fresh worktree (trust is assumed to follow the checkout above it), the web
  app. Leftovers: `docs/TODO.md` → "Start dialog (#66): leftovers".
- **A start that Claude Code refuses ("Workspace not trusted") is fixed in the app** (branch
  `fix/workspace-trust`, not merged, not pushed, not installed; 2026-10-06). Since 0.8.0 a ticket's
  session starts in its repository's checkout, a folder whose trust prompt was usually never
  accepted, so `claude --bg` refused it and the start was left held. Now the Start dialog says so
  before starting (`master draft-assign` carries `trusted`, read from Claude Code's `.claude.json`
  by `trust.py`), **Open Claude there…** opens `claude` in the folder for the user to accept the
  prompt (MasterDeck never does, and never writes that file), the dialog comes back when the
  folder is trusted, and a refused start (its tab, the HELD card in Needs you, a phone) has **Try
  again**, which starts the same held proposal (only one the CLI held for this, never beside a
  live session). Checked: the Python suite (450), typecheck, vitest (1419 passed, 3 skipped), and,
  before the review fixes (which the suites alone checked), the isolated app with a stand-in `claude` and a temp
  `CLAUDE_CONFIG_DIR` (the dialog's line and button, the tab in that folder, the dialog returning,
  the refused start's tab, the HELD card, Try again / Start now on the one proposal, no line for a
  trusted folder). Not checked: the real `claude` and its real prompt, Windows, the web app and a
  phone on screen. Open points are in TODO ("Where a session starts").
- A workspace per GitHub account, and sessions that start in the ticket's repository's checkout, are
  merged to `main` (660c726), installed locally, not pushed. `accounts[].workspace` (optional; the top-level `workspace` is
  the primary's), one resolver in the master CLI (`checkout.py`) used by master's ASSIGN proposals,
  the Start dialog's draft, `master add` / `master spawn` for ticket work without a folder and PR
  review sessions; the Start dialog says where the session starts, says plainly when no checkout was
  found (and when the search was cut short), and has **Choose folder…**. A session MasterDeck parks
  in a main checkout does not take the branch it found there (`parked-sessions.json`), and
  `Ops.repos()` covers every account's workspace. Checked: the Python suite (416), typecheck,
  vitest (1360 passed, 3 skipped), the real CLI against a temp config and temp checkouts, and the
  isolated app with a temp HOME (Setup with one and two accounts, save and reopen, switching the
  primary; the Start dialog's found, not-found and cut-short lines; the not-found line at 390 px in
  the web preview). Not checked: the native folder picker behind **Choose folder…**, pressing
  Start, anything that starts a session. Open points are in TODO ("Where a session starts").
- Plan K (Board repository view: picking repositories in a Board tab's Repos filter shows all their
  issues, on a board or not, in MasterDeck's columns, with sessions started from a click; a session
  can be linked to an issue no board holds; **Start a session** on the Assign and PR popups) is merged to `main` (e75ec9c), installed locally, not pushed. Checked on its branch: typecheck, vitest
  (1317 passed, 3 skipped), the Python suite (361); and, before the final fixes (which the two
  suites alone checked), the Board's markup for tabs with no repository picked (identical to `main`,
  also the live DOM and a screenshot of the isolated app against `main`'s), the isolated app with
  `MASTERDECK_BOARD_FIXTURE` and `MASTERDECK_REPO_FIXTURE` (the view, its notes, the loading, empty,
  not-read and not-selected states, the popups' **Start a session**, New ticket preset to the
  repository with no sprint, Back to board; a tab with no board only filters), and the phone layout
  at 390x844 on `/?preview`. Not checked: anything against GitHub (`master repo-issues` ran with
  fake runners only: the first real read is the user's, TODO has what to look at), starting a
  session or creating a ticket from the view, the PR popup at phone width, the cost of the read in
  GraphQL points. A saved tab that already
  had repositories picked opens as a repository view after the update. Deploy the web app only after
  the desktop release that has it. Spec and plan: backend repo, `docs/superpowers/` (2026-10-05).
- Plan J (Board without a GitHub project: repository issues in derived columns, Create a GitHub board,
  clearer empty states, linking and New ticket without a board, master proposals for such an account)
  is merged to `main` (7714ec8), installed locally, not pushed. Checked on its branch: typecheck, vitest, the Python suite, and the
  isolated app with board fixtures (no board: hint, four columns, no drag, empty states, New ticket
  dry run; with a board: same DOM as `main`). Board creation was tested with a fake gh only: the first
  real run is the user's, on a throwaway account or repository (the spec's §9 lists what schema
  introspection could not prove). Spec and plan: backend repo, `docs/superpowers/` (2026-10-05).
- `main` is pushed and released as **v0.7.1** (2026-10-03; CI builds the DMGs/EXE; v0.7.0 had no Windows build). Installed
  locally. In this release: snapshot patches + volatile hold (0b6d8ed), web state
  patches (75aafa1), the remote indicator (ce27e5d), instant typing (merge bacb8d6), plan H (merge
  f433be5: native PR watch, board moves, `/queue` hook, one-time migration of the skill hooks, own
  self-review gate; deploy watch and CI-failure messages are deliberate non-goals) and the web app's
  phone layout (merge b3c4d4b: ≤760 px, `usePhone()`, CSS in `web.css` under `.app.phone` /
  `html.phone`, dev-only preview `npm run dev:web` + `/?preview`). The web app with the phone layout
  is deployed to app.masterdeck.dev.
- Several GitHub accounts (plan I) and the master-reply fix are merged into `main` locally (merges 6a83862,
  592dc54; not pushed, installed locally 2026-10-03). The real config was migrated (one account, primary).
  The backend's optional `session.start.account` is merged to backend `master` and deployed (PR #10);
  the drift test runs against the backend checkout next to this repo again.
- Backend `master` = `3af02f3` (PR #8, docs only), deployed code is PR #5 (`fccbfee`).
- Next: whatever the user picks from [docs/TODO.md](docs/TODO.md). Top of the list: decide on
  pushing/releasing, fix or accept the broken backend CI deploy, re-measure web-bridge upload with
  a tab open, and the small remote hardening items.

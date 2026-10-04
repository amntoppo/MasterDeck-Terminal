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
  - `test/fixtures/` — `agents.json`, `board*.json`, `ledger.json`, `snapshot.json`, `claude-echo.json`.
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
npm test             # vitest: ~760 tests in ~100 files (~30 s); predictiveEcho alone ~30 s
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
| Create with Claude (Board ticket builder) | `main/ticketDirs.ts` (folders, one per tab with two or more accounts; request pump), `shared/ticketBuilder.ts`, `renderer/.../BoardView.tsx` |
| Workflows | `main/workflow.ts` (`WorkflowStore`), `shared/flow*.ts`, `renderer/.../FlowEditor.tsx` |
| Queue | `main/queue.ts`, `main/deckHooks.ts` (hook.sh `/queue` + Stop handshake) |
| master-agent | `main/masterCli.ts`, `main/assign.ts`, `skills/master` |
| GitHub accounts | `main/accountEnv.ts`, `main/sessionAccounts.ts` (also resume: `resumeAs`), `main/superseded.ts` + `shared/superseded.ts` (the old side of a copy, hidden), `main/accountClients.ts` (which account MasterDeck's own calls use), `shared/accounts.ts`, Setup's accounts step: `renderer/.../SetupDialog.tsx`, `renderer/.../setupAccounts.ts`, badges/pickers: `renderer/.../AccountBits.tsx` |
| Account | `main/account.ts`, `main/loopback.ts`, `shared/account.ts`, `renderer/.../AccountPanel.tsx` |
| Remote line | `main/cloudSync.ts`, `main/remoteCommands.ts`, `shared/remoteSnapshot.ts`, `shared/remoteGuard.ts`, `shared/remote.ts` |
| Web bridge | `main/browserBridge.ts`, `main/browserStore.ts`, `main/macKey.ts`, `main/ipcRegistry.ts`, `main/remoteGuards.ts`, `shared/{e2e,bridgeWire,remoteDeck}.ts` |
| Web app | `src/web/*`, `renderer/src/web.ts`, `renderer/src/webConfirm.ts`, `vite.web.config.ts`, `web/wrangler.jsonc` |
| Instant typing | `renderer/src/predictiveEcho.ts` (+ `.test.ts`, `test/fixtures/claude-echo.json`) |
| Remote indicator | `renderer/.../Rail.tsx` (`RemoteIndicator`), `shared/remotePresence.ts`, `shared/deviceInfo.ts` |

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
| `MASTER_WORKSPACE` | the config's workspace (keeps Janitor/standup on a temp repo) |
| `MASTERDECK_USER_DATA` | Electron user data (window state, localStorage) |
| `MASTERDECK_REMOTE_URL` | backend address (https, or `http://localhost:<port>`; anything else silently falls back to dev.masterdeck.dev) |
| `MASTERDECK_NO_SKILLS=1`, `MASTERDECK_NO_HOOK=1` | skip installing skills / the status line and deck hooks |
| `MASTERDECK_SETUP_MISSING=jq,claude` | Setup's tools step reports these as missing (the install flow) |
| `MASTERDECK_TEST_NO_ATTACH=1`, `MASTERDECK_BOARD_FIXTURE=<json>` | refuse `claude attach`; use a fixture board |

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
- **Remote text** may never start with `/` or `!` or contain control characters (`noEscape`), and
  remote sends are never relayed through master-agent (`sendMasterUp(true, …)` is false).
- **Claude Code's TUI runs on the alternate screen** (`?1049h`) with mouse/focus/bracketed-paste
  modes; instant typing only observes there until it has seen 3 exact echoes.

## Style

- Code reads like the surrounding code; comments say why, not what. UI text is plain, short, active.
- Deliberate simplifications carry a `ponytail:` comment naming the ceiling and the upgrade path.
- Commits: a clear subject, then a body that explains the change and why; no ticket noise. Commit
  messages end with the `Co-Authored-By` line the session gives you.
- Releases: see [OPERATIONS § Release](docs/OPERATIONS.md#release) (only when the user asks).

## Current state and next steps (2026-10-03)

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
  The backend's optional `session.start.account` is on backend branch `feat/session-start-account`
  (worktree `~/Documents/masterdeck-backend-proto`), not merged or deployed; until it merges, run the
  drift test with `MASTERDECK_BACKEND=~/Documents/masterdeck-backend-proto`.
- Backend `master` = `3af02f3` (PR #8, docs only), deployed code is PR #5 (`fccbfee`).
- Next: whatever the user picks from [docs/TODO.md](docs/TODO.md). Top of the list: decide on
  pushing/releasing, fix or accept the broken backend CI deploy, re-measure web-bridge upload with
  a tab open, and the small remote hardening items.

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
| [Masterdeck-Website](https://github.com/amntoppo/Masterdeck-Website) | The site at masterdeck.dev (its own repository) |
| [docs/GUIDE.md](docs/GUIDE.md) | The user guide: every feature as a user sees it |
| [docs/THEMES.md](docs/THEMES.md) | Themes: the token set, the light palette, adding a theme |
| [TODO.md](TODO.md) | Older design note: supporting Codex / Copilot CLIs |

## Three repos, one product

| Repo | Where | What |
|---|---|---|
| MasterDeck (this) | `~/Documents/MasterDeck-Terminal`, public, `main` | Desktop app (`app/`), skills (`skills/`), web app source (`app/src/web` + the renderer) |
| masterdeck-backend | `~/Documents/masterdeck-backend`, private, `master` | Cloudflare Worker + Durable Objects (UserHub per user, SQLite), accounts (Better Auth), browser relay. API at https://dev.masterdeck.dev |
| admin dashboard | private repo (its name and checkout: backend `docs/ADMIN.md`) | The admin dashboard at https://admin.masterdeck.dev (static React page; its API is the backend's `/admin/*`) |

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
  - `scripts/install-mac.sh` (copy the built app to /Applications), `scripts/sync-protocol.sh`,
    `scripts/icons.mjs` (the app and web icons in `build/` and `src/web/public/`, from one mark).
  - `test/fixtures/` — `agents.json`, `board*.json`, `repo-issues.json`, `ledger.json`, `snapshot.json`, `claude-echo.json`.
- `skills/` — skills shipped with the app (master, babysit-ticket, babysit-pr, babysit-worktree,
  kill-worktree, worktree-janitor, queue). MasterDeck no longer depends on babysit-ticket,
  babysit-pr or queue — it does their automatic parts itself (PR watch, board moves, /queue hook) —
  they stay for use by hand. `skills/master/` is also the `master` CLI (Python,
  `lib/master/`) that the app calls for the ledger, snapshot, board, config and spawning.
  (`skills/babysit-proof/` on disk is a leftover `__pycache__` only; the skill was removed in 9329db4.)
- `mods/` — Claude Code mods (a local-folder marketplace, `.claude-plugin/marketplace.json`): the
  core `mods/masterdeck` (per-session switches, heartbeat) and one mod per feature,
  `masterdeck-ticket`, `masterdeck-alerts`, `masterdeck-note`, `masterdeck-loop`, `masterdeck-board`
  (see [docs/MODS.md](docs/MODS.md)).
  `mods/shared/deck.ts` is copied into each by `mods/sync-shared.sh`: edit it there. Check each with
  `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`.
- `docs/` — see the table above. `README.md` — install, first run, config fields.
- `install.sh` — the one-line macOS installer (downloads the latest release DMG).
- `.github/workflows/` — `ci.yml` (Python tests, typecheck, vitest, unpublished DMG/EXE builds on PRs
  and `main`), `release.yml` (a `v*` tag, or called: build, attach, then `ota-release.yml`, which
  signs and publishes the in-app update) and `ota-main.yml`: **every merge to `main` that changes
  the app is released to users** once CI passes (patch + 1 from the latest tag, or `package.json`'s
  higher minor/major; a release commit only the tag holds; channel/rollout from the repo variables
  `OTA_MAIN_CHANNEL` / `OTA_MAIN_ROLLOUT`, `OTA_MAIN=off` pauses it; logic in
  `app/scripts/auto-release.mjs`). See [OPERATIONS § Release](docs/OPERATIONS.md#release).

## Commands

```bash
cd app
npm install          # postinstall runs electron-builder install-app-deps (node-pty for Electron)
npm run dev          # the app with hot reload
npm run typecheck    # tsconfig.node.json + tsconfig.web.json; must be clean
npm test             # vitest: ~2200 tests in ~184 files (~35 s); predictiveEcho alone ~30 s
npm run build        # electron-vite build → out/
scripts/whisper.sh   # macOS: whisper-cli for Meetings into resources/whisper/<arch>/ (before packaging; needs cmake)
scripts/mute.sh      # macOS: md-mute (reads the meeting app's mute) into resources/mute/<arch>/ (swiftc)
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
It never opens the Keychain (a new ad-hoc build would put a dialog up that blocks it: OPERATIONS).

## Operating rules (from the user; follow exactly)

- **Always open a PR once a change is done**: commit on the feature branch, push that branch and
  open a draft PR against `main` (description ends with the session's attribution line), then
  report its link. Never push `main` (or the backend's `master`) directly, never force-push, never
  merge a PR yourself. `main` is ahead of `origin/main` (21 commits as of 2026-10-03). Never deploy
  the web app or the backend unless asked.
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
| Messages that never mix with the user's draft (#123): the core mod first, typing only into an empty prompt, else held | `main/modDeliver.ts` (`ModDelivery`, `deck/deliver/<sid>/`) + `mods/masterdeck/hooks/deliver.ts`, `shared/heldMessages.ts` (`promptDraft`, `isTyping`, `heldAnswer`), `promptLines` in `main/screen.ts`, `main/held.ts` (`HeldStore`), `Sender.pumpHeld` / `sendHeld` / `takeHeldFor`, `DeckHooks.setHeldMarks` + `pumpQueue(…, held)`, `renderer/.../HeldBar.tsx`, `srow-held` in `Sidebar.tsx` |
| Terminals | `main/ptys.ts` (`PtyManager`), `shared/paneCommand.ts`, `renderer/.../TerminalView.tsx` |
| Hooks | `main/hooks.ts` (settings.json installs, `hookStatus`, one-time `migrateLegacyHooks` of the old skill hooks), `main/deckHooks.ts` (MasterDeck's hook script, incl. the master reports guard on `SendMessage`), `shared/deckHooks.ts` |
| Monitors / schedules | `main/watches.ts`, `shared/watches.ts`, `shared/schedules.ts` |
| Schedules (#140: sessions started on a timer) | `shared/sched.ts` (pure: `normalizeSchedule`, `whenCron`, `nextSlot` in a time zone, `planTick`, `runProgress`, `runCost`), `main/sched.ts` (`Scheduler`: `schedules.json`, `tick`, `runNow`), `startSession` in `main/index.ts` (also `CH.startClaude`), `CH.sched*`, `renderer/.../SchedulesView.tsx`, `AppState.schedRuns` (the session row's chip). Not `shared/schedules.ts` (a session's own CronCreate jobs) |
| PR watch | `main/prWatch.ts`, `shared/prWatch.ts` |
| Board moves | `main/boardOps.ts`, `main/boardFlow.ts`, `main/ticketLinks.ts`, `shared/ticketLinks.ts` |
| Board without a GitHub project | `shared/derivedBoard.ts` (`boardless`, `deriveBoard`, `tabBoard`, `boardEmpty`, `unreadRepos`, `awaitingRead`, `canMove`, `boardWanted`), `Sources.build()` / `refreshBoard`, `renderer/.../BoardView.tsx`, `skills/master` (`config.boardless`, `collect.Live.repo_issues`, `board.derived_status`, `normalize.repo_issues`) |
| Board repository view | `shared/repoView.ts` (`repoViewOn`, `askPlan` / `cleanRepos`, `repoPickable`, `repoRefusal`, `admitRepo`, `offBoardOk`, `reposFilterPick`, `applyRead`, `viewOf`, `repoViewDeriver`, `repoViewBoard`, `repoViewStatus`, `boardChips`), `main/repoIssues.ts` (`RepoIssues`: ask, refresh, cache), `Sources.askRepos` / `build()` / `refreshGithub(force, repoForce)`, `renderer/.../BoardView.tsx` (`repoMode`, `worked`, `boardTicketContext`), `skills/master` (`cli.cmd_repo_issues`, `collect.Live.repo_issues(only=, boards=)`) |
| Who can be assigned (Assign popup, Assignee filter) | `main/assignUsers.ts` (`AssignableUsers`: per repository, as its account, an hour), `GitHub.assignableUsers(force, repo)`, `shared/boardFilter.ts` (`assignChoices`, `assignSeed`, `tabFilterUsers`), `renderer/.../AssignPopup.tsx`; `state.users` is the primary issue repo's only. A card's GitHub calls go out as `accountClients.forCard` (its repository's account, else the account with that owner, else the account whose board holds it, else the primary; `cardBoardless` is the matching gate): use it, not `forRepo`, for anything done for a card; its board writes (status moves) as `forBoard` (the board's account); pass the card's `project` (`Ticket.project`, `knownProject` for input) where you have it |
| A ticket's description and sub-issues in the Board's popups | `shared/subIssues.ts` (`parseSubIssues`, `subIssueRows`, `subIssueProgress`), `GitHub.subIssues` / `issueBody` in `main/github.ts` (`issue:subIssues`, `issue:body`), `renderer/.../SubIssues.tsx`, `AssignPopup.tsx`, `AssignDialog.tsx` |
| Automate Review / Merge automatically (#157) | `shared/autoReview.ts` (`autoSearch`, `autoQuery`, `parseAutoAnswer`, `reconcile`, `readyToMerge`, `mergeGuard`, `mergeArgs`, `autoPrompt`, `inputBoxRows`, `autoStatusLine`), `main/autoReview.ts` (`AutoReview`, `paneReady`, `readTurn`; `auto-review.json`), the folder's turn hooks and `post-review.sh --auto` in `main/prReviewDirs.ts` (`prReviewSettings`, `prReviewTurn`, `prReviewAuto`, `writePrReviewAuto`, `writePrReviewFiles`), `CH.autoReviewSet` and the `review:` monitor in `main/index.ts`, `state.autoReview`, the `auto-review` notification type (`Notice.url`), `renderer/.../AutoReviewWidget.tsx`, `TerminalView` `onInputBox`, `PrsView.tsx` (`widgetPlace`, pane adoption) |
| Review with Claude (Pull requests view, #149) | `shared/prReview.ts` (`prReviewContext`, `prReviewBriefing`, `prRef`, `reviewPrompt`, `prReviewSpecError`), `main/prReviewDirs.ts` (`prReviewDir`, `prReviewPane`, `writePrReviewDir`, `prReviewGuard` + `prReviewPost` (guard and post script, outside the session's folder), `prReviewScript`, `PR_REVIEW_SETTINGS`, `isPrReviewSession`), `CH.prReviewPrepare` in `main/index.ts`, the `pr-review` pane (`paneCommand`, `PtyManager`, `WEB_PANES`), `renderer/.../PrsView.tsx` (`keptReviews`, `openReview`, the panel), `PrPopup.tsx` (`onReviewWithClaude`, passed by `App.openPr`) |
| Create a GitHub board | `main/boardCreate.ts` (`BoardCreator`, `accountGh`, `columnsOf`), `shared/boardCreate.ts`, `renderer/.../CreateBoardDialog.tsx` |
| Create with Claude (Board ticket builder) | `main/ticketDirs.ts` (folders, one per tab with two or more accounts; request pump), `shared/ticketBuilder.ts`, `renderer/.../BoardView.tsx`; its settings bar (#68): `shared/ticketSettings.ts` (`readSettings`, `enforceSettings`: the pump puts the bar's values in place of the session's flags), `renderer/.../TicketSettingsBar.tsx`, `settingsFrom` / `changeSettings` / `boardSprints` in `NewTicket.tsx` |
| Setup with Claude (Setup → Let Claude do it, #156) | `shared/setupClaude.ts` (`readSetupDraft`, `draftSummary`, `setupBriefing`, `setupScript`), `main/setupClaude.ts` (`prepareSetupDir`, `SetupPump`), `CH.setupClaude*` in `main/index.ts` (`detectAllAs`), `setupPatch` / `selFromDraft` in `renderer/.../setupAccounts.ts` (the one save path of Setup), the panel in `SetupDialog.tsx`, `onHold` in `App.tsx`. Only the window's Save writes the config; never let the session write it |
| Workflows | `main/workflow.ts` (`WorkflowStore`), `shared/flow*.ts`, `renderer/.../FlowEditor.tsx` |
| Built-in workflows (#104) | `shared/builtinWorkflows.ts` (`BUILTIN_WORKFLOWS`, `flowHash`, `rawFlowHash`, `sameAsMark`: the one "edited" rule), `shared/builtin-workflows/md-*.json`, `WorkflowStore.seedBuiltins` / `restoreBuiltin` / `builtinsRemoved` in `main/workflow.ts` (`workflows/builtins.json`), `CH.workflowBuiltinRestore` in `main/index.ts`, the chip and buttons in `renderer/.../WorkflowView.tsx` |
| Queue | `main/queue.ts`, `main/deckHooks.ts` (hook.sh `/queue` + Stop handshake) |
| master-agent | `main/masterCli.ts`, `main/assign.ts`, `skills/master`; sessions started on demand from master's chat: `skills/master/lib/master/start.py` + `cli.cmd_start` (`master start`), `assignMe` in `main/boardFlow.ts` |
| The New Claude session dialog (account first, each account's last choices, #153) | `renderer/.../NewMenu.tsx` (`NewSessionDialog`), `shared/newSessionPrefs.ts` (`parseNewSessionPrefs`, `initialAccount`, `resolveChoice`, `rememberChoice`; localStorage `newSessionPrefs`), `CH.folderExists` in `main/index.ts` |
| The Start dialog's options (worktree made before the start, permission mode, remembered choices) and its Markdown preview | `shared/startOptions.ts`, `main/startWorktree.ts` (`worktreeInfo`, `createWorktree`), `worktreeFolder` in `main/remoteGuards.ts`, `AssignRequest.permissionMode` → `master add --permission-mode` → `spawn.command`, `shared/markdown.ts` + `renderer/.../MarkdownView.tsx` (reuse for any Markdown view), `renderer/.../AssignDialog.tsx` |
| Where a ticket's session starts (per-account workspace, the repository's checkout) | `skills/master/lib/master/checkout.py` (`resolve`, `scan`: the one implementation), `config.workspace_for`, `rules._assign`, `cli.cmd_draft_assign` / `cmd_checkout`; the app only shows it: `shared/startFolder.ts`, `renderer/.../AssignDialog.tsx` (`StartFolderLine`), `inRepoFolder` in `main/assign.ts` (PR review), `chosenFolder` in `main/remoteGuards.ts`; every account's repos on disk: `main/checkouts.ts` (`workspaceRepos`, behind `Ops.repos()`); whether a folder's branch is the session's: `ownsFolderBranch` in `shared/parked.ts`, `main/parked.ts` (`parked-sessions.json`, written by `master spawn`: `checkout.parked`), `Sources.ownsBranch`; Setup: `workspacesFromConfig` / `accountsFromSetup` / `swapPrimaryWorkspace` in `setupAccounts.ts` |
| Whether Claude Code may work in a folder (its trust prompt), and a start it refused | `skills/master/lib/master/trust.py` (the one reader of Claude Code's `.claude.json`, read only: `trusted`, `wait`, `not_trusted`; `master trust`, `trusted` in `draft-assign` / `checkout`), `MasterCli.trust`, `shared/trust.ts` (`isNotTrusted`, `trustView`, `startBlocked`, `heldForTrust`, `trustHeldAssign`, `startFlags`, `retryRequest`, `waitForTrust`), `renderer/.../TrustFix.tsx` (`useTrust`, `TrustNote`: Start dialog, `StartRefused` in `App.tsx`, the held `ProposalCard`), **Open Claude there…**: `openClaude` in `main/index.ts`, `claudeFolder` in `main/remoteGuards.ts`, the `claude-here` pane; Try again: `AssignRequest.retry` / `retryHeld` in `main/assign.ts` → `MasterCli.spawnHeld` (`master spawn --held-for-trust`, `held_for` in the ledger); who asked an inbox action: `inboxActCall` in `main/remoteGuards.ts` |
| GitHub accounts | `main/accountEnv.ts`, `main/sessionAccounts.ts` (also resume: `resumeAs`), `main/superseded.ts` + `shared/superseded.ts` (the old side of a copy, hidden), `main/accountClients.ts` (which account MasterDeck's own calls use), `shared/accounts.ts`, Setup's accounts step: `renderer/.../SetupDialog.tsx`, `renderer/.../setupAccounts.ts`, badges/pickers: `renderer/.../AccountBits.tsx` |
| Account | `main/account.ts`, `main/loopback.ts`, `shared/account.ts`, `renderer/.../AccountPanel.tsx` |
| Remote line | `main/cloudSync.ts`, `main/remoteCommands.ts`, `shared/remoteSnapshot.ts`, `shared/remoteGuard.ts`, `shared/remote.ts` |
| Web bridge | `main/browserBridge.ts`, `main/browserStore.ts`, `main/macKey.ts`, `main/ipcRegistry.ts`, `main/remoteGuards.ts`, `shared/{e2e,bridgeWire,remoteDeck}.ts` |
| Web app | `src/web/*`, `renderer/src/web.ts`, `renderer/src/webConfirm.ts`, `vite.web.config.ts`, `web/wrangler.jsonc` |
| Instant typing | `renderer/src/predictiveEcho.ts` (+ `.test.ts`, `test/fixtures/claude-echo.json`) |
| A session's tabs (Terminal, files, diffs), Details → Diff / Files, ⌘P, ⌘-click paths | `shared/sessionTabs.ts` (model), `renderer/src/sessionTabsStore.ts` (per `Session.key`, localStorage, `onOpen`), `renderer/.../SessionTabs.tsx`, `FileTab.tsx`, `DiffTab.tsx`, `DiffList.tsx`, `FileTree.tsx`, `QuickOpen.tsx`, `renderer/src/usePull.ts` (3 s while shown), `renderer/src/highlight.ts`; reads: `main/sessionFiles.ts` behind `files:*` / `diff:*`, guarded by `sessionFileCall` (`main/remoteGuards.ts`) and `insideRoot` / `relativeTo` / `findPaths` (`shared/filePath.ts`), parsers `shared/diff.ts`, limits `shared/fileView.ts`, web size cap `webFit` (`shared/sessionFiles.ts`). Nothing in `AppState` |
| Links in a terminal (⌘-click opens http/https in the browser, #119) | `shared/termLinks.ts` (`findUrls`, `isWebLink`), `renderer/src/termText.ts` (`logicalLine`, `cellRange`: a wrapped line read through its cells), the link provider and `linkHandler` (OSC 8) in `renderer/.../TerminalView.tsx`, `deck.openLink` (`app:openLink`, `local`: main's `shell.openExternal`, the web's `window.open`, both after `isWebLink`); `openExternal` stays https only |
| Tabs in the session list (#146; "session groups" in code) | `shared/sessionGroups.ts` (`applyGroupOp`, `carryGroup`, `pruneGroups`, `inGroup`, `shownTab`), `main/sessionGroups.ts` (`SessionGroupStore` → `session-groups.json`), `CH.sessionGroupsAct` and the state callback / `resumeDeps().copied` in `main/index.ts`, `state.sessionGroups`, `renderer/.../SessionGroupBar.tsx`, `Sidebar.tsx` (the tab narrows the list before filters), **Move to tab** in `SessionMenu.tsx` |
| Notes | `shared/notes.ts` (types, limits, checks, `notePreview`, `sessionNotes`; a note's `link` (the session and/or ticket an `n-` note is about) and `meeting` (set by `NotesStore.addMeetingNote` alone)), `shared/noteEditor.ts` (`NoteEditor`: the editor's saves, switches, conflicts), `shared/noteFilter.ts` (the panel's All · Mine · Tickets · Sessions · Meetings, the Notes tab's meeting dot), `main/notes.ts` (`NotesStore`), `renderer/src/notes.ts` (`useNotes`, `ticketNote`, `noteView`), `renderer/.../NotesPanel.tsx` (the one editor: Write / Preview / Side by side, `MarkdownView` with `html={false}`); Session details → **Notes n**: `renderer/.../SessionNotes.tsx` (read only; Edit and New note open the panel); entry points in `Rail.tsx`, `GitHubDetails.tsx` (Details → GitHub), `SessionDetails.tsx`, `BoardView.tsx` (`Card`); sessions adding to notes: `skills/masterdeck-notes` (`note.sh`), `shared/noteRequest.ts`, `main/noteRequests.ts` (`pumpNoteRequests`, in `pumpWatches`), `NotesStore.append` |
| Meetings (macOS; record, transcribe on the Mac, match to sessions; issue #102) | IPC and lazy loading: `main/meetingsIpc.ts` (`MeetingsIpc`; the only importer of `main/meetings/`, by dynamic `import()`); `main/meetings/gate.ts` (consent, permissions), `recorder.ts` (capture window, chunks, `audio.webm`), `store.ts` (`MASTERDECK_HOME/meetings`), `transcriber.ts` (queue, crash recovery), `matcher.ts` (the one `claude -p`, meeting notes), `models.ts` + `whisper.ts` (speech models, `whisper-cli`), `apps.ts` (the offer's process check), `muteHelper.ts` (`findMute`, `spawnMute`: the `md-mute` helper, `native/mute/main.swift`, `scripts/mute.sh`; its rules and protocol in `shared/meetingMute.ts`), `mute.ts` (`MuteWatch`: the mic follows the meeting app's mute, `meetingLive.mic`, `meetings:micOff`); `main/meetingMedia.ts` (`masterdeck-media://` audio), `main/meetingNotices.ts` (Needs you), `main/meetingsFixture.ts`, `main/claudeOnce.ts` (`claude -p` from an empty temp folder); `shared/meetings.ts` (types, settings, consent, `systemAudioPath`), `meetingAudio.ts`, `meetingModels.ts`, `meetingMatch.ts` (candidates, answer check, `MATCH_FAILED`), `meetingsPage.ts`, `meetingJanitor.ts`, `meetingApps.ts` (Zoom, Webex); capture window: `renderer/capture.html`, `renderer/src/capture.ts`, `renderer/src/pcmWorklet.ts`, `preload/capture.ts`; UI: `renderer/.../MeetingsSetup.tsx` (Settings → Meetings), `RecordMeeting.tsx`, `MeetingsView.tsx` (the page), Janitor's section in `HygieneViews.tsx`; `scripts/whisper.sh`, `scripts/meeting-fixture.cjs`; ARCHITECTURE "Meetings: …", OPERATIONS "Meetings: …" |
| Side questions (right panel → Tools → BTW, `/btw`) | `shared/btw.ts` (prompt, `parseStreamLine`, `parseHistoryLine`, `parseBtwScreen`), `main/btw.ts` (`BtwStore` → `btw/<key>.json`, `BtwAsker`: a forked tool-less `claude -p`, `BtwTerminal`: `history.jsonl` + `claude logs`), `pollBtw` and the `btw:*` handlers in `main/index.ts`, `renderer/.../SessionBtw.tsx` (a sub-tab of `SessionTools.tsx`, the panel's Tools tab, which also holds the Queue); never in `AppState` |
| Clone a session (right-click → Clone…, #136) | `shared/clone.ts` (`cloneName`, `cloneBlock`, `cloneOptions`, `checkFirstMessage`, `cloneArgs`, `clonedLine`, `cloneOwnsBranch`), `main/clones.ts` (`CloneStore` → `session-clones.json`), `cloneSession` in `main/index.ts` (`CH.cloneSession`), `Sources.setClones` (`followPrs` filter, `branchDir`, `withClones`, `carryLinks`), `renderer/.../CloneDialog.tsx`, `SessionMenu.tsx`, the pending tab's `clone` in `App.tsx`. Never supersede the original or call `noteCopy` for a clone |
| Notifications (Settings → Notifications, #135) | `shared/notifications.ts` (`CHANNELS`, `NOTIFY_TYPES`, `normalizeRoutes`, `routeOf`, `typeOfKind`, `showsInNeedsYou`, `cellOf`), `main/notifier.ts` (`Notifier`: the one dispatcher, a sender per channel), `main/notices.ts` (events routed to Needs you, inbox kind `notice`), `showSystem` / `notifyItem` / `announceUpdate` in `main/index.ts`, `Inbox.view(shows)`, `renderer/.../NotificationsPanel.tsx`. Every notification goes through `notifier.dispatch(type, note)`: never `new Notification` directly |
| Remote indicator | `renderer/.../Rail.tsx` (`RemoteIndicator`), `shared/remotePresence.ts`, `shared/deviceInfo.ts` |
| MasterDeck's mods (inside a session: ticket line, alerts, `/md-note`, `/md-ticket`; switches per session) | `mods/masterdeck` (core: `hooks/register.ts`, `hooks/core.ts`), `mods/masterdeck-ticket`, `mods/masterdeck-alerts`, `mods/masterdeck-note`, shared `mods/shared/deck.ts` (copied by `mods/sync-shared.sh`, checked by `shared/modsShared.test.ts`), the app's side: `shared/modBand.ts` (`modBand`, `bandFor`, `parseModBeat`), `DeckHooks.setBand` / `pruneBands` / `modBeats` in `main/deckHooks.ts`, per-session mod switches `main/modOff.ts` (`ModOff` → `mod-off.json`, `ModCatalog` → `mod-catalog.json`, `CH.modSet`), `modRows` / `mergeCatalog` / `MASTERDECK_MODS` in `shared/modBand.ts`, the state callback in `main/index.ts` (`state.modLive`, `state.modOff`, `state.modCatalog`), `SessionMods.tsx` (Tools → Mods, a sub-tab of `SessionTools.tsx`); the mod refuses switched-off mods in its `plugin.register` hook |
| Installing MasterDeck's mods (Setup → Mods, Settings → Mods, the reload offer) | `main/mods.ts` (`syncModsFolder`, `ModsInstaller`: `claude plugin … --json`), `shared/mods.ts` (`modsInSettings`, `withPrepend`, `prependNote`, `modsReloadOffer`), `paths.bundledMods` / `modsDir` / `modsSettings`, `modsNow` / `reloadMods` in `main/index.ts`, the `mods` inbox kind, `renderer/.../ModsPanel.tsx`; `backupSettings` in `main/hooks.ts` |
| Themes (Settings → General → Appearance: Light / Dark / System) | `shared/themes.ts` (`TOKENS`, `DARK`, `LIGHT`, `THEMES`, `resolveTheme`, `xtermTheme`, `contrast`), `renderer/src/theme.ts` (`applyTheme`, `bootTheme`, `useTheme`, `onTheme`, the web app's own `useWebThemePref`), `applyNativeTheme` in `main/index.ts` (`nativeTheme.themeSource`, window background), `Settings.theme`, `remoteSettings` (a browser never changes the Mac's theme); CSS reads only `var(--token)`: never write a colour literal in `renderer/src` or `src/web` (`themes.lint.test.ts` fails); light AA checks in `themes.test.ts` |
| Session details tabs (Session · GitHub, #103; Mods moved to Tools) | `renderer/.../SessionDetails.tsx` (tabs, `md.detailsTab`), `renderer/.../GitHubDetails.tsx` (rows: ticket, PRs, monitors; `prLineOf`, `sessionPrUrls`), `shared/prDetail.ts` (`pr:detail`, `GitHub.prDetail`), events rings `pushEvents` in `shared/watches.ts` → `Watches.events` / `PrWatch.events` (`watch:events`) |
| A session's running processes and ports (Details → Session → Processes) | `shared/sessionProcs.ts` (`parsePs`, `sessionGroups`, `isClaudeShell`, `parseLsof`, `transcriptTasks`, `isPortUrl`), `main/sessionProcs.ts` (`SessionProcs`: `ps` + `lsof` on demand, exited ones kept 60 s), `CH.procsList` / `procsOutput` / `openPort` in `main/index.ts` (`openPort` blocked on the web), `renderer/.../SessionProcs.tsx` |
| In-app updates (#122: check, download, verify, install; Settings → Updates; the app menu) | `shared/updates.ts` (model, `compareVersions`, `signedMessage`, `statusLine`, `shouldPrompt`, `badge`), `shared/releaseKey.ts` (the public key; `releaseKey` / `updateBase`: `MASTERDECK_UPDATE_PUBKEY` and `MASTERDECK_UPDATE_URL` only in an update-test build, `MASTERDECK_UPDATE_TEST_BUILD=1` → define `__MD_UPDATE_TEST__`), `shared/updateHelper.ts` (the macOS helper script, bash 3.2), `main/updater.ts` (`Updater`, `updatesOffReason`), `main/updateMac.ts` (`MacInstaller`), `main/updateWin.ts` (`WinInstaller`, `electron-updater` on win32 only), `main/updateVerify.ts` (hash + Ed25519), `main/appMenu.ts`, `makeUpdater` / `restartToUpdate` / `setAppMenu` and the `update:*` handlers in `main/index.ts`; files in `<userData>/updates/`. Never in `AppState`; every `update:*` is `blocked` for the web. Off unless packaged; `MASTERDECK_UPDATES=0` turns it off; the `update:*` handlers are `updateHandlers` in `main/remoteGuards.ts`; MasterDeck's own Restart (`relaunching`) never installs on quit |
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
| `MASTERDECK_TEST_NO_ATTACH=1`, `MASTERDECK_BOARD_FIXTURE=<json>`, `MASTERDECK_REPO_FIXTURE=<json>`, `MASTERDECK_DETECT_FIXTURE=<json>` | refuse `claude attach`; use a fixture board; use a fixture answer for the Board's repository view; use a fixture `master config detect --all` answer (Setup's Repos & boards, Setup with Claude's `discover`) |
| `MASTERDECK_MEETINGS_FIXTURE=<dir>` | isolated launches only (`MASTERDECK_ISOLATED=1` and `MASTERDECK_HOME`): copies a stored meeting, its audio and its note (`test/fixtures/meetings`) into the home before the notes are read (OPERATIONS § Meetings: the fixture) |
| `MASTERDECK_WHISPER` | the `whisper-cli` Meetings run (before the app's own and one on the PATH): a stand-in for tests |
| `MASTERDECK_MUTE` | the `md-mute` helper Meetings run (instead of the app's own): a stand-in for tests |

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
- **Claude Code ends a turn after eight Stop-hook blocks in a row without a tool call**
  (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it; MasterDeck does not set it). A workflow loop
  (`workflows/loop.sh`, `shared/loopHook.ts`) blocks every stop while it is open, so a loop that
  only talks pauses there: it stays `open` and goes on counting at its next turn end, and nothing
  wakes the session. After 5 quiet minutes Needs you shows a `loop-paused` item (**Continue** types
  MasterDeck's fixed `Continue the loop "<name>".`, **Stop loop**). A loop that keeps going without
  changing anything is ended by the stall limit (3 rounds on a new Loop frame; a saved loop without
  the field keeps 0, off). Never rely on `stop_hook_active` to end a loop; its iteration counter does.
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
  decision first. Sessions may only add (`note.sh` → `pumpNoteRequests` → `NotesStore.append`/`save`):
  the answer to a session carries a note's id, never its text. A note's text is drawn with
  `MarkdownView html={false}` (every tag is text); never build HTML from it. A save carries `base`; never write a note without it except with the user's **Keep
  mine**. A web tab gets a 120-character preview with the list and the change event; a full text
  goes to it in two answers only: `notes:get`, and the conflict answer of `notes:save` (the stored
  note, to the tab that tried to save over it). A file in the notes folder that is not a note is
  never overwritten. A failed disk write is answered with `retry: true` and a message without the
  path (`diskError`): the editor retries those and only those on a timer; keep a new store failure
  on the right side of that line. The rail (z-index 41) is above the panel (40), and the phone's tab
  bar (47) above its sheets (45, 46): a popout of either must stay visible over an open panel.
  `NoteMeta` (the list and change event, so web tabs too) also carries a note's `link` (the linked
  session's key and name, a ticket) and `meeting` (the meeting's id, title and time): anything new
  in `Note` reaches the web unless `noteMeta` leaves it out.

- **Meetings ask macOS nothing before consent.** No startup path may call `askForMediaAccess`,
  `getUserMedia`, `getDisplayMedia` or `desktopCapturer`; `main/meetings/` is loaded only by
  dynamic `import()` in `main/meetingsIpc.ts` (no static import anywhere), and
  `main/meetingsStartup.test.ts` fails otherwise (also for `isTrustedAccessibilityClient`: Accessibility, asked only by Settings → Meetings' Allow). macOS only (hidden on Windows and the web: every
  `meetings:*` channel is `blocked`). Transcripts and audio are private like notes (never in
  `AppState`, the snapshot, GitHub or a session's prompt); the only thing that leaves the Mac is the
  one `claude -p` per meeting (`claudeOnce`, matching), which the consent names. An ad-hoc signed
  build changes signature with every build, so macOS may ask for (or silently stop honouring) both
  permissions after each update or local rebuild. Never press **Record** or **Allow** in a
  test or an agent's run, not even in the isolated app (the real prompts are the user's); use `MASTERDECK_MEETINGS_FIXTURE`
  for the page and Janitor.

## Style

- Code reads like the surrounding code; comments say why, not what. UI text is plain, short, active.
- Deliberate simplifications carry a `ponytail:` comment naming the ceiling and the upgrade path.
- Commits: a clear subject, then a body that explains the change and why; no ticket noise. Commit
  messages end with the `Co-Authored-By` line the session gives you.
- Releases: see [OPERATIONS § Release](docs/OPERATIONS.md#release). A merge to `main` that changes the app is released to users automatically (`ota-main.yml`); a release by hand only when the user asks.

## Current state and next steps (2026-10-18)

- **A new session goes into the selected session-list tab (#171)** on branch
  `worktree-MasterDeck-Terminal-171-new-session-tab` (PR, not merged, **not installed**: the
  rebuild of the real app waits for the user's word). New Claude session and the Start dialog (the
  Board's too) have a **Session list tab** field when a named tab exists (default: the tab on
  screen); main keeps a pending target by name (`SessionGroupStore.expect` / `claim`,
  `claimWaits`) and the list switches to the tab on Start. Design and plan:
  `docs/plans/2026-10-18-new-session-tab-{design,plan}.md`. Checked: typecheck, vitest (240 files
  passed, 2 skipped; 3074 tests passed, 5 skipped), the web preview (both dialogs at 1400 and 390
  px), and the isolated app with a stand-in `claude` listing a new session only from its third
  poll (claimed into its tab in the first state that listed it; a deleted tab and All left it in
  All; the dialog's default, a start into the tab on screen selected there, All picked switching
  the list to All). Open points: TODO ("A new session goes into the selected tab (#171)").

- **Every merge to `main` publishes an OTA update (#166)** on branch
  `worktree-MasterDeck-Terminal-166-ota-on-merge` (PR, not merged; nothing runs until it is on
  `main`, and then the next app merge is its first real run). `ota-main.yml` after CI, the version
  and notes from `app/scripts/auto-release.mjs`, a release commit held only by the tag, then
  `release.yml` (now callable) and `ota-release.yml` (now takes a rollout when called); commit status
  **OTA release** and a PR comment on failure. Spec and plan:
  `docs/superpowers/{specs,plans}/2026-10-18-ota-on-merge*`. Backend PR #12 was already merged
  (2026-10-15) and deployed. Checked: vitest for the script, actionlint, and the prepare job's shell
  run against a throwaway clone with stand-in `gh` / `curl` (first release, re-runs before and after
  publishing, docs only, the next patch, an older commit, beta, off, a bad rollout). Not checked: a
  real run on GitHub Actions (needs the merge), an install seeing the update. Open points: TODO
  ("OTA on every merge (#166)").

- **PR watch: same-account reviews and read failures (#158)** on branch
  `worktree-158-pr-watch-same-account` (PR, not merged, **not installed**: the rebuild of the real
  app waits for the user's word). The watch's account is also the PR's author, so a review posted
  as the user (by the user or a review session) was dropped as the session's own reply; now an item
  by that account is held back only when its text is in the session's tool calls
  (`shared/ownPosts.ts`, `Sources.ownPost`, `PrWatchEntry.own`). Details' PR watch shows the last
  good read, a failing read's error and what it could not check. Checked: typecheck, vitest
  (225 files passed, 2 skipped; 2814 tests passed, 5 skipped), and the matcher against PR #147's real reviews and its
  session's real transcript (the review and both inline comments news, both replies its own). Not
  checked: a live delivery in the installed app. Open points: TODO ("PR watch, same account").

- **Setup with Claude (#156)** is built on branch `worktree-156-let-claude-setup` (PR, not merged,
  **not installed**: the rebuild of the real app waits for the user's word). Setup's **Let Claude
  do it** opens a Claude terminal in Setup (`setup-claude` pane, `<home>/setup-claude/`) briefed to
  check and install tools, pick GitHub accounts and the primary, repositories (or all) and boards,
  and preferences; its `review.json` is checked (`readSetupDraft`), fills the wizard and shows a
  summary card whose **Save** writes through the wizard's own path (`setupPatch` → `master config
  save`); then a success view and the main screen. Design and plan:
  `docs/plans/2026-10-17-setup-with-claude-{design,plan}.md`; ARCHITECTURE "Setup with Claude".
  Checked: typecheck, vitest, and the isolated app with a stand-in `claude`, a fake `gh` and a
  detect fixture (the offer, the chat, a refused draft's errors, the card, Change in the wizard
  showing Claude's values, Save writing the config with both accounts and workspaces, the success
  view then the Skills popup, leaving early from Settings). Not checked: the real `claude`
  following the briefing, a real `gh auth login` from the chat, a mods install from Save, Windows
  (the helper is bash; Claude Code runs it in Git Bash). Open points: TODO ("Setup with Claude (#156)").

- **Automate Review and Merge automatically (#157)** are built on branch
  `worktree-MasterDeck-Terminal-157-auto-review` (PR #159, on top of #149, now merged). Not
  merged, **not installed**. A card at the Review with
  Claude chat's bottom left (lined up with Claude's input box, ◂ Auto hides it) with two switches
  per PR tab: Automate Review (a MasterDeck monitor `review:<tab>` reads review requests every 2
  minutes as the tab's account, types each into the tab's review session when its turn is over,
  the post script's `--auto` form (allowed in the folder's settings by its absolute path) posts a
  comment review only to what MasterDeck queued, re-review only on
  new commits) and Merge automatically (off by default, a warning first, the Mac's window only;
  merges only what `readyToMerge` / `mergeGuard` pass, `--match-head-commit`, never `--admin`).
  Needs you: an Automated review type with View on GitHub. Spec and plan in this repo's
  `docs/superpowers/{specs,plans}/2026-10-17-auto-review*`. Checked: typecheck, vitest, the web
  preview at 1440 and 390 px (the card on the input box's rules, the warning, the toggle, the
  phone's inline card). Not checked: a real GitHub read, a real automated review, post or merge,
  the installed app, Windows. Open points: TODO ("Automate Review").

- **New Claude session remembers per account (#153)** on branch
  `worktree-MasterDeck-Terminal-153-new-session-memory` (PR, not merged, **not installed**: the
  rebuild of the real app waits for the user's word). The account is the dialog's first field; each
  account's folder, model, workflow and permissions are kept in localStorage
  (`shared/newSessionPrefs.ts`, key `newSessionPrefs`) and filled in on open (the last account) and
  on an account pick (untouched fields only); a gone folder (`folderExists`, a new read open to the
  web), model, workflow or mode falls back with a note. Spec and plan in this repo's
  `docs/superpowers/{specs,plans}/2026-10-17-new-session-memory*`. Checked: typecheck, vitest, and
  the web preview with two accounts (`/?preview=accounts`) at 1400 and 390 px: account first, a
  start saved and filled in again after a reload, a switch keeping a touched model, the gone-value
  notes. Not checked: the Electron window, the real web app over the bridge, Windows.

- **Schedules (#140)** are built on branch `worktree-MasterDeck-Terminal-140-schedules` (PR, not
  merged, **not installed**: the rebuild of the real app waits for the user's word). A rail view
  where a schedule starts a `claude --bg` session on a timer (prompt and/or workflow, folder,
  account, model, permissions; daily / weekdays / days / every N hours / cron in a time zone), with
  skip-while-running, a cost limit, notifications, missed runs once (never a burst), and the run
  history (ARCHITECTURE "Schedules"). Design and plan in `docs/plans/2026-10-17-schedules-*`.
  Checked: typecheck, vitest, the web preview at 1400 and 390 px, and the isolated app with a
  stand-in `claude` (a slot started on time with the Berlin wall-clock name, the next slot skipped
  while it ran, done when it went idle, Run now refused then allowed, a restart with two missed
  slots: one catch-up run and one skipped row, no burst). Not checked: a real session, a real wake,
  the web app over the bridge, Windows. Open points: TODO ("Schedules (#140)").

- **Review with Claude in the Pull requests view (#149)** is built on branch
  `worktree-MasterDeck-Terminal-149-pr-review-panel` (PR, not merged, **not installed**: the
  rebuild of the real app waits for the user's word). A Claude panel on the right of the PRs view,
  one session per PR tab (as the tab's account with two or more), the picked PR in its
  `context.json` (taken from `state.teamPrs`), a briefing on how to review, and a post script kept outside the session's folder:
  one review, only after the user's yes (not in the allow list, so Claude Code asks), only to the
  picked PR, as the tab's account; gh's own PR writes are denied. Spec and plan in this repo's
  `docs/superpowers/{specs,plans}/2026-10-17-pr-review-panel*`. Checked: typecheck, vitest, the
  web preview at 1440 and 390 px, and the isolated app with a stand-in `claude` against the real
  PR list (a read): the row button, the popup's button, the pick following into `context.json`,
  the pane's command and folder, the session kept across views, the script's `--dry-run` and its
  refusal of another PR. Not checked: a real Claude review, a real post, the real web app,
  Windows. Open points: TODO ("Review with Claude").

- **Clone a session (#136)** is built on branch `worktree-MasterDeck-Terminal-136-clone-session`
  (PR #148, not merged; **not installed**: the rebuild of the real app waits for the user's word).
  Right-click → **Clone…** (name, first message, Keep ticket link) starts `claude --bg --resume
  <id> --fork-session -n <name>` in the session's folder as its account, with its model and
  permission mode when valid; the original keeps running and is not superseded; the clone skips
  the copied transcript lines (by timestamp) so it takes none of the original's PRs, worktrees or
  workflow steps, and its folder branch's PR only after it switches branch. Design and plan:
  `docs/plans/2026-10-17-clone-session-{design,plan}.md`. Probed against claude 2.1.302 with a
  throwaway haiku session. Open points: TODO ("Clone a session").

- **Tabs in the session list (#146)** are built on branch `worktree-146-session-tabs-groups` (PR,
  not merged, **not installed**: the rebuild of the real app waits for the user's word). All plus
  the user's tabs over the session list; drag a session onto a tab or right-click → Move to tab;
  counts and needs-you badges; rename, reorder, delete; kept on the Mac (`session-groups.json`) and
  carried to a resume's copy. Spec and plan: `docs/superpowers/{specs,plans}/2026-10-17-session-list-tabs*`.
  Checked: typecheck, vitest, `build:web`, the web preview at 1400 and 390 px (every action driven
  over CDP), and the isolated app with a stand-in `claude` listing three fake sessions (tabs and the
  tab on screen kept after a restart). Open points: TODO ("Tabs in the session list (#146)").

- **Settings → Notifications (#135)** is built on branch `135-notification-settings` (PR, not
  merged, **not installed**: the rebuild of the real app waits for the user's word). A table of ten
  notification types × System notification / Needs you / Mobile push (disabled, #134), Pause all,
  Send test; one registry (`shared/notifications.ts`) and one dispatcher (`main/notifier.ts`) that
  every notification goes through; `notifyNeedsYou` migrated, defaults as before. Spec and plan:
  `docs/superpowers/{specs,plans}/2026-10-17-notification-settings*`. Checked: typecheck, vitest,
  the web preview at 1400 and 390 px (toggling a cell, Send test), and the isolated app (an old
  `notifyNeedsYou: false` file migrated, Send test adding a Needs-you notice and `notices.json`,
  Pause and a cell saved from the page and kept after a restart). Not checked: real notifications
  on screen per type, Windows, the real web app. Open points: TODO ("Notifications: open points").

- **Resuming a session opens its terminal (#133)** on branch
  `worktree-MasterDeck-Terminal-133-resume-opens-terminal` (PR, not merged, **not installed**: the
  rebuild of the real app waits for the user's word). A resume's answer carries the background id
  (`ResumeResult.key`); Board cards, the Start dialog and History close and open the session's
  Terminal tab with focus (`openResumed`, `shared/resumeOpen.ts`); Resume all is unchanged. Checked:
  typecheck, vitest, the web preview over CDP (card Resume and the Start dialog's Resume: Terminals
  view, `tab:bg-5` active, focus in the xterm, dialog closed), and the isolated app with a stand-in
  `claude` (`resumeSession` answered `key: "4f2a9c1e"`, the session listed under it). Not checked: a
  real `claude --bg --resume` in the installed app, History's Resume on screen, a phone, Windows.

- **Several accounts' accepted simplifications (#37)** on branch
  `worktree-MasterDeck-Terminal-37-accounts-simplifications` (draft PR #132, not merged, **not
  installed**: the rebuild of the real app waits for the user's word). The workflow builder runs
  as the primary account (`builderSettings` in `PtyManager`); the other items are GUIDE § Several
  GitHub accounts → **Known limits**, and the list left TODO. Checked: typecheck, vitest. Not
  checked: the builder pane in the app with two accounts.
- **Sub-issues open in place (#112)** on branch `112-subissue-details` (PR #131, not merged, **not
  installed**: the rebuild of the real app waits for the user's word). In the Start dialog, the
  Assign popup and Details → GitHub a sub-issue row opens (click, Enter or Space) to its status,
  assignees, labels and description (Markdown, cut at 10 000 characters), with Open on GitHub;
  several at once. The data comes from the sub-issues read already made (`SUB_ISSUES_JQ` keeps
  more). Design and plan: `docs/plans/2026-10-14-subissue-details-{design,plan}.md`. Checked:
  typecheck, vitest, and the web preview at 1280 and 390 px (click, Enter, Space, several open, a
  long body scrolling in its box, no sideways scroll). Not checked: a real issue with sub-issues,
  the Electron window, the real web app over the bridge, Windows.

- **Admin dashboard (#127)**, 2026-10-16, **not deployed, not merged**: the API is in the backend (branch
  `127-admin-dashboard`, `/admin/*`, its own D1 migration, docs `docs/ADMIN.md`), the page in its own new private repo
  (named in the backend's `docs/ADMIN.md`; branch `127-admin-dashboard`, pushed). In this repo only the hello's optional
  `platform` / `osVersion` (`CloudSync`, protocol copy synced; branch `worktree-127-admin-dashboard`). Checked:
  backend typecheck + vitest (278), MasterDeck typecheck + vitest (2596 passed), the drift test against the
  backend branch, the dashboard's typecheck/tests/build, and every page locally (wrangler dev + headless Chrome,
  light/dark, 390 px). Not checked: production (no deploy), a real Mac's hello with the new fields, Windows.
  Open points: TODO ("Admin dashboard (#127)").

- **Master starts sessions on demand (#126)** on branch
  `worktree-MasterDeck-Terminal-126-master-start` (PR #129, not merged, **not installed**: the
  rebuild of the real app waits for the user's word). `master start` (`skills/master/lib/master/start.py`,
  `cli.cmd_start`): from scratch (a `START` proposal) or for tickets by reference or board filter
  (ASSIGN proposals with the ticket's description and sub-issues, `assignMe`); a plan to approve or
  trim, `--yes` for "start it now"; `claude --worktree` through the spawn target; the app assigns the
  user after linking and lists a started session at once (ARCHITECTURE "master-agent integration").
  Checked: the Python suite, typecheck, vitest. Not checked: a real start, the real assign, the
  MasterBar app. Open points: TODO ("Master starts sessions on demand (#126)").

- **In-app updates (#122)** are built on branch `worktree-MasterDeck-Terminal-122-in-app-updates`
  (PR #128, not merged, not installed, nothing published or deployed), with the code review's fixes: no
  install on quit for MasterDeck's own Restart and none while the app runs from the bundle; the
  backup kept after an install on quit and removed by the healthy new app; the administrator path
  runs only inline root commands that unpack the verified zip again (never the helper file or the
  staged copy); the test key and update URL only in an update-test build
  (`MASTERDECK_UPDATE_TEST_BUILD=1`); the publish script checks the key against the app's, skips
  files already uploaded (same size and sha512 only; a published file with another hash stops it)
  and runs after the GitHub attach; the final review's fixes: the running check again right before
  the renames (also as root, after the password prompt), Windows' install on quit off for a
  relaunch, a channel change during a failed Restart now checked at once. A new GitHub release is
  published as an update by `.github/workflows/ota-release.yml` (on `release: published`, called by
  `release.yml` after it attaches the files, or by hand). Backend: branch `122-update-service`
  (backend PR #12, not merged; **deployed from that branch 2026-10-16** with the R2 bucket,
  migration 0006, the Worker secret and both GitHub secrets: the update service is live, nothing
  published yet). Checked: typecheck, vitest (the helper with nasty paths
  through a `/bin/sh` stand-in for osascript), actionlint, the OTA download step against the real
  v0.9.0 release (read only), and end to end (OPERATIONS "Testing in-app updates") before the final
  review's fixes: local `wrangler dev`, packaged builds in a temp folder, 0.9.0 → 0.9.1 and 0.9.0 →
  0.9.2 in place, a broken 0.9.3 rolled back to 0.9.2 and skipped. Not checked: real R2 and
  Cloudflare, the workflows on GitHub Actions, the real password prompt, Windows. Open points: TODO
  ("In-app updates (#122)").

- **Why the mic did not follow Meet's mute (#102)** is built on branch
  `worktree-MasterDeck-Terminal-102-mute-check` (from `main` 7c346e2; PR #125, not merged;
  installed locally 2026-10-16). The user's Google Meet in
  Chrome was recorded while muted (md-mute never read `muted`); the cause is still unknown. Added:
  md-mute's per-app diagnostics (`why`, the matched `label` only, `searched`, `ms`, `cached`; the
  parser accepts lines with or without them), Meet as a web rule (search from `AXWebArea`, 40000
  elements / 800 ms, three roles, one retry after `AXManualAccessibility`), Settings → Meetings →
  **Check mute reading** (`meetings:muteCheck`, 3 s, every rule, `gateTrusted` beside the helper's
  `trusted`), and a per-meeting **Mic log** (`micLog`, the first and last 250 with `micLogDropped`,
  no why-only changes, Meetings page and export). Review fixes (second commit): Meet searched only
  on pages whose `AXURL` host is `meet.google.com` (rule field `hosts`), toolbars and Chromium's
  tab strip skipped, cached processes first, `AXManualAccessibility` remembered only on success,
  failed AX reads give `error`, the split-grant note only when the helper said `trusted: false`.
  Checked: typecheck, vitest (208 files passed, 2 skipped; 2569 tests passed, 4 skipped), `npm run
  build`, md-mute rebuilt and run against bundle ids nothing runs. Not checked: the Check or the
  Mic log on screen, any real meeting app (Chrome was never read). Next: the user presses Check in
  a Meet call (muted, then unmuted) on the installed app; OPERATIONS § Meetings: md-mute says how
  to read it. Open points: TODO ("The mic follows the meeting app's mute").

- **MasterDeck messages never mix with a half-typed prompt (#123)**, branch
  `worktree-MasterDeck-Terminal-123-held-messages` (draft PR, not merged, **not installed**: the
  rebuild of the real app copies the 0.6.0 mods over `~/.claude/masterdeck/mods`, so it waits for
  the user's word). The core mod submits MasterDeck's messages with `$.prompt.submit` (all mods are
  0.6.0, so running sessions get the reload offer); without it, typing waits for an empty prompt and
  a held message shows on the session with Send now / Discard, and goes when the prompt is empty or
  at the next turn end (Stop hook). Spec and plan in this repo's `docs/superpowers/`
  (`2026-10-16-held-messages*`); ARCHITECTURE "Sender and PTYs". Checked: typecheck, vitest, the
  mod's `claude plugin validate` / `test`, a probe of `$.prompt.submit` and then the real core mod
  in a throwaway haiku session (draft `refactor the login` with the cursor moved: the message ran
  as its own turn, the draft and cursor unchanged), `promptDraft` against that session's real
  screens, the web preview at 1400 and 390 px. Not checked: the installed app with real sessions,
  the Stop-hook hand-off in a live session, Windows, the real web app. Open points: TODO ("Held
  messages (#123)").

- **Links in a terminal (#119)** are built on branch
  `worktree-MasterDeck-Terminal-119-terminal-links` (PR #121, not merged, **not installed**: the
  rebuild of the real app waits for the user's word). ⌘-click (Ctrl-click off a Mac) opens an
  http/https address in the browser: localhost / IP with ports, paths and queries, one link across
  wrapped rows, trailing punctuation left out, OSC 8 links; underline and pointer only while the
  key is held (paths too, which now also wrap and survive wide characters). Checked: typecheck,
  vitest (one timing flake in `browserBridge.test.ts` under the full run, passing alone), and the
  isolated app over CDP with `shell.openExternal` stubbed in main: hover with and without ⌘, ⌘ down
  and up while hovering, a plain click opening nothing, a ⌘-click on a plain, a wrapped and an OSC 8
  link opening the right address, a `file:` OSC 8 link ignored. Not checked: the web app over the
  bridge, Windows, a real Claude session's output. Open points: TODO ("Terminal links (#119)").

- **Which account a card's calls and sessions use (#54)** is fixed on branch
  `worktree-MasterDeck-Terminal-54-card-account-routing` (not merged, not installed): status moves
  go as the card's board's account (`forBoard`), the card's board travels in the ticket
  (`Ticket.project`), `boardOf` falls back in Setup's order, and a ticket session's account
  (`startAccount`, after the code's repository) uses the card's board as `accountForCard` does.
  Checked: typecheck and vitest (fake clients per account). Not checked: real GitHub with two
  accounts, the app on screen. The CLI's `start_account` and master's own proposals still pick by
  repository (TODO).

- **Session processes in Details (#115)** are built on branch
  `worktree-MasterDeck-Terminal-115-session-processes` (draft PR, not merged, **not installed**: the
  rebuild of the real app waits for the user's word). Details → Session → **Processes**: the
  session's Claude Code shells and what runs below them, what a command left running, their ports
  (open in the browser), folder, pid, uptime, CPU / memory and last output; exited background
  commands keep their exit code for a minute (ARCHITECTURE "Session details → Session → Processes").
  Checked: typecheck, vitest (169 files passed, 2 skipped; 2067 tests passed, 4 skipped), the parsers against this Mac's real `ps` / `lsof` and a live session's
  tree, and the isolated app with a stand-in `claude` whose session ran `npm run dev` and two Python
  servers (list, ports, expanded output following along, the list emptying when they were killed).
  Not checked: the installed app with a real session, a port click opening the browser, the web
  app, Linux, Windows. Open points: TODO ("Session processes (#115)").

- **Per-session tabs (#113)** are built on branch `113-session-tabs` (PR #114, `origin/main`
  merged in, not merged to `main`; **installed locally 2026-10-12**). A tab row per session pane
  (Terminal, then file and diff tabs, kept per `Session.key` across restarts), Details → **Diff**
  and **Files**, ⌘P, ⌘-click on terminal paths; ⇧← / ⇧→ removed. Design and plan:
  `docs/plans/2026-10-12-session-tabs-{design,plan}.md`. Checked: typecheck, vitest, `build:web`,
  the web preview at 1400 and 390 px, and the isolated app with a stand-in `claude` listing one
  session in a temp repo (the four channels against real git, the Diff list updating by itself
  after a file was added, a diff tab kept after a restart, middle-click close). Open points:
  TODO ("Session tabs, files and diffs (#113)").

- **Built-in workflows (#104)** are built on branch
  `worktree-MasterDeck-Terminal-104-builtin-workflows` (3d5503a, 21a5f82, a42f78b and the review
  fixes; not merged, **not installed yet**). Five templates MasterDeck ships (Superpowers, Ticket to
  PR, Bug fix, TDD (locked tests), CI doctor) are seeded at launch with a mark
  (`builtin: {id, hash, raw}`), kept up to date while unedited, left alone once edited; the Workflow
  window shows a **Built-in** chip, the description and when to use it, **Duplicate**, **Restore
  original** (edited or renamed) and **Restore built-ins (n)**. TDD's check guards every `tests:`
  commit of the branch; CI doctor's waits for every run of the commit. Spec in the backend repo
  (`docs/superpowers/specs/2026-10-12-builtin-workflows-design.md`, branch
  `docs/builtin-workflows-104`, not pushed). Checked: typecheck, vitest (162 files passed, 2
  skipped; 2006 tests passed, 4 skipped), and, before the review fixes, the isolated app and the web
  preview as in a42f78b. Live runs (one `claude -p --model haiku` each, on a sample repo with a
  local bare `origin` and stand-in `gh`/`tt.sh`, isolated home; before the review fixes): Bug fix,
  Ticket to PR, TDD, CI doctor passed (plan from the trigger, loop met, PR step reached the gate);
  Superpowers ended at the stall limit while it waited on a background reviewer (fixed in the
  texts: reviewers run in the foreground; its loop has no stall limit now). The runs also changed
  every loop's wording (`LOOP DONE` only for a reached goal; nothing after the loop while it is
  open). Open: a loop is armed when its trigger fires, before the steps ahead of it, so question
  turns (Superpowers' brainstorm) are blocked as rounds. Open points: TODO ("Built-in workflows:
  open points").

- **BTW in the right panel's Tools tab (#106)** (Tools was the Queue tab; it now holds Queue and BTW as sub-tabs) (branch `worktree-MasterDeck-Terminal-106-btw-tab`, PR,
  not merged, **not installed**: the rebuild of the real app waits for the user's word). Asks a side
  question as `/btw` does through a forked `claude -p` of the session (no tools, hooks or MCP, nothing
  saved), streams it in, keeps the history per session in `<home>/btw/`, and picks up `/btw` typed in
  the terminal (`history.jsonl`, the answer read off `claude logs`). Spec and plan on the issue
  (the backend repo was out of reach of this session). Checked: typecheck, vitest, the web preview at
  1440 and 390 px, and the isolated app with a throwaway haiku background session: a panel question
  answered from its conversation, a terminal `/btw` captured off its screen, an old one listed
  without its answer, all three after a restart, the session's transcript unchanged. Not checked:
  the real web app, a phone, Windows. Open points: TODO ("BTW (Tools tab)").

- **Themes and a light theme (#105)** on branch `worktree-MasterDeck-Terminal-105-themes` (PR #108,
  not merged; installed locally 2026-10-12, default Dark so the look is unchanged until picked): every colour is a token of `shared/themes.ts` (Dark = the old look, Light = Primer-based,
  AA-checked), Settings → General → **Appearance** (Light / Dark / System, default Dark; per browser
  in the web app), live switching including terminals (xterm `minimumContrastRatio` 4.5 in light).
  Spec and plan in the backend repo (`docs/themes-105`, not pushed). Checked: typecheck, vitest,
  `build:web`, every screen in both themes in the web preview (1440 px and 390 px), and the isolated
  Electron app (Light / Dark / System switching, the window background and `nativeTheme`, kept
  after a restart). Not checked: Windows, a real Claude session in the light terminal, a phone.
  Open points: TODO ("Themes: open points").

- **Session details in three tabs (#103)** (branch `worktree-MasterDeck-Terminal-103-details-tabs`,
  draft PR, not merged): Session (no GitHub UI), GitHub (ticket / PRs / monitors as rows that
  open: sub-issues, checks, reviews, threads, comments, a PR watch's and a monitor's events newest
  first, ↗ links, live refresh) and Mods; the tab is remembered. Two new reads, `watch:events` and
  `pr:detail`; events kept in memory only. Spec and plan in this repo's
  `docs/superpowers/{specs,plans}/2026-10-12-details-tabs*`. Checked: typecheck, vitest, the web
  preview over CDP (each tab, rows opening, the tab kept after a reload, no GitHub text on the
  Session tab, a 280 px panel without sideways scroll, the phone's Panel). Not checked: a real
  `pr:detail` read against GitHub, the real web app over the bridge, Windows. Open points: TODO
  ("Session details → GitHub (#103)").

- **The README is rewritten for developers (#90)** (merged to `main` from branch
  `worktree-MasterDeck-Terminal-90-readme`, not pushed): pitch, badges, hero, Features with placeholder images in
  `docs/images/` (four copied from the website, `accounts-setup.svg` drawn in the same style), a
  Quick start, links to masterdeck.dev and the docs. Checked: every local link and guide anchor,
  masterdeck.dev's pages answer. Not checked: the render on GitHub (needs a push).

- **Costs time filter** (issue #88) is merged to `main` (from branch
  `worktree-MasterDeck-Terminal-88-costs-timeline`, not pushed) and installed locally (2026-10-12): presets and a custom range in the Costs view, costs and tokens kept
  per local hour (`shared/timeline.ts`; ARCHITECTURE "The Costs time filter"). Checked: typecheck,
  vitest, and the web preview (`/?preview` now has fixture cost history) at 1400 px and 390 px.
  Open points are in TODO ("Costs time filter").

- **MasterDeck installs, updates and reloads its mods (#93)** (branch
  `worktree-MasterDeck-Terminal-93-mods-install`, draft PR, not merged, **not installed**: the
  rebuild of the real app copies over `~/.claude/masterdeck/mods`, so it waits for the user's
  word). `mods/` ships in the app and is copied to `<home>/mods` at launch when it changed; Setup's
  **Mods** step and Settings → **Hooks, mods & skills** → **Mods** install (version check, the
  marketplace, each mod, `prependPlugins`) and remove them, backing up settings.json before every
  change; a Needs-you **MODS** item offers **Reload idle sessions**; `prependNote` says where
  `prependPlugins` is ignored. Checked: typecheck, vitest (153 files passed, 2 skipped; 1771 tests
  passed, 4 skipped), the isolated app with the real `claude` 2.1.296 and a temp `CLAUDE_CONFIG_DIR`
  (Install, Remove, backups, the real settings.json's hash unchanged), a packaged dir build's
  `Resources/mods`. Not checked: the reload item with real sessions, an update over the user's
  copy, Windows. Open points: TODO ("Mods install (#93)").

- **Meetings (#102)** are built on branch `worktree-MasterDeck-Terminal-102-meetings` (from 537cd0f,
  the capture notes, to the docs commit that carries this line): not merged, not pushed, installed
  locally (2026-10-10). Settings → **Meetings** (consent first, then the microphone, the Mac's sound,
  a speech model, offers), **Record** in the rail (a capture window: microphone and system audio
  apart as You / Others, 30-second chunks, `audio.webm`), whisper.cpp on the Mac per chunk, one
  `claude -p` per meeting that adds notes to the sessions and tickets it was about (Needs you lists
  them), the **Meetings** page (dates, transcript, audio, search, Match again, Export, Delete),
  Janitor → Meetings and **Delete audio after**, an offer when Zoom or Webex is in a call; and for
  notes: a note's `link` and `meeting`, Session details → **Notes n**, the panel's filters. Spec in
  the backend repo (`docs/superpowers/specs/2026-10-10-meetings-design.md`, branch
  `docs/meetings-102`, not pushed). What a quit or a crash left is transcribed at the next start
  once agreed (`background()` loads the queue; no gate, nothing asked of macOS), and Turn off
  cancels a model download and keeps the pick from before it. Checked: typecheck, vitest twice
  after the final review's fixes (182 files passed, 2 skipped; 2189 tests passed, 4 skipped, both
  runs), `npm run build`, and the isolated app: Settings → Meetings
  up to the consent, the Meetings page with `MASTERDECK_MEETINGS_FIXTURE` (list, transcript,
  audio, search), Janitor's Meetings section. Not checked: any real capture or permission prompt, a
  real transcription with a downloaded model, a real `claude -p` match, Zoom's and Webex's real
  process names in a call; Windows is not supported. Open points: TODO ("Meetings (#102): open points").
  **The mic follows the meeting app's mute** (Plan M, 2026-10-12; fc97904, a321ec6, 0466563,
  65937de and 081b82e, same branch, not installed yet): `md-mute` reads the meeting app's mute
  through Accessibility while recording, a gate keeps your mic out while muted (unknown keeps it),
  Settings → Meetings' **Your microphone** (Follow / Always record) and **Accessibility** row, the
  Record popout's mic line (`micLine` in `shared/meetings.ts`) and **Mic off in the recording**, a
  struck mic on the rail's red time. A crash of md-mute (or `trusted: false`) while muted keeps the
  mic out for the ~3 s hold, and the line tells a missing reader from a stopped one and says
  "Mic: paused." while paused. Checked: typecheck, vitest (186 files passed, 2 skipped; 2266
  tests passed, 4 skipped), `npm run build`, and Settings
  → Meetings' new rows in the isolated app after consent (no Allow pressed). Not checked: anything
  while recording (the popout's line and switch, the rail mark: typecheck and `micLine`'s tests
  only), the Accessibility prompt, whether its grant reaches the helper, any real meeting app's
  labels. Open points: TODO ("The mic follows the meeting app's mute").
  **`origin/main` merged in** (2026-10-13, up to PR #116): the session's Notes are a tab of
  Details beside Session, GitHub, Diff and Files (Mods moved to Tools on main), `btw.ts` uses
  `claudeOnce`'s `tidyProjects`, and the Meetings CSS reads theme tokens only (the theme lint).
  Checked: typecheck, vitest (208 files passed, 2 skipped; 2543 tests passed, 4 skipped),
  `npm run build`. Not checked on screen.

- **Workflow agent loops (#82)** are built on branch `worktree-MasterDeck-Terminal-82-agent-loops`
  (local `main` merged in at 9e00e29, so it also carries the mods of #86; pushed as PR #101, not
  merged; **installed locally 2026-10-10**, which added the loop Stop hook to the real
  `~/.claude/settings.json`). It sits beside the `/md-loop` mod (#86, `mods/masterdeck-loop`), a
  separate loop typed in one session; the two share no code (#100). A
  Loop frame on the Workflow canvas; `workflows/loop.sh` (generated by `shared/loopHook.ts`,
  installed with mark `masterdeck-workflow:loop`, timeout 600) blocks the session's stop until the
  check passes / the agent says `LOOP DONE:` or a limit is hit; state in
  `workflows/loops/<sid>.json` → `LoopStore` → `AppState.loops`. Design on the issue; spec and plan L
  in the backend repo (`docs/agent-loops-82`, not pushed). Checked: typecheck, vitest (155 files
  passed, 2 skipped; 1858 tests passed, 4 skipped), `build:web`, the canvas and Details in the web
  preview (1280 x 900, 390 x 844) and the isolated app with a stand-in `claude`, and three live
  loops with haiku in `claude -p` (temp settings file and home, `--setting-sources project`): met
  on the third round with the met branch run, stopped at 2/2 rounds, and `PROGRESS:` lines carried
  between rounds. Not checked: the installed app's real hooks driving a loop, the window's native
  Stop loop dialog, the real web app over the bridge, a phone, Windows. Open points: TODO
  ("Workflow loops: open points").

- **masterdeck.dev** (issue #89) is its own repository, [Masterdeck-Website](https://github.com/amntoppo/Masterdeck-Website)
  (private, `main`; checkout `~/Documents/personal/Masterdeck-Website`; deploy and search-engine notes
  in its README; OPERATIONS § Website). Live since 2026-10-10 as the Workers `masterdeck-site` and
  `masterdeck-www`. Built first as `site/` on branch `worktree-MasterDeck-Terminal-89-website`
  (bbebbb4), then moved out. For search: structured data, IndexNow on deploy, and this repository's
  website field, topics, README and release notes link to it. Google Search Console is still to be
  set up by hand (TODO). Agent loops (#82) show as "coming soon" on the site: update it when they ship.

- **MasterDeck has its own icon** (merged to `main` 3ce574c and pushed; installed locally and the
  web app deployed, 2026-10-10): the mark from masterdeck.dev on a dark tile, as the app icon
  (`app/build/icon.icns` / `icon.ico`, picked up by electron-builder; the Dock in `npm run dev`) and
  on app.masterdeck.dev (favicon, home-screen icons, web manifest). Made by `app/scripts/icons.mjs`.
  Checked: typecheck, `build:web`, the installed bundle's `icon.icns`, the live web app serving the
  icons and manifest. Not checked: Windows (the `.ico` reaches users with the next release).

- **Claude Code mods (#86)** (merged to `main` through PR #91; the app is installed locally from
  that branch, the six mods are installed at user scope from `~/.claude/masterdeck/mods`, and
  `prependPlugins` lists the core): research in
  [docs/MODS.md](docs/MODS.md); a probe showed a mod runs in a `claude --bg` session and draws in
  `claude attach`. Prototype mods: a core `mods/masterdeck` (per-session switches, heartbeat) and
  `masterdeck-ticket`, `masterdeck-alerts`, `masterdeck-note`, `masterdeck-loop` (`/md-loop`, #82),
  `masterdeck-board` (`/md-board`), and the app's side
  (`deck/band/<sid>.json`, Tools → **Mods** with a switch per mod per session). Checked:
  typecheck, vitest (151 files passed, 2 skipped; 1738 tests passed, 4 skipped), `claude plugin
  validate` / `test` / tsc for each mod, the Mods tab in the web preview at 1400 and 390 px, and
  throwaway sessions: the line at 80/110/160 columns, toasts, `/md-note` against a stand-in pump,
  the pane, MasterDeck closed, a `--plugin-dir` mod refused at start and back after a reload, and
  with the installed mods the core reporting all three and the ticket line switched off and on at
  once; `/md-board`'s pane with a sample board, and a `/md-loop` that took two rounds to pass its
  check. The user saw the line, `/md-ticket` and the pane in a real session. Not checked: the Mods
  tab in the installed app with real switches, instant typing under the line, Windows. A background session gets the daemon's environment, not the launching shell's
  (`MASTERDECK_HOME` does not reach the mod there). Open points: TODO ("MasterDeck mod").

- **Where a session starts was checked for real** (issue #59, branch
  `worktree-MasterDeck-Terminal-59-start-for-real`, pushed as a draft PR, not merged; no app code
  changed, one Python test added): in the isolated app with the real `claude`, a ticket session started from the
  Start dialog in the resolved temp checkout, `parked-sessions.json` got its record keyed by the
  background id, the parked session's link recorded no branch (the same link without the record
  took the folder's), the real trust prompt came up through **Open Claude there…**, and
  `claude --bg` 2.1.295's output matches the parser (its real shape is now in `test_spawn.py`),
  and from a master proposal the native picker, **Choose folder…**'s line and a start that kept
  master's prompt and model in the chosen folder (the checkout itself; a folder that is no
  checkout is still only unit-tested). The recipe is in OPERATIONS; follow-ups in TODO ("Where a
  session starts"). The Python suite: 453 passed.

- **Sessions move to Merged again** (branch `fix/session-merged-state`, not merged, not
  installed): the PR watch's "merged" message counted as the user writing after the merge, so
  watched sessions showed Rework; `isUserWords` skips `[MasterDeck …]` messages, and the watch's
  merge reaches `Sources.prLive` at once (`prEnded`). Checked: typecheck, vitest (`ask`, `prWatch`
  tests). Not checked: a real merge in the installed app.

- **Create with Claude's settings bar** (issue #68) is built on branch
  `worktree-MasterDeck-Terminal-68-ticket-settings`: not merged, not pushed, **not installed** (the
  rebuild and relaunch of the real app waits for the user's word). A bar below the chat, collapsed
  to one line (repo · people · column (board) · sprint · labels · milestone), expanded to pickers;
  it starts from the + column, the tab's filters and sprint, or the dialog's draft; each change
  rewrites `context.json` (`settings`) and the create pump enforces it on the next ticket
  (`enforceSettings`), answering with `applied` and any `overridden` value. A conflict is handled one
  way: Claude says the bar's value applies, and the user changes it in the bar. Checked: typecheck,
  vitest (142 files passed, 2 skipped; 1620 tests passed, 4 skipped, before the last sprint fix; the
  touched files again after it), and the isolated app with a fixture board and a stand-in `claude`
  (the collapsed line and expanded pickers, a board change moving status and sprint and reaching
  `context.json`, a hand-made dry-run request answered with the bar's values and four overrides).
  Not checked: a real Claude session following the briefing, a real create on GitHub, the web app,
  a phone, two or more accounts on screen, Windows. Open points: TODO ("Create with Claude settings bar").

- **Board popups show the description and sub-issues** (issue #81) on branch
  `worktree-MasterDeck-Terminal-81-board-popup-subissues` (not merged, not installed): the Assign
  popup shows the ticket's rendered description; it and the Start dialog list the sub-issues
  (`shared/subIssues.ts`, `SubIssues.tsx`, `GitHub.subIssues` → `issue:subIssues`, a read open to
  the web). Checked: typecheck, vitest, and the web preview (`/?preview`) at 1280x900 and 390x844,
  with a 40-paragraph description and 30 sub-issues scrolling in their boxes. Not checked: a real
  issue with sub-issues (none found in this repo; the endpoint and the jq filter were run read-only
  against GitHub), the Electron window.

- **The web app's Start dialog has Choose folder… (#62)** (branch
  `worktree-MasterDeck-Terminal-62-web-folder-choice`, not merged, not installed): a pick of the
  workspace and its repositories (`RepoPicker` `listOnly`), and `chosenFolder(remote, cwd, known)`
  takes a browser's folder only when it is one of `workspaceFolders()` (real paths), else refuses
  with a message. Checked: typecheck, vitest, the guard's tests (allowed, refused, a link out of the
  workspace), and the dev preview at 390 x 844 (the pick, the folder line after it, a refusal
  keeping the folder). Not checked: the real web app over the bridge, a start from the web, a real
  phone. An `assign` request's own `cwd` is still not checked (TODO).
- **Notes in Markdown (#65)** are built on branch `worktree-MasterDeck-Terminal-65-notes-markdown`
  (from `origin/main` with Notes merged, PR #69): the editor's **Write / Preview / Side by side**, the
  preview drawn by `MarkdownView` with `html={false}`, plain one-line previews, the window refusing
  navigation, and sessions adding to notes through the `masterdeck-notes` skill. Not merged, not
  installed (the user's word first). What was checked is in the PR; open points in TODO.

- **Where a session starts: three decisions (issue #61)** are built on branch
  `worktree-MasterDeck-Terminal-61-start-folder` (not merged, not installed). One rule decides the
  account a ticket's session runs as, and its workspace is where the folder is looked for:
  `config.start_account` (Python) / `startAccount` (TS): the account of the repository the code is
  in, else the issue's, else the primary. The code repository is a PR review's repository, else
  Setup's **Issues whose code is in another repository** pair (`codeRepos`), else the issue's.
  Picking another account in the Start dialog looks again in its workspace (`draft-assign
  --account`); a PR review asks `master checkout --account`. Checked: the Python suite, typecheck,
  vitest. Not checked: the isolated app on screen (Setup's pairs, the dialog's line after a pick).

- **Working hours per account** (issue #64) are built on branch `worktree-MasterDeck-Terminal-64-hours` (PR #75, installed locally 2026-10-09)
  (not merged): the Costs view's **Hours** estimates time per GitHub account, day and
  ticket from session activity on this Mac (idle gap 1 h by default, an account counts a minute once,
  each ticket its full time, unknown account listed), with CSV export; desktop only. Decisions are on
  the issue; the spec is in the backend repo (`docs/superpowers/specs/2026-10-09-working-hours-design.md`,
  branch `docs/working-hours-64`, not pushed). Open points: TODO ("Working hours: open points").

- **Session filters (#74)** are built on branch `worktree-MasterDeck-Terminal-74-session-filters`
  (PR #76, draft, not merged; installed locally 2026-10-09): a **Filters** line in the Sessions column, closed by
  default, with chips, Clear all and an empty state; status, account (two or more accounts), repo,
  starred and a name search, kept in localStorage. Logic in `shared/sessionFilter.ts`, UI in
  `SessionFilterBar.tsx`. Checked: typecheck, vitest, and the isolated app with a stand-in `claude`
  listing five fake sessions and two fictional accounts (open/close, picking, AND across kinds, the
  empty state, chip ×, Clear all, kept after a restart). Not checked: the web app, a phone, Windows,
  real sessions with recorded accounts.
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
- **Remote no longer waits for ever for the session list** (issue #8, branch
  `worktree-MasterDeck-Terminal-8-remote-waiting`, not merged; 2026-10-09): the
  status names the `claude agents` error, and after 60 s the line connects anyway (`remoteWait`,
  `REMOTE_WAIT_MS`); until the first session list no snapshot is sent and commands are answered
  "still loading" (agents loading) or fail at once with its error (agents failing). PR #77; the
  first version is installed locally. Checked: typecheck, vitest. Not checked: the isolated app against a local backend with a failing `claude`.
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

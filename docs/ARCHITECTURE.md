# Architecture

How the desktop app is put together, for agents changing it. Paths are relative to `app/src/`
unless they start with `app/` or `skills/`. The remote half (account, backend line, browser bridge,
web app, instant typing) has its own doc: [REMOTE.md](REMOTE.md).

```
                    ┌────────────────────────── Electron main process (main/) ─────────────────────────┐
 claude agents ───▶ │ Sources (sources.ts)  ── build() every change (250 ms coalesce) ──▶ AppState       │
 transcripts   ───▶ │   polls agents/details/menus/deck/ledger/github/stats                │           │
 ledger.json   ───▶ │                                                                     ▼           │
 gh / ghc      ───▶ │ Inbox (inbox.ts)  ◀── collectItems (shared/inbox.ts)       index.ts onState:    │
 deck hook files──▶ │ DeckHooks, Watches, WorkflowStore, Summaries, TokenIndex     emit(CH.state)  ───┼──▶ window (preload → renderer)
                    │ PtyManager (ptys.ts) ◀─ ptyOpen/Write/Resize ─┐               bridge.event()  ───┼──▶ browsers (browserBridge.ts)
                    │ Sender (send.ts) → open tab / hidden attach / master relay   cloud.push(snap) ──┼──▶ backend (cloudSync.ts)
                    │ IpcRegistry (ipcRegistry.ts): every CH handler, callable by the bridge too        │
                    └──────────────────────────────────────────────────────────────────────────────────┘
```

## Main process

### Startup (`main/index.ts`)

Module scope builds the singletons: `resolvePaths` (`main/paths.ts`), `makeRunner` (`main/run.ts`,
never throws: missing binary = code -1, timeout = -2), `MasterCli`, `PtyManager`, `GitHub`,
`Sender`, `Ops`, `Watches`, `Summaries`, `DeckHooks`, `Sources`, `BrowserStore`, `Account`,
`BrowserBridge`, `RemoteCommands`. `app.whenReady()` then:

1. Reconciles the remote token file and `account.json` (a token without identity is deleted; an
   identity without a token → `account.signedOutRemotely`).
2. `loginPath()` (the login shell's PATH) and `resolveClaude()`.
3. `registerIpc()` — every handler through `reg = new IpcRegistry(ipcMain)`; then
   `linkStore.importOnce()` (babysit-ticket's links copied into `ticket-links.json`, first launch only).
4. `loadMacKey(<home>/browser-key, safeStorage)` (the web app's Mac key).
5. Status line hook (`statusline.ts`: install or refresh `statusline_tee.py`), bundled skills
   (`syncSkills`), the one-time `migrateLegacyHooks` (non-Windows, not smoke, no
   `MASTERDECK_NO_HOOK`; recorded in `native-hooks.json`), `installReviewGate` (same conditions),
   hook status, MasterDeck's deck hook (non-Windows: `deckHooks.setup()`, monitors,
   `setInterval(pumpWatches, 1000)`, `installDeckHooks` with `UserPromptSubmit` for `/queue`, then
   `refreshHooks()` again), workflow migration + hook sync, then the PR watch (`prWatch.load()`,
   `setWatchInfo`/`setWatchedPrs`, `prWatch.poll` every 60 s, delivery in the 1 s timer).
6. A 1 s timer reading tickets the Board's session created and the workflow builder's draft.
7. `createWindow()`, then the accounts (`refreshAccounts`, awaiting only the local `gh auth token` reads; the `gh api user` checks, and `migrateAccounts` once, run in the background — an older config becomes one account from gh's active login and the global git identity, `config.backup.<ts>.json` kept), `sources.start()`, `syncRemote()`.

Env aids handled here: `MASTERDECK_USER_DATA`, `MASTERDECK_SMOKE`, `MASTERDECK_CAPTURE`
(+ `_JS`, `_WAIT`, and a `test:shot` IPC handler while capturing). `will-quit` stops the cloud line,
the sender's hidden attaches, watches, PTYs and sources.

### Sources and the state build (`main/sources.ts`)

`Sources` owns every polled input and builds `AppState` in `build()`. Any change calls the private
`emit()`, which coalesces to one `build()` per 250 ms and hands the state to the callback in
`index.ts`.

| Timer | What |
|---|---|
| `AGENTS_MS` 3 s | `claude agents --json` → sessions (`shared/agents.ts`); health `agents` |
| `DETAIL_MS` 3 s | `pollDetails`: transcript tails, stats, git for visible/focused tabs |
| `MENUS_MS` 4 s | `pollMenus`: the screen (`claude logs`, `main/screen.ts`) of sessions waiting on input |
| 1 s | `pollDeck`: deck hook events, permission/question requests, `alive` touch every 5 s |
| 30 s | `pollReview` (PR comments for Ready for Review; `REVIEW_MS` 2 min per session), `scanAllStats` |
| 60 s | ticket context files for the deck hook (`writeTicketContext`) |
| 5 s + `watchFile` | `readLedger` (`~/.claude/master/ledger.json`) |
| `GITHUB_MS` 1 h | `refreshGithub`: `master snapshot` + board + team PRs (through `ghc`); also on Refresh |
| `watchFile` 2 s | `~/.claude/master/config.json` → `loadConfig` |

GitHub rate limits pause every caller for `RATE_LIMIT_PAUSE_MS` (10 min). On start it loads the
cache (`cache.json`: snapshot, boards, sprints, users, team PRs) so the UI fills before GitHub
answers.

With two or more accounts `master snapshot`/`board`/`sprints` read each account with its own token (`collect.Live.for_account`: `gh auth token --user`) and merge (snapshot: `accounts[].sources`, each issue and PR tagged `account`, sessions read once with the primary; board: cards tagged `account`, `errors` when some failed); `keepLastGood` keeps only a failed account's last issues/PRs; team PRs are one search per account (`teamPrPages(owner, …, ownerType)`), tagged `account`, a failed account keeping its last pages (`mergeTeamPages`). A rate limit on one account: the shared cache pauses that account's calls, and the app's polling waits for any account's pause to lift (every account's refresh waits); `snapshot source missing: <k>` names the accounts. A session's branch head is read as its repo's account (`config.account_for_repo`), its failure tagged with that account; `master sprints` merges a title found on several accounts' boards (`board.merge_sprints`). Assignable users and `me` are the primary's. One account: the same single read as before.

`build()` order: raw sessions (minus the workflow/ticket builder sessions: `isTicketBuilderSession`, named `md-ticket-builder[-<tab>]` or in `ticket-builder/` or a `ticket-builder/tab-*` folder) → `attachIssues` →
`applyFreshness` → activity → hook state; asks and menus; deck hook permission requests become
menus; `collectItems` (`shared/inbox.ts`) → `inbox.update()`; then the `AppState` object.
The inbox is "primed" only once agents are healthy and the ledger was read, so nothing resolves or
notifies while loading.

Setters other modules call: `setExternalItems` (API items from the backend), `setAccount`,
`setRemote`, `setBrowsers`, `setRemoteClients` (skips the emit when both old and new are empty),
`setSkills`, `setHooks`, `setManualStatus`, `setSettings`, `setDeckHooks`, `setWatchInfo`,
`setLinker`, `setResumer`, and `changed()` (re-emit after an inbox action).

### What happens with each new state (`Sources` callback in `index.ts`)

1. `workflows().snapshot(...)` — each new session gets its own workflow copy (non-Windows).
2. `runFlowWatch(state)` — the Needs-you / idle workflow triggers (`shared/flowWatch.ts`); may
   notify or send `Workflow step (idle): …` to the session.
3. `boardFlow.tick(state)` (board moves, at most every 30 s) and `linkedSteps.deliver(sessions)`
   (the `linked` steps of native links); both catch their own errors.
4. `emit(CH.state, state)` — to the window and to every connected browser (`bridge.event`).
5. `cloud?.push(toRemoteSnapshot(state, version))` — the backend snapshot (see REMOTE.md).
6. First state with healthy agents → `remoteReady = true; syncRemote()`; a `remoteEnabled` flip →
   `syncRemote()`.
7. Notifications (`diffEvents`), dock badge (Needs-you count), auto-open (`newlyNeedsInput` →
   `CH.autoOpen`, dock bounce), and the SMOKE exit.

### Sessions and agents

- A `Session` (`shared/types.ts`) is keyed by `key` = background id when there is one (survives
  resume), else the sessionId. `state`: `working | idle | needs-input | suspended | done`, plus
  `waitingOn` (monitor/schedule), `busyWith` (background agents/commands), `asking`.
- `MASTER_NAME` (`shared/derive.ts`) is `master-agent`; `deriveMaster` gives `AppState.master`
  (`attached | elsewhere | duplicate | absent`).
- Statuses shown to the user come from `sessionStatus` (`shared/review.ts`) with `prStage` and
  `manualStatus` (`session-status.json`).
- Session ↔ ticket links: MasterDeck's `ticket-links.json` (`main/ticketLinks.ts` `LinkStore`,
  imported once from babysit-ticket's `~/.claude/babysit-ticket/state.json`; never read again after
  that), re-linked after resumes (`session-history.json`, `shared/carry.ts`).
- Restart recovery: `running-sessions.json` → `AppState.stoppedByRestart` → `resumeStopped`
  (`shared/restore.ts`).
- GitHub account (two or more connected): every `claude --bg` MasterDeck runs (`startClaude`,
  `resumeBg`, `startHere`, `startMaster`) gets `--settings <accounts/<login>.settings.json>` from
  `AccountEnv.settingsArgs` (via `sessionSettings` in `main/sessionAccounts.ts`); an unhealthy or
  unknown account, or no file yet, is refused, never started as gh's active one. Only master-agent
  starts without it, when the primary needs to log in again or the accounts' files are still
  being written. The account is recorded in `session-accounts.json` (`SessionAccounts`, by
  session id and key: the bg id `claude --bg` prints is recorded at once, `bgIdFromOutput`; a new
  session started by name is matched by name for 10 min; a live session known by only one of its
  ids, e.g. resumed by `claude attach` under a new session id, gets the other one on the next state
  build, `claim`) and shown as `Session.account` (`sessionAccount`: recorded, then its spawn
  proposal's `target.spawn.account`, then its folder's `origin`, then the primary). Resume always
  passes `--settings` again. `accountFor` (IPC) gives a new session's default for a folder. One
  account: no `--settings`, the same arguments as before.

### Needs you (the inbox)

- `shared/inbox.ts` `collectItems` builds every item (kinds include questions, menus, permission,
  input, blocked, proposals, offers for CI/review on my PRs, budget, context, idle/waiting nudges,
  API errors, `external` for API-created items, and `account`: a connected GitHub account whose token fails, only in multi mode; action `login` → `CH.ghLogin` → a gh-login tab, refused from a remote client; also `notice:<id>` items from `accountNotices` with no action: gh's active login (`refreshGhActive`, `gh config get user`, local, each minute) differing from the primary, with one account too, and in multi mode a master-agent not recorded in `session-accounts.json` as the primary (`startMaster` records it)), each with a stable id, priority, actions and a
  resolution reason.
- `main/inbox.ts` `Inbox` (an `EventEmitter`) keeps state in `inbox.json` and appends every
  addition, action and resolution to `inbox-events.jsonl` (last 2000 lines kept). Its `added`
  events drive notifications (`notifyItem` in `index.ts`, with macOS action buttons and replies).
- Every action goes through `inboxAct(id, type, payload, remote)` → `sources.inbox.act(…,
  runInboxAction)`. `runInboxAction` re-checks the session, then uses the normal paths: `sender.send`
  (reply/option/continue/compact/send), `answerMenuFor` (menus, hook-held questions and
  permissions), `cli.approve/reject` (proposals), `cloud.answerItem` (external items). Dismissing
  an `ext-…` item also sends `itemDismissed` to the backend.

### Hooks

- `main/hooks.ts` edits `~/.claude/settings.json` (backups, atomic writes, marker per hook):
  `hookStatus` (`HookStatus`: `queue` = something runs `/queue`: the deck hook with no skill queue
  hook beside it, or both skill queue hooks; `foreignQueue` = any queue skill hook, e.g. a
  hand-installed `$HOME/.claude/hooks/queue-submit.sh`; `reviewGate` = `REVIEW_MARK` in
  PreToolUse), `installWorkflowHooks`, `installDeckHooks`, `migrateLegacyHooks`.
- `migrateLegacyHooks(settingsPath, backupDir)` runs once at launch (`<home>/native-hooks.json`
  records it with what it removed). It removes only what older MasterDeck versions wrote for the
  skills: the exact commands in `LEGACY_COMMANDS` (tt.sh hook, babysit-pr's pre/post `gh pr create`
  hooks, the queue skill's `~/.claude/skills/queue/scripts/*`) or their `# masterdeck-builtin:<id>`
  wrappers. Everything else stays, including queue hooks installed by hand (they keep MasterDeck's
  queue off). It writes (backup first, atomic) only when it removed something. Nothing is switched
  off: board moves, self-review and the PR watch are Default-workflow steps. There is no install
  path for skill hooks any more (no `installHooks`, no `hooksInstall` IPC); the skills stay
  installed for use by hand. Sessions alive at the migration keep the queue skill's hooks (Claude
  Code reads hooks at session start), so when it removed a queue hook it writes `deck/legacy-sids`
  (`DeckHooks.markLegacy`: `*` until the session list is in; then `pruneLegacy`, from the state
  callback, turns it into the live session ids and deletes it once none of them is alive). The
  deck hook does no `/queue` work (UserPromptSubmit store, Stop drain/request) for a listed id, so
  no turn drains twice.
- Review gate: `reviewGateCommand`/`installReviewGate` (marker `REVIEW_MARK`) put a PreToolUse Bash
  hook in settings.json at every launch (via `refreshHooks()` after). It is `guardedBuiltin('pr-review')`,
  so a session whose workflow leaves the step out is skipped; it fires only when the command runs
  `gh pr create` (`runsOrExit`), denies the first try per session and branch with a short review instruction
  (marker `$TMPDIR/masterdeck-review-<session>-<branch>`; a prefilter exits before jq unless the input mentions `gh pr create`), and lets the retry through, as it does when
  `.git/pr-selfreview-<HEAD sha>` exists (a hand-run /babysit-pr).
- `main/deckHooks.ts` writes `<home>/deck/hook.sh` (one script for every event, `$1` = event) and
  reads what it leaves: `pending/<id>.json` + `answers/<id>.json` (PermissionRequest and
  AskUserQuestion held while MasterDeck runs, given up after ~9 min), `context/<session>.json`
  (printed on SessionStart), `watch-requests/` + `watch-answers/` (Monitor takeover),
  `events.jsonl` (the rest; emptied at launch past 4 MB), `alive`, `monitors-by`.
  It also handles `/queue`: UserPromptSubmit stores `/queue <prompt>` (any other prompt returns at
  once, unread and unlogged); Stop hands over the next item through `queue-requests/<id>.json` →
  claimed by rename to `.taken` → `queue-answers/<id>.json` (see Queue). `queue-off` (written when
  `hooks.ts` `hookStatus().foreignQueue` sees the queue skill's own hooks in settings.json; worked
  out again whenever settings.json's mtime changes) leaves `/queue`
  to those hooks.
  `shared/deckHooks.ts` parses events into per-session hook state (compacting, failures, stops).

### Monitors (watches) and schedules

- Settings `monitorsBy`: `claude` (Claude Code runs Monitor, 30 min, re-armed) or `masterdeck`.
- With `masterdeck`, the deck hook leaves each Monitor call in `watch-requests/`; `pumpWatches`
  (1 s) answers within the hook's 10 s window: `watches.add(req)` takes it over and the call is
  denied with `handedOver(...)` text; anything else (setting off, bad file) → Claude Code runs it.
- `main/watches.ts` `Watches` runs each script (no time limit), queues its output lines and
  delivers them through `sender.send` once the session's turn is over, as
  `[MasterDeck monitor: <description>]`. Kept in `watches.json`, restarted at launch (leftover
  process groups killed). `AppState.watches` / `watchStop`.
- PR watch (`main/prWatch.ts` `PrWatch`, pure parts in `shared/prWatch.ts`; replaces babysit-pr's
  Monitor phase): `sync` from the state callback adds each open PR in `sessionPrs` of a session with
  `settings.watchPrs` on and the `pr-watch` built-in in its workflow (old PRs are baselined: their
  items go into `seen` and the session gets one "already has K threads and L comments" line).
  First run (no `pr-watch.json` at `load`, e.g. the upgrade from babysit-pr): PRs added in the next
  10 min are `quiet`: their first full read goes into `seen` and nothing is sent, not even that line. Every 60 s `poll` sends one light GraphQL per 50 PRs and a heavy one (≤ 10
  PRs) only for PRs that changed, every 10 min, or when a stalled review is due; all through `ghc`
  (ttl 50 s) and nothing while the GitHub pause holds. Rate limits are read only from stderr, a failed
  answer's body or a GraphQL `RATE_LIMITED` error (`ghErrorText`; `pollPrs` too), never from a good
  answer's body (comments can say "rate limit"); a JSON answer's stdout is never scanned (gh
  exits 1 on a partial GraphQL error but prints the data). Such an answer is still read
  (`ghHasData`): one inaccessible PR does not starve its batch; after 3 light reads in a row
  without it, its watch ends with one line. Pending items that make no text (a stall past its
  nudges) are dropped. "Me" is the response's `viewer`; without it
  nothing is read into `seen`. A failed heavy read keeps `seen` and the old `updatedAt` (retried
  next poll). New items wait per PR (newest 30); at delivery (1 s timer, once the turn is over)
  one `[MasterDeck PR watch]` message per PR is built from them (10 listed per kind, "and N more"),
  and the paste stops at 6 KB ("(N more PR updates — check MasterDeck)", the rest next time). Ends on merge/close (told), on another author (silent) or by Stop (told).
  With two or more accounts each watched PR keeps its session's account (`PrWatchEntry.account`) and `poll` reads each account's PRs with that account's runner, so "me" (`viewer`) is that account.
  Kept in `pr-watch.json` (`seen`, pending, ended URLs never re-watched); `sync`/save wait for
  `load()`, and an unreadable file is moved to `pr-watch.corrupt.<ts>.json`. Rows join
  `state.watches` with ids `pr:<url>` (`watchStop` routes them), so they count as monitors in
  `withActivity`. Review offers are left out of Needs you (`InboxInput.watchedPrs`) only for watched PRs whose
  session can take a message now (`canSend`: not parked, not on a prompt, master up for interactive).
  BoardFlow's PR states come from the same light query (`prStates`, ttl 300 s).
- Schedules (CronCreate/CronDelete) are read from transcripts (`shared/schedules.ts`) into
  `AppState.schedules`; they make an idle session "Waiting".

### Workflows

`main/workflow.ts` `WorkflowStore` under `<home>`: `workflow.json` (Default), `workflows/templates/`,
`workflows/sessions/<sessionId>.json` (each session's copy), `workflows/triggers/` (custom
triggers), `workflows/monitors/` (`<id>.json` + `<id>.sh`), `workflows/runs.jsonl`,
`workflows/pending.json`. The flow model, compiler and checks are `shared/flow.ts`,
`shared/flowBuilder.ts` (builder drafts in `<home>/workflow-builder/`), `shared/flowTrack.ts`
(progress from transcripts), `shared/flowWatch.ts` (needs-you/idle triggers MasterDeck acts on).
One MasterDeck hook per trigger in settings.json reads the session's copy.

### Queue

`main/queue.ts` reads/edits `~/.claude/queue/<sessionId>.jsonl` (`MASTERDECK_QUEUE_DIR` in the
app's env moves it; the dir is baked into `hook.sh`, so a session's own env never splits them; the
`queue` skill uses the same file). MasterDeck's hook stores `/queue …`; at a Stop the app (running)
or the hook (not running) hands over the next prompt, claimed by rename so it runs once: the hook
leaves `queue-requests/<now>-<pid>-<rand>.json` and waits until 4 s after its start;
`DeckHooks.pumpQueue` (every second from `pumpWatches`) takes only requests under 8 s old whose
hook pid is alive, claims, answers with `queueAnswer`, and shifts the item when the hook still runs
or already read the answer (it removes the file right after reading); a hook that died before
reading leaves the item queued and its answer removed. Not claimed in time, the
hook renames the request back itself and drains one item; claimed, it waits until 7 s after its
start (clock deadlines, under the 10 s hook timeout). Unread answers are swept after 60 s.
`pumpWatches` also re-checks queue-off whenever `~/.claude/settings.json` changes.
Writes are temp + rename; an empty queue has no file. Remote `session.send` with `via: queue` adds
here (needs `hooks.queue`).

### Sender and PTYs

- `main/ptys.ts` `PtyManager`: one PTY per pane id (`PaneSpec` kinds `attach`, `shell`, `installer`,
  `builder`, `ticket-builder`; command from `shared/paneCommand.ts`). Keeps a 200 KB replay buffer
  and a cumulative `seq` (characters emitted) so a view that mounts later replays and then drops
  data already covered. Output goes out as `pty:data:<id>` / `pty:exit:<id>` through `emit`.
  Closing a pane kills only `claude attach`; the background session keeps running.
- The Board's ticket builder (`ticket-builder` spec `{resume, prompt, tab?, account?}`): one account,
  pane `ticket-builder:<gen>`, `claude -n md-ticket-builder` in `<home>/ticket-builder/`, exactly as
  before (`tab`/`account` ignored). Two or more (`isMulti`): one per Board tab, pane
  `ticket-builder:<tabId>:<gen>`, `-n md-ticket-builder-<tabId>` in `<home>/ticket-builder/tab-<tabId>/`
  (tab id `^[A-Za-z0-9_-]{1,64}$`), with the tab's account's `--settings <file>`
  (`AccountEnv.settingsArgs`); a bad tab, no account or an account that can't start refuses the pane
  (`main/ticketDirs.ts` `ticketPane`), never starting as gh's active account. `ticketBuilderPrepare`
  writes the same files into the tab's folder (`ctx.tabId`). The 1 s pump (`pumpTicketDir`) answers
  each folder (the shared one, or every `tab-*` one) and creates as that folder's `context.json`
  account (`ticketAccount`); created.jsonl is read from every folder whatever the mode. The browser
  bridge refuses a remote ticket-builder open with a bad `tab`, an `account` that is not a connected
  login, or one other than the account the tab folder's `context.json` already names (logins compared
  case-insensitively; `ticketSpecError`). Symlinked `tab-*` entries are skipped, and a folder is only
  prepared, opened or pumped when its real path is directly inside the real `ticket-builder/`
  (`ticketDirOk`). The New ticket dialog's Create with Claude is blocked while its Account differs
  from the tab's (`claudeHandoff`). Tab folders are never removed (see TODO).
- PTY size rule (spec §4, `MacPanes` in `main/remoteGuards.ts`): while the Mac window shows a pane
  its size wins; a browser's size applies only to panes the Mac doesn't show (`cols 0` from the
  window = hidden).
- `main/send.ts` `Sender.send(session, text, masterUp)`: types as the user would, into the open
  tab, through a short hidden `claude attach` (~3 s), or relayed by master-agent for a session in
  another terminal (only when `masterUp`). One send per session at a time; re-checks right before
  typing that the session didn't start waiting on a prompt (`looksLikePrompt`). `answerMenu`
  sends key steps for menus.

### master-agent integration

`config.accounts()` reads the connected accounts (primary first; a repo belongs to the first account listing it) and `config.is_multi()` is the one multi-account check (two or more); `repos()`/`projects()` are every account's; `master config save` mirrors the primary account into the top-level fields and `config shell` (tt.sh) reads only those.

`main/masterCli.ts` runs `python -m master.cli` (the `master` skill's lib, the installed copy in
`~/.claude/skills/master/lib` wins over the bundled one): ledger approve/reject, `draft-assign`,
`spawn`, snapshot, board, `config detect`. `master snapshot` reads MasterDeck's `ticket-links.json`
(not babysit-ticket's state; `MASTERDECK_HOME` overrides the folder), and the ASSIGN prompt no longer
asks the session to run babysit-ticket or babysit-pr: MasterDeck links it and watches its PR. `main/assign.ts` `startAssign` records + approves an
ASSIGN proposal and spawns. `startMaster()` runs `claude --bg -n master-agent "/master"` in the
workspace. GitHub reads go through `ghc` (`main/ghc.ts`, the shared cache in `~/.claude/gh-cache`;
`gh` directly on Windows).

master's sweep collects the same way (one read per account), so its proposals see every account's issues and PRs; `author_is_me` and the "last comment is mine" thread rule use each account's own login.

With two or more accounts, master's ASSIGN proposals carry `target.spawn.account` (the issue repo's account, `config.account_for_repo`); `master spawn` adds `--settings` for it and holds the proposal (with the reason) when the account's settings file is missing, never starting it as gh's active account; a proposal without an account (older, or `master add` without `--account`) spawns as its repo's account, else the primary's, and that account is written to the proposal (so the app attributes the session to it). ORPHAN resumes name the account the session was recorded as in `session-accounts.json` (`config.session_account`, a connected login only); unrecorded, `spawn.default_account` follows the app's `sessionAccount`: the session's own spawn proposal (same name), its folder's `origin` (`config.origin_repo` + `match_repo`), then the issue repo's account, else the primary. `spawn.command` holds a proposal whose account is not connected (case-insensitive) even when a file for it lingers. With one account `master spawn` passes no `--settings`, even for a target naming an account. The app's starts (`CH.assign`, remote `startAssign`) go through `assignNow` (`main/assign.ts`, wrapped in `index.ts`): the chosen account, else the issue's (`defaultAccount`), refused when it needs to log in again; master's proposal is reused only when it already names that account, otherwise (none: it would start as gh's active account; another; or the Start dialog's Account field changed) a new proposal carries it (`master add --account`). The account is recorded with `SessionAccounts.expect`. With one account any `account` in the request is dropped.

### Board writes (`main/boardOps.ts`)

`BoardOps` (formerly babysit-ticket's `tt.sh`) on the `ghc` runner: `issueInfo` (item and status on
the first configured board holding the issue; reads skip the cache), forward-only `move` (by
`statusRank`; `setStatus` forces, for the Board's status menu), `linkPr` (Development box via
`addCloseIssueReferences`) and `create` (issue, board, status, sprint). `linkTicket` is what
`linkSession` runs: it writes `LinkStore.link` (a failed write returns a failed result), marks the
session's `linked` stage (`Sources.markReached`), and moves the ticket to In Dev when
`WorkflowStore.builtinsFor(session)` has `ticket`. There is no global switch for board moves.
A successful `linkSession` also queues `LinkedSteps` (below).

### Which account a call uses (`main/accountClients.ts`)

`accountClients` (wired in `index.ts`) gives `forAccount(login)`: the account's `gh` runner
(`makeGhRunner` with `accountEnv.runEnv`, made once per login), `GitHub` and `BoardOps`; an unknown
login is the primary. `forRepo(repo)` picks by `accountForRepo`: issue body, assign, the PR popup,
status moves, ticket create (dialog and the ticket builder's requests), `linkSession`, and, straight
to gh without the cache (`ghDirect`), New ticket's repo meta and the summary post. BoardFlow's
`move`/`linkPr` go as the ticket's repo's account (boards are ticked under the same account as
their repos in Setup). `ghRouted` picks from a call's own `-R`/`--repo`, a whole PR or issue URL, or a
`repos/<owner>/<repo>/…` API path (`repoOfArgs`): Ops' janitor reads and Sources' `pr view <url>`;
a call naming no repo (`api user`, search) goes as the primary. BoardFlow's PR states go per account (`prStatesFor`, one
batched read each, in parallel; a failing account's read drops only its own PRs); the current branch's PR (`pr view` in the folder) is its `origin`'s account,
looked up first. An account without a usable token fails its calls with "GitHub account <login>
needs to log in again", and one AccountEnv has not read yet (just connected: its `runEnv` still
answers without a token) with "GitHub account <login> is not ready yet"; they never run as another
account or gh's active one. With one account
every one of them is the plain `gh`/`github`/`boardOps` singleton, called exactly as before.

### Board moves (`main/boardFlow.ts`)

`BoardFlow.tick(state)` runs from the state callback, at most every 30 s (`BOARD_TICK_MS`), one at a
time. Links imported from tt.sh (`imported: true` in `ticket-links.json`) are history: BoardFlow
leaves them out of (2) and (3) until a session links that ticket again (`withLink` writes a fresh
entry). (1) A session with no issue whose name matches the spawn target of a sent/question/blocked/done
ASSIGN proposal is linked through `linkSession` (tried once per session, ever:
`<home>/board-link-tried.json`). (2) Each new
PR in `state.sessionPrs` of a linked session that it opened (its transcripts: `Sources.prsOpenedBy`)
or whose repo and head branch are the link's branch key (`prOnBranch`, `PrLive.headRef`) is recorded
(`LinkStore.addPr`; a failed write is logged and retried next tick) and, when the session keeps
`ticket`, linked under the issue's Development box (`BoardOps.linkPr`; a failure is logged). The PR
of whatever branch its checkout is on stays display-only. (3) Tickets with at least one session keeping
`ticket`, whose card (and so its board) is known and not yet at Dev Done, get their PRs' states in
one `prStates` call per tick; `boardTarget` of a ticket's PR states: PR Raised once a PR is open and not a draft, Dev Done once none is open and
one is merged (only when every PR's state is known). Forward only (`statusRank` against the card's
status). A (ticket, target, PR set) move that went through, or found the card already there or past it,
is recorded in `<home>/board-moved.json` and never tried again (a card the user moved back stays; a
reopened ticket's new PR is a new PR set, so it moves again);
a failed one is tried again after 30 min (`RETRY_MS`). PR states
come from `state.prLive` for now (live sessions' PRs only).

`LinkedSteps` replaces the `linked` hook for links MasterDeck makes itself (no `tt.sh link` runs, so
the PostToolUse hook never fires): `queue(sid)` after a link adds the session to
`<home>/linked-steps.json` when its workflow (`compiledFor`) has `linked` steps not handed yet;
`deliver` sends their notes joined by a blank line (exactly what the hook adds; each note starts
`Workflow step (when a session is linked to its issue):`) once the turn is over (`canDeliver`,
the `Sender` path watches use), touches the hook's own once markers
(`$TMPDIR/masterdeck-workflow-<step>-<sid>`, so a later hand-run `tt.sh link` does not repeat them,
and vice versa), and logs the run (`logRun(sid, 'linked', ids)`) for Details. An ended session's
entry is dropped.

### GitHub accounts (`main/accountEnv.ts`)

With two or more connected accounts (`isMulti`), `AccountEnv` keeps each account's token in memory
(`refresh`: `gh auth token --user`, local only) and writes `accounts/<login>.settings.json` (mode
600, folder 700, temp + rename) with `accountEnvBlock`'s `env` (`GH_TOKEN`, `GHC_ACCOUNT`, git identity and rules); ssh aliases come from `~/.ssh/config`
and its Includes (`readSshConfig`). `check` then asks GitHub in the background (`gh api user`, parsed
with `parseGhUser`: HTTP 401 or another login → unhealthy and its file removed; offline →
unchanged; a new token clears an old refusal) and runs `git config --global --includes --get-regexp
'^url\..*\.(push)?insteadof$'`: a rule sending `https://github.com` to an SSH form
(`githubSshRewrite`) wins over a session's own rewrite, so it shows as a `warning` on every account.
`refreshAccounts` in `index.ts` runs at launch, when the config's accounts (login, primary, name, email:
`accountsKeyOf`) change (state callback) and hourly. A disconnected account's file, or one gh is no longer logged
in to, stays while a live session runs as it (`accountsInUse` reads `session-accounts.json` for the
live sessions; until the agents poll has answered, every recorded login counts). Leftover
`*.settings.json.*.tmp` files go on each refresh. With one account it reads and writes nothing,
removes every file not in use, `runEnv` gives `{env: {}}` and `settingsArgs` no arguments. The
migration (`migrateLegacyConfig`) builds the account from the config re-read after its network
waits, and writes nothing if accounts appeared meanwhile.

## Preload and IPC

- `shared/ipc.ts` defines `CH` (every channel name, e.g. `state:update`, `pty:open`,
  `inbox:act`, `account:signIn`, `browser:decide`) and `DeckApi` (the `window.deck` interface).
- `preload/index.ts` implements `DeckApi` with `ipcRenderer.invoke` (request/response),
  `ipcRenderer.send` (fire-and-forget: `setSprint`, `ptyWrite`, `ptyResize`, `ptyClose`,
  `setFocus`, `setVisible`, `openExternal`, `copy`, `setBoardOpen`) and `listen()` for events
  (`onState`, `onFocusSession`, `onShowNeedsYou`, `onShowInboxItem`, `onAutoOpen`,
  `onPtyData(id)` = `pty:data:<id>`, `onPtyExit(id)`, `onWorkflowDraft`, `onTicketsCreated`,
  `onGhLogin(login)`: open a gh-login tab for that account).
- GitHub accounts: `accountFor(cwd)` (a new session's default account for a folder; remote-allowed),
  `ghUser(login)` and `configDetectAll(login?)` (Setup's per-account reads; `ghUser` is local only),
  `ghAccounts` in state. There is no `ghSwitch`: MasterDeck never runs `gh auth switch`.
- Main registers handlers only via `IpcRegistry` (`reg.handle` / `reg.on`) so the browser bridge
  can `reg.call(ch, args)` the same function with a frozen `{remote: true}` event. `isRemote(e)`
  distinguishes the two; remote callers skip native dialogs (the web already asked with
  `webConfirm`), cannot change `remoteEnabled` (`remoteSettings`), only get known dirs
  (`knownDirsOnly` for standup), and obey the PTY size rule.
- `shared/remoteDeck.ts` `DECK_ACCESS` classifies every `DeckApi` member: `remote` (invoke/send
  over the bridge), `event`, `local` (runs in the browser) or `blocked` (account, browser approval,
  gh accounts and gh login (`ghUser`, `ghAccounts`, `ghOwners`, `onGhLogin`), folder picker, editor,
  shell prepare, auto-open). `ARG_FIX` reshapes
  arguments the preload defaults (`inboxAct`, `sessionWorkflowSave`).

## Shared modules (`shared/`)

Pure TypeScript, no electron/node imports in the types, tested with vitest. The main groups:

| Area | Modules |
|---|---|
| Types, IPC, settings | `types.ts` (`AppState`, `Session`, `PaneSpec`…), `ipc.ts`, `settings.ts` (`Settings`, `DEFAULT_SETTINGS`, `normalizeSettings`), `appConfig.ts`, `shortcuts.ts`, `keys.ts` |
| Sessions | `agents.ts`, `derive.ts`, `review.ts`, `sessionOrder.ts`, `tasks.ts`, `restore.ts`, `pastSessions.ts`, `carry.ts`, `link.ts`, `procs.ts`, `paneCommand.ts` |
| Transcripts | `activity.ts`, `ask.ts` (menus from screens), `prompt.ts`, `promptGuard.ts`, `prscan.ts`, `worktrees.ts`, `stats.ts`, `history.ts`, `summary.ts`, `tokens.ts`, `costs.ts`, `schedules.ts`, `watches.ts` |
| Needs you | `inbox.ts`, `notify.ts`, `nudge.ts`, `offers.ts`, `send.ts` |
| GitHub, board | `board.ts`, `boardFilter.ts`, `teamPrs.ts`, `prSummary.ts`, `accounts.ts`, `ticket.ts`, `ticketBuilder.ts`, `sprintSummary.ts`, `standup.ts`, `ghAuth.ts`, `detect.ts`, `git.ts`, `janitor.ts`, `cleanup.ts` |
| Workflows, hooks | `flow.ts`, `flowBuilder.ts`, `flowTrack.ts`, `flowWatch.ts`, `workflow.ts`, `deckHooks.ts`, `skillInfo.ts`, `install.ts`, `models.ts` |
| Remote | `remote.ts` (wire protocol copy), `remoteSnapshot.ts`, `remoteGuard.ts`, `remoteDeck.ts`, `remotePresence.ts`, `deviceInfo.ts`, `account.ts`, `bridgeWire.ts`, `e2e.ts`, `b64.ts`, `wordlist.ts` (BIP-39) |
| Misc | `format.ts`, `fuzzy.ts` |

## Renderer (`renderer/src/`)

- `main.tsx` mounts `App`. `deck.ts`: `deck()` = `window.deck`, `useAppState()` (first
  `getState()`, then `onState`), `useNow(ms)`.
- `App.tsx` lays out, left to right: **`Rail`** (views, tools, the remote indicator, actions,
  Settings), **`Sidebar`** (the Sessions column on Terminals: Needs you, grouped sessions, shells,
  Parked, footer with Refresh/Cleanup/GitHub cache), the **main view**, the **`Inspector`** right
  panel on Terminals (Details = `SessionDetails`, Queue = `QueuePanel`, Summary = `SummaryPanel`),
  and **`MasterPane`** (master-agent's terminal; ★ Master / ⌘⇧M). Dialogs and popups mount at the
  end (`BrowserApproval` only where `can('browserDecide')`, i.e. desktop).
- Views (`View` in `Sidebar.tsx`): `terminals`, `board` (`BoardView`), `prs` (`PrsView`), `tasks`
  (`TasksView`), `costs` (`CostsView`), `janitor` (`HygieneViews`), `workflow` (`WorkflowView` +
  `FlowEditor`), `settings` (`SettingsView` + `AccountPanel`), `history` (`HistoryDialog`).
- Terminals: `TerminalView` (xterm 6 + fit + search; replay/seq handling; Cmd+C/V; size only from
  the visible view; on the web all output goes through `predictiveEcho`).
- Web gating: `web.ts` — `isWeb()` (`deck().platform === 'web'`), `can(method)`, `WEB_VIEWS`,
  `screenOk`, `shortcutOk`, `actionOk`, `keyPlatform`. `webConfirm.ts` + `WebConfirm.tsx` replace
  native dialogs on the web. `repoPicker.ts` + `RepoPicker.tsx` replace the folder picker.
- One stylesheet: `styles.css` (the web adds `src/web/web.css`).
- Phone layout (web only): `web.ts` `isPhone()` / `usePhone()` = `isWeb() && matchMedia(PHONE_QUERY)`
  (`(max-width: 760px)`), so Electron never gets it. App adds `phone ps-list|main|master` to `.app`
  and keeps `phoneScreen` (session list, terminal or view, master) and `phonePanel` (Inspector as a
  sheet); `shown`/`panelShown`/`masterShown` follow those on a phone (one terminal, no split). The
  Rail becomes `PhoneBar` (Rail.tsx: tabs + More menu); the terminal screen gets a `phone-head` and
  `QuickKeys` (App.tsx; a key is sent on click, so a swipe along the bar only scrolls it, and
  pointer/mouse down are prevented so the terminal keeps focus), which press keys through `terminalKey()` (TerminalView.tsx: xterm's
  `input()`, so predictive echo and `ptyWrite` see them like typing; bytes from `quickKeys.ts`,
  arrows follow DECCKM). A phone terminal uses 12px (changed and refitted when phone mode comes or goes). The panel sheet
  closes when the terminal screen is left. `html.phone` is set too while phone mode is on, so dialogs
  and menus portaled to `<body>` get the phone dialog/menu/input rules. `--vvh`/`--vvt` follow `visualViewport` (soft
  keyboard). Board and PRs render their filter row through `PhoneFilters` (components/PhoneFilters.tsx) on a
  phone: a "Filters (n)" button (n = `activeBoardFilterCount` / `activeFilterCount` without search) plus the
  search box; the same controls JSX (`filterControls`) opens in a portaled `.dialog.filters-sheet`
  (Reset keeps search, Done, Esc/backdrop close). All phone CSS is in `src/web/web.css` under `.app.phone`; when not phone, every shared
  component renders the same DOM as before.
- Dev preview (web): `npm run dev:web`, then `/?preview` mounts App on a stub `window.deck` with a
  fixture AppState and fake terminal output (`src/web/preview/`), `/?preview=gate` the sign-in card.
  `main.tsx` imports it only under `import.meta.env.DEV`, so `build:web` leaves it out (check:
  `grep -l "nothing was sent" out/web/assets/*` finds nothing).

## AppState: fields and producers

| Field | Producer |
|---|---|
| `sessions`, `master`, `lastActivity`, `asks`, `menus`, `prStage`, `manualStatus`, `hookInfo` | `Sources` (agents poll, transcripts, deck hook, `session-status.json`) |
| `issues`, `prs`, `proposals`, `lastSnapshotAt`, `board*`, `sprints`, `selectedSprint`, `users`, `me`, `boardHistory`, `githubRefreshedAt/ing` | `master snapshot` / `master board` / ledger (`refreshGithub`, `readLedger`), cached in `cache.json` |
| `teamPrs`, `teamPrsAt`, `teamPrsLoading`, `teamPrsError` | `refreshTeamPrs` |
| `inbox` | `Inbox.view()` over `collectItems` |
| `stats`, `allStats`, `tails`, `git`, `tokens`, `costBook` | status line files (`stats/`), transcript tails, git, `TokenIndex` (`tokens.json`), `costs.json` |
| `prLive`, `sessionPrs`, `sessionWorktrees`, `pastSessions` | `gh pr view` for followed PRs, `session-prs.json`, transcripts, `ticket-links.json` |
| `watches`, `schedules` | `Watches.info()` + `PrWatch.info()` (`pr:<url>` rows), transcripts |
| `sources`, `errors`, `missingBinaries`, `ghCache` | health of each poll, `readGhCacheStatus()` |
| `settings`, `config`, `skills`, `hooks`, `statuslineInstalled`, `masterWorkspace` | `settings.json`, `~/.claude/master/config.json`, `syncSkills`, `hookStatus` |
| `stoppedByRestart`, `restoring` | `running-sessions.json` |
| `remote` (+ `warning`), `remoteClients` | `CloudSync` status / `clients` message (`syncRemote`), bridge warning |
| `browsers`, `browserRequests` | `BrowserBridge` via `publishBrowsers()` |
| `account` | `Account.state()` |
| `Session.account` (inside `sessions`; two or more accounts) | `sessionAccount` over `SessionAccounts` (`session-accounts.json`), the session's spawn proposal, its folder's `origin`, else the primary |
| `ghAccounts` | `AccountEnv.status()` (login, primary, health, warning; never a token) |

## Files on disk

Under `MASTERDECK_HOME` (default `~/.claude/masterdeck`):

| File / folder | What |
|---|---|
| `settings.json` | `Settings` |
| `cache.json` | last GitHub snapshot, boards, sprints, users, team PRs |
| `costs.json`, `tokens.json`, `stats/` | cost book, token index, status line output per session |
| `statusline_tee.py` | installed status line tee (settings.json points here) |
| `inbox.json`, `inbox-events.jsonl` | Needs you state and event log |
| `session-history.json`, `session-prs.json`, `session-status.json`, `running-sessions.json` | session ids per background session, PRs per session, manual statuses, restart list |
| `summaries/`, `templates.json`, `skills.json` | session summaries, Start-dialog templates, removed skills |
| `watches.json` | monitors MasterDeck runs |
| `pr-watch.json` | PR watch: watched PRs (seen keys, pending messages) and ended PR URLs |
| `ticket-links.json` | session ↔ ticket links (tt.sh `state.json` shape; imported once from babysit-ticket) |
| `board-link-tried.json` | sessions BoardFlow already tried to auto-link (never retried) |
| `board-moved.json` | `<ticket>:<target>:<PR urls>` board moves BoardFlow made or found done (never retried) |
| `linked-steps.json` | sessions linked by MasterDeck whose `linked` workflow steps are still to be sent |
| `deck/` | `hook.sh`, `pending/`, `answers/`, `context/`, `watch-requests/`, `watch-answers/`, `queue-requests/`, `queue-answers/`, `queue-off`, `legacy-sids`, `events.jsonl`, `alive`, `monitors-by` |
| `workflow.json`, `workflows/` | workflows (see above) |
| `workflow-builder/`, `ticket-builder/`, `installer/`, `editor-probe` | the builder sessions' folders, Setup's installer folder, editor detection. `ticket-builder/` (two or more accounts: each `ticket-builder/tab-<tabId>/`) also holds `requests/` (`<id>.req`, NUL-separated flags from `create-ticket.sh`; `.taken` once MasterDeck claims it) and `answers/` (`<id>.json`) |
| `settings.backup.<ts>.json` | Claude settings backups |
| `native-hooks.json` | `{at, removed}`: the one-time removal of the old skill hooks ran (`migrateLegacyHooks`) |
| `account.json` | signed-in identity `{email, provider, deviceId}` |
| `session-accounts.json` | GitHub account per session id / key (two or more accounts) |
| `accounts/` | `<login>.settings.json` per connected account (two or more): `{"env": {GH_TOKEN, GIT_* …}}` for `claude --settings`; mode 600, folder 700 |
| `remote-token` | device token, Keychain-encrypted (`safeStorage`), mode 600 |
| `remote-device-id` | random UUID sent in `hello` |
| `remote-done.json` | last 500 remote command outcomes (run-once) |
| `browser-key` | the Mac's P-256 key for browsers, Keychain-encrypted, mode 600 |
| `browsers.json` | approved browsers, tagged with the account id, mode 600 |
| `claude-settings.json`, `skills/` | only with `MASTERDECK_ISOLATED=1` |

Elsewhere: `~/.claude/settings.json` (hooks, status line), `~/.claude/skills/` (bundled skills),
`~/.claude/master/{config.json,ledger.json}` (plus `config.backup.<ts>.json`, written once before the first-launch accounts migration), `~/.claude/queue/` (or `MASTERDECK_QUEUE_DIR`), `~/.claude/babysit-ticket/`,
`~/.claude/gh-cache/`, `~/.claude/projects/` (transcripts, read-only), Electron user data.

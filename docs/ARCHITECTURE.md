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
   `setInterval(pumpWatches, 1000)`, `installDeckHooks` with `UserPromptSubmit` for `/queue` and the
   `SendMessage` reports guard, then
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
  ids gets the other one on the next state build, `claim`) and shown as `Session.account` (`sessionAccount`: recorded, then its spawn
  proposal's `target.spawn.account`, then its folder's `origin`, then the primary).
- Resume (`resumeAs` in `main/sessionAccounts.ts`, for `resumeBg`, `startHere` and the restorer;
  `spawn.command` in the master skill). Claude Code 2.1.288: `claude --bg --resume <id>` with **no
  other flag** wakes the background session itself (same session id and bg id, its saved options:
  name, model, mode, `--settings`); **any** flag (`-n`, `--settings`, `--model`,
  `--permission-mode`) starts a copy under new ids and leaves the old session listed, so two
  sessions share a name and the old one shows outdated messages. Rules:
  - A listed background session resumes bare, with one account or several, recorded or not. The
    account is not resolved for it (an account still loading or logged out does not block it).
  - After a bare resume with two or more accounts the note is read (`wokeFromOutput`: `note: woke
    session <id> with its saved options (-n, --settings, …)`; `--settings` is listed only when the
    session was started with it; the list counts only when it was read whole: closing
    parenthesis, no `…`, else nothing is changed). Without it the session works as gh's active account: its ids
    are marked in `session-accounts.json` (`SessionAccounts.markGhActive`, value `*gh-active*`,
    which replaces a record an earlier build left under the old ids), `Session.ghActive` is set
    and `Session.account` is not, and the UI shows "gh's active account (started without an
    account)" (AccountBadge, SessionAccount, Details), never a login. With it the record stands.
  - A copy happens only when the user chose one: an account given that is not the recorded one
    (`resumeAccount` sends the pick, else the record, never the select's default), or a new name
    (`rename`). The account is resolved, the session list is read afresh (`sources.refreshAgents`,
    awaited) and the resume is refused while the old session has a process (`pid !== null`
    alone). The copy is started with `--settings` and `-n` and recorded under its own bg id
    (`bgIdFromOutput`: the id after `backgrounded ·`, whatever follows it; `claim` adds its
    session id). **MasterDeck never removes a session** (`claude rm` deletes its worktree too):
    the old one stays, stopped, and its bg id and session id go to `superseded-sessions.json`
    (`main/superseded.ts`), only when the output names it as the copied one (`copyFromOutput`).
    `Sources.build` leaves superseded background rows that do not run out of the list, matched
    by bg id only (`shared/superseded.ts` `hideSuperseded`); running again, they show. The copy
    inherits the old session's ticket link and PRs: `Sources.noteCopy` (`shared/carry.ts`
    `carryCopy`) puts the old session ids into the copy's `session-history.json` entry, so
    `linksToCarry` links the copy once it shows up, and copies its `session-prs.json` list. The
    master skill reads the same list (`config.superseded_ids`, `join.sessions`): a superseded
    session that does not run is left out of the snapshot, so it owns no issue and gets no
    ORPHAN proposal beside its copy. The copy does not carry
    the old session's `--model` / `--permission-mode` (not known reliably; see TODO).
  - Not a listed background session (History, an interactive session for Start here): there are no
    saved options and nothing to copy, so `--settings` and `-n` as for a new start.
  - The session list not loaded (`Sources.sessionsNow()` null): read once more; still unknown,
    one account resumes bare (it cannot copy), two or more (or a rename) are refused.
  - `master spawn` (ORPHAN): bare when there is no record (`config.session_account`) or it is the
    proposal's account; `--settings` (a copy) only when the proposal names another account than
    the record. Never `claude rm`. `spawn.running` is true / false / None, by session id or bg
    id: true marks the proposal sent ("already running"), None (`claude agents` failed) holds
    it. After a copy (`spawn.copy_of`) it writes the copy's bg id to `session-accounts.json` and
    the old ids to `superseded-sessions.json` (`spawn.merge_json`: read, merge, temp file +
    rename; a file that is there but unreadable is left untouched). The app reads both files again when their mtime changes, and its own writes of
    `session-accounts.json` keep entries it does not know (`SessionAccounts.sync`).
  - The restorer (`shared/restore.ts` `resumeEntries`, used by `Sources.resumeStopped`) awaits a
    fresh `claude agents` read before each entry and skips one that runs again under the same
    session id or bg id, so a second app start resumes nothing twice.
  Deviation from the several-accounts spec (plan I, "resume always passes `--settings` again"):
  that rule made every resume a copy; the saved options carry the account instead.
  `accountFor` (IPC) gives a new session's default for a folder. One
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
  PreToolUse; `masterGuard` = the deck hook's `MasterReport` entry in PreToolUse), `installWorkflowHooks`, `installDeckHooks`, `migrateLegacyHooks`.
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
- Master reports guard: `installDeckHooks` also registers `"<home>/deck/hook.sh" MasterReport` as a
  PreToolUse hook on `SendMessage` (marker `/deck/hook.sh" MasterReport`, timeout 10 s; part of
  `deckInstalledIn`, so an install from before it is completed at the next launch; the legacy
  migration and the review gate never match it). The script's `MasterReport` branch exits before jq
  unless the input holds `#<digit>`, then runs one jq program (`MASTER_REPORT_JQ`): a report is a
  message (or `summary`) whose first non-empty line, after leading markdown or quote characters
  (`>`, `*`, `_`, backticks, `-`, spaces, heading markers `## `, list numbers `1. `), matches
  `^((?:[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+)?#\d+\s*:\s*(done|blocked|question|answered)` (not followed
  by a letter or digit), case-insensitive: `#12`, `name#12` or `owner/name#12`. A report
  is denied (`permissionDecision: "deny"`; the reason says to send it to the master by name and,
  if that is not reachable, to ask the user, never another session) unless `to`
  is the master: `masterName`, case-insensitive, or `<masterName> [<ref>]`. The name and
  `masterEnabled` are read from the config file on every call (its path, `paths.config`, is baked
  into the script like the queue dir), so a config change needs no reinstall; a missing or broken
  config means `master-agent`, enabled. With `masterEnabled: false` every report to a session is
  denied. Not checked: a call from a subagent or teammate (`agent_id` or `agent_type` in the hook
  input; it reports to its parent), and the master session itself: `deck/master-sids` lists its
  session ids (every session named `masterName`, done or not, from the state callback in
  `index.ts`: `DeckHooks.setMasterSessions`) and, right after `startMaster` or a resume of the
  master, its bg id or session id (`addMasterSession`, kept 10 minutes until a poll lists it; on a
  resume only when the session list names that id as the master, `isMasterSession`, and only
  from the window, never a remote caller); the
  hook passes a `session_id` that equals a line or starts with it. It fails open: no jq, input
  that does not parse, a `to` or message that is not a string, all print nothing.

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

An account with repositories but no project board (`config.boardless(view)`; with one account: the whole config): `master board` reads its ticked repositories' issues instead (`collect.Live.repo_issues`: one GraphQL query with an alias per repository — open issues 100 a page, at most three rounds, plus the ones closed in the last 14 days; `ghc` TTL 120 s; a repository GitHub answers nothing for is named in `missing` and remembered for an hour in `missing-repos.json` under the master home only when GitHub's error for that alias is `NOT_FOUND` (any other null, e.g. `RATE_LIMITED`, is listed in `missing` for that run only, named with its error type in `unread`, shown as a Board note, and asked again next call), so the steady-state query has no failing alias and the cache works; a forced read, `GHC_FORCE=1` from the Board's Refresh or Retry, ignores the memory, asks for every repository and writes it afresh: still `NOT_FOUND` is remembered from now, one that answers is forgotten; `collect._run(…, partial=True)`, also when every repository is gone), `--mine` keeps the issues assigned to the account's login and `--sprint` is ignored (no sprints without a board); one `pr_details` read only for linked PRs that are open or drafts. Its cards carry `derived: true`, `state`, `closedAt` and no status (the app works out the column, see "Board without a GitHub project"); the board lists what was read in `derived` (`account`, `repos`, `total`, `shown`, `skipped` past 10 repositories, `missing`, and `notes`: one line for each thing that read could not do, e.g. `acme/api not read: RATE_LIMITED`, `Pull request details not read: …`; the same lines, joined per account, are also the top-level `notes`). An issue that is on one account's board and in a ticked repository of an account with no board is the board's card, whichever account is read first (`board.on_boards`; `board.build` drops the derived item, `snapshot.merge` does the same for the snapshot's issues), and `cmd_board` takes it off that part's `total` and `shown` when it is open (`board.shadowed_open`), so the note never counts a card the tab does not show. Limits are in `config.py` (`DERIVED_MAX_REPOS` 10, `DERIVED_MAX_CARDS` 300, `DERIVED_MAX_DONE` 50, `DERIVED_DONE_DAYS` 14). A board whose config entry has `sprintless: true` (one MasterDeck created) is read without the sprint part of the filter (`board.sprintless_query`): `sprint:@current` matches nothing on a board with no sprint field. GitHub's detection never says a board is such a one, so Setup carries the mark over when it rebuilds an entry from a detected board (`setupAccounts.ts`: `markMade` marks the detected list from the saved config, `withFound` keeps it on chosen boards; both only while the detected board has no sprint field: one added on GitHub since drops the mark, and the board has sprints again); `master config save` passes it through (`config._project`, `setup._mirror`).

The same read serves the Board's repository view, narrowed: `collect.Live.repo_issues(today, only=[…], boards=True)` reads just the named repositories (in the spelling Setup has; each paged to its own three rounds of 100 open issues instead of the account-wide stop at 300) and, when the reading account has a board, asks each issue which project boards hold it (`projectItems(first: 5)` with one aliased `fieldValueByName` per distinct status field name: `board.status_fields`, `board._boards_part`; both are fields MasterDeck already reads elsewhere). `repo_issues_page` turns that into `on boards: [{key, status}]` for the boards selected in Setup only, and `board.build` hands it on as the card's `onBoards` (only on a derived item, so a card of `master board` never has it). An error on `projectItems` (a token without the `project` scope: GitHub then nulls the issue itself) makes the read send the same round once more without that part and report `boards_unread`. Without `only` and `boards` the query is byte for byte the one above, so the board read and the snapshot still share one cached answer. The read also returns `totals` (open issues per repository).

`master snapshot` for such an account (`snapshot.build`: repositories, no board) takes the same repository read (the identical call, so `ghc` answers one of the two) and keeps only the open issues assigned to that account's login (`normalize.repo_issues`), each `derived: true` with the column GitHub alone gives it (`board.derived_status`: an open ready PR → PR Raised, a draft → In Dev, a merged one → Done and left out, else Todo); Todo becomes In Dev when a session owns the issue. `rules.propose` reads `config.DERIVED_STATUSES` for them (`rules._statuses`): ASSIGN only for Todo with no owner, ORPHAN for In Dev / PR Raised with a stopped owner; never an issue assigned to someone else or to nobody. On a `sprintless` board the issues assigned to me count as current (`normalize._issue`); unassigned ready ones are not offered.

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
For an account with no board (`repoBoardless`): `linkTicket` links the session all the same (`LinkDeps.boardless`; no card, so no move), `create` without a named board makes the issue only (it never falls back to another account's first board, and drops a status or sprint that came along); the same holds when the account creating it (`CreateOpts.account`: the Board tab's from `context.json`, the dialog's) has no board, whatever repository is named, and a board named outright is then refused before anything is created, and the `setStatus` handler refuses without a GitHub call. `BoardFlow` links such a ticket's session and its PRs under the issue's Development box as usual, and `move` skips the ticket before any read because its card has no `project`: no move, no error, nothing retried (pinned in `boardFlow.test.ts`).

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

### Board without a GitHub project (`shared/derivedBoard.ts`)

`boardless(login, cfg)` is the one check: the account (two or more: the tab's; one: the whole config) has repositories and no board; `repoBoardless(repo, cfg)` asks it for a repository's account. For such an account `master board` delivers its repositories' issues as cards with `derived: true`, `state`, `closedAt` and no status. `Sources.refreshBoard` therefore runs the board read whenever a board or a repository is selected (`boardWanted`; not only when a project is configured, and not at all when nothing is ticked), keeps those facts in `boards[…]` / `cache.json`, and `Sources.build()` passes the board through `deriveBoard`, which sets each derived card's status from what MasterDeck knows at that moment (`derivedStatus`, first match wins): closed → Done (only if closed in the last 14 days, else the card is dropped); a PR open and ready → PR Raised; a draft → In Dev; a merged PR → Done; a linked session, live (`sessionForIssue`) or stopped (`pastSessions`) → In Dev; else Todo. PR states come from the card's linked PRs and the PRs recorded for the ticket's sessions (`ticketPrMap` over `ticket-links.json`, kept in `Sources.linkPrs`), with `prLive` winning when MasterDeck follows the PR; a PR closed without merging, or of unknown state, counts for nothing. A board with no derived card comes back as the same object; one with them goes through `boardDeriver` (one per `Sources`), which hands back the board of the build before while the read is the same and no card changed (cards compared field by field, since an assign changes one in place), so the Board does not filter again on every state build. `tabBoard` gives a Board tab its cards (an account with a board: exactly `boardForAccount`; without: its derived cards and the fixed columns `DERIVED_COLUMNS`), `boardEmpty` says why a tab has no card (the tab's Refresh / Retry runs through `whileBusy`, `shared/busy.ts`, so a rejected refresh never leaves it on "Loading board…"), `derivedNotes` what the read left out, `withoutDerived` keeps these cards out of the sprint Summary and the burndown.

The Board tab (`BoardView.tsx`): `fallback = boardless(tabAccount, cfg)` is the one switch. With it: the cards come from `tabBoard` (also for a tab with a board, so it never shows another account's derived cards), the columns are `DERIVED_COLUMNS` in their fixed order (no `orderColumns`, no long-press reorder), cards are not draggable and nothing can be dropped (`drop` and `doMove` also refuse any `card.derived`, and `CH.setStatus` refuses a repository whose account has no board, so a derived card never reaches `BoardOps.move`), there is no sprint picker (also for a tab whose boards are all `sprintless`) and no Summary, a Boards filter left from when the account had a board is ignored, the + is on Todo only and `NewTicketDialog` sends `ticketRequest(t, noBoard, account)` (no project, status or sprint). `.board-hint` under the tabs carries the fixed sentence, **Create a GitHub board** (`can("boardCreate")`, so the web and the phone get "Create one from MasterDeck on your Mac." instead) and one `.board-note` line per `derivedNotes` entry: the first-N-of-M note, repositories past the limit, `Not found: owner/name` for a `missing` repository with no reason, then the part's `notes` as `master board` printed them (`parseBoard` reads them per part; from a CLI that only prints the top-level `notes` they go to the part when there is exactly one). The dialog is `CreateBoardDialog`, keyed by the account. Empty states come from `boardEmpty` (`nothing-selected` also before any board was read, since none is asked for then; `not-read` instead of `no-issues` when `unreadRepos` names repositories the read did not get: the part's `missing`, or all of the tab's when the board holds no part for the account; a part whose only note is about pull request details names none; `loading` instead of `not-read` while `awaitingRead` holds: a read is under way and the board has no part for the account yet, so the tab shows "Loading board…"). `canMove(card, fallback)` is the one answer for drag start, drop and `doMove`. In such a tab the ticket context has an empty `status` and `project` (`ctxFor`), `claudePrompt` then names no column, and the ticket session's CLAUDE.md (`ticketContext`, given the tab's account) says what the empty fields mean, lists only that account's repositories and no board. Once nothing is selected (`!boardWanted`) `Sources.build()` shows no board (`boardToShow`) and `refreshBoard` drops the cached ones. Other readers of `AppState.board` with derived cards in it: the remote snapshot adds MasterDeck's columns to `board.columns` when such cards are there (`columnsWithDerived`; `RemoteCard` has no `derived`, so a reader groups by status), the command palette, Costs and the PR popup only read number, repo, title and status, `BoardFlow` skips a card with no `project`, and the sprint Summary and the burndown use `withoutDerived`.

### Create a GitHub board (`main/boardCreate.ts`, `shared/boardCreate.ts`)

`BoardCreator` turns an account's fallback board into a real Projects (v2) board. Every call goes out as the account through `accountGh(config, forAccount)`: it checks on each call that the login is still connected (two or more accounts: a login of the config; one: none) and fails the call otherwise, because `forAccount` alone answers an unknown login with the primary's runner. Variables go to `gh api graphql` with `-f` (raw strings), never `-F`.

`plan(account)` is one read as the account: the owner's node id and open boards (`projectsV2(first: 100, query: "is:open")` with `pageInfo.hasNextPage`: when there are more, `moreBoards` adds the confirmation line "The name could not be checked against all of <owner>'s boards"; the run is not refused), each ticked repository's id and open-issue count (the first 10; a count GitHub leaves out is `null`, "unknown", not 0), after a scope check from `gh auth status` (`lacksProjectScope`; the fix is `scopeFix`: `gh auth switch -h github.com -u <login>`, `gh auth refresh -h github.com -s project`, switch back; when gh's active login is unknown the switch still comes first and there is no switch back). `gql()` marks an answer without a `data` object (not JSON, `data: null`) as `ok: false` with an error entry, so no caller can read a failed call as an empty clean one. A plan whose board list did not come whole (no `nodes`, or an error under `repositoryOwner`) is refused: a duplicate name could not be ruled out. A failed call shows gh's stderr or GitHub's error, else a fixed text, never raw stdout.

`create({account, title}, remote)` refuses remote callers and a second run (`cleanTitle` also refuses control, zero-width and direction characters), plans, refuses a title an open board of the owner already has, asks on the Mac (`deps.confirm`, the lines of `confirmLines`; the message names the account, with one account gh's active login), then **plans again**: the account must still be connected and without a board, owner and repositories the ones confirmed, the title still free; with one account gh's active login must still be the one the confirmation named; otherwise "Nothing was created: …". Still before any write it takes the snapshot of the Board's columns (`deps.columns(login)`, in the app `columnsOf(state.board, login)`): null when the board holds no read of that account's repository issues (`board.derived` has no part for it), and the run is refused with "Open the Board tab and wait for it to load, then try again", because every issue would otherwise get Todo. Then: `createProjectV2` (a refusal by GitHub, with or without `data`, and a call `accountGh` never sent are plain failures; only no answer at all, a timeout or a throw, adds "check the owner's projects before trying again", as the board may exist) → read the Status field → `updateProjectV2Field` with the four options (an option that has the new or the old default name keeps its id; `createProjectV2Field` only when the project came without a Status field; an unread field stops the run) → the job is built: the board entry, the columns snapshot, every repository unlinked and unread → `linkProjectV2ToRepository` per repository (a failure is a warning; the repository stays in `job.unlinked`) → the repositories' open issue ids (100 a page, 1000 at most; the "only the first 1000" warning only when something was really cut), each issue stored with its column → per 20 issues one `addProjectV2ItemById` request and one `updateProjectV2ItemFieldValue` request, 1 s apart → `master config save` with the board appended to the account's `projects` (`boardConfigPatch`, login matched without regard to case, `null` when no account took it, `'selected'` when the account already has that project by id or owner + number, e.g. picked in Setup after a failed save: nothing is written and the board counts as selected; the entry is `boardEntry`: columns and statuses Todo / In Dev / PR Raised / Done, `sprintless: true`) → reload and refresh. The config is written last, so the tab shows the repository issues until the board is selected.

What a run leaves undone stays in `pending` (memory only) for `retry(account)`, which runs the same steps from the links on (only the repositories still unlinked are linked). With one account the job keeps gh's active login as confirmed (`Job.as`) and `retry` reads `gh auth status` first: another active login is refused with nothing sent ("gh's active account changed to <login>; nothing was added"), the job kept:

- An issue GitHub refuses is reported and the run goes on. An add request with no answer (rate limit, network) stops the adding; the rest is `left`.
- A status request with no answer stops the run too: that batch and the rest are `left`, and the retry adds them again (GitHub returns the same item) and sets the Status. An item refused inside an answered request is counted as `unset` and the run goes on.
- A repository whose issue pages cannot be read (no data, `repository: null`, a rate limit, a timeout) is in the result's `unread` with the warning "Could not read the open issues of <repo>: A of T added"; the retry reads it again and adds only what is not on the board yet (`job.done`).
- Columns are never looked up again: the retry uses the column stored with each issue, and the job's snapshot for issues it reads only then (after the board is selected the tab no longer shows derived columns).
- A config save that fails, or finds no account, returns `ok: false` with the URL, `retry: true` and what was added; the retry saves again. `progress` may throw without effect, and any other throw after `createProjectV2` comes back as "The board was created (<url>) but MasterDeck stopped before it was finished", with the job kept.

Nothing is ever deleted: when the columns cannot be set, the result names the project and says to delete it on GitHub or pick it in Setup. Ids from GitHub are checked (`okId`) before they go into a document. `CreateBoardDialog` clears its state when its account changes, survives a rejected IPC call (the plan load and the run), and shows Try again for `failed`, `left`, `unread` and for a failure with `retry`.

### GitHub accounts (`main/accountEnv.ts`)

With two or more connected accounts (`isMulti`), `AccountEnv` keeps each account's token in memory
(`refresh`: `gh auth token --user`, local only) and writes `accounts/<login>.settings.json` (mode
600, folder 700, temp + rename) with `accountEnvBlock`'s `env` (`GH_TOKEN`, which `gh` prefers over its stored logins; `GHC_ACCOUNT`; `GIT_AUTHOR_*`/`GIT_COMMITTER_*`; and `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` for `user.name`, `user.email`, an empty then `!gh auth git-credential` helper for `credential.https://github.com`, and `url.https://github.com/.insteadOf` per SSH form; the variable table is in GUIDE "Several GitHub accounts"); ssh aliases come from `~/.ssh/config`
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
- Create a GitHub board: `boardCreatePlan(account?)` (a read), `boardCreate({account?, title})`, `boardCreateRetry(account?)` and the event `onBoardCreateProgress` (`board:createProgress`, sent to the Mac's window only). All four are `blocked` in `DECK_ACCESS`, and the handlers refuse a remote caller as well: the confirmation is main's native dialog, and the usual fix (the `project` scope) needs a terminal on the Mac.
- Main registers handlers only via `IpcRegistry` (`reg.handle` / `reg.on`) so the browser bridge
  can `reg.call(ch, args)` the same function with a frozen `{remote: true}` event. `isRemote(e)`
  distinguishes the two; remote callers skip native dialogs (the web already asked with
  `webConfirm`), cannot change `remoteEnabled` (`remoteSettings`), only get known dirs
  (`knownDirsOnly` for standup), and obey the PTY size rule.
- `shared/remoteDeck.ts` `DECK_ACCESS` classifies every `DeckApi` member: `remote` (invoke/send
  over the bridge), `event`, `local` (runs in the browser) or `blocked` (account, browser approval,
  gh accounts and gh login (`ghUser`, `ghAccounts`, `ghOwners`, `onGhLogin`), board creation (`boardCreatePlan`, `boardCreate`, `boardCreateRetry`, `onBoardCreateProgress`), folder picker, editor,
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
  fixture AppState and fake terminal output (`src/web/preview/`), `/?preview=noboard` the same account with no GitHub board (derived cards and read notes), `/?preview=gate` the sign-in card.
  `main.tsx` imports it only under `import.meta.env.DEV`, so `build:web` leaves it out (check:
  `grep -l "nothing was sent" out/web/assets/*` finds nothing).

## AppState: fields and producers

| Field | Producer |
|---|---|
| `sessions`, `master`, `lastActivity`, `asks`, `menus`, `prStage`, `manualStatus`, `hookInfo` | `Sources` (agents poll, transcripts, deck hook, `session-status.json`) |
| `issues`, `prs`, `proposals`, `lastSnapshotAt`, `board*`, `sprints`, `selectedSprint`, `users`, `me`, `boardHistory`, `githubRefreshedAt/ing` | `master snapshot` / `master board` / ledger (`refreshGithub`, `readLedger`), cached in `cache.json`; `board` passes `deriveBoard` (columns of cards from an account with no board) |
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

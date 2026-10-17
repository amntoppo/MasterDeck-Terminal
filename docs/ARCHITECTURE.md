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
7. `guardSessions` (`main/meetingsIpc.ts`): permission request and check handlers on the default
   session, the `meetings-capture` partition and any session made later. `media` and
   `display-capture` are refused everywhere but that partition, and there only while
   `meetingsAgreed(settings)`; every other permission is allowed, as with no handler. It only sets
   handlers: nothing at startup asks macOS for anything (see "Meetings: the permission gate").
8. `createWindow()`, then the accounts (`refreshAccounts`, awaiting only the local `gh auth token` reads; the `gh api user` checks, and `migrateAccounts` once, run in the background — an older config becomes one account from gh's active login and the global git identity, `config.backup.<ts>.json` kept), `sources.start()`, `syncRemote()`.

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

`build()` order: raw sessions (minus the workflow/ticket builder sessions: `isTicketBuilderSession`, named `md-ticket-builder[-<tab>]` or in `ticket-builder/` or a `ticket-builder/tab-*` folder; and the PR view's review sessions, `isPrReviewSession`: `md-pr-review-<tab>` or a `pr-review/tab-*` folder) → `attachIssues` →
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
7. Notifications (`diffEvents` → `notify` → the notifier), dock badge (Needs-you count), auto-open (`newlyNeedsInput` →
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
- A resume from the window (`session:resume` → `resumeBg`) answers `ResumeResult`: `key` is the
  background id the output names (`bgIdFromOutput`, else `wokeFromOutput`; null when neither).
  The window opens that session (#133): `openResumed` in `App.tsx` finds it with `resumedSession`
  (`shared/resumeOpen.ts`: by key, else sessionId, else name started after the resume; only a
  running background row), at once or through a "Resuming …" pending tab (`resumed`), puts its tab
  row on Terminal and gives the pane a wake mark (reattach an exited terminal; `TerminalView`'s
  `focusAt` focuses it). Board cards, the Start dialog and History call it through `onResumed`;
  Resume all does not.
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
  `view(shows)` leaves out the items whose type's Needs-you channel is off (see "Notifications").

### Notifications (#135)

- One registry, `shared/notifications.ts`: `CHANNELS` (`system`, `needsYou`, `mobile`, the last
  `available: false` until #134) and `NOTIFY_TYPES` (id, label, hint, `source: inbox | event`,
  `defaults` per channel, `fixed` cells). `Settings.notifications` is `{ [type]: { [channel]:
  boolean } }` and `Settings.notifyPaused` the Pause all switch; `normalizeRoutes` fills them from
  the defaults and, for a file from before #135, from the old `notifyNeedsYou` (the system cell of
  `session-input`, `needs-you`, `ci-failed`). `routeOf(settings, type)` is the one routing rule
  (unavailable channels never, pausable ones not while paused, fixed cells as fixed).
- One dispatcher, `main/notifier.ts` `Notifier`: `dispatch(type, note)` sends a `Note` to each
  routed channel's sender (a `Record<ChannelId, Sender>`: a new channel cannot lack one), skips
  Needs you for a note that is an inbox item already (`itemId`), and drops a note whose `coalesce`
  key went out in the last minute. `test()` goes to every available channel. The senders in
  `index.ts`: `showSystem` (Electron `Notification`, macOS button and reply, kept in `shown` until
  closed) and `notices.add`.
- What dispatches: `diffEvents` (`session-finished`, `pr-ready`, `pr-merged`, via `notify`), the
  inbox's `added` events (`notifyItem`, typed by `typeOfKind`: input/menu/question/blocked/waiting
  → `session-input`, `ci` → `ci-failed`, the rest `needs-you`), workflow notify blocks
  (`workflow`), the meetings notice and offer (`meeting`), `Watches`' `onLines` (`monitor`,
  coalesced per monitor) and the updater's first `available` / `ready` per version (`update`,
  `announceUpdate`). A failed action from a notification goes out as the item's type.
- Needs you as a channel: for `inbox` types it is a view filter (`Inbox.view(showsInNeedsYou)` in
  `Sources.build()`; items stay stored and unresolved); for `event` types the sender adds a
  **notice** (`main/notices.ts` → `<home>/notices.json`, atomic, 50 at most, three days), which
  `collectItems` turns into an inbox item of kind `notice` (Open, Done; `inboxNotice` returns null
  for it so it never notifies twice). An item hidden from the list notifies with a target of its
  session, else the list (`itemTarget`: there is no card to show). A `meeting` notice stays on the
  Mac like the meeting items: `toRemoteSnapshot` and `webState` (web tabs) leave it out
  (`isMeetingNotice`; the offer names the call app).
- `CH.notifyTest` (`remote`): the Settings button. The web app can change these settings too.
- Every action goes through `inboxAct(id, type, payload, remote)` → `sources.inbox.act(…,
  runInboxAction)`. `runInboxAction` re-checks the session, then uses the normal paths: `sender.send`
  (reply/option/continue/compact/send), `answerMenuFor` (menus, hook-held questions and
  permissions), `cli.approve/reject` (proposals), `cloud.answerItem` (external items). A `held`
  proposal that `master spawn` marked `held_for: "trust"` (Claude Code refused its folder) gets the actions `trust`
  (**Open Claude there…**, the window only) and `approve` (**Try again**: `retryHeld` starts that
  same proposal through `master spawn --held-for-trust`); any other held item still has only Open.
  Kind `meeting` (a meeting's notes added, or it could not be matched or transcribed): see
  "Meetings: matching and meeting notes".
  The `inboxAct` handler refuses `trust`, `rematch` and `retry` for a browser (`inboxActCall`); its other actions run as the window's. Dismissing
  an `ext-…` item also sends `itemDismissed` to the backend.

### Hooks

- `main/hooks.ts` edits `~/.claude/settings.json` (backups, atomic writes, marker per hook).
  `installWorkflowHooks` puts in one hook per trigger (timeout 10 s), one per custom trigger event,
  and the workflow loop's Stop hook (`loopCommand`, mark `masterdeck-workflow:loop`, timeout 600 s);
  all carry `masterdeck-workflow:`, so one check sees them up to date and one removal takes them out.
  Also
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
  (printed on SessionStart: ticket and linked sessions), `peers/<session>.delta.json` (printed and deleted by the next UserPromptSubmit), `watch-requests/` + `watch-answers/` (Monitor takeover),
  `events.jsonl` (the rest; emptied at launch past 4 MB), `alive`, `monitors-by`.
  A `/queue` prompt is handled first and leaves a pending linked-sessions delta on disk; any other
  prompt prints (and deletes) the delta.
  It also handles `/queue`: UserPromptSubmit stores `/queue <prompt>` (any other prompt returns at
  once, unread and unlogged); Stop hands over the next item through `queue-requests/<id>.json` →
  claimed by rename to `.taken` → `queue-answers/<id>.json` (see Queue). `queue-off` (written when
  `hooks.ts` `hookStatus().foreignQueue` sees the queue skill's own hooks in settings.json; worked
  out again whenever settings.json's mtime changes) leaves `/queue`
  to those hooks. While a workflow loop is open (`<home>/workflows/loops/<sid>.json`, passed in as
  `hookScript`'s `loopsDir`), Stop hands nothing over: the queue waits until the loop is over. Stop
hooks run side by side, so on the turn that closes the loop the deck hook usually still reads it
open and skips; when that stop goes through, the session is left idle with prompts queued.
`main/loopQueue.ts` (`LoopQueue`, ticked from the state callback in `main/index.ts`) notices a
session's open loop going away, waits up to 2 minutes for the session to be `idle`, and then, once
per closing, sends its next queued prompt as **Send next** does (`sendNextQueued`: `shiftQueue`,
`Sender`, back to the front when the send fails), only while the deck hook owns the session's queue
(`DeckHooks.ownsQueue`: no `queue-off`, not a legacy session) and when `pumpQueue` served the
session no prompt since the closing (`queueServedAt`; 30 s slack).
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

### MasterDeck's mods (`mods/`, issue #86, prototype)

Claude Code mods (plugins of function hooks, Claude Code 2.1.287 or later; see [MODS.md](MODS.md))
that work inside a session with what MasterDeck knows about it. They never call GitHub: the app
writes, the mods read, so one poller serves every session. `mods/` is a local-folder marketplace
(`.claude-plugin/marketplace.json`) of four plugins:

| Mod | What |
|---|---|
| `masterdeck` (core) | Nothing on screen. Switches mods per session, reports which run (heartbeat). Never switched off |
| `masterdeck-ticket` | The ticket line above the prompt, its pane, `/md-ticket` |
| `masterdeck-alerts` | Toasts when the card moves, a review thread opens, CI fails or passes, the PR merges or is linked |
| `masterdeck-note` | `/md-note <text>`: adds to the ticket's note through the note pump |
| `masterdeck-loop` | `/md-loop [--max N] <check> -- <goal>`: an agent loop (issue #82) with its progress above the prompt |
| `masterdeck-board` | `/md-board`: the board of the session's account in a pane, read only |

- **What they share.** A mod may import only its own files, and the engine follows `$` into
  functions of the register file only (a `$` passed to an imported function fails validation). So
  `mods/shared/deck.ts` holds the pure part (the `Band` type, `parseBand`, `isOff`, `deckFolder`,
  `deckRead`, `ago`), copied into each mod as `hooks/deck.ts` by `mods/sync-shared.sh`
  (`app/src/shared/modsShared.test.ts` fails while a copy differs, or the marketplace lists other
  names), and each register file carries its own few lines that read `deck/alive` and the band.
  The deck folder is `$MASTERDECK_HOME/deck`, else `~/.claude/masterdeck/deck` (a background
  session has the daemon's environment, so in practice the latter).
- **App side.** In the state callback (`main/index.ts`, while `agents` is healthy)
  `DeckHooks.setBand(sessionId, bandFor(modBand(state, s), s.name, modOff.of(s.key)))` writes
  `deck/band/<sessionId>.json` for every live session (`shared/modBand.ts` `ModBand`: name, ticket
  label/ref/title/url, the card's column, the session's newest PR with state, CI, open threads and
  draft, linked sessions, `boardKey`, `offMods`). The board files: one per account a live session
  works as (`boardKeyOf`: the session's account, else the primary's, `_` with none), `deck/boards/
  <key>.json` (`modBoard`: `tabBoard` of that account, its columns in order with a "No status" one for
  the rest, at most 30 cards a column with the count, titles cut at 120 characters), written when
  changed (`DeckHooks.setBoard` / `pruneBoards`, sharing `writeIfChanged` with the bands). It is written only when its text changed, and `pruneBands` removes the files of
  sessions that are no longer live. `DeckHooks.modBeats()` reads the core's heartbeats,
  `deck/mods/<sessionId>.json` (`{v: 1, version, claude, at, mods, ended?}`, `parseModBeat`: fresh
  under 45 s; files older than a day are removed), and the callback puts them in `state.modLive` by
  `Session.key` (`version`, `claude`, `mods`, so a beat alone does not change the state).
- **Mods per session.** Claude Code turns a plugin on or off per settings scope only, so MasterDeck
  does it per session. The core's `plugin.register` hook judges every mod module that loads after it
  (`prependPlugins: ["masterdeck@masterdeck"]` in the user's settings puts it first, ahead of
  `--plugin-dir` mods too) and reports each in its heartbeat (`mods`: name, provenance, version,
  tier, `loaded`). The app keeps every mod reported anywhere in `<home>/mod-catalog.json`
  (`ModCatalog`, `mergeCatalog`) as `state.modCatalog`, and the switches in `<home>/mod-off.json`
  (`ModOff`: `{Session.key: [names]}`; older files, where `masterdeck` meant the one mod off, read as
  every feature mod off; the core cannot be switched) as `state.modOff`. `CH.modSet`
  (`deck.modSet(key, mod, on)`, open to the web) writes it and calls `sources.changed()`; the state
  callback puts the names in the session's band as `offMods`.
  MasterDeck's feature mods read their own name there (`isOff`) and go quiet at once, either way
  (nothing drawn or toasted, their commands answer with nothing, the ticket pane closes); the core
  never refuses them (`FAMILY` in `mods/masterdeck/hooks/core.ts`). Any other mod of tier `user` is
  refused when it loads (`refuses`), so one switched off while it runs stays until the session starts
  again; one switched on after a refusal joins at a `/reload-plugins` the core asks for from its timer
  (`toReload`; a `$.command.run` cannot run from a `command.run` hook). Managed (`prepend`/`append`)
  and built-in mods are never refused.
- **Tools → Mods** (`SessionMods.tsx`, the third of the Tools tab's `Queue | BTW | Mods`
  sub-tabs, `SessionTools.tsx`, with "· n off" on its label; `modRows` in shared): a MasterDeck group
  (the core, locked; the feature mods by
  `MASTERDECK_MODS` title and what they do, always listed) and Other mods (every mod in the catalog
  or this session's heartbeat; managed and built-in ones locked), each with a switch for this session
  and its status: `on`, `off`, `off-next-start`, `turning-on`, `not-seen`. A running session takes
  new or changed mods only at `/reload-plugins`: when its core is not `MOD_VERSION` or a feature mod is
  missing from its heartbeat (`modsStale`), the tab says so with **Reload plugins**, which types it
  (`deck.sendText`, as **Compact** does). MasterDeck's own switches stay usable then (the choice is in
  the band when the mod loads). `modsShared.test.ts` holds every mod's `version` to `MOD_VERSION`.
- **masterdeck-ticket**: every 2 s it reads `alive` (older than 30 s: MasterDeck is closed) and its
  band into module variables and redraws on a change; it draws only for a ticket, a PR or a link (`$.ui.invalidate`; a reload refills them at
  `session.start`). The line above the prompt (`AbovePrompt`, sized to `bodyColumns`: one short line
  under 90 columns, the title when there is room, then **Details** / **Hide**; `hooks/line.ts`
  `segments`) keeps what other mods draw there (`next(e)` under it). `/md-ticket` opens a pane with
  the ticket, its column, the PR (links) and linked sessions.
- **masterdeck-alerts**: compares two reads of the band (`bandEvents`) and toasts the difference;
  the first read after a load, and the first after it is switched on, toast nothing.
- **masterdeck-loop** (`hooks/loop.ts`, its `$.state` contract `types/index.d.ts`): `/md-loop
  [--max N] <check> -- <goal>` (max 5 by default, 20 at most) submits the goal (`$.prompt.submit`,
  `asUser`, from a timer: never inside a dispatch). The first main-loop turn that starts after a
  round is submitted is that round's (`turnId`); when it ends (`turn.complete`, not a subagent's)
  the check runs in the session's folder (`sh -c`, up to 10 minutes, from a timer); exit 0 ends it
  (`passed`), else the next round is submitted with the check's last 40 lines (`nextPrompt`) until
  `max` (`gave-up`). An interrupted round (`aborted`), an error or a refusal, `/md-loop stop`, the
  line's **Stop** and switching the mod off end it (`stopped`, with why). The line above the prompt
  says where it stands (`progressText`); **Dismiss** clears a finished one. Not yet told to
  MasterDeck's window or a workflow (#82's canvas): the loop lives in the session.
- **masterdeck-board**: `/md-board` reads the band's `boardKey` and `deck/boards/<key>.json` and
  opens a pane (`md-board`) with the account, the sprint, each column with its count and cards, this
  session's ticket marked; re-read every 5 s; closed when switched off.
- **masterdeck-note**: `/md-note <text>` writes `note-requests/<id>.part`, renames it to `.json`
  and waits up to 6 s for `note-answers/<id>.json`, else takes the request back by renaming it (the
  mods API has no rename or delete, so these go through `$.process.run(['mv' | 'rm', …])`: macOS and
  Linux only).
- **The core** writes its heartbeat every 15 s where `deck/alive` exists (`ended: true` at
  `session.end`); what it saw is in `$.state` (`seen`), since a reload does not judge an unchanged
  module again.
- **Installing the mods** (`main/mods.ts`, `shared/mods.ts`, issue #93). The app ships `mods/`
  (electron-builder `extraResources`, without tests, `shared/` and `sync-shared.sh`) and at every
  launch copies it to `<home>/mods` when its content hash differs from the folder's marker
  (`syncModsFolder`: `.masterdeck-mods.json`, copied to `mods.new` and swapped in; a hand copy there
  is replaced). Claude Code reads a directory marketplace in place (`claude plugin list` shows
  `readFromFolder`), so that copy is the update: nothing is installed again. `ModsInstaller.install`
  checks `claude --version` (`MODS_MIN_CLAUDE`, 2.1.287), backs up settings.json
  (`settings.backup.<ms>.before-mods.json` in `<home>`; `backupSettings` in `hooks.ts` never
  overwrites one), runs `claude plugin marketplace add <home>/mods --scope user` (adding it again
  re-points a `masterdeck` marketplace that came from elsewhere) and `claude plugin install
  <name>@masterdeck --scope user` for each mod in `marketplace.json`, all with `--json` (the last
  line's `outcome` / `failureCode`), then puts the core first in `prependPlugins` with the hooks'
  own atomic write (another backup) and records `<home>/mods-installed.json` (`{at, version}`).
  `uninstall` runs `claude plugin uninstall` for each (`not_installed` is fine), `claude plugin
  marketplace remove masterdeck` (`not_configured` is fine) and takes the core out of
  `prependPlugins` (the key goes when empty); the folder stays. One change at a time.
  `modsInSettings` reads what is installed from the settings file: the marketplace on this folder,
  each `enabledPlugins` entry and `prependPlugins` (`installed`, `partial` with what is `missing`,
  `off`). `prependNote` says when `prependPlugins` is not honoured: a managed settings file
  (`managedSettingsFiles`: `managed-settings.json` and `managed-settings.d/*.json` per platform) that
  does not list the core itself, or `claude auth status --json` reporting a `team` / `enterprise`
  `subscriptionType`. `state.mods` (`ModsStatus`) is read in the state callback at most every 30 s
  (`modsNow`) and again after each change. `paths.modsSettings` is the file `claude plugin` writes:
  Claude Code's own, or `$CLAUDE_CONFIG_DIR/settings.json`; null (install refused, with a note) when
  MasterDeck's settings are kept apart (`MASTERDECK_ISOLATED`, `MASTERDECK_CLAUDE_SETTINGS`) without
  `CLAUDE_CONFIG_DIR`, since the CLI would write the real one. `CH.modsInstall` / `CH.modsUninstall`
  are open to the web (fixed commands, `webConfirm` first), as the status line's are.
- **Reloading after an update.** `modsReloadOffer` (the state's sessions, `DeckHooks.modBeats()`,
  installed, `installedAt`) lists running sessions (not done or suspended) whose core is older
  (`modsStale`), or that have no heartbeat and started before MasterDeck installed the mods; the
  idle ones (state `idle`, no `busyWith`) can be reloaded now. `Sources.setModsReload` puts it into
  `collectItems` (`modsReload`) as one Needs-you item `mods:<MOD_VERSION>` (kind `mods`, action
  `reload` while one is idle; a dismissed one stays dismissed until the next version).
  `reloadMods()` (the `reload` inbox action and `CH.modsReload`, Settings → Mods) types
  `/reload-plugins` into each idle one through `Sender`, never relayed through master-agent.
- **Not wired yet:** nothing of the deck hook moved into the mods, and no Windows path. See TODO
  ("MasterDeck mod").

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
  and the paste stops at 6 KB ("(N more PR updates — check MasterDeck)", the rest next time). Ends on merge/close (told), on another author (silent) or by Stop (told). On merge/close it also calls `deps.ended(url)` → `Sources.prEnded`, which reads that PR again past the gh cache so the session's lane (`prStage`) moves at once, not on the next review poll. Its messages, like `[MasterDeck monitor: …]` lines, are not the user writing (`isUserWords` in `shared/ask.ts`): the "merged" message arrives after the merge and would otherwise turn Merged into Rework.
  With two or more accounts each watched PR keeps its session's account (`PrWatchEntry.account`) and `poll` reads each account's PRs with that account's runner, so "me" (`viewer`) is that account.
  Kept in `pr-watch.json` (`seen`, pending, ended URLs never re-watched); `sync`/save wait for
  `load()`, and an unreadable file is moved to `pr-watch.corrupt.<ts>.json`. Rows join
  `state.watches` with ids `pr:<url>` (`watchStop` routes them), so they count as monitors in
  `withActivity`. Review offers are left out of Needs you (`InboxInput.watchedPrs`) only for watched PRs whose
  session can take a message now (`canSend`: not parked, not on a prompt, master up for interactive).
  BoardFlow's PR states come from the same light query (`prStates`, ttl 300 s).
- **Session details → Session → Processes** (#115, `renderer/.../SessionProcs.tsx`): read on
  demand, never in `AppState`. While the section is on screen (and the window visible) it calls
  `deck.procsList(key)` (`procs:list`) every 2.5 s; `SessionProcs` (`main/sessionProcs.ts`) runs one
  `/bin/ps ax -o pid,ppid,pgid,etime,%cpu,rss,command` and two `/usr/sbin/lsof -F` calls (folder and
  stdout; listening TCP sockets) for the session's processes only. `shared/sessionProcs.ts` groups
  them: each child of the session's `claude` (`Session.pid`) that is a Claude Code Bash shell
  (`zsh -c … eval '<cmd>' < /dev/null && pwd -P >| /tmp/claude-<hex>-cwd`, `isClaudeShell`) with its
  whole tree, and, outside the tree, processes still in the process group of a shell seen before
  (what `cmd &` leaves, adopted by launchd). Claude Code helpers (`caffeinate`, MCP servers) are not
  shells and are left out. A shell writes to `…/<sessionId>/tasks/<taskId>.output` whether or not it
  runs in the background; the transcript says which ("running in background with ID: …",
  `transcriptTasks`, read again only when its mtime changes) and gives a background command's exit
  code from its `<task-notification>` (`… (exit code N)` or `… failed with exit code N`). An ended
  background or detached command stays listed `exited` for `EXITED_KEEP_MS` (60 s); a foreground
  call drops off at once (its result is in the conversation). `deck.procsOutput(key, pid)` reads
  the last 12 KB of the stdout file of a process the last list found (never a path from the
  caller), ANSI and `\r` redraws cleaned (`cleanOutput`). `deck.openPort(url)` (`procs:openPort`,
  blocked on the web and refused for a remote call) opens only `http://localhost|<IP>:<port>`
  (`isPortUrl`). Windows answers `supported: false`.
- **Session details → GitHub** (#103, `renderer/.../GitHubDetails.tsx`; the tab is kept in
  localStorage `md.detailsTab`, open rows in a module map per `Session.key`): ticket, PRs and
  monitors as rows that open. What is not in `AppState` is read on demand, never added to it (the web
  bridge drops states over ~1.05 MB): `deck.watchEvents(id)` (`watch:events`) returns the last 50
  events of a monitor (`Watches.events`, lines with their time) or a PR watch (`PrWatch.events` for
  `pr:<url>`: items with kind and author, and its own notes), newest first; the rings
  (`pushEvents`, `EVENTS_MAX`, text cut to 500) are memory only, stripped from `watches.json` /
  `pr-watch.json`. A row reads again when its `WatchInfo` (`events`, `lastEventAt`, `queued`)
  changes. `deck.prDetail(url)` (`pr:detail`) is one GraphQL read through ghc (ttl 60 s) as
  `forCard(prRepo(url))`: `shared/prDetail.ts` builds it (`prDetailQuery`, never the word for a
  write) and reads checks (CheckRun and StatusContext, failing first), the latest review per
  reviewer, unresolved current threads and comments (`parsePrDetail`); `worstPrStatus` sums the PRs'
  lines for the closed row. A PR row reads again when `state.prLive[url]` changes and each 60 s,
  keeping its last answer on screen. Both channels are `remote` in `DECK_ACCESS` (reads); main checks
  the id's length and that the URL is a PR's.
- Schedules (CronCreate/CronDelete) are read from transcripts (`shared/schedules.ts`) into
  `AppState.schedules`; they make an idle session "Waiting".

### Workflows

`main/workflow.ts` `WorkflowStore` under `<home>`: `workflow.json` (Default), `workflows/templates/`,
`workflows/sessions/<sessionId>.json` (each session's copy), `workflows/triggers/` (custom
triggers), `workflows/monitors/` (`<id>.json` + `<id>.sh`), `workflows/runs.jsonl`, `workflows/loop.sh`,
`workflows/loops/` (`<sid>.json`, the loops; `<sid>-<loop id>.md`, their progress files),
`workflows/pending.json`. The flow model, compiler and checks are `shared/flow.ts`,
`shared/flowBuilder.ts` (builder drafts in `<home>/workflow-builder/`), `shared/flowTrack.ts`
(progress from transcripts), `shared/flowWatch.ts` (needs-you/idle triggers MasterDeck acts on).
One MasterDeck hook per trigger in settings.json reads the session's copy.

**Built-in workflows** (#104). `shared/builtinWorkflows.ts` (`BUILTIN_WORKFLOWS`: id, name,
description, whenToUse, flow; `builtinById`, `flowHash`, `rawFlowHash`, `markFor`, `sameAsMark`)
with the flows as JSON in `shared/builtin-workflows/<id>.json`. Ids start with `md-`.
`WorkflowStore.seedBuiltins()` runs at launch right after `migrate()` (also on Windows and with
`MASTERDECK_NO_HOOK`, not in the smoke test) and writes them as `workflows/templates/md-*.json` with
a mark `builtin: {id, hash, raw}`: `hash` is `flowHash` of the shipped flow (over `parseFlow`, so
formatting is no edit while a moved block is), `raw` is `rawFlowHash` (sorted-key JSON of the flow
as written, no `parseFlow`). A file is unedited when its flow's raw hash equals `raw` **or** its
parsed hash equals `hash` (`sameAsMark`; a mark from before `raw` has the parsed hash only), so a
later `parseFlow` that reads the same file differently never turns an untouched built-in into an
edited one. Seeding: a missing one is written unless its id is in `workflows/builtins.json`
(`{removed: [...]}`, written by `deleteTemplate` for a marked file); an unedited marked file is
rewritten when the shipped flow changed (keeping its name); an edited one and any file without the
mark are never touched. `templates()` fills `WorkflowTemplate.builtin` (`edited`; `renamed` when the
name differs from the shipped one; `updated` when edited and the shipped flow changed since);
`saveTemplate` keeps the mark on a built-in it rewrites, never puts one on a new template
(Duplicate), never gives a new template a built-in's id, and refuses (null) to write a deleted
shipped built-in's id (a late autosave; the handler answers "restore it first"). The
`workflow:templateSave` answer carries the store's `builtin` for the template, which the window
shows as it is. `restoreBuiltin(id)` writes one back as shipped (Restore original, shown when edited
or renamed, `workflow:builtinRestore`; the window asks with a native dialog, the web with
`webConfirm`); `restoreBuiltin(null)` writes back every removed one and clears the list (Restore
built-ins). `workflowGet` carries `builtinsRemoved`. The window's autosave binds each change to the
template open when it was made (`useAutosave`'s target), flushes before Rename and Delete, and drops
what is pending before Restore original.

**Loops** (a Loop frame, #82). A trigger's step carries its `CompiledLoop`s; when it fires, its hook
arms the loops with nothing before them (`after: null`) in `workflows/loops/<sid>.json` (written to `<sid>.json.<pid>.tmp`, then renamed)
(`{loops: [{id, step, state: "open", iteration: 0, startedAt, history: [], reason, lastCheck}]}`)
and creates an empty progress file `workflows/loops/<sid>-<loop id>.md` (the hook's to fill: Claude
Code refuses a session's writes under `~/.claude`, so the session never writes it); a loop still
open is left as it is. `workflows/loop.sh`, generated by `loopScript(home)` in `shared/loopHook.ts` (written by
`WorkflowStore.setupLoopHook`, mode 755, only when its text changed, each time `syncWorkflowHooks`
runs; installed by `installWorkflowHooks` as a Stop hook, mark `masterdeck-workflow:loop`, timeout
600 s: the check may take up to 540), runs at every turn end, ignoring `stop_hook_active` (the iteration counter is the guard). It takes the first open
loop, reads what the agent said (`last_assistant_message`, else the text of the transcript's last
assistant entry, nothing when that entry has none; `LOOP DONE:` must start a line), and runs the check command in the session's folder in its own
process group (`set -m`: macOS has no `timeout` or `setsid`) under its time limit (`timeoutMin`, at
most 540 s; a timeout fails the check and kills what it started). With the agent's goal on and
nothing said, the check is not run. The decision is one jq program (`DECIDE`): met; else
`limits.iterations` + `extra` (Run 5 more) reached; else the time limit; else stall (the last N
hashes of the output tail, durations taken out, plus `git rev-parse HEAD` and `git status
--porcelain`, equal). It writes the loop file (temp + rename; history keeps 50 entries, a tail is
at most 40 lines / 4 KB; just before the rename it reads the file again and writes nothing, and
answers nothing, when the loop is no longer open or has a new `startedAt`: a Stop loop or Run 5
more during the check stands), one `runs.jsonl` line (`trigger: "loop"`, `iteration`, `state`; `WorkflowStore.lastRun` skips these, so the Workflow line in Details stays on the step that armed the loop) and
answers: an open loop blocks the stop with `↻ Loop "<name>": iteration n/max[, m min left].`, the
check's output (one that failed and printed nothing: ``The check `<cmd>` failed (exit N, no
output).``) or "not done yet", "So far" (the last three rounds' `PROGRESS:` lines), the round's
plan and the ask to end the turn with a `PROGRESS:` line. The round's `PROGRESS:` line (the first
line of what the agent said that starts with it, control characters and blank runs made one
space, at most 300 characters) goes into its history entry (`progress`) and is appended to the
progress file as `- round N: <text>`. A loop that ends
opens the loops of its step whose `after` names it by that outcome or by a plain arrow (fresh, with
empty progress files) and blocks with `Loop "<name>" is done|over: <reason>. Now: <branch>`, then
`After the loop: <then>` (the blocks its plain arrows lead to: `CompiledLoop.then`, loops left out
as they open themselves), then each next loop's round; when it opened no loop, the session's
turn-end plan last (`Before you finish this turn:` and its turn-end steps' notes, logged as a
`turn-end` line in `runs.jsonl`), since the turn-end trigger stood aside during the loop and runs
once a turn; with none of these it lets the stop through. A `stopped`
loop, a missing or unreadable loop file, or no jq lets the stop through; so does a session workflow
file (else `workflow.json`) that is missing or that jq cannot read, leaving the loop file as it is;
a loop that a workflow read without error no longer has is set `stopped`. It writes nothing outside `workflows/loops/` and `runs.jsonl`.
While a loop is open the loop hook owns the session's stops: the turn-end trigger's hook and the
deck hook's queue (Stop) exit at once when `workflows/loops/<sid>.json` has an open loop, and go on
once it is over (the turn-end trigger only skips turns the loop hook answers: it hands the plan over
on the closing turn).
`main/loops.ts` `LoopStore` reads the loop files (cached by mtime; `parseLoopFile` in
`shared/loops.ts` drops junk entries and never throws) into `AppState.loops`: by session id, at
most 3 loops each, newest first, closed ones for 24 h, the check's tail cut to 1 KB, names and
limits from the session's compiled workflow (`loopViews`; `LoopView.minutes` is the time limit, so
nothing in the state ticks). The files change from the hooks, outside the app: the 1 s deck poll
also asks `LoopStore.changed()` (the folder's names and mtimes) and rebuilds the state when they
moved. Its two writes (temp file + rename): **Stop loop** (`stop`: only an open loop, `state:
"stopped"`, reason `stopped by you`, `endedAt`) and **Run 5 more** (`more`: only a `limit` loop,
and only while no other loop of the session is open: `extra += 5`, `state: "open"`, `startedAt`
reset to now so a time limit is not hit again at once, and `stallFrom` set to the iteration, so
`DECIDE` counts only later rounds toward the stall limit). Run 5 more also types
`Continue the loop "<name>".` (`loopNudge`: fixed text, the name cleaned of control characters and
a leading `/` or `!`) into the session through `Sender` when it is idle (`nudgeLoop` in
`main/index.ts`, shared with the Needs-you action); a busy session meets the reopened loop at its
next turn end. Needs you (`collectItems` in `shared/inbox.ts`) has two loop kinds: `loop` (a loop
at a limit: `loop-more`, dismiss, open) and `loop-paused` (an open loop whose session is `idle`,
not waiting on its own watch, and quiet for `LOOP_PAUSED_MS`, 5 minutes, by `lastActivity`; the id
carries that time, so a new quiet spell is a new item: `loop-continue`, the same `nudgeLoop`, and
`loop-stop`, `LoopStore.stop` after the window's own confirm, `confirmLoopStop`). `newLoop` starts
with a stall limit of 3; `parseFlow` keeps 0 for a loop saved without one.

**The Loop frame on the canvas.** `FlowEditor.tsx` draws a loop node as a React Flow node of type
`frame` (`Frame`: `width`/`height` from the node's `w`/`h`, `zIndex: -1`, listed first, dragged by
its header only via `dragHandle: ".ff-head"`; the box itself has `pointer-events: none` so blocks
and arrows inside stay clickable; `NodeResizeControl` at the bottom-right corner; the editor sets
`elevateNodesOnSelect={false}` so a selected frame never covers its blocks). Members stay ordinary
nodes with absolute positions; the rules live in `shared/flowFrame.ts` (pure, tested):
`insideFrame` (a block's centre in the frame's box), `membersAfterDrop` (on `onNodeDragStop` and on
add: a block joins the frame it lands in and leaves the one it left; a trigger, built-in or loop is
put back right of the frame with a note; a frame put down takes in the blocks under it),
`refitFrame` (after a resize), `moveFrame` (a frame's position change moves its members),
`frameArrow` (an arrow into a member goes to its frame; out of a member to outside is refused),
`frameEdges` (`parseFlow`'s edge rules applied after membership changes, dropping an arrow that
would close a cycle; a drop that loses arrows says so), `edgeKindFrom` / `framedEdgeKinds` (from a
frame the toolbar's *if it worked / failed* read *when met / at the limit*), and the header text
(`frameHeader`, `frameLive`). `layoutFlow` (`shared/flow.ts`) places a frame like a block, its
members inside it in rows and columns of their own, and sizes it around them (`BLOCK_W/H`,
`FRAME_PAD`, `FRAME_HEAD`); a flow without a loop is laid out exactly as before. The session's own
editor (`SessionWorkflowDialog`) passes `state.loops[sessionId]` as `loops`, and the frame's header
adds the round (`3/10 · last check failed`, pulsing while open). The web preview (`/?preview`) has
a workflow with a loop and a session in round 3 to look at.

### Notes

`main/notes.ts` `NotesStore` keeps the user's notes in `<home>/notes/`, one JSON file per note,
written as temp file + rename. A global note is `n-<32 hex>`, a ticket's is `t-<owner>~<name>~<number>`
(one per ticket). Every argument is checked in the store (`shared/notes.ts`: id pattern, limits,
characters), a save carries the `base` version it was made from and is refused as a conflict when the
stored note differs. Limits (`shared/notes.ts`): title 200 characters, text 50,000, 1000 notes, search
query 200. A `.json` file in the folder that MasterDeck cannot read as a note is skipped at load and
left alone. When its name is a valid note id (bad JSON or the wrong shape under `n-…` / `t-…`), a save
or delete of a note with that id is refused with a message until the file is moved away (then the id
is free again); a file with any other name is simply ignored, since no save or delete can name it.
The store reads every file in the folder whatever its size and follows symlinks (see TODO).
A write that fails on disk (the temp file, the rename, the removal) is answered `{ ok: false,
message, retry: true }`: the message carries the error's code at most ("Could not save the note
(EBUSY)."), never Node's own text, which names the file and could go to a browser; the whole error
is logged in main. A refusal about the note itself (the limit, a character) has no `retry`.
Notes are not in `AppState`, a snapshot, a prompt or a GitHub call: their text leaves the process only
through the `notes:*` handlers. A note's full text travels to a web tab in two answers only: `notes:get`
(a note opened), and the conflict answer of `notes:save`, which carries the stored note to the tab
that tried to save over it (so the editor can offer Reload). The list (`notes:list`) and
`notes:changed` carry `NoteMeta`, which has a 120-character `preview` instead of the text: the note's
Markdown read as one plain line (`notePreview` → `markdownText` in `shared/markdown.ts`, from the first
4000 characters; kept per note object in a WeakMap, since a save replaces the object). `notes:search` runs in main and returns ids.

Two optional fields, on `n-` notes only (a file without them loads as before, and the store writes
them only when set, so an old note saved again keeps its shape). `ticket` keeps its one meaning: set,
this *is* the ticket's note (`t-…`). **`link`** (`NoteLink`: `session` `{ key, name }` and/or `ticket`
`{ repo, number }`) is what an `n-` note is about: `key` is the session's `Session.key` (1 to 200
characters of `[A-Za-z0-9._:-]`), `name` its name then (200 at most, one line), the ticket's repository
named in full by the store (`repoOf`, as for a ticket note). An editor sends it in `NoteInput.link`
(the draft's `link`: `blankDraft(ticket, link)`, `NoteTarget.link`, part of `noteTargetKey`); the
store takes it for a new note only, a stored note keeps the link it has, and a link on a ticket note
is refused ("Not a note."). **`meeting`** (`NoteMeeting`: `id` matching `MEETING_ID` from
`shared/meetings.ts`, `title` at most `MEETING_TITLE_MAX` 120, `at`) is the meeting a note came from.
No editor can set it (`cleanNote` ignores one); `NotesStore.addMeetingNote({ title, body, link,
meeting })` is its only writer (a new `n-` note, `created === updated`, checked as a save, a body past
50,000 cut at a line break, a link required), and every later save keeps it. `meetingNotes(id)` lists
one meeting's notes, `dropMeetingNotes(id, onlyUnedited)` removes them (with `onlyUnedited`, only
those never saved since: `updated === created`). `storedNote` refuses a bad link or meeting, and
either on a ticket note. `NoteMeta` carries both (the web gets them with the list); `matches` also
searches the session's name, the linked ticket and the meeting's title. `sessionNotes(metas, session,
ticket, repoOf)` is a session's notes: its ticket's note first, then the notes whose `link.session.key`
is the session's or whose `link.ticket` is its ticket, newest first, each once. Session details →
Notes (`renderer/.../SessionNotes.tsx`) lists them and renders the picked one read only
(`notesGet`, `MarkdownView html={false}`); **Edit** and **New note** set the panel's `NoteTarget`
(App's `setNotesAt`), so the window's one `NoteEditor` is the only editor. `shared/noteFilter.ts`
holds the panel's filters (`noteIn`, `filterNotes`), the tab's meeting dot (`meetingDot` against
`md.sessionNotesSeen.<key>`, the newest meeting note's `created` when the tab was last open: the
Mac's clock, never the browser's) and `sessionLink` (a new note's link, the key checked as the store
checks it).

A note's body is Markdown source, stored as typed. It is drawn by `MarkdownView` with `html={false}`:
`parseMarkdown(text, { html: false })` builds a tree of blocks and inlines, React draws elements from
it, and no HTML is ever built from the text. In that mode no tag is read at all (`<img>`, `<br>`, comments
stay text, unlike an issue's description), and an image is drawn as a link to it, so opening a note
never fetches an address (its text may come from a session); links keep `https://` addresses only (`safeHref`,
`safeImage`); a click goes to `deck.openExternal` (the window: `shell.openExternal`, https only; the
web: `window.open`, https only). The window also refuses any navigation away from the app
(`will-navigate`: an https address opens in the browser instead). The editor's Write / Preview / Side by
side choice is per viewer (localStorage `masterdeck.notesView`; side by side only at `WIDE_QUERY`).

**Sessions add to notes** (the `masterdeck-notes` skill): `skills/masterdeck-notes/scripts/note.sh
new "Title" | ticket owner/name#12 | append n-…` reads the text on stdin, writes
`<home>/deck/note-requests/<id>.json` (`{op, arg, body}`, by jq) while MasterDeck runs (`deck/alive`
younger than 30 s), and waits up to 8 s for `note-answers/<id>.json`, then takes the request back by
renaming it (one rename wins against MasterDeck's claim; a claimed one gets 7 s more). The 1-second
`pumpWatches` tick runs `pumpNoteRequests` (`main/noteRequests.ts`): claim (`.taken`), at most 20 a
tick, files over 256 KB refused, `parseNoteRequest` (`shared/noteRequest.ts`: the ticket as GitHub
names it, ids `n-…` only, control characters and terminal colours stripped), then `NotesStore.save`
(new) or `NotesStore.append` (the text as a new paragraph at the end; a ticket's note is made when
there is none; refused past 50,000 characters). The answer carries the note's id and a sentence,
never a note's text: the app never hands a session a note. That is the app's rule, not a wall: a
session runs as the user and can read `<home>/notes/` like any file, and a refusal past 50,000
characters says something about a note's length. Leftovers older than a minute are swept. Not on
Windows (the deck hook folder and the pump run on macOS only).

The panel (`renderer/.../NotesPanel.tsx`, opened by the rail's Notes button or the palette, mounted
after every header so it gets its clicks) only draws. The list is `useNotes` (`renderer/src/notes.ts`:
titles and previews, kept current by `notes:changed`). The editor is `NoteEditor`
(`shared/noteEditor.ts`), one per window, living outside the panel. Its rule: typed text is dropped
only by the user's own choice (Reload, Discard, Delete). It saves 500 ms after the last key, and at
the latest 2 s after the first unsaved one (`SAVE_MAX_WAIT_MS`: typing without a pause still saves), one
save at a time (text typed while a save is out goes with the next, based on the version that save
returned); `show` opens another note only after `flush` stored what was typed, and stays where it
is when that fails or a conflict waits for an answer (the panel then goes back to the open note);
`seen` compares the list's row with the draft's `base` (`incoming`): a clean draft takes the new
text, a dirty one shows "Changed elsewhere" (Reload / Keep mine, the latter a save with `force`),
and nothing is written until the user chose. Closing the panel flushes (`leave`), and so do
`pagehide` and the document becoming hidden (`visibilitychange`: a phone that puts the tab away often
sends only that); text that could
not be saved stays in the editor and is on screen again when the panel opens. Two failures are kept
apart: a save that got no answer (the call threw: the line is down), or that the store could not
write to disk (`retry: true`), is retried every 5 s with the status "Not saved"; a save
the store refused with a reason (the limit of notes, a character it does not take) is in `refused`
and is tried again only when the text changes or the user leaves, and the editor shows a line with
**Discard** (`discardUnsaved`: a stored note returns to its stored text, a draft never saved
closes), which also says so when a switch or a close was held back by it (`stayed`). `target` is
what the draft was opened for: where the panel goes back to when `show` answers false. Delete
(`remove`) deletes the note that was open at the click, and nothing when another was opened while
the question was on screen.

Layers (`styles.css`, `web.css`): the panel is 40, above the views (20) and the find bar (35); the
rail is 41, so its tooltips and the remote indicator's card, which stick out over the panel's place,
draw above it; dialogs are 50. On a phone the panel is a sheet at 46 (the inspector's is 45) and the
tab bar is 47: the More menu lives in the bar's stacking context and would open behind a sheet
otherwise.

### Side questions (BTW, issue #106)

The right panel's **Tools → BTW** (`renderer/.../SessionBtw.tsx`, in `SessionTools.tsx`) asks what Claude Code's `/btw` asks: a
question answered from the session's conversation, with no tools, never added to it. Claude Code has
no API for it, so `main/btw.ts` `BtwAsker` runs `claude -p --resume <sessionId> --fork-session
--no-session-persistence --tools "" --strict-mcp-config --settings '{"disableAllHooks":true}'
--output-format stream-json --verbose --include-partial-messages [--model <the transcript's model>]`
from an empty temp folder (its empty `~/.claude/projects` folder is removed, `tidyScratchProject` in
`summary.ts`). The prompt (`btwPrompt` in `shared/btw.ts`) frames the question as a side question and
carries the session's last 20 answered ones. Text deltas (`parseStreamLine`) go out as the entry at
most every 120 ms; the result's `total_cost_usd` is kept. One question at a time per session; **Stop**
kills the run; 5 minutes at most. The session's transcript is never written (checked with a live
session) and a `claude -p` prompt is not added to `history.jsonl`.

`/btw` typed in a terminal: Claude Code writes the question to its prompt history
(`~/.claude/history.jsonl`, or `$CLAUDE_CONFIG_DIR/history.jsonl`: `paths.claudeHistory`) with the
session id, and keeps the answer nowhere (it lives in the overlay only). `BtwTerminal` stats the file
every 2 s (`pollBtw` in `index.ts`), reads what it gained (its offset in `btw/history-offset.json`; the
first read looks 2 MB back), files each `/btw <question>` (`parseHistoryLine`) under the listed
session with that id (or whose background id starts it), as `t-<timestamp>`; one whose session is
not listed yet waits up to 2 minutes for it (a session just started), then is dropped. A fresh one (under 2
minutes) of a background session gets its answer from the screen: `claude logs` every 2 s for up to
90 s, `parseBtwScreen` finds the box (`/btw <question>`, the answer, the footer `… c to copy … Esc to
close`), keeps the longest answer seen while the question matches (`sameQuestion`), and marks it
`partial` when the footer shows `↑/↓` (the answer goes on below the box). Anything else is kept with
`captured: false`.

`BtwStore` keeps each session's entries in `btw/<session key>.json` (oldest first, 200 at most, an
answer 64 KB at most; temp file + rename) and sends every change as `btw:event` (`BtwEvent`: the
whole entry, or `removed`). An answer still streaming is sent but written only when it ends; one left
`asking` by a quit is read back as `stopped`. Not in `AppState` or a snapshot: channels `btw:list`,
`btw:ask`, `btw:stop`, `btw:remove` and the event, open to the web app (`DECK_ACCESS`), so a browser's
question runs on the Mac the same way. The web preview (`/?preview`) has an in-memory stand-in.

### Linked sessions (peers)

A user can link sessions to each other (running sessions only, any repository or account). `shared/peers.ts` is the
pure graph (`addEdge`, `removeEdge`, `peersOf`, `prune`, `carry`; `MAX_PEERS = 8` per session) and
`main/peers.ts` `PeerStore` keeps it in `<home>/session-peers.json`: `{version: 1, edges, seen}`,
keyed by `Session.key`. `seen[T][P]` is the `at` of P's summary that T last received. `seen` is
written coalesced (500 ms) and flushed on quit; a file that cannot be read is moved aside
(`.corrupt-<ts>`) and the store starts empty. The store is pruned against the live sessions on each
agents poll (never when that list is empty), so an ended or removed session drops its edges on the
next poll; a resume or copy carries them to the new key (`carry`). `expect`/`claim` hold the links
chosen in a Start dialog until the new session shows up in the poll. `AppState.peers` is the
symmetric adjacency by key.

What a linked session receives (`shared/deckHooks.ts`):
- `peersBlock` (a `## Linked sessions` block: name, folder, branch, ticket, state, the summary
  capped at 2500 characters; newest 5) is part of the SessionStart context. `Sources.writeTicketContext`
  writes `deck/context/<sid>.json` for a session on a ticket or with linked sessions; a context
  write never marks `seen`. `composePrompt` takes the block as its 6th argument, so the first turn
  has it too.
- `peerDeltas` is the per-prompt delta: `deck/peers/<sid>.delta.json`, printed once by the deck
  hook's `UserPromptSubmit` case and deleted. It is composed per target and lists every peer that
  target has not received; peers in a delta the hook has not consumed yet stay queued in it.

`main/peerSync.ts` `PeerSync`: on a Stop of a session with at least one peer, when its summary is
stale (the same check as the Summary panel) and at least 2 minutes (`PEER_SYNC_MIN_MS`) passed since
the last make for it, it makes a summary (haiku, as the Summary panel does) and writes one delta per
peer target. `seen` advances only when a delta is written (or, with **Sync now** on Windows, typed
in). **Sync now** (`CH.peersSync`) awaits a make already under way, then makes a fresh one and
delivers; syncs of one session are serialized. Where deck hooks are not live (Windows, or not
installed) it types the text through `Sender` into peers that are idle (`canDeliver`) and skips the
rest. `peerSync.auto` in the app config (default true) turns off the automatic part on Stop.
IPC: `CH.peersSet` (add or remove one link) and `CH.peersSync`, both open to remote callers.
Renderer: `PeersDialog.tsx` and `PeerPicker.tsx` (`peersView.ts`), the "Linked sessions" section of
`SessionDetails.tsx`, and a "Link to sessions" field in `AssignDialog` and `NewSessionDialog`.
Unlinking stops further sharing but retracts nothing already in a transcript.

### Session tabs, files and diffs (issue #113)

Each session pane has its own tab row (`renderer/.../SessionTabs.tsx`): the terminal, then file
and diff tabs. The model is pure (`shared/sessionTabs.ts`: `openTab` focuses an open tab, else
adds it after the active one; `closeTab` never closes the terminal and hands the active tab to its
right, else left neighbour; `cleanTabs` checks a saved state). `renderer/src/sessionTabsStore.ts`
keeps every session's row by `Session.key` in localStorage (`session-tabs`), so it survives a
resume and a restart; the App prunes keys no longer listed (never on an empty list). Every opener
goes through the store: Details → Diff (`DiffList.tsx`) and Files (`FileTree.tsx`), ⌘P
(`QuickOpen.tsx`), ⌘-click in a terminal (an xterm link provider in `TerminalView.tsx`,
`findPaths` / `relativeTo` in `shared/filePath.ts`), a diff tab's **Open file**.

The same link provider opens web links (#119). It reads the whole line a row belongs to, its
wrapped rows joined, through the cells (`renderer/src/termText.ts`: `logicalLine`, `cellRange`), so
a link or path that wraps is one link and wide characters before it do not shift it. `findUrls`
(`shared/termLinks.ts`) finds http/https addresses and drops trailing punctuation and a closing
bracket the address did not open; a path inside an address is not a path. OSC 8 links go through
xterm's `linkHandler` (xterm itself drops non-http schemes). A click opens only with ⌘ (Ctrl off a
Mac); the underline and pointer follow the key (`showMod` sets the hovered link's decorations),
except on OSC 8 links, which xterm always underlines on hover. The click goes to `deck.openLink`
(`app:openLink`, `local`): the window's main checks `isWebLink` (http or https, a host, no spaces or
control characters, at most 2048 characters) before `shell.openExternal`; the web app checks the
same and calls `window.open` itself. `openExternal` stays https only for everything else. The store's
`onOpen` lets the phone close its panel sheet. The terminal stays mounted (hidden) under another tab.

Main reads, never writes: `main/sessionFiles.ts` `SessionFiles` behind four `remote` channels
(`files:list`, `files:read`, `diff:list`, `diff:file`). The folder is always the listed session's
`cwd`, looked up by key (`sessionFileCall` in `main/remoteGuards.ts`); a path passes `insideRoot`
(relative, no `..`, no NUL) and then the real-path check (no link out of the folder); a path
through `.git`, `.ssh`, `.gnupg` or `.aws` is never read, and a session whose folder is the home
folder (no repository) gets no file list (no crawl of `~/Library`). Git runs with
`GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1` (`[id].tsx` is a name, not a glob),
`--no-textconv` and a 10 s timeout; a tracked file over 10 MB is not diffed; lists come from `-z` output (`shared/diff.ts`
`parseChanges`, `parseDiff`, `splitRows`). **Uncommitted** diffs against `HEAD` (the empty tree
before a first commit), **Branch** against `merge-base HEAD origin/<default>` (else the local
branch); untracked files are listed as added (the first 300; `more` counts the rest) and their
lines counted by main, 8 files at a time. Limits (`shared/fileView.ts`): a
file over 1 MB or 20,000 lines, or binary (a NUL in the first 8 KB), is refused with a reason; a
diff is cut at 5,000 lines. A web answer passes `webFit` (`shared/sessionFiles.ts`): under ~900 KB
of JSON so it fits one bridge frame (a list is cut to what fits, a file becomes too-large, a diff is refused).

Nothing of this is in `AppState`. Details → Diff and an open diff tab pull (`renderer/src/usePull.ts`):
every 3 s while on screen and the window is visible, at once when the session's state changes;
the schedule is checked from refs, so nothing re-renders between pulls, and an unchanged answer
draws nothing.
Highlighting is `highlight.js` (`lib/common` plus dockerfile) in `renderer/src/highlight.ts`,
which splits its HTML per line; over 300 KB a file is shown as plain text. Markdown goes through
`MarkdownView html={false}`. Token colours are theme tokens (`.hljs-*` in `styles.css`).

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
  `builder`, `ticket-builder`, `pr-review`; command from `shared/paneCommand.ts`). Keeps a 200 KB replay buffer
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
- The PR view's review session (Review with Claude, `pr-review` spec `{resume, tab, prompt?,
  account?}`, #149): always one per PR tab, pane `pr-review:<tabId>:<gen>`, `-n md-pr-review-<tabId>`
  in `<home>/pr-review/tab-<tabId>/` (`main/prReviewDirs.ts`: `prReviewDir`, `prReviewDirOk`,
  `prReviewPane`); with two or more accounts as the tab's account (`--settings`), else gh's active
  account, as the ticket builder. `prReviewPrepare` (`CH.prReviewPrepare`, remote) takes `{tabId,
  tab, account?, filters, url?, context?}`, checks the tab id, the account (connected) and the
  folder, and writes `context.json` from MasterDeck's own `state.teamPrs` (`prReviewContext` in
  `shared/prReview.ts`: the selected PR's repo, number, title, author, branch, base, CI, reviews,
  threads, issues; never facts from the caller), and, unless `context: true` (the view's 400 ms
  follow-up when the pick or the filters change), `CLAUDE.md` (`prReviewBriefing`), project
  settings (`PR_REVIEW_SETTINGS`: `gh pr view/diff/checks/list`, `gh run view/list`, `gh issue view`
  allowed; `gh pr review/comment/merge/close/edit/ready`, `gh issue comment` denied) and
  `post-review.sh` (`prReviewScript`), each atomically. The script is the session's only write: one
  review (`POST repos/<o>/<r>/pulls/<n>/reviews`, body and inline comments from files inside the
  folder, JSON by `jq`), only to the selected PR (`--pr` must match), only when `gh api user` is the
  tab's account (when there is one), `--dry-run` posts nothing; both checks read the guard file
  `<home>/pr-review-guard/tab-<tabId>.json` (`prReviewGuard`, written with every prepare), outside
  the folder, so the session's unasked edits (`acceptEdits`) cannot change them. The settings also
  deny `Edit` of the script, `context.json`, `CLAUDE.md` and `.claude/**`, and a `.claude` that is a
  link is refused. The script is not in the allow list, so Claude Code asks the user before each
  run. A browser's prepare may not change the account a tab folder already names. The renderer keeps the sessions per
  tab in a module map (`keptReviews` in `PrsView.tsx`); a tab's account change, its close, or a
  switch between one and several accounts closes its pane. The bridge refuses a remote `pr-review`
  open without a tab, with a bad one, an account not connected, or one other than the tab folder's
  (`prReviewSpecError` → `ticketSpecError(…, "PR review")`). `isPrReviewSession` hides them from
  the session list. The PR popup's **Review with Claude** is passed by `App.openPr` only when the
  popup was opened from the PRs view.
- Automate Review and Merge automatically (#157; `shared/autoReview.ts` pure, `main/autoReview.ts`
  `AutoReview`): switches per PR tab through `CH.autoReviewSet` (remote; main refuses Merge
  automatically on from a browser, an account not connected, and from a browser an account other
  than the tab folder's; `forget: true` on a tab close), kept with the PRs it follows in
  `<home>/auto-review.json`. Every 2 s main asks `due()` (2 minutes per round, at once when switched
  on) and `deliver()`. A round is one GraphQL read per tab as its account (`autoQuery`: `viewer`,
  `search(review-requested:@me …, autoSearch's scope)` and each followed PR by reference, 30 per
  read), then `reconcile`: new requests are `queued` once per account and URL (`trackKey`), a
  review by the account at or after the sent commit makes it `commented` (a notice), a new head
  re-queues it, `readyToMerge` (open, not draft, MERGEABLE, APPROVED, checks SUCCESS or none, merge
  state CLEAN, head = the reviewed commit) makes it `ready` (a notice), and `mergeGuard` (the tab's
  switch, its own PR, not tried at this head, a known method) lets `gh pr merge <url>
  --<viewerDefaultMergeMethod> --match-head-commit <oid>` run (never `--admin`/`--auto`) after the
  switch is checked again and the PR is read again past the cache (`force`) and guarded again; merged,
  closed and failed merges are told. Nothing is decided without `viewer`, nor on an answer whose
  tab was switched or changed while GitHub answered. "Sent" means a review by the account dated
  after MasterDeck typed the line. Switching off drops the tab's open PRs (another tab may take
  them). A browser only flips switches (the window's name, filters and account stay; it never
  forgets a tab); the window's name/filters follow-ups carry `follow: true`, so main keeps its
  switches. A new review pane needs a fresh turn; a pane is started at most once per 5 minutes. `deliver` types
  `autoPrompt` (one line, `[MasterDeck auto-review] …`) into the tab's live `pr-review:<tab>:*`
  pane when `paneReady`: the folder's hooks (`prReviewSettings`: SessionStart → `start`, Stop →
  `idle`, prompt and tool use → `busy`) wrote the turn file `pr-review-guard/tab-<id>.turn`
  after MasterDeck's last line, and the user has not typed for 30 s (a `busy` older than 15 min
  with no "esc to interrupt" on screen counts as idle: Esc fires no Stop). With no live pane it
  starts one (`pr-review:<tab>:auto<ts>`, the line as its first message), which the panel adopts
  through `state.autoReview.tabs[id].pane`. Before typing it writes `pr-review-guard/tab-<id>.auto.json`
  (`writePrReviewAuto`), the only PRs `post-review.sh --auto` (allowed in the settings without
  asking) posts to, always as a COMMENT. Notices go through the notifier as `auto-review`
  (`Notice.url` → **View on GitHub**). The monitor is listed in `state.watches` as `review:<tab>`
  (`watchStop` switches it off, `watchEvents` its log); `state.autoReview` (`AutoReviewView`) feeds
  `AutoReviewWidget.tsx`, placed by `TerminalView`'s `onInputBox` (`inputBoxRows` finds the rules
  around Claude's prompt).
- The workflow builder (`builder` spec) runs as the primary account with two or more: the
  `builderSettings` callback of `PtyManager` gives `AccountEnv.settingsArgs(null)`'s `--settings`,
  and nothing while the primary needs to log in again (gh's active account then, as master).
- Create with Claude's settings bar (#68; `renderer/.../TicketSettingsBar.tsx`, `shared/ticketSettings.ts`):
  the panel holds `TicketSession.settings` (repo, board, status, assignees, labels, milestone, sprint
  and its field), started by `settingsFrom` (the dialog's draft, else `ticketDefaults` of the + column,
  the tab's filters and sprint; no board, status or sprint for an account with none) and changed by
  `changeSettings` (another repository drops labels and milestone, another board keeps only the
  status and sprint it has; sprints follow the board: `boardSprints`, none on a `sprintless` one).
  Every change calls `ticketBuilderPrepare` again, which rewrites `context.json` with `settings` (no
  new channel). `pumpTicketDir` re-reads it at each request: `readSettings` checks it (no `settings`:
  the flags pass as before; `settings` that fail the check refuse the create, never drop the bar) and `enforceSettings` replaces all seven flags with the bar's,
  so the bar wins over anything the session passed; the answer carries `applied` (what was used)
  and, when a passed flag differed, `overridden` and a `note`. The briefing tells Claude to leave
  those flags out and, when the chat asks for another value, to say the bar's applies and that the
  user can change it there (the one way a conflict is handled). New chat keeps the bar; a + on
  another column (or the dialog) starts it again from there.
- PTY size rule (spec §4, `MacPanes` in `main/remoteGuards.ts`): while the Mac window shows a pane
  its size wins; a browser's size applies only to panes the Mac doesn't show (`cols 0` from the
  window = hidden).
- `main/send.ts` `Sender.send(session, text, masterUp, {from, force, held})`: a message never mixes
  with what the user is typing in the session's prompt (#123; spec
  `docs/superpowers/specs/2026-10-16-held-messages-design.md`). In order:
  1. **The core mod** (`mods/masterdeck` 0.6.0 on, heartbeat `deliver: 1`, `ModBeat.deliver`), for any
     text that is not a command (`isCommand`: `/`, `!`) to a session not done, waiting on a prompt or
     parked: `main/modDeliver.ts` `ModDelivery.deliver` writes `deck/deliver/<sid>/<id>.json`, the mod
     (`hooks/deliver.ts`, every 2 s) writes `.claim`, MasterDeck answers `.go` only if the claim came
     within 5 s, the mod calls `$.prompt.submit({text, asUser: true})` once (a turn of its own, queued
     while busy; the prompt box and its cursor are not touched) and writes `.done`; MasterDeck removes
     the files (`$.fs` can't rename or delete, so only MasterDeck decides). A mod that waited 3 s for
     `.go` in vain writes `.skip` and never submits that id (a stalled app). No claim, or `.skip` → the next step;
     a `.go` with no `.done` in 5 s counts as delivered (`handed`), never typed again. `prune` clears
     folders of ended sessions and files over 10 minutes old.
  2. **Typing, guarded**: into the open tab or through a short hidden `claude attach` (~3 s), only
     when the prompt box is empty: `promptLines` (`main/screen.ts`: headless xterm at the pane's size,
     `PtyManager.screen`; 120x40 for an attach; dim cells blanked: the placeholder and suggestions)
     then `promptDraft` (`shared/heldMessages.ts`: the last pair of rules whose first line starts with
     `❯` and its no-break space). Text there, a key typed into the pane in the last 4 s
     (`PtyManager.input` from `CH.ptyWrite`, `isTyping` leaves out focus, mouse and terminal reports),
     or no box to be seen → held. A key typed during the 150 ms between the paste and Enter keeps
     Enter back (the text stays in the box, unsent; `ok: true, typedNotSent`, so no caller types it
     again). Relayed by master-agent for a session in another
     terminal (only when `masterUp`): `master say --to` → `SendMessage`, which never types.
  3. **Held** (`main/held.ts` `HeldStore`, `<home>/held-messages.json`, atomic): per session in
     order; a new message to a session with messages held, or with a send in flight, waits behind
     them (reason `sending`). `pumpHeld` (every 2 s,
     once the session list is in) tries each session's first one again (an attach at most every
     20 s) and drops those of ended or unlisted sessions. A busy session's Stop hook gets it first:
     `deck/held/<sid>` marks (`DeckHooks.setHeldMarks`) make the hook ask through the queue handshake
     even with nothing queued, and `pumpQueue(…, held)` answers `heldAnswer` before any queued prompt
     (only where the deck hook owns the queue; never while a send to the session is in flight, which
     may be that very message, and never a command, which an answer would turn into words). `AppState.held` (`heldViews`, 240-character
     previews) drives the row's ✉ badge (`SessionRow`) and `HeldBar` above the session's tabs: **Send
     now** (`CH.heldSend`, `sendHeld`: `force` types it even if the box can't be read or the user just
     typed, never over text in it) and **Discard** (`CH.heldDrop`); both open to the web app.
  One send per session at a time; re-checks right before typing that the session didn't start
  waiting on a prompt (`looksLikePrompt`). The result is `{ok: true, held: true}` for a held
  message, so callers (PR watch, monitors, workflow steps, linked sessions, the queue's Send next)
  count it as taken. `answerMenu` sends key steps for menus (no prompt box involved).

### master-agent integration

`config.accounts()` reads the connected accounts (primary first; a repo belongs to the first account listing it) and `config.is_multi()` is the one multi-account check (two or more); `repos()`/`projects()` are every account's; `master config save` mirrors the primary account into the top-level fields and `config shell` (tt.sh) reads only those.

An account with repositories but no project board (`config.boardless(view)`; with one account: the whole config): `master board` reads its ticked repositories' issues instead (`collect.Live.repo_issues`: one GraphQL query with an alias per repository — open issues 100 a page, at most three rounds, plus the ones closed in the last 14 days; `ghc` TTL 120 s; a repository GitHub answers nothing for is named in `missing` and remembered for an hour in `missing-repos.json` under the master home only when GitHub's error for that alias is `NOT_FOUND` (any other null, e.g. `RATE_LIMITED`, is listed in `missing` for that run only, named with its error type in `unread`, shown as a Board note, and asked again next call), so the steady-state query has no failing alias and the cache works; a forced read, `GHC_FORCE=1` from the Board's Refresh or Retry, ignores the memory, asks for every repository and writes it afresh: still `NOT_FOUND` is remembered from now, one that answers is forgotten; `collect._run(…, partial=True)`, also when every repository is gone), `--mine` keeps the issues assigned to the account's login and `--sprint` is ignored (no sprints without a board); one `pr_details` read only for linked PRs that are open or drafts. Its cards carry `derived: true`, `state`, `closedAt` and no status (the app works out the column, see "Board without a GitHub project"); the board lists what was read in `derived` (`account`, `repos`, `total`, `shown`, `skipped` past 10 repositories, `missing`, and `notes`: one line for each thing that read could not do, e.g. `acme/api not read: RATE_LIMITED`, `Pull request details not read: …`; the same lines, joined per account, are also the top-level `notes`). An issue that is on one account's board and in a ticked repository of an account with no board is the board's card, whichever account is read first (`board.on_boards`; `board.build` drops the derived item, `snapshot.merge` does the same for the snapshot's issues), and `cmd_board` takes it off that part's `total` and `shown` when it is open (`board.shadowed_open`), so the note never counts a card the tab does not show. Limits are in `config.py` (`DERIVED_MAX_REPOS` 10, `DERIVED_MAX_CARDS` 300, `DERIVED_MAX_DONE` 50, `DERIVED_DONE_DAYS` 14). A board whose config entry has `sprintless: true` (one MasterDeck created) is read without the sprint part of the filter (`board.sprintless_query`): `sprint:@current` matches nothing on a board with no sprint field. GitHub's detection never says a board is such a one, so Setup carries the mark over when it rebuilds an entry from a detected board (`setupAccounts.ts`: `markMade` marks the detected list from the saved config, `withFound` keeps it on chosen boards; both only while the detected board has no sprint field: one added on GitHub since drops the mark, and the board has sprints again); `master config save` passes it through (`config._project`, `setup._mirror`).

The same read serves the Board's repository view, narrowed: `collect.Live.repo_issues(today, only=[…], boards=True)` reads just the named repositories (in the spelling Setup has; each paged to its own three rounds of 100 open issues instead of the account-wide stop at 300) and, when the reading account has a board, asks each issue which project boards hold it (`projectItems(first: 5)` with one aliased `fieldValueByName` per distinct status field name: `board.status_fields`, `board._boards_part`; both are fields MasterDeck already reads elsewhere). `repo_issues_page` turns that into `on boards: [{key, status}]` for the boards selected in Setup only, and `board.build` hands it on as the card's `onBoards` (only on a derived item, so a card of `master board` never has it). When GitHub refuses that part (a token without the `project` scope), the read sends the same round once more without it and reports `boards_unread`. A refusal is recognised in every shape seen or documented (`collect._boards_refusal`): an error whose `path` holds `projectItems` (GitHub then nulls the issue itself), an error of type `INSUFFICIENT_SCOPES`, an error whose message names `projectItems` or `read:project` (never a `NOT_FOUND`: its message quotes the repository's name), and gh failing with no data at all over one of those (`_run` raises; the text is matched the same way). A second refusal, or any other failure, fails the read as before. Without `only` and `boards` the query is byte for byte the one above, so the board read and the snapshot still share one cached answer. The read also returns `totals` (open issues per repository).

`master repo-issues --repos owner/a,owner/b` (`cli.cmd_repo_issues`) is that read as a command, for the app only: read-only (not in `WRITE_CMDS`), never called by master's skill, and `master snapshot`, `master board` and `rules.propose` do not know these issues. It refuses a name `config.repo_readable` does not pass (below), groups the rest by account (`config.account_for_repo`; one account: the whole config), and reads each group with its own token (only the accounts asked about), `DERIVED_MAX_REPOS` (10) repositories at a time, one read after the other: this command is the one place that cuts a long list, so however many repositories a tab picked none is left out, and the app only gives the CLI two minutes for each started ten (`MasterCli.repoIssues`). A read that fails ends that account's reads (its remaining repositories carry what gh said; the ones already read stay). It trims each repository on its own (`board.trim_repo_issues`: 300 open, 50 closed in the last 14 days), reads PR details once per read when a linked PR is open or a draft (`_pr_facts`, shared with `_repo_cards`), and prints `{taken_at, cards, repos}`: the cards through `board.build` (so exactly a derived card's shape, plus `onBoards`), and one part per repository, `{repo, account, ok, total, shown, note?}`. `ok: false` never fails the command: a repository not selected in Setup (`… is not selected in Setup`, not read), `Not found: …`, `… not read: RATE_LIMITED`, or `… not read: <what gh said>` when its account's read failed (`… not read: more than 10 repositories at once` is still handled for a source that reports `skipped`, which this command no longer causes). `config.repo_readable` is stricter than `repo_allowed`, because here the names come from outside (a Board tab, also one in a paired browser): a repository listed under any account, or, unlisted, one whose owner is the owner of an account that itself has "Select all" (no accounts: the config's `owner` with its `allRepos`). `repo_allowed` (any name once any account has "Select all") is unchanged for its other callers, `normalize._ours`, `normalize.issue_ref_in` and `board.build`: they filter what GitHub returned for the user's own boards and repositories, never a name a client sent. A part that is `ok` can carry a note too (`Pull request details not read: …`, `Board columns not read: …`). A malformed `--repos` exits 2.

`master snapshot` for such an account (`snapshot.build`: repositories, no board) takes the same repository read (the identical call, so `ghc` answers one of the two) and keeps only the open issues assigned to that account's login (`normalize.repo_issues`), each `derived: true` with the column GitHub alone gives it (`board.derived_status`: an open ready PR → PR Raised, a draft → In Dev, a merged one → Done and left out, else Todo); Todo becomes In Dev when a session owns the issue. `rules.propose` reads `config.DERIVED_STATUSES` for them (`rules._statuses`): ASSIGN only for Todo with no owner, ORPHAN for In Dev / PR Raised with a stopped owner; never an issue assigned to someone else or to nobody. On a `sprintless` board the issues assigned to me count as current (`normalize._issue`); unassigned ready ones are not offered.

`master start` (`cli.cmd_start`, `start.py`, issue #126) starts sessions on demand from a chat with
master. From scratch (`--prompt`, optional `--repo`/`--cwd`, `--name`, `--worktree`, `--model`,
`--permission-mode`, `--account`): a `START` proposal for issue 0, its folder the repository's
checkout (`checkout.resolve(…, mapped=False)`) or the workspace, its name from the task
(`start.scratch_name`), its prompt the task plus the reply protocol with the session's name as the
label. For tickets, by reference (`12`, `api#12`, `acme/api#12`) or by board filter (`--column`,
`--assignee` login/`@me`/`none`, `--label`, `--sprint` `@current`/title/`none`/`any`, `--limit`;
`_board_cards` reads every account's board, a boardless account's repository issues with
`board.derived_status`, and matches in `start.board_match`; finished columns only when named): each
ticket is read from GitHub as its repository's account (`Live.issue`, `Live.sub_issues`: REST
`repos/…/issues/N` and `…/sub_issues`) and becomes an ASSIGN proposal (`rules._assign`, so the same
name, folder and account as the sweep's) with source `start:<owner/name#N>:<now>`, its prompt
`start.ticket_prompt` (the ASSIGN prompt, then the description cut at 20 000 characters, up to 50
sub-issues as context, not instructions: the user approved a one-line plan and never read them, so the
session still stops and asks in step 2 unless the user's own instructions follow, which it follows; with
`--worktree` it is told it already runs in its worktree) and `assignMe: true` unless
`--no-assign`. Refused before anything is added: not found, closed, a pull request, a repository
`config.repo_readable` does not pass, a running owner session (`join.owner_of` over `claude agents`
and `ticket-links.json`), an approved ASSIGN for it; a waiting (proposed) or held ASSIGN for the ticket is
rejected with "replaced by start proposal N". Warnings only: no checkout found, a folder
`trust.trusted` says no to, a stopped owner. A name in use (running, or a waiting proposal) gets
`-2`, `-3` (`start.unique_name`). `--worktree` is a flag (each session's worktree named after it),
`--worktree-name` names one (one ticket only). `--yes` approves and spawns each at once (one ledger lock each,
a failure left held and said, exit 1; one master's watch spawned first counts as started); `--dry-run` adds nothing and is a read. `master spawn` and
`master start --yes` print `started <name> (proposal N) — claude attach <bg id>`. A spawn target
may carry `worktree` (→ `claude --bg … --worktree <name>`) and `assignMe` (`spawn.validate_spawn_target`).
A START in a repository's checkout is recorded in `parked-sessions.json` as ticket work is
(`checkout.parked`); a start with its own worktree is not.
On the app's side, `parseLedger` keeps both; `BoardFlow` links the session by the newest ASSIGN of
its name (a newer START of that name means no link) and, when it says `assignMe`, assigns the ticket to the session's account (one account:
`state.me`) through `forCard(…).github.assign` once, with the link; `Sources.readLedger` reads
`claude agents` at once when a spawn proposal turns `sent`; Needs you and the Sidebar name a
proposal without a ticket by its session (`proposalLabel`).

`main/masterCli.ts` runs `python -m master.cli` (the `master` skill's lib, the installed copy in
`~/.claude/skills/master/lib` wins over the bundled one): ledger approve/reject, `draft-assign`,
`spawn`, snapshot, board, `config detect`. `master snapshot` reads MasterDeck's `ticket-links.json`
(not babysit-ticket's state; `MASTERDECK_HOME` overrides the folder), and the ASSIGN prompt no longer
asks the session to run babysit-ticket or babysit-pr: MasterDeck links it and watches its PR. `main/assign.ts` `startAssign` records + approves an
ASSIGN proposal and spawns. `startMaster()` runs `claude --bg -n master-agent "/master"` in the
workspace. GitHub reads go through `ghc` (`main/ghc.ts`, the shared cache in `~/.claude/gh-cache`;
`gh` directly on Windows).

**Where a ticket's session starts** is decided in one place, `skills/master/lib/master/checkout.py`
(`resolve(repo, cwd=None, account=None, mapped=True)` → `{cwd, workspace, repo, found}`, plus
`filedIn` when the repository looked for is not the issue's, and `partial` and `searched` when it
was not found and a limit was reached). The repository looked for is where the issue's code lives:
`config.code_repo` (Setup's `codeRepos` pairs, `[{issues, code}]`, a list so a save replaces it;
`mapped=False` for a PR's repository). It is looked for in the workspace of the account the session
runs as (`config.workspace_for(repo, cfg, account)`: `account` when given, else the code
repository's account, else the issue's, else the primary; an account's own `workspace`, blank
counting as none, else the top-level one; `MASTER_WORKSPACE` replaces them all). That account is
`config.start_account` (two or more accounts; the app's `startAccount` in `shared/accounts.ts` is
the same rule, plus a PR review's repository first).
First the folder named after the repository (`_named`: one directory read, no scan). Else `scan`:
the workspace, its sub-folders, and the sub-folders of the plain ones; a `.git` folder whose
`origin` is the repository, without case. The origin is read from `.git/config` (`_config_origin`,
no process); `config.origin_repo` (git, with its insteadOf rewrites) is asked only for an origin the
file does not spell out as a full URL, at most `MAX_GIT_CALLS` = 20 times. Hidden folders and links
leading out of the workspace are skipped, a linked worktree (`.git` file) is neither picked nor
looked into, and at most `MAX_FOLDERS` = 2000 folders get a stat. Several checkouts of one
repository: `_rank` (named after it, then depth, then path length, then name). A scan is remembered
for 60 s in the process. It reads the filesystem, so `rules.propose` (through `_assign`) is no
longer a pure function of the snapshot. The tests' `conftest.py` points HOME, `MASTERDECK_HOME`,
`MASTER_HOME` and `MASTER_WORKSPACE` into one temp sandbox before anything is imported and again
before every test, and fails a test that leaves a path in the real home (`test_isolation.py`).
Found: `cwd` is the checkout and step 1 of the ASSIGN prompt (`rules.assign_prompt`) says so, naming
the workspace for an issue filed in one repository and built in another; with a `codeRepos` pair it
names the code repository instead (found or not); else `cwd` is the workspace and the prompt is the
text it always was (pinned in `tests/prompts/`). Callers: `rules._assign`
(master's proposals and `master draft-assign`, which also prints `workspace`, `found`, `checkoutOf`,
`genericPrompt`, `filedIn` and `account`, and takes `--cwd` for a folder the user chose and
`--account` for another account than the ticket's), `master checkout <owner/name> [--account]`, and
`checkout.default_cwd` for `master add` without `--cwd` and `master spawn` of a proposal without a
folder: only an ASSIGN or PRREVIEW for an issue number above 0 is looked up; any other kind, issue 0
and a resume keep `config.workspace()`.
The app never decides the folder: the Start dialog (`AssignDialog.tsx`, `shared/startFolder.ts`)
shows the draft's answer; for master's proposal it looks the ticket up again and `adoptFresh` moves
to a checkout only from a plain workspace; `swapPrompt` replaces a prompt only while it is one of
the drafts' own texts; `startChoice` approves master's proposal when nothing differs and otherwise
carries its model (`SpawnTarget.model`). The dialog's other options live in `shared/startOptions.ts`
(`ticketBranch`, `branchError`, `worktreeDir`, `worktreeNote`, `PERMISSION_MODES`, the per-repository
`StartPrefs` kept in localStorage under `prefsKey`). **Create worktree** is the one thing the app
does to a folder itself: `main/startWorktree.ts` (`worktreeInfo`: main checkout, branches, default
base; `createWorktree`: `git worktree add -b <branch> <root>/.claude/worktrees/<dir> <base>`, never
reusing a branch or folder), behind `CH.worktreeInfo` / `CH.worktreeCreate` (`worktreeFolder` in
`remoteGuards.ts`: the Mac's window only, `blocked` in `DECK_ACCESS`). The dialog awaits it before
`assign`, so a failure is shown there and nothing starts; the request then carries the worktree as
`cwd` and `worktreeNote` after the system prompt (`composePrompt`'s `setup`). The permission mode
travels as `AssignRequest.permissionMode` → `master add --permission-mode` →
`SpawnTarget.permissionMode` → `claude --bg --permission-mode` (`spawn.PERMISSION_MODES`:
`bypassPermissions` is refused); like a model, it always makes a new proposal. The description's
Preview is `shared/markdown.ts` (`parseMarkdown` → a tree; `safeHref` / `safeImage`: https only)
drawn by `renderer/.../MarkdownView.tsx` as React elements, never HTML from the text; the CSP's
`img-src` allows `https:` for it. Reuse both for any other Markdown view (Notes). **Choose folder…** asks for a draft with `--cwd`. Picking another account asks for a draft with
`--account` (`refindOnAccount`: not after Choose folder…, not for a held start, not for a
proposal's own folder); main passes a connected login only (two or more accounts). A PR
review names its repository (`AssignRequest.cwdRepo`): main's `assignNow` takes the picked account,
else `startAccount(repo, cfg, cwdRepo)` (the PR's repository's account), and `inRepoFolder`
(`main/assign.ts`) asks `master checkout --account` for it, so folder and account agree. The `cwd`
argument of `draftAssign` is checked by `chosenFolder` (`main/remoteGuards.ts`): from the window it
must be an absolute, existing folder; from a browser it must be one of `workspaceFolders()` in
`main/index.ts` (the workspace and `Ops.repos()`, the list `workspaceRepos` gives the web app's
`RepoPicker`), compared as real paths, and anything else is refused with a message (the dialog
keeps its folder and shows it). An `assign` request's own `cwd` and `cwdRepo` are passed on from a
browser exactly as from the window, as `cwd` always was.

**Whether Claude Code may work in that folder** (`claude --bg` refuses a folder whose trust prompt
was never accepted: "Workspace not trusted. Run `claude` in <folder> once and accept the trust
prompt, then retry.") is read in one place, `skills/master/lib/master/trust.py`: `trusted(folder)`
reads Claude Code's own `.claude.json` (`claude_json()`: the home folder, or `CLAUDE_CONFIG_DIR`)
and mirrors Claude Code's walk: `projects[<dir>].hasTrustDialogAccepted === true` for the folder
or a parent, inside a git repository up to and including its root (the first folder with a `.git`,
found by walking, no git process), outside one all the way up. So a sub-folder of a trusted
repository is trusted, a plain folder under a trusted parent is trusted, and a repository under a
trusted plain parent (a checkout in a trusted workspace) is not. Folders are compared by their
real path only (a key spelled through a link is not this folder's), with the keys as stored
(forward slashes, no trailing one, NFC; no case on Windows; never by prefix). True, False, or
None for not known: no file, unreadable, not JSON, not UTF-8, over 8 MB, no `projects` object, a
folder that is not there, or a walk that ended at a `.git` file (a linked worktree or submodule,
where Claude Code may go by the main repository) without finding a yes. Never True on a guess,
and never False on one (the dialog holds Start back only on False). It never writes the file.
`master draft-assign` and `master checkout` add `trusted` to their JSON; `master trust <folder>
[--wait N]` answers for one folder, and with `--wait` looks again every two seconds (the file's
time, size and inode; it is read again only when one changed, and each call starts with a read)
until it is trusted or N seconds (60 at most) passed. The app has no reader of its own:
`MasterCli.trust(folder, wait)` behind `deck.trust` (`CH.trust`, the window only).
`shared/trust.ts` holds what the app says and decides: `isNotTrusted(text)` (the matcher for the
refusal's text on a failed start, loose about wording; `trust.not_trusted` is its copy in the CLI,
tested on the same sentence), `needsTrust`, `trustView` (the line, the hint, whether **Open Claude
there…** shows: `ask` / `waiting` / `ready`), `startBlocked` (the dialog's Start waits only for a
folder known not to be trusted, in the window), `heldForTrust(proposal)`, `trustHeldAssign`,
`startFlags`, `retryRequest`, `waitForTrust` (the loop of 15-second `deck.trust` calls, ten
minutes at most) and `remoteTrustMessage`. `renderer/.../TrustFix.tsx` (`useTrust`, `TrustNote`)
is the one view of it, used by the Start dialog (`DraftAssign.trusted` → `StartFolder.trusted`; a
folder the draft says nothing about is asked about once; while the user answers the prompt the
dialog is hidden, not unmounted, behind a small strip), the "did not start" pane (`StartRefused`
in `App.tsx`) and the held card (`ProposalCard` in `Sidebar.tsx`).

**Open Claude there…** is `deck.openClaudeIn(cwd)` or the item's `trust` action → `openClaude` in
`index.ts` (`claudeFolder` in `remoteGuards.ts`: the window only, an absolute folder that is
there) → `CH.openClaude` to the window alone → a shell tab with `claude: true` (id
`claude:<folder>`, one per folder, never restored; asked for again after its Claude exited, the
pane starts it again) whose pane is `{kind: "claude-here", cwd}`: the resolved `claude` with no
arguments in that folder (`paneCommand`). It is the Mac's only, at every door: the bridge's
`WEB_PANES` has no `claude-here`; `ptyOpen` refuses it from a browser; `PtyManager.open(…,
remote)` remembers each pane's kind and gives a browser an existing pane only as the kind it is
(else `claude:<folder>` could be had by asking for it as a `shell`); `PtyManager.open` refuses a
missing folder (`startDir` would fall back to home); and the `inboxAct` handler refuses `trust`
for a browser (`inboxActCall` in `remoteGuards.ts`; every other action of the web app takes the
window's path, as it always did). MasterDeck never answers the
prompt, never writes `.claude.json`, and never closes that tab.

**Try again** starts the same proposal, and only one the CLI itself held for this. When Claude
Code refuses a folder, `master spawn` marks the proposal `held_for: "trust"` (and writes the
folder into a proposal that named none, so the app shows it and the retry starts there); any
other hold, and leaving `held`, drops the mark (`ledger.transition`), so a start that then timed
out ("may still have started a session") is not one. `Proposal.heldFor` carries it to the app
(`parseLedger`), and `heldForTrust` reads only that, never the note (master-agent can write any
note). The retry is `master spawn <id> --held-for-trust` (`MasterCli.spawnHeld`), decided under
the ledger lock: it refuses anything not `held` with that mark, and before starting it asks
`claude agents` for a live session of the proposal's name (`spawn.named_running`): one there, the
held start is rejected with a note instead ("a session named X is already running; this held
start was closed"); not known, nothing starts and it stays held. The app asks first too
(`sessionForProposal`: a live session with the proposal's name or its ticket) and then closes the
held start with `master reject <id> --note …`; the "did not start" tab then says "<ticket>
already has a session: <name>" with **Open it** and Close, no Retry (`pendingPane` reads the
closing sentence, the CLI's and the app's being the same). Both doors use only that: the held Needs-you item
(actions `trust` and `approve`, label **Try again**; `approve` because it is the one a phone's
`inbox.act` can send) → `runInboxAction` → `retryHeld` (`main/assign.ts`); and
`AssignRequest.retry` → `startAssign`, which then never calls the plain `spawn` (so a browser
sending `retry` for any held proposal gets the CLI's refusal). The "did not start" tab sends
`retry` only for the refusal's text (`retryRequest`); for any other error its Retry sends what it
always did. The Start dialog, for a ticket whose refused start is still held (`trustHeldAssign`),
drafts from that proposal (its prompt is the whole first message already, so description and
earlier sessions are not added again) and `startFlags` makes an unchanged Start a retry of it; a
changed one adds a new proposal and rejects the held one, as for master's. `session.start` from
the API answers a refused start with `remoteTrustMessage`. Other failures are untouched.
Because MasterDeck now starts sessions in main checkouts, `master spawn` records each new ASSIGN or
PRREVIEW session it starts in a folder that is not a workspace (`checkout.parked`, written to
`$MASTERDECK_HOME/parked-sessions.json`: `{ <bg id, or "name:<session name>"> : {dir, branch,
review, name, at} }`, the branch read from `.git/HEAD` before the start, the last 500 kept; a file
that cannot be parsed is started afresh). The app
only reads it (`main/parked.ts` `ParkedStore`) and decides with one pure function,
`ownsFolderBranch` (`shared/parked.ts`): never in a workspace (master's or an account's); a session
with no record, yes, as always; a review never; a parked one yes in a linked worktree
(`inLinkedWorktree`), and in a main checkout only inside the folder it was parked in, with a branch
that is known (undefined = git failed, kept apart from null = detached) and is not the parked one.
A record kept by name (`parkedFor`) counts only for the session that started in that folder within
ten minutes of its `at`. Two call sites ask it through `Sources.ownsBranch`: `pollDetails` → `pollPrs` (the folder's
branch PR, `gh pr view` in the folder) and `linkSession`'s `branch` (the link's `branchKey`; there
a workspace is not exempt, as before). Sessions started by hand or before this version have no
record and behave as they did.
`Ops.repos()` (Janitor, `removeWorktree`, the + menu, standup, the Workflow view, the web's known
folders) lists every account's workspace by the resolver's depth rule (`main/checkouts.ts`
`workspaceRepos`; one account with its repos directly in the workspace gets the list it always
got).

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

An issue of a repository selected in Setup that no selected board holds (the Board's repository view shows these) is linked as well (`LinkDeps.offBoard`, fed by `offBoardOk` in `linkSession`; the Link dialog and `BoardFlow` autoLink go through the same function): no card, so no move; one that is on a board moves as before. `offBoardOk` (`shared/repoView.ts`) needs the issue's repository to be known (a ticket with no repository is the primary issue repo, so a legacy single-repo config still links) and selected by the config (`repoPickable`, the same check the ask makes): listed in Setup under any account, or, unlisted, a repository whose owner is the owner of an account that itself has Select all (no accounts: the config's owner with its Select all). One account's Select all does not open another account's owner, and a login is not an owner. Anything else is refused as before ("… is not on any selected board"). `BoardFlow` then links the session's PRs to the issue as for any linked ticket: `BoardOps.linkPr` adds the PR as a closing reference (`addCloseIssueReferences`; it shows under the issue's Development box), so **merging that PR closes the issue**, also an issue no board holds. This is the one existing GitHub write that reaches such issues. `move` skips it (no card with a `project`). The Assign popup and the PR popup start a session for a card that is not mine without assigning it (`onStart`, the Start dialog); the Assign popup's people are those of the card's repository (next paragraph), `startSessionTitle` words the button's tooltip by who is assigned, and `reviewRequest` carries the card's repository into a PR review (`shared/boardFilter.ts`).

### Which account a call uses (`main/accountClients.ts`)

`accountClients` (wired in `index.ts`) gives `forAccount(login)`: the account's `gh` runner
(`makeGhRunner` with `accountEnv.runEnv`, made once per login), `GitHub` and `BoardOps`; an unknown
login is the primary. `forRepo(repo)` picks by `accountForRepo`: ticket create (dialog and the
ticket builder's requests) and, straight to gh without the cache (`ghDirect`), New ticket's repo
meta and the summary post. A card's calls go through `forCard` and its board's through `forBoard`
(see "Which account a card's calls go out as" below): issue body, assign, the PR popup, status
moves, `linkSession`, and BoardFlow's `move`/`linkPr`. `ghRouted` picks from a call's own `-R`/`--repo`, a whole PR or issue URL, or a
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
ASSIGN proposal (the newest of that name) is linked through `linkSession` (tried once per session, ever:
`<home>/board-link-tried.json`); when that proposal is a `master start` with `assignMe`, the ticket is
then assigned to the user (`deps.assignMe`, once, only after a link that went through). (2) Each new
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

**Who can be assigned (`main/assignUsers.ts`, `shared/boardFilter.ts`).** There are two sources. `state.users` is the primary issue repo's assignable users (`GitHub.assignableUsers()`: `gh api repos/<owner>/<repo>/assignees`, a REST read), read at every GitHub refresh as the primary account (`Sources.refreshPeople`) and cached in `cache.json`; it serves the Board's Assignee filter on the primary account's tab or with one account (`tabFilterUsers`; another account's tab gets only the people on its cards and its own login) and seeds the Assign popup for a card of the primary issue repo (`assignSeed`: no read, the same list and order as before). For any other repository the popup asks main when it opens: `deck.assignableUsers(repo)` (`issue:assignable`, an invoke, `remote` in `DECK_ACCESS`: a read) → `AssignableUsers.get`, which accepts a repository the config selects (`offBoardOk`: `repoPickable`; no repository means the primary issue repo) or one that a card of a loaded board is in (`Sources.boardRepos()`, counting only cards of boards Setup still selects: a board can hold issues of a repository Setup does not tick; the name read is then the board's own, from GitHub, and a name that is neither is refused), reads `GitHub.assignableUsers(false, repo)` through `forCard(repo)`, keeps the answer an hour per repository (at most 50 repositories, the one read longest ago goes), joins a second ask to a read that runs, and answers a failed read from memory for a minute (`ASSIGN_USERS_FAILED_MS`), so whoever asks cannot repeat a failing read without bound; a change of the config or a board read that lands (`Sources.boardStamp()`) forgets those failures at once, since the card may be routed to another account now. The primary issue repo is always accepted. **Which account a card's calls go out as** (`accountClients.forCard`, `shared/accounts.ts` `accountForCard`): in this order, the account that lists the card's repository; else an account whose `owner` is the repository's owner (the first in the config: it is the one with rights there, whichever board the card sits on); else the account whose board holds the card (`Sources.boardOf(repo, number)`: the loaded boards' cards, only of boards Setup still selects; a board can hold issues of a private repository only its own account can read); else the primary. The card's board is the one the caller names (`Ticket.project`, `forCard(repo, number, project)`; from outside kept only when Setup selects it: `knownProject`), else `Sources.boardOf`; without a number (the assignable-users read, a PR's summary opened from no card) or when no loaded card is that issue, `boardOf` answers the first board in Setup's order that holds a card of the repository, never whichever loaded first. **Board writes go by the board, not the card** (`accountClients.forBoard`, `boardOps.move` / `setStatus`): a status move, and the issue read right before it (`BoardOps.issueInfo`, which then reads the named board's item first), go out as the account whose board holds the card (`accountForProject`), even when another account lists the repository: that account can write its board, and it read the card from it. With no known board they go as `forCard`. Issue reads and writes (assign, issue body, a PR link under Development) stay on `forCard`. The Board's status menu sends the card's `project` with `setStatus`, `BoardFlow` the `project` of the card it found (on the loaded board or among my issues, any sprint) with `move` and `linkPr`, `linkSession` the board `issueInfo` read the item on. When no board holds the card, `setStatus` asks whether the card's account has a board (`cardBoardless`, `shared/derivedBoard.ts`) before it writes, so gate and routing cannot disagree; a card on a board is never derived, so it is moved there whatever the repository's account has. A ticket session (Start, a PR review) takes the card's board too (`AssignRequest.project`, else `boardOf`): `startAccount(repo, cfg, prRepo, project)` keeps the code's repository's account first and, after it, uses `accountForCard` once the board is known instead of the repository's account alone; the Start dialog computes its default the same way. With one account it is the default runner, as before. `forRepo` (repository's account, else the primary) remains for calls that have no card. The popup (`AssignPopup.tsx`) shows `assignChoices(me, users)`: "Me" first (the tab's account), then the users by name, without case; while the read runs it shows "Me" and a loading line, and when it fails an error line and "Me" alone, so assigning to me always works. `assignIssue` runs as the same account as that read (`forCard(t.repo, t.number).github.assign`; pinned in `accountClients.test.ts`).

### Board repository view (`shared/repoView.ts`, `main/repoIssues.ts`)

A Board tab whose Repos filter names repositories, and whose account has a board, shows every issue of those repositories instead of the board: `repoViewOn(login, cfg, repos)` is the one check (an account with no board is not one: its tab already shows these issues, and picking a repository filters them). The issues never enter `AppState.board`; they live in `AppState.repoView = { cards, repos: RepoPart[] }`, absent until a tab asks. `shared/repoView.ts` is the pure part: `repoPickable` / `repoRefusal` / `askPlan` (what an ask may read, and why the rest is not: `owner/name`, selected in Setup, of an account with a board, at most 30; `cleanRepos` is `askPlan(…).repos`), `admitRepo` (may a new repository be taken in), `pauseText`, `parseRepoIssues` (the answer of `master repo-issues`), `needRead` / `applyRead` / `liveRepos` / `pruneEntries` / `dumpEntries` / `loadEntries` / `withAssignee` over the per-repository entries (a failed read keeps the cards of the read before and records the reason), `viewOf` (entries to view), `repoViewDeriver` (every card's column through `boardDeriver`, the same object back while nothing changed), and what a tab needs: `repoViewBoard` (the picked repositories' cards, `DERIVED_COLUMNS`, no boards), `repoViewStatus` / `repoViewEmpty` (loading, not read, no issues, filtered), `repoAskEvery`, `repoViewTitle`, `repoChoices` / `reposFilterOffered` (the Repos filter's options, and whether it shows) and `boardChips` (a card's `onBoards` as chips: only boards selected under the account that read the repository, because the read asks for that account's status fields and `repo_issues_page` keeps that account's boards). `parseCards` (`shared/board.ts`) is shared with `parseBoard`; a parsed card parses to itself, which is what the cache relies on. `BoardCard.onBoards` is read only on a derived card, and `master board` never prints it.

`RepoIssues` (`main/repoIssues.ts`, one per `Sources`) holds the entries. `ask(repos)` (from `deck.boardRepos`, renderer or web: untrusted, so it goes through `cleanRepos`) takes in each repository (`admitRepo`, below), marks it as asked now and reads the ones never read or read over an hour ago (`REPO_VIEW_STALE_MS`); `refresh(force)` (from `Sources.refreshGithub`, so hourly and on Refresh) reads the ones asked for within the last hour (`REPO_VIEW_LIVE_MS`) and makes no call when there are none; a tab in repository view asks again every 20 minutes (`REPO_VIEW_ASK_MS`) to stay in that set, and every 5 minutes while one of its repositories was never read and a new ask could read it (`repoAskEvery`: `RepoStatus.retry`). One read at a time, and one per repository: a repository already being read (or queued) is joined, not read twice, and is `loading` until its read ends; except that a forced read (Refresh, Retry) never settles for an unforced one that runs (that one answers from the caches, and the CLI remembers "Not found" for an hour): the repository is read again behind it, forced, and stays `loading` until then (a read that finds GitHub paused when its turn comes, because the one before it hit the rate limit, does not go out) (`master repo-issues` through `MasterCli.repoIssues`, `GHC_FORCE=1` only when the user pressed the Board's Refresh or Retry: `Sources.refreshGithub(force, repoForce)`, so the refreshes after a ticket, an assign or Setup, and the hourly one, read through the shared gh cache); a repository never read (its first read failed) is read again by the first ask that comes once the failure is 5 minutes old (`REPO_VIEW_RETRY_MS`; with the tab's 5-minute tick that is 5 to 10 minutes later), one read before keeps its hour, and a trial dated in the future counts as none; while GitHub is paused nothing is read and a repository never read says so; a failed read's text goes through `Sources.githubPaused` like any other, but only what gh said: the whole read's error, and of a repository's note the part after "<repo> not read: " (`pauseText`), never the repository's name ("Not found: acme/rate-limiter" must not pause every GitHub read for ten minutes). `Sources.build()` puts `repoViewDeriver(view, ctx)` in the state as `repoView`; `saveGithubCache` writes `dumpEntries` as `cache.json`'s `repoIssues` and `start()` loads it; `loadConfig` prunes repositories no longer selected (never on a config that is not configured: a half-written `config.json` must not wipe the cache), and a read that ends after its repository was unticked does not bring it back; `noteAssigned` updates a card at once. The state carries only the repositories on screen (asked for within `REPO_VIEW_LIVE_MS`, or being read) and the ones asked for and refused: the others stay in `cache.json`. `viewOf` cuts the published view to `REPO_VIEW_MAX_CARDS` (1200) cards and to `REPO_VIEW_MAX_BYTES` (500 KB of JSON, UTF-8, cards and parts together; cards differ a lot in size, so the count alone bounds nothing): small repositories keep all their cards, the rest share what is left equally (`fitCards`: first cards, then bytes), a cut repository's part has `cut: true` and its `note` says "api: showing the first N of the M issues read, to keep the view small." (the tab then leaves out GitHub's own "first N of M open issues" line for it), and its `total`/`shown` stay what GitHub said. What this guarantees is the view's share of the state, not the state: the web bridge drops a state whose JSON passes about 1.05 MB (`browserBridge.ts` `tooBig`: `MAX_FRAME` after sealing), and the board, sessions, PR lists and the rest are not budgeted, so a very large board next to a full view can still pass it. The list in an ask is untrusted (the web may send it): an unlisted repository must belong to the owner of an account that itself has "Select all" (`repoPickable`; the CLI checks the same again with `config.repo_readable`), names are checked as GitHub spells them (an owner never starts with `-`, a name is never `.` or `..`), only the first 200 names of a list are looked at, and at most `REPO_VIEW_MAX_ENTRIES` (30) repositories are kept, entries and asks both. A repository MasterDeck holds nothing of is taken in by `admitRepo`: while there is room; else in place of the one asked for longest ago that no tab shows any more (not asked for within `REPO_VIEW_HELD_MS`, 25 minutes, and not being read); never in place of one a tab still shows, so two tabs (or two browsers) with different repositories cannot read each other's away for ever. The two windows mean different things: `REPO_VIEW_LIVE_MS` (an hour) is how long after its last ask a repository is published in the state and read by refreshes; `REPO_VIEW_HELD_MS` is how long it blocks a newcomer once MasterDeck is full, a little more than the 20 minutes between a tab's asks, so a tab that went back to the board frees its repositories for another tab within 25 minutes, not an hour; and not at all while `REPO_VIEW_MAX_QUEUED` (30) first reads wait or run, so a browser cannot queue reads without limit. A refused repository is kept as a refusal (at most 30, for an hour after its last ask) and published as a part that was never read, with the reason as its note. One rule decides what is never read and what a tab says about it: `askPlan` (not selected in Setup; a repository of another account that has no board; past 30 picked) is what `cleanRepos` returns and what `repoViewStatus` reads, so a picked repository that main drops shows as failed with its reason (with **Retry** and **Back to board**), never as "Loading issues…"; main's own refusals arrive as parts and show the same way. `repoView` is not in `toRemoteSnapshot` (pinned by a test). A failed repository read is not part of `refreshGithub`'s result or `boardError`: it shows in the view's own notes. `MASTERDECK_REPO_FIXTURE=<json>` replaces the CLI call (test aid, as `MASTERDECK_BOARD_FIXTURE` for the board).

The Board tab (`BoardView.tsx`): `repoMode = repoViewOn(tabAccount, cfg, tab.filters.repos)`, and `worked = fallback || repoMode` (MasterDeck's four columns, either way) stands wherever the question is whether the columns are worked out: the card source (`repoViewBoard(state.repoView, f.repos)` instead of `tabBoard`), the fixed columns, no drag or drop, no long-press reorder, no sprint picker, no Summary, no Boards filter (one left over is ignored), `canMove(card, worked)`. `fallback` alone still decides what is about having no board: the hint line, **Create a GitHub board**, the no-board empty states, a new ticket without a board step. An effect calls `deck().boardRepos(f.repos)` while the tab is a repository view: when it shows, when the pick changes, and every `repoAskEvery(repoStatus)` (20 minutes; 5 while a picked repository was never read). **Retry** in the view refreshes (the forced read) and then asks again, for a repository MasterDeck had no room for. `.board-hint.repo-view` carries the title (`repoViewTitle`), **Back to board** (`set({ repos: [] })`) and one `.board-note` per `repoViewStatus` note; the empty states come from `repoViewEmpty`; a card renders `boardChips` as `.lbl.on-board`. The Repos filter shows with one option in a tab with a board, and from two in a tab with no board, as before the view (`reposFilterOffered`; options from `repoChoices`); in a tab with a board every pick is kept, all of them too (a view of all the repositories), while a tab with no board still reads "all picked" as none (`reposFilterPick`), and its first entry clears the pick. Tabs are not migrated: one saved before this feature with repositories picked is a repository view from then on (**Back to board** clears the pick). A new ticket from the view (`boardTicketContext`) goes to the first picked repository, the board's "ready" column, and no sprint; in a tab with no board `ticketDefaults` keeps the older default (one picked repository counts, several mean the account's primary). `boardRepoView.test.ts` renders the tab to static markup (no browser) in both modes.

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
  `setFocus`, `setVisible`, `openExternal`, `copy`, `setBoardOpen`, `boardRepos`) and `listen()` for events
  (`onState`, `onFocusSession`, `onShowNeedsYou`, `onShowInboxItem`, `onAutoOpen`,
  `onPtyData(id)` = `pty:data:<id>`, `onPtyExit(id)`, `onWorkflowDraft`, `onTicketsCreated`, `onNotesChanged`,
  `onGhLogin(login)`: open a gh-login tab for that account; `onOpenClaude(cwd)`: open a tab
  running `claude` in that folder, see "Whether Claude Code may work in that folder").
- Notes: `notesList`, `notesGet`, `notesSearch`, `notesSave`, `notesDelete` (`notes:*`, invoke) and the
  event `onNotesChanged` (`notes:changed`), all open to the web (`remote` / `event`). The store
  validates every argument; a save carries `base` and is refused as a conflict when the stored version
  differs; `notes:delete` asks with the native dialog unless `isRemote(e)` (the web asked with `webConfirm`).
- GitHub accounts: `accountFor(cwd)` (a new session's default account for a folder; remote-allowed),
  `ghUser(login)` and `configDetectAll(login?)` (Setup's per-account reads; `ghUser` is local only),
  `ghAccounts` in state. There is no `ghSwitch`: MasterDeck never runs `gh auth switch`.
- Create a GitHub board: `boardCreatePlan(account?)` (a read), `boardCreate({account?, title})`, `boardCreateRetry(account?)` and the event `onBoardCreateProgress` (`board:createProgress`, sent to the Mac's window only). All four are `blocked` in `DECK_ACCESS`, and the handlers refuse a remote caller as well: the confirmation is main's native dialog, and the usual fix (the `project` scope) needs a terminal on the Mac.
- Assign popup: `assignableUsers(repo)` (`issue:assignable`, invoke, `remote` in `DECK_ACCESS`: a read, the repository is checked in `AssignableUsers.get`).
- Description and sub-issues of a ticket (Assign popup, Start dialog): `issueBody(ticket)` (`issue:body`) and `issueSubIssues(ticket)` (`issue:subIssues`), both invokes, `remote` in `DECK_ACCESS` (reads), routed `forCard`. `GitHub.subIssues` reads `repos/<repo>/issues/<n>/sub_issues?per_page=100` (GitHub allows 100 sub-issues per issue, so one page), cached 5 minutes, flattened by `SUB_ISSUES_JQ` and parsed by `parseSubIssues` (`shared/subIssues.ts`; a sub-issue in another repository keeps its owner/name, a URL that is not github.com is dropped). The same read keeps each sub-issue's `body` (cut in jq at `SUB_BODY_MAX`, 10 000 characters, `bodyCut` when cut; then `fitSubIssues` empties the longest descriptions, marked cut, until the answer's JSON is under `SUB_ANSWER_MAX`, 900 000 bytes, since the web bridge drops a larger answer whole), `assignees` (logins, an app's as `name[bot]`) and `labels` (name, six-hex colour or null); a malformed field is emptied, never the row (#112). A row opens in place to `SubIssueDetail` (`SubIssues.tsx`: status, assignees, labels, the body in `MarkdownView`, Open on GitHub), from `SubIssueList` in the popups and `SubIssueItem` in Details → GitHub (`GitHubDetails.tsx`); in the popups the list is the one scroll box, in Details the description scrolls in its own (32vh); which are open is component state (`useOpenSubs`), never kept. `SubIssues.tsx` reads them when the popup opens and gives each its column from `state.board` (or the repository view) by `ticketKey`, else Open / Closed (`subIssueRows`); "done" is closed, as GitHub counts it (`subIssueProgress`). Nothing about sub-issues enters `AppState`.
- Workflow loops: `workflowLoopHistory(sid, loopId)` (`workflow:loopHistory`: every round and the
  last 64 KB of the progress file), `workflowLoopStop` (`workflow:loopStop`) and `workflowLoopMore`
  (`workflow:loopMore`), invokes, `remote` in `DECK_ACCESS`. `LoopStore` checks the session id
  (`validSessionId`) and the loop id (`^[a-z0-9-]{1,24}$`) and refuses a stop of a loop that is not
  open and more for one not at a limit; the web cannot type anything: the nudge is MasterDeck's text.
- Repository view: `boardRepos(repos)` (`board:repos`, fire-and-forget, `remote` in `DECK_ACCESS`: it is a read, and main checks the list with `cleanRepos`).
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

### Meetings: the permission gate (issue #102)

- Channels: `meetingsSetup()` (`meetings:setup`), `meetingsConsent(agree)` (`meetings:consent`),
  `meetingsPermission('mic' | 'screen')` (`meetings:permission`), invokes, all `blocked` in
  `DECK_ACCESS`. Each answers a `MeetingsAnswer` (`shared/meetings.ts`): `MeetingsSetupInfo`
  (`mac`, `agreed`, `mic`, `screen`, `systemAudio` path, `model`, `settings`, `message?`) or
  `{ ok: false, message }`. `MeetingsIpc` (`main/meetingsIpc.ts`, registered in `index.ts`) refuses
  any OS but macOS ("Meetings work on macOS only.") and `isRemote(e)`, and refuses a permission
  without consent before loading anything.
- `main/meetings/gate.ts` (`MeetingsGate`) asks macOS for the grants and opens the privacy
  panes (the recorder only reads the microphone's grant before a start). `MeetingsIpc.loadGate()` loads it with a dynamic `import()` the first time
  Settings → Meetings asks for its state or after consent; nothing else imports `main/meetings/`
  (`main/meetingsStartup.test.ts` checks it, and that no other main file names a media API).
  `setup()` only reads (`getMediaAccessStatus`). `permission('mic')` calls `askForMediaAccess`, or
  opens `Privacy_Microphone` once refused. `permission('screen')`: on macOS 14.2+ (Core Audio tap,
  System Audio Recording Only, which no API reads) runs `probeSystemAudio`, the recorder's 1-second
  capture (`Recorder.probe`, wired by `MeetingsIpc.loadRecorder`, which `permission('screen')`
  loads first), and stores `{ at, ok }` in `settings.meetings.systemAudio`; with no probe it opens
  `Privacy_AudioCapture` and the status stays `not-checked`. On 13 to 14.1 it is
  `getMediaAccessStatus('screen')` (`Privacy_ScreenCapture`).
- `Settings.meetings` (`MeetingsSettings`: `consentAt`, `consentVersion`, `model`, `language`,
  `offer`, `deleteAudioAfterDays`, `systemAudio`), `normalizeMeetings` (older files read with
  `DEFAULT_MEETINGS`), `meetingsAgreed` (`consentVersion === MEETINGS_CONSENT_VERSION`).
  `setSettings` goes through `keepMeetings`: the window cannot change the consent or the sound check
  (only `meetings:*` can), a browser changes no meetings setting.
- `electron-builder.yml` `mac.extendInfo`: `NSMicrophoneUsageDescription`,
  `NSAudioCaptureUsageDescription`. UI: `MeetingsSetup.tsx` in `SettingsView` (darwin only).

### Meetings: speech engine and models (issue #102)

- `shared/meetingModels.ts`: `MODELS` (Best `large-v3-turbo-q5_0`, Fast `base`: `id` (what
  `settings.meetings.model` keeps), `file`, `bytes`, `sha256`, `url`), `modelById`,
  `defaultModel(arch)` (arm64 Best, else Fast), `ModelsInfo` / `ModelProgress`.
- `main/meetings/models.ts` (`ModelStore(dir)`, dir `MASTERDECK_HOME/meetings/models`):
  `path(id)`, `ready(id)` (the file has the expected size), `status()`, `download(id, onProgress)`
  (refused while one runs; free space checked; streamed to `<file>.part` with a running SHA-256,
  cut off past the expected size, then size and hash checked and renamed; progress at most every
  250 ms plus a last `done` / `failed` / `cancelled`), `cancel()`, `remove(id)`. It only touches
  the files `MODELS` names and their `.part`.
- `main/meetings/whisper.ts`: `findWhisper(where)` (`MASTERDECK_WHISPER`, the bundled
  `whisper/<arch>/whisper-cli`, PATH), `transcribe({ bin, wav, model, language })` →
  `Segment[]` (`{ start, end, text }`, ms) via `-oj -of <tmp>` under `nice`, threads
  `whisperThreads()` = cores − 2 (at least 1), a timeout that kills its process group,
  `parseWhisperJson`. Building the binary: OPERATIONS § Meetings: speech engine and models.
- Channels: `meetingsModel(op, id?)` (`meetings:model`; `status`, `pick`, `download`, `cancel`,
  `remove`) answers `ModelsAnswer`; `pick` and `download` need the consent and store
  `settings.meetings.model` through `MeetingsIpc` (`setMeetings`), and `download` runs in the
  background (Turn off meetings cancels it and puts back the pick from before it), its progress sent to the window only (`meetings:modelProgress`, not `emit`).
  `meetingsRestart()` (`meetings:restart`): a native confirmation (while recording, the recording's
  question instead, with **Stop recording and restart**), then `app.relaunch()` + `app.quit()`
  (quit, so `will-quit` still cleans up; relaunch only once nothing can refuse the quit). Closing
  the window, quitting and Restart share one pending recording question (`oneAtATime` in
  `shared/meetings.ts`). All `blocked`. `MeetingsIpc.loadEngine()`
  loads `models.ts` and `whisper.ts` dynamically, like the gate; `setup()` fills `model.ready` from
  the store once a model is picked.

### Meetings: recording (issue #102)

- Channels: `meetingsStart(title?)` (`meetings:start`), `meetingsStop()` (`meetings:stop`),
  `meetingsPause(paused)` (`meetings:pause`), invokes, `blocked` in `DECK_ACCESS`, answering a
  `RecordAnswer` (`{ ok: true, live, id?, message? }` or `{ ok: false, message }`). `MeetingsIpc`
  refuses another OS, `isRemote(e)` and no consent before loading anything; `loadRecorder()` loads
  `main/meetings/recorder.ts` and `store.ts` dynamically (once, at the first Record or the first
  Allow of the Mac's sound) and sets the gate's `probeSystemAudio`. Recording with no speech model
  on disk is allowed; the answer's `message` says the transcript waits.
- `main/meetings/recorder.ts` (`Recorder`): one recording or one probe at a time. `start(title?)`
  refuses without consent or the microphone's grant (`getMediaAccessStatus`, never a prompt),
  makes the meeting (`MeetingStore.create`, state `recording`), opens the capture window and starts
  it with `executeJavaScript('window.mdCapture.record(id)', true)` (a user gesture, which
  `getDisplayMedia` wants). `pause(bool)` / `stop()` send `mdCapture.command(...)` once the page was
  started; a pause or Stop pressed while it loads goes in front of the start script instead, and the
  page keeps it (`CaptureControl` in `shared/meetingAudio.ts`) until its streams open, so a track
  starts paused or the page ends at once. **Turn off meetings** during a recording stops it first
  (`stop('consent')`), then clears the consent and drops the service (`dropService`): the queue and
  the matcher stop, a running whisper-cli (`killRunning`) and `claude -p` (its `AbortSignal`) are
  killed, and `svc` / `service` go, so nothing is transcribed or sent to Claude after it. What they
  left on disk (chunks, a meeting `matching`) is taken by the next service, loaded at the next
  consent; a service still loading then is stopped, not kept. The recorder stays loaded (its IPC
  listeners are registered once) and hands chunks to the service of now (`this.svc`). Stop waits up to
  10 s for the window's `ended`, then the meeting gets `ended`, `pausedMs` and state `transcribing`
  (or `failed` with "Nothing was recorded." when no chunk came). Past `MEETING_MAX_MS` (4 h, checked
  every 10 s) it stops with a notice. A window that ends by itself (`mic-refused`, `mic-ended`, a
  crash, `render-process-gone`) finishes the meeting with a reason in `error` and a notice; what was
  written stays. `probe()`: a capture window in probe mode, true when its `ended` is `probe` and the
  loudest `level` was above `PROBE_SILENCE` (60 s wait for macOS's prompt); during a recording,
  whether the others' track has come through. `live()` is `AppState.meetingLive`.
  `setMicGate(on)` (the mic follows the meeting app's mute, Plan M) sends `gate` / `ungate` the
  same way as a pause: to a started page, else in front of the start script (`CaptureControl.gated`
  holds it until the streams open, so a recording that starts muted never keeps a frame of the
  mic). The recorder keeps the last value (`micGated`) for the recording now and for one that starts
  later; a value equal to the last sends nothing; it is sent while stopping too (the last chunk is
  still to come). Who calls it decides when: the mute watch (§ Meetings: the mic follows the mute).
- It sets `setDisplayMediaRequestHandler` on `session.fromPartition('meetings-capture')`
  (`useSystemPicker: false`): it answers `{ video: request.frame, audio: 'loopback' }` only for the
  capture window's own main frame (compared by `processId` / `routingId`) while the consent holds,
  else `{}`. The capture page stops the video track at once.
- The capture window: a hidden `BrowserWindow` (`show: false`, partition `meetings-capture`,
  `contextIsolation`, `sandbox`, no node, `backgroundThrottling: false`, autoplay without a gesture,
  no navigation, no new windows), page `renderer/capture.html` + `renderer/src/capture.ts` (a second
  renderer entry in `electron.vite.config.ts`), preload `preload/capture.ts` (a second preload entry:
  `window.capture.chunk / audio / level / ended`, `ipcRenderer.send` only; it imports nothing but
  `electron` and types, its channels written out, since the two preload inputs share chunks and a
  sandboxed preload can require no chunk: `preload/capture.test.ts`). The page opens the
  microphone (`getUserMedia`, echo cancellation) and the Mac's sound (`getDisplayMedia`, asked
  first, both at once: it needs the user activation), an `AudioContext` at 16 kHz and one
  `AudioWorklet` per track (`renderer/src/pcmWorklet.ts`, loaded with `?worker&url` as a module in
  dev and build: `worker.format: 'es'`; mono blocks of 2048 frames; `pause` posts what it buffered
  and drops the input until `resume`, `flush` at Stop); `shared/meetingAudio.ts`
  (`Resampler` if the context is not 16 kHz, `toInt16`, `Chunker`, `wav`) cuts 30-second WAVs
  (`CHUNK_MS`; a chunk's offset is `seq × CHUNK_MS`). A `MediaRecorder` on both tracks mixed
  (`audio/webm;codecs=opus`, 32 kbit/s, 10-second slices) sends the playback copy. Levels go out
  every 500 ms (-1: no track). Pause pauses the worklets and the `MediaRecorder`, so the chunks and
  the audio leave the paused time out alike (Stop while paused sends nothing recorded since).
  The mic gate: the "you" worklet takes `gate` / `ungate` (and `processorOptions.gated` for the start
  state) and while gated writes zeros for its frames, so the "you" track keeps its timeline next to
  the others' one; the mic reaches the playback mix through a `GainNode` that is 0 while gated. It
  applies from the next audio block; nothing from the gated time is kept or pre-rolled. A pause
  holds over a gate (a paused worklet drops its frames either way).
- Messages from the capture window (`CAPTURE_CH` in `shared/meetings.ts`, `ipcMain.on`, never on
  `DeckApi`): each is dropped unless its sender is the capture window's own main frame. `meetings:chunk`
  `({ id, track, seq }, bytes)`: the recording's id, `you` or `others`, a sequence number above the
  last written for that track, and `checkWav` (exactly a 16 kHz mono 16-bit WAV, at most
  `CHUNK_MAX_BYTES` 1 MB); a failed write stops the recording with the reason. `meetings:audio`
  `(id, bytes)`: at most 1 MB, appended (a failed append loses the playback copy from there; the
  chunks go on). `meetings:level` `('others', rms)`. `meetings:ended` (one of `CAPTURE_ENDS`).
- `main/meetings/store.ts` (`MeetingStore(dir)`, `MASTERDECK_HOME/meetings`): `get`, `list(from,
  to)` (newest first; files that are not `m-<32 hex>.json` meetings skipped), `create`, `update(id,
  fn)` (re-checked with `storedMeeting`, temp file + rename; never over a file that is not a
  meeting), `chunkPath(id, track, seq)` (null unless `MEETING_ID`, a track and `0..CHUNK_SEQ_MAX`),
  `writeChunk` (temp + rename, never over an existing chunk), `audioPath`, `appendAudio` (capped at
  `AUDIO_MAX_BYTES`), `leftovers()` (the chunks still on disk, by meeting, sequence, you first),
  `removeChunk`, `sizes()` (audio, transcript, chunks per meeting, for Janitor), `deleteAudio`,
  `delete` (only the files it knows by name; a folder it does not empty stays). Disk errors are
  said without a path.
- `shared/meetings.ts`: `Meeting` (spec §8: `title`, `titleBy` `user` / `claude` / null, `started`,
  `ended`, `pausedMs`, `apps`, `state` (`recording`, `transcribing`, `matching`, `done`, `failed`),
  `model`, `language`, `segments`, `summary`, `matches`, `progress`, `error`), `Segment` (`{ start, end, speaker:
  'you' | 'others', text }`, ms), `storedMeeting(raw, id)`, `mergeSegments(you, others)` (by start,
  overlaps kept, you first on a tie), `cleanTitle`, the limits, `MeetingLive`, `recordedMs`,
  `recordClock`, `MEETING_LANGUAGES` (Settings → Meetings' Language).
- `index.ts`: `state.meetingLive = meetings.live()` in the state callback; the recorder's changes
  call `sources.changed()`. Quitting (`before-quit`) or closing the window while recording asks
  first with a native dialog (Keep recording / Stop recording and quit), then `stopForQuit()` writes
  the last chunks. `activate` checks `win`, not `getAllWindows()` (the capture window is one).
  Notices are macOS notifications.
- UI: `RecordMeeting.tsx` in `Rail.tsx` (after the tools; macOS and the window only, `canRecord`);
  ⌘K **Record meeting** (`record-meeting`, hidden on the web) opens its popout, or Settings →
  Meetings before consent.

### Meetings: transcription (issue #102)

- `main/meetings/transcriber.ts` (`Transcriber`): the queue, one `whisper-cli` at a time, first in
  first out. The recorder's `onChunk` calls `add({ id, track, seq })` for each chunk on disk, and its
  `onEnded` calls `ended(id)`. A run takes the meeting's own model if it is on disk, else the one
  picked now (`modelPath`), and the meeting's language; `chunkSegments` adds the offset `seq ×
  CHUNK_MS` and the track as speaker (control characters become spaces, empty lines go). The lines
  are written with `store.update` (a chunk's earlier lines are replaced, so a run again never
  doubles them; at most `MEETING_SEGMENTS_MAX`), then the WAV is removed. Once the meeting is no
  longer the one recording and none of its chunks wait (a chunk on disk the queue never heard of is
  queued first), its lines are merged by time (`mergeSegments`) and it becomes `matching` and goes
  to `onTranscribed(id)` (the matcher, below), or `done` when none is set.
- A chunk with nothing to hear is not given to whisper (which makes up lines such as "Thank you."
  from silence): `silentChunk` (`shared/meetingAudio.ts`) on its WAV, read before the run. A "you"
  chunk is silent below `SILENT_RMS` (1e-4 of full scale, -80 dBFS: under any real microphone's
  noise floor, so it catches the mic gate's zeros and digital silence); an "others" chunk only when
  every sample is zero (the Mac's sound can be faint and real). It gets no lines, its WAV is
  removed and it counts as done. A partly gated chunk is transcribed as it is (zeros are silence).
- `Meeting.progress` (`MeetingProgress`: `done`, `total`, `wait`; null before the first chunk and in
  older files) is what the Meetings page shows: chunks done, chunks known (grows while recording),
  and why it waits. With no model on disk the head of the queue waits, the meeting stays
  `transcribing` with `wait` "Waiting for the speech model", and `modelReady()` (a finished
  download, or picking a model already on disk) starts it again.
- A failure (whisper-cli's error, the engine missing, a write refused) keeps the chunk, drops the
  meeting's other queued chunks (they stay on disk) and sets `failed` with the reason in `error`
  (one line, the home folder as `~`). `meetingsRetry(id)` (`meetings:retry`, `blocked`; refused off
  macOS, from a browser, for an id that is not `MEETING_ID` and before consent) → `retry(id)`:
  only a `failed` meeting not being recorded, with chunks on disk or lines already; it is
  `transcribing` again and its chunks are queued.
- `MeetingsIpc.loadService()` loads `store.ts` and `transcriber.ts` dynamically, once, after
  consent: the first Record (`loadRecorder` waits for it, and the recorder uses its store), Settings
  → Meetings (`setup`, `consent(true)`), Try again, and `background()` when the app is ready (so
  what a quit or a crash left is transcribed at the next start without opening Meetings; it loads
  no gate and asks macOS nothing). Loading runs `start()`: a meeting left
  `recording` with no live recorder (a crash, a forced quit) gets an `ended` from what was saved and
  becomes `transcribing` (or `failed`, "Nothing was recorded.", with no chunk and no line); the
  chunks left on disk are queued first, oldest meeting first; a meeting left `matching` goes to the
  matcher again. `loadEngine()` passes `deps.fetch` (`index.ts`: Electron's `net.fetch`) to
  `ModelStore` and runs `cleanParts()`; a download is refused before the pick is stored when one is
  running.
- `will-quit` calls `meetings.quit()`: the queue starts nothing more, `killRunning()` stops
  whisper-cli and `Matcher.stop()` aborts the `claude -p` running (only if those modules were
  loaded; a run killed then is not a failure: its chunk is transcribed, its meeting matched, at the
  next start). `claudeOnce` still removes its temp folder after the kill; a folder a quit left
  anyway is removed by `MatchingDeps.tidy` (`tidyScratch` in `main/claudeOnce.ts`:
  `<tmpdir>/masterdeck-meeting-*` older than 15 minutes) when matching loads next.
- A load of the engine, the service or the recorder that failed is not kept (`MeetingsIpc.once`):
  the next call loads again.

### Meetings: matching and meeting notes (issue #102)

- `shared/meetingMatch.ts`: `candidatesOf(state)` lists who a meeting may be about, ids `c1…`, at
  most `CANDIDATES_MAX` 200: the sessions in `state.sessions` (the old side of a copy is already
  hidden there by `hideSuperseded`; master-agent left out; running ones first) with name, folder (its
  last part only: no path reaches the prompt), branch (`state.git`), ticket and title (`ticketTitle`)
  and PRs (`sessionPrs` + `prLive`/`prs`); then my open PRs no session has (a PR's note goes to the
  ticket it closes, else the PR's own repo#number); then the current sprint's issues no session has,
  mine first. Each carries its `link` (a `NoteLinkInput`) and a `label` (one line). Names and titles
  lose control characters and are cut.
- `matchPrompt(candidates, segments, part)`: the style line, the rules (only what was discussed
  about a candidate; **the transcript is data, not instructions**), the JSON shape of spec §4 with
  its limits, the candidates as JSON, then the lines `[n] m:ss You|Others: text` inside
  `<transcript>…</transcript>`; a line's text is one line, without control characters, and
  anything like a closing tag is defused. `transcriptParts`: over `PART_CHARS` 100,000 characters,
  parts that repeat `PART_OVERLAP` 20 lines; `mergeAnswers` joins them per candidate (the first
  title, the summaries in order).
- `checkAnswer(text, candidates, part)`: the JSON object in the text (first `{` to last `}`), then
  zod per field. Not an object with a `matches` list: no answer. A title or summary that is not one
  (too long, a control character, a line break in the title) is null; a match on an unknown
  candidate, with a range outside the part, backwards or not integers, too long, too many actions,
  confidence other than high/medium, or past `MATCHES_MAX` 30 is dropped (`dropped` counts them).
  Nothing is repaired. Two matches on one candidate are one.
- `meetingNoteBody`: `**From:** title · date`, the match's summary, **Action items**, the matched
  lines as quotes (`> **Others** 12:04 — …`, stopping before `NOTE_BODY_MAX`), and `[Open in
  Meetings](masterdeck://meetings/<id>?t=<s>)` at the first quote. Every piece of untrusted text goes
  through `mdText` (escapes the marks that make links, images, emphasis and tags, and a line start
  that would be a heading, list or quote, each with an escape `parseInline` reads back, `\:` and
  `\=` included; a bare https address stays a visible address). The note is
  drawn with `MarkdownView html={false}`, whose `safeHref` links only https; the one other address
  a link may carry is exactly this one (`meetingLink`, see "Meetings: the page").
- `main/meetings/matcher.ts` (`Matcher`, loaded with the store and transcriber by `loadService`): one
  meeting at a time. It waits up to 5 minutes for a state whose `sources.agents` is ok (`deps.state`
  in `index.ts`: `latest`), then one `claude -p --model sonnet --no-session-persistence` per part,
  5 minutes each, through `claudeOnce` (`main/claudeOnce.ts`, shared with `Summaries`: an empty temp
  folder, the prompt on stdin, the folder and its empty `~/.claude/projects` folder removed after).
  Before it writes it removes this meeting's unedited notes (`dropMeetingNotes(id, true)`: a run a
  quit cut short, or Match again) and stops if one could not be removed; a candidate with an edited
  note from this meeting keeps it and gets no second. Then `addMeetingNote` per match (link, the
  meeting with its title), and the meeting gets the title (unless `titleBy` is `user`), the
  summary, `matches` (`label`, `noteId`, line indexes) and `done`. A run that fails (exit code, the
  timeout, no text, no valid JSON) leaves it `failed` with an error starting `MATCH_FAILED` ("Could
  not match: ") and nothing written. Nothing said: `done` without asking. `addMeetingNote` strips
  control characters from the title and body and cuts the title at `NOTE_TITLE_MAX` (machine-made
  text), and `asNoteMeeting` needs `at > 0`. A run that worked clears the meeting's `unmatched`
  item (`clearNotice`), with or without notes. Before it drops any note it checks again that the
  meeting is there and still `matching`, and a meeting deleted while queued or matched
  (`Matcher.forget`, from `MeetingsIpc.dropMeeting`) gets nothing written: the notes it added stay.
- `meetingsRematch(id)` (`meetings:rematch`, `blocked`; refused off macOS, from a browser, for a bad
  id, before consent) → `Matcher.rematch`: a `done` meeting or one whose matching failed; it drops the
  unedited notes first (refused when one could not be removed), sets `matching` and matches.
- Needs you, kind `meeting` (`meetingItem` in `shared/inbox.ts`): from `MeetingNotice`s that
  `main/meetingNotices.ts` keeps in `MASTERDECK_HOME/meeting-notices.json` (one per meeting, atomic,
  30 days; outside `main/meetings/` because `Sources.build()` reads it through `setMeetingNotices`).
  The matcher sets `added` (counts of session and ticket notes) or `unmatched` (the reason);
  `MeetingsIpc` sets `failed` from the transcriber's `onChange` for a transcription failure and
  clears it once the meeting goes on; Try again clears `failed` and `unmatched`. Actions: `open` (`meetings.seen`: the item resolves; the
  window opens the meeting), `rematch`, `retry`, all through `runInboxAction`, refused for a remote
  client there and for a browser in `inboxActCall`. Off the backend: `toRemoteSnapshot` leaves the
  kind out. A web tab shows the card with Dismiss only.

### Meetings: the page (issue #102)

- Channels (all `blocked` in `DECK_ACCESS`; `MeetingsIpc` refuses any OS but macOS and
  `isRemote(e)`): `meetingsList(from, to)` (`meetings:list`: the meetings that started in
  `[from, to)`, newest first, at most 500, as `MeetingRow`s without transcripts, plus `agreed`),
  `meetingsGet(id)` (`meetings:get`: the whole `Meeting` and whether `audio.webm` is there; it also
  calls `seen(id)`, so opening a meeting resolves its "notes added" item), `meetingsRename(id,
  title)` (`cleanTitle`, `titleBy: 'user'`), `meetingsDelete(id)` and `meetingsDeleteAudio(id)`
  (a native question in main, `deps.confirm`; refused while that meeting is recorded; delete calls
  `transcriber.forget(id)` before `MeetingStore.delete` and clears its Needs-you item; the notes it
  added stay), `meetingsExport(id, 'md' | 'audio')` (a save dialog, `deps.saveFile`; the Markdown is
  `meetingMarkdown`, the audio a copy; written as a temp file next to the pick, then renamed), and
  the event `onMeetingsChanged` (`meetings:changed`, `{ id | null }`, to the window only: the
  transcriber's and matcher's `onChange`, the recorder's (null), rename, delete). Every id goes
  through `MEETING_ID` before the store.
- The page's store (`MeetingsIpc.pageStore`): with the consent, the service's (`loadService`, so
  what a quit or a crash left is transcribed when the page opens, as the quit dialog promises).
  Without it (never agreed, or after Turn off meetings) a bare `MeetingStore`: stored meetings are
  listed, read, exported and deleted, nothing is queued, transcribed or recorded. Match again and
  Try again still need the consent.
- Audio: `masterdeck-media://meeting/<id>/audio` (`MEDIA_SCHEME`, `meetingAudioUrl` in
  `shared/meetingsPage.ts`). `protocol.registerSchemesAsPrivileged` (standard, secure, stream,
  supportFetchAPI) at the top of `main/index.ts`, before ready; `session.defaultSession.protocol.handle`
  in `whenReady`, so only the window's session has it (the capture partition and the web bridge
  never do). `serveMeetingAudio` (`main/meetingMedia.ts`): GET or HEAD, the URL exactly that shape
  (`audioId`), the path from `MeetingsIpc.audioFile` (macOS, a meeting the store holds, its folder a
  real directory and `audio.webm` a regular file, never a link), else 404; `Range` (`parseRange`:
  `a-`, `a-b`, `-n`) answers 206 with `Content-Range`, one that cannot be met 416 (`bytes */size`),
  several ranges the whole file; always `Accept-Ranges: bytes`. The file is opened once
  (`O_NOFOLLOW`), checked with `fstat` (a regular file) and streamed from that descriptor, so
  nothing can swap it between the check and the read. `audioFile` keeps the path it found for a
  meeting 10 s (`AUDIO_CACHE_MS`; a delete forgets it), so a seek's Range requests do not read the
  meeting's JSON each time; the folder and file checks still run on every request. The window's CSP (`renderer/index.html`) has `media-src 'self' masterdeck-media:`.
- `shared/meetingsPage.ts`: `meetingRow`, `stateView` (Recording, Transcribing d/t, the wait,
  Matching, Done, Failed with `retry` or `rematch` by `MATCH_FAILED`), `meetingLengthMs` (paused
  time left out), `monthGrid` (six weeks from a Monday), `gridRange`, `markedDays`, `presetRange`
  (Today, This week from Monday, Last 30 days; all end at tonight's midnight), `customRange`,
  `lineAt` (the playing line: the last that started at or before the time), `searchLines`,
  `highlightParts`, `stepHit`, `lineMatches` (chips per line), `meetingMarkdown`, `exportName`
  (letters, digits, spaces, `_` and `-` only).
- `renderer/.../MeetingsView.tsx` (view `meetings`, `App.tsx`; rail icon between Notes and Workflow
  and ⌘K **Go to Meetings**, both only when `meetingsHere()` in `renderer/src/meetingLinks.ts`: macOS,
  not the web; not in `WEB_VIEWS`, `SCREEN_NEEDS.meetings` is `meetingsList`). One list call over
  the range and the month grid together, each cut from it (both read on their own only when the
  answer is at the list's 500; all of history only when it is empty, for the empty page), again on
  `meetings:changed`, which is gathered for 250 ms (a burst of chunk updates is one read); the
  open meeting re-reads when its id is among them. The transcript (up to 20,000 lines) is a memo'd
  `Lines` of memo'd `Line`s: a time update re-renders only the line that stops and the one that
  starts playing, and typing a search only the lines it marks. A line is focusable (Enter plays
  from it); Space plays and pauses unless focus is in a field or on a button; following the playing
  line stops at any scroll the page did not make itself. The player is an `<audio>`
  on the scheme; a recorder's WebM has no duration at first, so the seek bar uses the meeting's
  length until the element reports one.
- `masterdeck://meetings/<id>?t=<s>` links: `meetingLink` (`shared/markdown.ts`) accepts exactly
  that shape (an id matching `m-<32 hex>`, `t` up to six digits), and `parseInline` makes it a link in
  a `[text](…)` only (a bare one stays text), and only with `html: false` (a note; in an issue's
  body it shows the words only); `safeHref` stays https only. `MarkdownView`'s `Link`
  turns it into an in-app link in the window (`openMeetingAt` → the opener `App.tsx` sets:
  Meetings view, that meeting and time, the Notes panel closed) and plain text on the web. Needs
  you's **Open** (`MeetingCard` → `onOpenMeeting`) opens the same way.
- Test aid: `MASTERDECK_MEETINGS_FIXTURE=<dir>` with `MASTERDECK_ISOLATED=1` and `MASTERDECK_HOME` set
  (`main/meetingsFixture.ts`, run in `index.ts` before the notes are read): copies `meeting.json`,
  `audio.webm` and `notes/*.json` into `MASTERDECK_HOME`, each checked as its store reads it, never
  over a file that is there. OPERATIONS § Meetings: the fixture.

### Meetings: Janitor and Delete audio after (issue #102)

- `shared/meetingJanitor.ts`: `JanitorMeetingRow` (`id`, `title`, `started`, `audioBytes`,
  `transcriptBytes`, `recording`), `janitorRows(store.sizes(), recordingId)`, `pickOlder(rows, days,
  now)` (started more than `days` ago, never the one recording), `janitorTotals(rows, ids?)`,
  `needsTypedCount(n)` (over `TYPED_CONFIRM_OVER` 10), `cleanRequest(raw)` (`{ ids, what: 'audio' |
  'meetings' }`, every id `MEETING_ID`, at most `CLEAN_MAX`), `audioExpired(rows, days, now)` (the
  timer's pick: older, with audio; none for `null`), `sizeLabel`.
- `meetingsJanitor()` (`meetings:janitor`) and `meetingsClean(req)` (`meetings:clean`), both
  `blocked`, refused from a browser and off macOS; they use `pageStore()`, so they work after Turn
  off meetings like the page. `clean` asks a native question first (`deps.confirm`; the renderer's
  `webConfirm` is a no-op in the window, and over 10 the Janitor has the count typed before it),
  skips the meeting being recorded and ones gone meanwhile, and removes through the page's own paths
  (`dropMeeting`: `transcriber.forget`, `store.delete`, the Needs-you item cleared; `dropAudio`).
  Notes stay.
- The **Delete audio after** timer: `MeetingsIpc.background()` (called once in `whenReady`, after
  `createWindow`; macOS only) sets timers only: `sweepAudio()` first `AUDIO_SWEEP_FIRST_MS` (5 min)
  after start, then every day (unref'd). `sweepAudio` does nothing for `deleteAudioAfterDays: null`;
  it uses the loaded service's store, else the bare store, and that only when the meetings folder
  exists (a Mac that never recorded loads nothing); it removes audio only (`dropAudio`), never a
  transcript, never the recording's. `quit()` clears the timers.
- UI: `JanitorMeetings` in `HygieneViews.tsx` (under Parked sessions, when `meetingsHere()`):
  totals, **Older than 7 / 30 / 90 days**, a checkbox per row, **Delete audio** / **Delete
  meetings**, the typed count over 10; it reloads on `meetings:changed`.

### Meetings: the offer (issue #102)

- `shared/meetingApps.ts`: `MEETING_APPS` (a `ponytail:` list: Zoom by `CptHost` / `aomhost`
  inside `zoom.us.app`, Webex by `Meeting Center` under a Webex folder; Teams and Slack have no
  call-only process and are left out; the upgrade is Core Audio's "device running somewhere"),
  `callApps(psOut)` (the executable's own name and its app's path, each app once), `offerText`,
  `OFFER_POLL_MS` 10 s.
- `main/meetings/apps.ts`: `psComm()` (one `execFile('/bin/ps', ['-axo', 'comm'])`, 5 s timeout)
  and `OfferWatch` (`tick`, `dismiss`, `start`, `stop`, `offered`): a look only while `allowed()`
  (macOS, consent, `settings.meetings.offer`) and not `recording()`, and none after `stop()` (a
  `stopped` flag checked after the ps); an app in a call now that is not in `inCall` is a new call,
  offered once. `inCall` holds the offered apps with a miss count: a call ends only after
  `MISSES_TO_END` (3) looks without it, so a helper restart or a breakout move is not offered again.
  One chip at a time: an app found while another's chip shows is not added to `inCall`, so it is
  offered once that chip goes, if its call still runs. `inCall` is kept while not looking, so a call
  is not new after a recording; the chip goes when its call ends.
- `MeetingsIpc`: `startOffers()` loads `apps.ts` (dynamic import, `deps.loadApps`) only on macOS
  with the consent: from `background()` `OFFER_POLL_MS` after start, and from `consent(true)`; the
  watch starts only if the consent still holds once the module loaded; `consent(false)` and `quit()`
  call `stopOffers()`. `live().offer` is the offered app (null while
  recording). `start()` (the chip's Record, the popout's) notes the offered app in the meeting's
  `apps` and dismisses the chip; `notNow(e)` (`meetings:notNow`, `blocked`) dismisses it.
  `deps.offer(app)` (`index.ts`) dispatches a `meeting` notification (Settings → Notifications)
  whose click shows the window and sends `meetings:showRecord`
  (event, `blocked`): `App.tsx` opens the Record popout. Web tabs never learn the call app: the
  state the bridge sends (`emit`'s state event and a remote `getState`) goes through `webState`
  (`shared/meetings.ts`), which sets `meetingLive.offer` to null.
- UI: `RecordMeeting.tsx` draws the chip (`.rec-offer`) when `live.offer` is set and the popout is
  closed: the words, **Record** (`meetingsStart()`), **Not now** (`meetingsNotNow()`), "Tell the
  others you are recording."

### Meetings: the mute reader `md-mute` (issue #102, Plan M)

So a recording can leave the microphone out while you are muted in the meeting app (macOS has no
API for another app's mute), a small Swift helper reads the app's own Mute / Unmute control
through Accessibility. `MuteWatch` (below) runs it while a recording runs.

- `native/mute/main.swift`, built by `scripts/mute.sh` into `resources/mute/<arch>/md-mute`
  (OPERATIONS § Meetings: md-mute). One line of JSON rules on stdin, then every 400 ms one line
  `{"t":<ms>,"trusted":bool,"apps":[{"id","state",…}]}` (`muted` / `unmuted` / `unknown`, only apps
  with a running process, found by bundle id with `NSWorkspace`). Each app also carries
  diagnostics (additive; `parseMuteLine` accepts lines with or without them): `why` (`found`,
  `not-trusted`, `no-control`: searched everything without a match, `cut`: hit the element or time
  budget, `error`: the app did not answer the windows / menu bar read, or a children / role read
  failed during the walk (other than an element gone: `invalidUIElement`) and nothing was found),
  `label` (the matched
  control's label only, at most 80 characters, anything outside printable ASCII as `?`; nothing
  else on screen ever leaves the helper), `searched` (elements visited this tick; 0 when the
  throttle skipped the search and the last search's `why` is repeated), `ms`, `cached` (re-read
  from the control found before). Not trusted: every app is `unknown` with `why: not-trusted`. It
  calls `AXIsProcessTrusted()` only (never the prompting variant: the app asks, after
  consent). A **menu rule** reads the titles of one menu bar menu's items; an **element rule** walks
  the app's windows breadth first and reads the rule's label attributes (`AXTitle`,
  `AXDescription`, `AXHelp`) only on controls of one of the rule's `roles` (`role`, one string, is
  the older form; the app sends both). A **web rule** (`web: true`, Google Meet) first walks down
  to the windows' `AXWebArea` elements without going into them (nor into `AXToolbar`, nor, in a
  Chromium process, `AXTabGroup`: the tab strip; Safari's pages sit inside one), keeping with
  `hosts` (Meet: `meet.google.com`) only pages whose `AXURL` host is one of them or below one (the
  URL is read for that alone and never leaves the helper), then searches from those, with a larger
  budget: depth 150, 40000 elements, 800 ms; still at most one failed search every 2 s per
  process. After it sets `AXManualAccessibility` (remembered only when the set returned success;
  otherwise asked again at the next search) on a
  Chromium process, a first search that finds nothing is tried again on the next tick without the
  2 s wait (once): Chromium may build the page's tree only after that. Several processes of one
  rule: the ones with a cached control first, the first that reads, else the most telling `why` (`cut`, then `error`, then
  `no-control`). Matching is a case-insensitive
  prefix; the longest matching prefix decides (muted on a tie); a prefix in the rule's `whole`
  (Teams' and Webex's bare "Mute" / "Unmute") matches only the whole label or the label followed
  by " (" (a shortcut), so "Mute Alice" is nothing; and a control any of whose labels
  starts with one of the rule's `exclude` prefixes ("Mute all", "Mute everyone", "Turn off
  microphone for everyone", …) is never the user's (`classify` / `classifyControl`, mirrored by
  `classifyLabel` / `classifyControl` in `shared/meetingMute.ts`, whose tests are theirs; prefixes
  stay ASCII, as Swift counts Characters and JS UTF-16 units). The control found is kept per
  process and only its labels are read again each tick; when it no longer reads, a full search
  runs in the same tick, and only failed searches in a row are held to one every 2 s per process
  (`unknown` in between). Caps per search: depth 60, 6000
  elements, 150 ms (past any: `unknown`, `why: cut`; a web rule's are larger, above); a 50 ms messaging timeout set once on the system-wide
  element (the default for every element; an app element's own would not reach its children);
  each tick in an `autoreleasepool`. For the Chromium bundles of a rule it was sent it sets
  `AXManualAccessibility` once per process (how screen readers get web content; it stays on until
  that browser quits). It presses nothing. It exits when stdin closes or its parent changes (`getppid()` each tick); bad rules: a
  line on stderr, exit 2.
- `shared/meetingMute.ts`: `MUTE_RULES` (Zoom: the **Meeting** menu, "Unmute audio" while muted,
  "Mute audio" while heard; Teams, Webex: buttons "Unmute…" / "Mute…"; Google Meet in Chrome, Arc,
  Edge, Brave, Safari: a web rule over `AXButton`, `AXCheckBox`, `AXToggleButton`, "Turn on
  microphone…" / "Turn off microphone…" (Meet's aria-label, with or without a shortcut such as
  " (⌘ + d)"), "…for everyone" excluded; all `ponytail:` guesses until checked on real calls, data
  so a fix is no rebuild), `muteRulesLine`, `parseMuteLine(line, known?)` (strict: any wrong field,
  an app twice, an id not in `known`, a muted/unmuted state while not trusted, a diagnostic of the
  wrong type, `why` other than `found` with a muted/unmuted state (or the other way round), a
  `label` without `found` or outside printable ASCII, or `not-running` is `null`), the check's
  `muteCheckApps` / `muteCheckWhy` / `muteCheckView` (below), `muteRuleId` (a rule from the offer's app name or an id),
  `pickApp(apps, preferred)` (the preferred app while listed, else the first read as
  muted/unmuted), `MuteSettle` (the first `muted` reading settles at once; leaving `muted` takes two
  `unmuted` readings in a row, or `MUTE_UNKNOWN_HOLD` (7, about 3 s) `unknown` ones, so a brief gap
  in the reading never lets the mic in; between `unmuted` and `unknown`, both of which keep the
  mic, at once; `switched()` when the followed app changes keeps a settled `muted` until the new
  app's readings leave it).
- `main/meetings/muteHelper.ts`: `findMute(where)` (`MASTERDECK_MUTE`, set but not runnable is
  none; then the bundled `mute/<arch>/md-mute`, or `app/resources/mute/<arch>/` in development; no
  PATH lookup) and `spawnMute(bin, rules?)` → `{ onLine, onExit, kill }` (lines split across chunks
  are joined, junk dropped, stderr kept for `onExit`; `kill` closes stdin and sends SIGTERM).

### Meetings: the mic follows the mute (Plan M)

- **Settings.** `settings.meetings.mic`: `'follow'` (default; settings from before have none and
  read as follow) or `'always'`, through `normalizeMeetings` / `keepMeetings` like the rest of
  Settings → Meetings. The `setSettings` handler calls `meetings.settingsChanged()`, so a change
  applies to a recording running now.
- **Accessibility** is the gate's (`main/meetings/gate.ts`): `permission('accessibility')` after
  consent only; the first press calls `systemPreferences.isTrustedAccessibilityClient(true)` (macOS's
  prompt, which points to System Settings), a later press while still not trusted opens
  `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`. `setup()` and the
  watch read it with `isTrustedAccessibilityClient(false)` (never prompts) via
  `accessibilityTrusted()`; `MeetingsSetupInfo.accessibility` is `granted`, `not-determined`, or
  `denied` once Allow was pressed in this run (macOS reports no refusal). `meetingsStartup.test.ts`
  bans the name outside `main/meetings/`.
- **`MuteWatch`** (`main/meetings/mute.ts`, loaded with the recorder by `import()`): `begin(app)`
  before every `Recorder.start` (the manual switch goes off, nothing of the last recording carries
  over, `setMicGate` is set explicitly, and md-mute is started then, so a first `muted` reading
  can gate before the capture page opens the mic; one not yet in leaves the mic ungated as
  before), then `sync({recording, paused})` after start, stop, pause, Turn off, a quit, a settings
  change, an Accessibility grant and every recorder `onChange` (a stop by itself; skipped while
  `Recorder.start` runs, so its own changes do not kill that md-mute). While the watch is
  `waiting` (following, recording, not paused, but no Accessibility or no md-mute), MeetingsIpc
  syncs again every 5 s: a grant made in System Settings during the call, or a helper that
  ended, takes effect without a pause (a helper is started again at most `MUTE_RESTARTS`, 3,
  times per recording: `ponytail:`, no backoff). md-mute runs only while recording, not paused, in follow mode and with Accessibility
  trusted (`findMute` through `deps.whisper()`'s paths); anything else kills it. It gets only the
  offered call app's rule when one is known (`muteRuleId`; MasterDeck then reads no other app and
  touches no browser), else every rule. Which app it follows: the offered one while listed, else
  the one followed now while it reads (or, settled muted, while it is listed at all), else
  `pickApp`'s first readable, else the first listed.
  The gate is `manualOff || (follow && settled === 'muted')`, sent on every change; a lost app
  or unknown, `trusted: false` and a helper that ended (all three after about 3 s when muted: while
  md-mute is down a timer feeds `unknown` every `MUTE_TICK_MS`, and a restart within it keeps the
  mute), a missing helper, 'always', stop and Turn off all come out ungated: the mic records as before. A pause kills md-mute but keeps the settled mute, so a resume while muted
  starts gated.
- **State.** `meetingLive.mic` (null while nothing records) = `{ mode, app, state, manualOff, kept,
  paused, reason }`: `app` the rule's name ("Zoom"), `paused` the recording is paused (the line says only "Mic: paused."), `kept` the mic goes into the recording now (not gated,
  not paused), `reason` why the state is unknown in follow mode (`not-trusted`: Accessibility not
  given or lost, as after an update of an ad-hoc signed build; `no-helper`: missing;
  `helper-ended`: ended, started again by the next sync; `no-app`; `unreadable`:
  an app found whose control did not read). `onChange` only when it changes. `webState` blanks
  `mic.app` with `offer`: web tabs never learn the call app.
- **The manual switch.** `meetings:micOff(on)` (`deck.meetingsMicOff`, `blocked` on the web;
  refused from a browser and off macOS; only while recording): Mic off in the recording, in either
  mode; the next recording starts with it off.
- **The Mic log.** `MuteWatch` calls `deps.log(entry)` on every change, while recording, of
  `{state, app, why?, reason?, gated, paused?}` (`state` and `why`: what md-mute read for the app
  followed, `unknown` with no `why` while it does not run; `reason`: `MicLive.reason`). MeetingsIpc
  keeps them with their wall-clock time from `start()` (before `begin()`) in a `MicLogKeep`
  (`shared/meetings.ts`): a change of `why` alone (state, app, reason, gate and pause as the last
  entry) is not kept, and of the rest the first and the last `MIC_LOG_KEEP` (250), counting the ones
  between. It writes them into the meeting as `micLog`, with `micLogDropped` when some fell out
  (`storedMeeting` reads it only beside a full log) (`t` = time − the
  meeting's `started`, at least 0) once Record gave the id, at most every 5 s while recording, and
  when the recording ends (`syncMute` sees it stopped: Stop, the 4-hour limit, a quit, Turn off).
  `storedMeeting` reads files without it, and leaves out (never refuses the meeting for) a log
  that does not read back. The Meetings page shows it as a closed **Mic log** under the meeting;
  `meetingMarkdown` adds a "Mic log" section (`micLogLines`: "n changes not kept" where they fell,
  and `MIC_LOG_CLOCK`: the times are wall clock since Record, `shared/meetingsPage.ts`).
- **Check mute reading.** `meetings:muteCheck` (`deck.meetingsMuteCheck`, `blocked` on the web;
  refused from a browser, off macOS, without consent, and while `Recorder.start` is starting the
  recording's md-mute; one check at a time, a second press shares it): `checkMute` in
  `main/meetings/mute.ts` (loaded by `import()`) runs md-mute with every rule for `MUTE_CHECK_MS`
  (3 s), whatever records (beside a recording's md-mute is fine), kills it, and answers `{found,
  trusted, gateTrusted, apps: [{id, name, state, why, label?, searched, ms}], message?}`:
  `muteCheckApps` takes each rule's last reading and the last real search's size and time, and
  `not-running` for a rule md-mute never listed; `gateTrusted` is the gate's
  `accessibilityTrusted()` (no prompt), so a grant that reaches MasterDeck but not md-mute shows
  (`MUTE_CHECK_SPLIT_GRANT`, only when md-mute sent a line with `trusted: false`, not when it failed
  or sent nothing).
  Settings → Meetings (`MuteCheck` in `MeetingsSetup.tsx`) draws `muteCheckView`'s notes and table.

### Working hours (issue #64)

The Costs view's **Hours** (`HoursView.tsx`, desktop only) estimates time per GitHub account, day
and ticket. `TokenIndex` (`main/tokens.ts`) keeps, next to each transcript file's tokens, its
activity `spans`: every line with a top-level `timestamp` (the line is parsed; a nested one never
counts) widens the last span when within `SPAN_GRAIN` (5 min) of it, else opens one (`addMoment`,
`shared/tokens.ts`). The cache is `tokens.json` version 3 (hours, #88); an older file is dropped
and every transcript read again once. `CH.hoursActivity(ids, since)` (the book's session ids; the view
re-asks every minute) answers `{spans, account}` for each session active since `since`:
`Sources.hoursActivity` gives the spans, key, folder and ticket, main's handler the account
(`hoursAccount`: recorded in `session-accounts.json` and still connected, else the account of the
folder's origin repository, else of the ticket's repository, else the only account; else `null`,
"unknown account"; never the primary as a guess). Origins come from `hoursOrigins`: the state's
`origins` when known, else `git remote` four at a time for folders that still exist, in a cache of
its own (`hoursRepos`) so past folders never evict live ones. `shared/hours.ts` `estimateHours` is
pure: a session's spans (grouped by key, account and ticket, so a resume's new id fills its gap)
joined across gaps up to the idle gap (at least `SPAN_GRAIN`), then a union per account and per
(account, ticket), cut at local midnight;
so an account counts a minute once and each ticket gets its full time. `hoursCsv` writes
`date,account,ticket,minutes`; `CH.hoursExport` saves it through a save dialog. Both channels are
`blocked` in `DECK_ACCESS` and refuse a remote call: nothing reaches `AppState`, the snapshot or
the web.

### The Costs time filter (issue #88)

`shared/timeline.ts` holds the presets (`PRESETS`, `RangeChoice`, `parseRange` for the saved value),
`resolveRange(choice, now)` to `[from, to)` epoch ms in local time (Last 7/30 days start at the
midnight 6/29 days back, as before), `rangeLabel`, the custom range's input values (`customRange`:
the To minute is included, an end before the start is an error) and `chartBars` (hours up to 48 h,
days up to 62 days, weeks from Monday, then months). The choice is in the renderer's localStorage
(`costsRange`), like `costsUnit`. Costs and tokens are kept per **local clock hour**, bucket key
`YYYY-MM-DDTHH` (`hourOf`): `Sources.scanAllStats` records the cost book under the hour
(`recordCosts`), `tallyLines` counts tokens under the message's hour, and `TokenIndex`'s cache is
version 3 (every transcript is read again once). Day keys (`YYYY-MM-DD`) stay valid: books from
before #88, and hours older than 35 days, which `pruneBook` folds into their day (max of the
cumulative cost) so the book in `AppState` stays small. `bucketShare(key, from, to, now)` is the one
rule for a range: the part of a bucket inside it by time, the running hour only up to `now`
(`spendIn`, `sessionSpendIn`, `tokensIn`); the day-string helpers (`dailySpend`,
`sessionSpendBetween`, `tokensBetween`) read hour keys by their day. `CostsView` computes every
figure from `[from, to)`; the ticket table's All time column stays all-time (the budget check).
`HoursView` takes the same `from`/`to`: `estimateHours` cuts the joined spans to it before the
per-day split.

### In-app updates (issue #122)

Spec: backend repo, `docs/superpowers/specs/2026-10-16-in-app-updates-design.md` (§1 the release
signature, §2 the server, §4 this client). macOS has its own updater (the app is ad-hoc signed, no
Developer ID, so no Squirrel.Mac); Windows uses `electron-updater`'s NSIS updater. The state is
**not** in `AppState`: it reaches the window through `update:*` only, and every one of those is
`blocked` in `DECK_ACCESS` (a browser never updates the Mac; `remoteSettings` also keeps the Mac's
`autoDownloadUpdates` / `updateChannel`).

| Module | What |
|---|---|
| `shared/updates.ts` | `UpdateState` / `UpdateOffer` / phases / error kinds, `compareVersions` (semver with prereleases), `signedMessage`, `parseOffer` (an `https:` download, plain `http:` only to `localhost` / `127.0.0.1`: `downloadUrlOk`), `parseResult`, `checkUrl`, and the UI's `statusLine`, `shouldPrompt`, `badge`, `readyLine`; `REMIND_MS` (4 h), `CHECK_EVERY_MS` (6 h), `FIRST_CHECK_MS` (30 s), `HEALTHY_AFTER_MS` (10 s) |
| `shared/releaseKey.ts` | the release public key (raw Ed25519, base64; `release-publish.mjs` reads it from this file); `releaseKey({testBuild, env})` takes `MASTERDECK_UPDATE_PUBKEY` only in an update-test build with `MASTERDECK_ISOLATED=1`; `updateBase({testBuild, packaged, env})` takes `MASTERDECK_UPDATE_URL` only in an update-test build or a development run |
| `shared/updateHelper.ts` | the macOS helper script (bash 3.2) and its arguments |
| `main/updater.ts` | `Updater`: the state and its events, the schedule, the check, downloads through an `Installer`, restart / remind later / install on quit, what the last install left; `updatesOffReason` |
| `main/updateVerify.ts` | `UpdateFailure(kind)`, `signatureOk` (SPKI prefix + raw key, `crypto.verify`), `hashFile`, `checkRelease` (hash, size and signature) |
| `main/updateMac.ts` | `MacInstaller`, `macBundle`, `macDisabledReason` (`/Volumes/`, App Translocation), `plistVersion`, `removeMacBackup` |
| `main/updateWin.ts` | `WinInstaller` over `NsisUpdater` (`electron-updater`, imported on first use on win32 only), `feedUrl`, `nsisOptions` |
| `main/remoteGuards.ts` | `updateHandlers`: the `update:*` handlers, refusing a browser (`isRemote`) |
| `main/appMenu.ts` | the macOS app menu: Electron's default roles plus **Check for Updates…** / **Restart to Update…** |

**When it runs.** `makeUpdater()` in `index.ts` before `registerIpc`. Off (with the reason Settings
shows) in a development build (`!app.isPackaged`), with `MASTERDECK_UPDATES=0`, on Linux, and on a
Mac app run from `/Volumes/…` or App Translocation. `start()` (after `sources.start()`, not in
`MASTERDECK_SMOKE`) reads what the last install left, checks 30 s later and every 6 h; **Check for
updates** and the menu item check at once; another `updateChannel` checks again (queued until a
check or download already running is done; a ready **beta** offer is dropped, its staged files
removed, when the channel goes back to stable). The server is the real service
(`DEFAULT_REMOTE_URL`); `MASTERDECK_UPDATE_URL` (passing `validBackendUrl`) replaces it only in an
update-test build or a development run, and `MASTERDECK_UPDATE_PUBKEY` replaces the key only in an
update-test build launched with `MASTERDECK_ISOLATED=1`. An update-test build is one made with
`MASTERDECK_UPDATE_TEST_BUILD=1` (electron-vite's define `__MD_UPDATE_TEST__`, false in every
release build), because any process of the user can `launchctl setenv` a variable for every app. The check is `GET <base>/v1/updates/check?version&platform&arch&channel&id`
with a 20 s timeout through `net.fetch`: `204` up to date, `200` an offer, a thrown fetch `offline`,
anything else `check`. An offer not above this version, or the version a rollback skipped, counts as
up to date. A ready update stays ready through later checks; only a newer offer replaces it, and
the old staged one is discarded at once (`Installer.discard`). With
`autoDownloadUpdates` (default on) an offer downloads at once, else it waits for **Download**.

**macOS.** `prepare`: the zip goes to `<userData>/updates/<version>/<name>`, hashed (SHA-512) as it
streams, stopped when it grows past the offer's size; then the hash, size and the Ed25519 signature
of `signedMessage({version, platform: 'darwin', arch, name, sha512})` are checked against the built-in
key. Any failure deletes the folder (`verify`). Then `ditto -x -k` into `<version>/stage/`, the
staged `MasterDeck.app/Contents/Info.plist` must say the offer's version (else `verify`), quarantine
is cleared → `ready`; the zip stays beside it until the install is done (the administrator path
unpacks it again as root). `needsAdmin` when the bundle or its folder is not writable. **Restart
now** (`restartToUpdate`: a recording asks first, as Restart does) writes `update-helper.sh` (temp
file + rename) and `pending.json` (`{version, from, relaunch, at}`), starts the helper detached and
calls `app.quit()` (will-quit still closes terminals and the remote line). A normal quit with an
update ready runs the helper without a relaunch (`onQuit` in will-quit), unless it needs a password
or the quit is MasterDeck's own **Restart** (`app.relaunch()`; `relaunching` in `index.ts`, handed to
`Updater.onQuit(relaunching)` → `Installer.onQuit(offer, relaunching)`): the relaunched app would
start from the bundle the helper is about to move. When **Restart now** fails (`restart()` throws) a
check asked for meanwhile (a channel change while `installing`) runs at once (`afterBusy`).

The helper (`update-helper.sh install <pid> <app> <staged> <dir> <version> <from> <relaunch> <zip> <sha512>`):
1. waits up to 120 s for the old pid to exit (else `result.json {ok:false, reason:"still-running"}`, nothing touched);
2. stops with `still-running`, nothing touched, when any process runs from `<app>/Contents/MacOS/` (the path compared literally against `ps -axo pid=,command=`: a folder name with `(` or `.` is no pattern), i.e. the app was opened again or relaunched;
3. swaps. Right before the renames it looks again for a process running from the bundle (as the user: `app_pids` at the top of `swap_user`; as root: the same literal `ps -axo command=` match inside the root command, after the zip is checked and unpacked, exit 17): the password prompt can take minutes, and MasterDeck opened meanwhile must not have its bundle swapped under it. Found: `still-running`, nothing touched, nothing opened. As the user: staged → `.MasterDeck.app.new` next to the app, `MasterDeck.app` → `.MasterDeck.app.previous`, `.new` → `MasterDeck.app`, clears quarantine. When the folder is not writable nothing of the helper file runs as root: the root commands go inline to `osascript -e 'do shell script (item 1 of argv) with administrator privileges'` with every path single-quoted for `/bin/sh`, and as root they copy the **zip** into a fresh root-owned `mktemp -d` folder, check its SHA-512 (`openssl dgst -sha512 -binary | base64`) against the one the app verified with the signature, `ditto -x -k` it there, check `CFBundleShortVersionString`, clear quarantine, give it the current app's owner (`stat -f %u:%g`), and do the two renames (the old app back on failure). The user's staged copy is never used there. A cancel (`-128`) is `reason: "permission"`, any other failure `swap-failed`; the old app is opened again;
4. without relaunch: writes `{ok:true, from, version}` and keeps the backup. The new app removes it (`removeMacBackup`, through `UpdaterDeps.removeBackup`) once it has written its health marker, only when `pending.json` says `relaunch: false`, its own bundle is the `MasterDeck.app` beside the backup and the backup's `Info.plist` version is older than its own. **No automatic rollback on this path**: a new version that never comes up leaves the backup for the user (TODO);
5. opens the app and waits up to 120 s for `<dir>/healthy-<version>`; a second launch if not; still nothing → kills what runs from the bundle (TERM, then KILL after 3 s, same literal match), puts the backup back, writes `{ok:false, reason:"unhealthy"}` and opens the previous app. On success it removes the backup (as the user; as root it stays until the next swap) and writes `{ok:true, …}`.

The new app writes `healthy-<version>` 10 s after its window's `did-finish-load` when `pending.json`
names its version (`Updater.windowLoaded`), then reads `result.json` 3 s and 15 s later. At launch
`readLaunchFiles` reads `result.json` once and removes it: ok → `updatedFrom`; `unhealthy` →
`rolledBack`, kept in `rolled-back.json` so that version is skipped until a newer one; other reasons
→ an `install` / `permission` error with no offer (Try again then checks again: `retryAction(state)`).
Stale `<version>/` folders are removed at launch. Stand-ins for the helper's tests: `MD_OPEN`,
`MD_OSASCRIPT` (gets the root command as its last argument; the tests' stand-in runs it with `/bin/sh`
as the same user), `MD_KILL`, `MD_XATTR`, `MD_PID_WAIT`, `MD_HEALTH_WAIT`, `MD_KILL_WAIT`, `MD_POLL`.

**Windows.** `WinInstaller.prepare` first stops a previous ready updater from installing on quit,
then makes an `NsisUpdater` (`nsisOptions`: `useMultipleRangeRequest: false`, as the backend
answers single ranges only) on the per-install, per-version feed
`<base>/v1/updates/feed/<channel>/<install id>/<current version>/` (the same decision as `/check`,
mandatory updates included), `autoDownload`, `autoInstallOnAppQuit` and `allowDowngrade` off; the
feed's version must equal the offer's; after `downloadUpdate()` the installer file's hash and
signature (`platform: 'win32'`) are checked (a failure deletes it), then `autoInstallOnAppQuit` goes
on. **Restart now** is `quitAndInstall(true, true)`; when it throws, or the app is still running
10 s later, it is an `install` error (the update stays ready). `discard` turns
`autoInstallOnAppQuit` off, and so does `onQuit(offer, true)`: MasterDeck's own **Restart** relaunches
the app, and NSIS must not run under the new instance (will-quit comes before electron-updater's
`quit` handler, which reads the flag; the relaunched app offers the update again). No rollback on Windows (ponytail in `updateWin.ts`).

**IPC.** `update:state`, `update:check`, `update:download`, `update:restart`, `update:later`; events
`update:changed` (the whole `UpdateState`) and `update:open` (the menu's Check for Updates…: show
Settings → Updates). Settings: `autoDownloadUpdates` (true), `updateChannel` (`'stable'` | `'beta'`).

## Shared modules (`shared/`)

Pure TypeScript, no electron/node imports in the types, tested with vitest. The main groups:

| Area | Modules |
|---|---|
| Types, IPC, settings | `types.ts` (`AppState`, `Session`, `PaneSpec`…), `ipc.ts`, `settings.ts` (`Settings`, `DEFAULT_SETTINGS`, `normalizeSettings`), `appConfig.ts`, `shortcuts.ts`, `keys.ts` |
| Sessions | `agents.ts`, `derive.ts`, `review.ts`, `sessionOrder.ts`, `sessionFilter.ts`, `stars.ts`, `tasks.ts`, `restore.ts`, `pastSessions.ts`, `carry.ts`, `link.ts`, `procs.ts`, `paneCommand.ts` |
| Transcripts | `activity.ts`, `ask.ts` (menus from screens), `prompt.ts`, `promptGuard.ts`, `prscan.ts`, `worktrees.ts`, `stats.ts`, `history.ts`, `summary.ts`, `tokens.ts` (also activity `spans`), `costs.ts`, `hours.ts` (working hours estimate), `schedules.ts`, `watches.ts` |
| Needs you | `inbox.ts`, `notify.ts`, `nudge.ts`, `offers.ts`, `send.ts` |
| GitHub, board | `board.ts`, `boardFilter.ts`, `repoView.ts`, `teamPrs.ts`, `prSummary.ts`, `accounts.ts`, `ticket.ts`, `ticketBuilder.ts`, `sprintSummary.ts`, `standup.ts`, `ghAuth.ts`, `detect.ts`, `git.ts`, `janitor.ts`, `cleanup.ts` |
| Workflows, hooks | `flow.ts`, `flowFrame.ts`, `flowBuilder.ts`, `flowTrack.ts`, `flowWatch.ts`, `workflow.ts`, `deckHooks.ts`, `skillInfo.ts`, `install.ts`, `models.ts` |
| Remote | `remote.ts` (wire protocol copy), `remoteSnapshot.ts`, `remoteGuard.ts`, `remoteDeck.ts`, `remotePresence.ts`, `deviceInfo.ts`, `account.ts`, `bridgeWire.ts`, `e2e.ts`, `b64.ts`, `wordlist.ts` (BIP-39) |
| Misc | `format.ts`, `fuzzy.ts` |
| Notes | `notes.ts` (types, limits, `NOTE_ID`, `cleanNote`, `storedNote`, `incoming`), `noteEditor.ts` (`NoteEditor`: the editor's saves, switches and conflicts, without its screen) |

## Renderer (`renderer/src/`)

- `main.tsx` mounts `App`. `deck.ts`: `deck()` = `window.deck`, `useAppState()` (first
  `getState()`, then `onState`), `useNow(ms)`.
- Themes (issue #105, [THEMES.md](THEMES.md)): every colour is a token of `shared/themes.ts`
  (`DARK`, `LIGHT`). `theme.ts` writes the active theme's tokens on `<html>` as CSS variables
  (`applyTheme`), `bootTheme()` runs before the first render (`main.tsx`, `web/main.tsx`) from
  localStorage `md.theme`, and `useTheme(pref)` in `App` follows `settings.theme` (the window) or
  the browser's own choice (`useWebThemePref`, the web app), resolving System through
  `prefers-color-scheme`. Terminals subscribe with `onTheme`. In main, `applyNativeTheme` sets
  `nativeTheme.themeSource` and the window's background on every settings save, and `remoteSettings`
  never lets a browser change the Mac's theme. `themes.lint.test.ts` fails on any colour literal in
  `renderer/src` or `src/web`.
- `App.tsx` lays out, left to right: **`Rail`** (views, tools, the remote indicator, actions,
  Settings), **`Sidebar`** (the Sessions column on Terminals: Needs you, grouped sessions, shells,
  Parked, footer with Refresh/Cleanup/GitHub cache), the **main view**, the **`Inspector`** right
  panel on Terminals (Details = `SessionDetails`, Tools = `SessionTools` with sub-tabs Queue = `QueuePanel` and BTW = `SessionBtw`, kept in `md.toolsTab`; a saved `inspTab` of `"queue"` opens Tools; Summary = `SummaryPanel`),
  and **`MasterPane`** (master-agent's terminal; ★ Master / ⌘⇧M). Dialogs and popups mount at the
  end (`BrowserApproval` only where `can('browserDecide')`, i.e. desktop).
- Views (`View` in `Sidebar.tsx`): `terminals`, `board` (`BoardView`), `prs` (`PrsView`), `tasks`
  (`TasksView`), `costs` (`CostsView`; its Hours choice is `HoursView`), `janitor` (`HygieneViews`), `workflow` (`WorkflowView` +
  `FlowEditor`), `settings` (`SettingsView` + `AccountPanel`), `history` (`HistoryDialog`).
- Notes is a panel over the current view, not a view: the Rail's button (`notesOpen` / `onNotes`,
  `aria-pressed`; under More on a phone) toggles and the palette opens `App.tsx`'s `notesAt` (`null` closed,
  `{}` the list, `{id}` / `{ticket}` / `{fresh}` a note to open). `renderer/src/notes.ts` has `useNotes`
  (the list of `NoteMeta`, read once and kept current by `onNotesChanged`; `loaded` is false until the
  first read, and a failed first read is not retried) and `ticketNote(metas, repo, number)`.
  `components/NotesPanel.tsx` draws the list, search and editor; the editor's rules live in
  `shared/noteEditor.ts` (`NoteEditor`, one per window, outside the panel: 500 ms debounce, `base`,
  `incoming`, see "Notes" above). The panel is mounted after the headers (like the ★ Master button) so
  it gets its clicks. The entry points are `GitHubDetails.tsx` (Details → GitHub: **Add note** / **Edit note**), `SessionNotes.tsx` (Details → Notes) and the
  mark in the top row of a `BoardView` `Card` (`bcard-note`; always visible on a phone). A ticket's
  title in the panel comes from `ticketTitle` over the issues, the board and the repository view.
  On a phone the panel is a full-screen sheet (`web.css`, `.app.phone > .notes-panel`) and `App.tsx`
  closes it when a screen is chosen (another tab, the palette, a More dialog); unsaved text is saved
  first (the panel's unmount flushes).
- Terminals: `TerminalView` (xterm 6 + fit + search; replay/seq handling; Cmd+C/V; size only from
  the visible view; on the web all output goes through `predictiveEcho`).
- Web gating: `web.ts` — `isWeb()` (`deck().platform === 'web'`), `can(method)`, `WEB_VIEWS`,
  `screenOk`, `shortcutOk`, `actionOk`, `keyPlatform`. `webConfirm.ts` + `WebConfirm.tsx` replace
  native dialogs on the web. `repoPicker.ts` + `RepoPicker.tsx` replace the folder picker (`listOnly`: the workspace repositories and no typed path, for the Start dialog).
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
  fixture AppState and fake terminal output (`src/web/preview/`), `/?preview=noboard` the same account with no GitHub board (derived cards and read notes); the fixture also carries `repoView` data for `acme/web` and `acme/api` (pick one in the Board's Repos filter), `/?preview=gate` the sign-in card.
  `main.tsx` imports it only under `import.meta.env.DEV`, so `build:web` leaves it out (check:
  `grep -l "nothing was sent" out/web/assets/*` finds nothing).

## AppState: fields and producers

| Field | Producer |
|---|---|
| `sessions`, `master`, `lastActivity`, `asks`, `menus`, `prStage`, `manualStatus`, `hookInfo` | `Sources` (agents poll, transcripts, deck hook, `session-status.json`) |
| `issues`, `prs`, `proposals`, `lastSnapshotAt`, `board*`, `sprints`, `selectedSprint`, `users`, `me`, `boardHistory`, `githubRefreshedAt/ing` | `master snapshot` / `master board` / ledger (`refreshGithub`, `readLedger`), cached in `cache.json`; `board` passes `deriveBoard` (columns of cards from an account with no board) |
| `repoView` | `RepoIssues.view()` through `repoViewDeriver` (`master repo-issues`, only after a Board tab asked with `boardRepos`), cached in `cache.json` (`repoIssues`) |
| `teamPrs`, `teamPrsAt`, `teamPrsLoading`, `teamPrsError` | `refreshTeamPrs` |
| `inbox` | `Inbox.view()` over `collectItems` |
| `stats`, `allStats`, `tails`, `git`, `tokens`, `costBook` | status line files (`stats/`), transcript tails, git, `TokenIndex` (`tokens.json`), `costs.json` |
| `prLive`, `sessionPrs`, `sessionWorktrees`, `pastSessions` | `gh pr view` for followed PRs, `session-prs.json`, transcripts, `ticket-links.json` |
| `watches`, `schedules` | `Watches.info()` + `PrWatch.info()` (`pr:<url>` rows), transcripts |
| `loops` | `LoopStore.views()` over `workflows/loops/<sid>.json` (3 per session, closed ones for 24 h, tail 1 KB) |
| `sources`, `errors`, `missingBinaries`, `ghCache` | health of each poll, `readGhCacheStatus()` |
| `settings`, `config`, `skills`, `hooks`, `statuslineInstalled`, `masterWorkspace` | `settings.json`, `~/.claude/master/config.json`, `syncSkills`, `hookStatus` |
| `stoppedByRestart`, `restoring` | `running-sessions.json` |
| `remote` (+ `warning`), `remoteClients` | `CloudSync` status / `clients` message (`syncRemote`), bridge warning |
| `browsers`, `browserRequests` | `BrowserBridge` via `publishBrowsers()` |
| `account` | `Account.state()` |
| `peers` | `PeerStore` (`session-peers.json`) through `of(key)`: symmetric links between sessions by `Session.key`, pruned on each agents poll |
| `modLive` | the state callback in `main/index.ts`, from `DeckHooks.modBeats()`: sessions MasterDeck's core mod runs in (fresh heartbeat), by `Session.key`, `{version, claude, mods}` (the mods it saw load in that session) |
| `modOff` | the state callback, from `ModOff` (`mod-off.json`): the mods switched off per session, `Session.key` → plugin names |
| `modCatalog` | the state callback, from `ModCatalog` (`mod-catalog.json`): every mod the MasterDeck mod reported in any session |
| `meetingLive` | the state callback, from `MeetingsIpc.live()` (`Recorder.live()`): `{ recording, since, paused, elapsed, offer }` (`elapsed` as of the last change, so it does not tick; the rail counts from `since`), idle until a recorder was loaded, null off macOS; never in `toRemoteSnapshot` |
| `mods` | the state callback, `modsNow()` over `ModsInstaller.status()`: whether MasterDeck's mods are installed in Claude Code, Claude Code's version, the mods' version, `prependNote`, `unavailable` |
| `Session.account` (inside `sessions`; two or more accounts) | `sessionAccount` over `SessionAccounts` (`session-accounts.json`), the session's spawn proposal, its folder's `origin`, else the primary |
| `ghAccounts` | `AccountEnv.status()` (login, primary, health, warning; never a token) |

## Files on disk

Under `MASTERDECK_HOME` (default `~/.claude/masterdeck`):

| File / folder | What |
|---|---|
| `settings.json` | `Settings` |
| `cache.json` | last GitHub snapshot, boards, sprints, users, team PRs, the repository view's issues (`repoIssues`) |
| `costs.json`, `tokens.json`, `stats/` | cost book, token index (version 3: per transcript file, tokens per local hour and activity `spans`); the cost book keeps each session's highest cumulative cost per hour (per day once 35 days old), status line output per session |
| `statusline_tee.py` | installed status line tee (settings.json points here) |
| `inbox.json`, `inbox-events.jsonl` | Needs you state and event log |
| `session-history.json`, `session-prs.json`, `session-status.json`, `running-sessions.json` | session ids per background session, PRs per session, manual statuses, restart list |
| `summaries/`, `templates.json`, `skills.json` | session summaries, Start-dialog templates, removed skills |
| `watches.json` | monitors MasterDeck runs |
| `mod-off.json`, `mod-catalog.json` | the mods switched off per session (`{Session.key: [names]}`) and every mod seen (`main/modOff.ts`) |
| `mods/`, `mods-installed.json` | MasterDeck's copy of its mods, the local-folder marketplace Claude Code reads (`.masterdeck-mods.json` marks the copied hash), and when MasterDeck last installed them (`main/mods.ts`) |
| `session-peers.json` | linked sessions: `{version: 1, edges, seen}` by `Session.key` (`main/peers.ts`); a file that cannot be read is moved aside as `.corrupt-<ts>` |
| `btw/` | Side questions (Tools → BTW): `<session key>.json` per session (`{version, entries}`), `history-offset.json` (how far `history.jsonl` was read). `main/btw.ts` |
| `notes/` | One JSON file per note (`n-<32 hex>.json` a global note, `t-<owner>~<name>~<number>.json` a ticket's): title, text, ticket, created, updated. Written as temp file + rename by `main/notes.ts`. Private: never in `AppState`, a snapshot, a prompt or a GitHub call |
| `meetings/` | `<id>.json` per meeting (`m-<32 hex>`; temp file + rename), `<id>/audio.webm` (the playback copy, appended every 10 s), `<id>/chunks/<you|others>-<seq>.wav` (30-second 16 kHz WAVs until transcribed), `models/` (speech models). Private like notes (`main/meetings/store.ts`) |
| `meeting-notices.json` | Meetings' Needs-you items, one per meeting (meeting id, title, kind, counts or reason, time); temp file + rename by `main/meetingNotices.ts`; 30 days |
| `pr-watch.json` | PR watch: watched PRs (seen keys, pending messages) and ended PR URLs |
| `ticket-links.json` | session ↔ ticket links (tt.sh `state.json` shape; imported once from babysit-ticket) |
| `board-link-tried.json` | sessions BoardFlow already tried to auto-link (never retried) |
| `board-moved.json` | `<ticket>:<target>:<PR urls>` board moves BoardFlow made or found done (never retried) |
| `linked-steps.json` | sessions linked by MasterDeck whose `linked` workflow steps are still to be sent |
| `deck/` | `hook.sh`, `pending/`, `answers/`, `context/`, `watch-requests/`, `watch-answers/`, `queue-requests/`, `queue-answers/`, `queue-off`, `legacy-sids`, `peers/` (`<sid>.delta.json`: the delta the session's next prompt prints once), `events.jsonl`, `alive`, `monitors-by`, `band/` (`<sid>.json`: what the MasterDeck mod draws in that session), `mods/` (`<sid>.json`: the mod's heartbeat), `note-requests/`, `note-answers/` |
| `workflow.json`, `workflows/` | workflows, the loop hook `workflows/loop.sh` and the loop files `workflows/loops/` (see above) |
| `pr-review-guard/tab-<tabId>.json` | the selected PR's URL and the account `post-review.sh` checks (outside the session's folder); `.auto.json`: the PRs Automate Review queued (`--auto`); `.turn`: the session's turn, written by its hooks |
| `auto-review.json` | Automate Review's switches per PR tab and the PRs it follows (#157) |
| `pr-review/tab-<tabId>/` | the PR view's review sessions (Review with Claude): `CLAUDE.md`, `context.json`, `post-review.sh`, `.claude/settings.json`, and the review files the session writes |
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

In Electron's user data (`MASTERDECK_USER_DATA`), `updates/` (in-app updates, issue #122):
`install-id` (random UUID, the server's rollout bucket), `<version>/` (the download and its
`stage/MasterDeck.app`; removed at the next launch), `update-helper.sh`, `helper.log`, `pending.json`
(the version being installed), `healthy-<version>` (the new app's health marker), `result.json` (the
helper's outcome, read once), `rolled-back.json` (the skipped version).

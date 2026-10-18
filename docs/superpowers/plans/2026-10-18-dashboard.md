# Dashboard (#183): plan

- **Spec**: [../specs/2026-10-18-dashboard-design.md](../specs/2026-10-18-dashboard-design.md),
  approved 2026-10-18. Mock-up, approved: https://claude.ai/artifact/YNLSLuijAmcrApcaSsxtsj.
- **Branch**: `worktree-MasterDeck-Terminal-183-dashboard`, one PR, which closes #183.
- **How**: subagent-driven. Each task below goes to one implementer subagent, followed by one
  reviewer subagent, before the next task starts. A final review of the whole branch comes at the
  end. Pure logic is test first (red, then green). Each task ends with
  `cd app && npm run typecheck` and the vitest files it touched passing, then one commit (subject
  `Dashboard (#183): …`, the session's `Co-Authored-By` line).
- **Never in this work**:
  - typing into a real session or acting on a real Needs-you item
  - a GitHub write
  - touching `~/.claude/settings.json`
  - rebuilding or reinstalling the real app (it waits for the user's word)
  - pushing before the PR step

## One refinement of the spec

The spec has an `InboxActions` component extracted from `Sidebar.tsx`. The Needs-you card is not
one set of buttons, though: `InboxCard` (Sidebar.tsx:908) switches over a dozen kinds (proposal,
offer, meeting, menu, trust…), each with its own controls.

So **Task 9 moves `InboxCard` and its helpers, unchanged, into `components/InboxCard.tsx`**, and
the Needs attention row for an inbox item draws:

- its line, its primary action, **Open** and ×
- **Reply…**, which expands the real `InboxCard` (`full={false}`) under the row

The behaviour comes from the code the Needs-you list runs, with no second copy. The spec's
**Files** section is updated with it.

## Order and dependencies

```
1 activity logic ─┐
2 ActivityLog ────┼─ 3 wiring the log ─┐
4 procs:all ──────┤                    │
5 cost account ───┤                    ├─ 10 cards ─ 11 customise ─ 12 phone/web ─ 13 preview ─ 14 checks ─ 15 docs ─ 16 PR
6 dashboard logic ┤                    │
7 layout logic ───┤                    │
8 shell + setting ┘                    │
9 InboxCard move ──────────────────────┘
```

- Tasks 1, 4, 5, 6, 7 and 9 do not depend on each other. They still run one at a time, each
  reviewed, so the reviews stay small.
- Task 2 needs task 1's types.
- Task 3 needs tasks 1 and 2.
- Task 6 needs task 1's types (the timeline filter lives in `activityLog.ts`).

---

### Task 1: the activity log's logic (`shared/activityLog.ts`)

**Files**: `app/src/shared/activityLog.ts` and `app/src/shared/activityLog.test.ts`, both new.

1. **Write the types exactly as the spec's "Shape"**: `ActivityType`, `ActivityEvent`,
   `ActivityTarget`. Also:
   - `ACTIVITY_KEEP_DAYS = 14`, `ACTIVITY_MAX_LINES = 5000`, `ACTIVITY_COALESCE_MS = 15 * 60_000`,
     `ACTIVITY_LIST_MAX = 1000`, `ACTIVITY_RANGE_MAX_MS = 31 * 86_400_000`
   - `TYPE_TAG: Record<ActivityType, 'SES' | 'PR' | 'TKT' | 'GIT' | 'RUN' | 'NOTE' | 'YOU'>`
   - `TYPE_GROUP`, for the chips: Sessions, PRs, Tickets, Commits, Schedules, Meetings and notes,
     Needs you
2. **Write the tests first** for `diffActivity(prev, next, now, ids?)`. `ids` is an injectable id
   maker, for stable tests. Each of these with a small `AppState` builder (copy the shape of the
   fixture in `shared/notify.test.ts`):
   - `prev === null` gives `[]`
   - a new session key gives `session-started`
   - a key whose state is now `done` or `suspended`, or a key that is gone, gives `session-ended`.
     A key that is gone but whose session is in `superseded` is not ended. Check how
     `Sources.build` hides superseded sessions, and use the same signal from the state; if none
     reaches the state, skip ended-by-disappearance for a key whose `name` reappears under another
     key in `next`.
   - `working` → `idle` with no `busyWith` gives `session-finished`. It is still `idle` with
     `busyWith`: nothing.
   - `teamPrs`:
     - a new url, mine (author is `me` or a `ghAccounts` login) or in a session's `sessionPrs`,
       with `createdAt` within an hour, gives `pr-opened`
     - someone else's gives nothing
     - an old PR first seen gives nothing
   - `reviewDecision` to APPROVED or CHANGES_REQUESTED, or a longer `reviews`, gives
     `pr-reviewed`
   - `mergedAt` newly set gives `pr-merged`; `closedAt` without `mergedAt` gives `pr-closed`
   - `teamPrsAt` null in `prev`: nothing for PRs
   - `board`:
     - the same card (`repo`, `number`, `project`) with a different `status` gives
       `ticket-moved`, titled "#42 Title moved A → B"
     - `derived` cards, new cards and removed cards give nothing
     - `prev.board === null` gives nothing
   - `git`:
     - `ahead` 3 → 0 with the same `branch` and `dir` gives `commit-pushed`, "Pushed 3 commits to
       fix/x"
     - a different branch, or `ahead` 3 → 1, gives nothing
   - the `agents` source not `ok` in `prev`: no session events
   - every event carries a `subject` and a `target` as in the spec's table, and `account` /
     `repo` where known (a session's `account`, a PR's `account`, `repo`)
3. **Implement `diffActivity`** until green.
4. **Write the tests, then implement**:
   - `filterActivity(events, {groups?: string[], account?: string | null, repo?: string | null})`:
     an empty filter keeps everything, and the conditions combine with AND
   - `coalesce(list, e)`: the in-memory rule, newest first. The same `type` and `subject` within
     15 minutes replaces the older one, keeping its id; it gets the new `at`, `title` and
     `detail`.
   - `activityRows(events)`: grouped by local day, with labels Today / Yesterday /
     "Mon 13 Oct"
   - `cleanEvent(raw)`: the validator for a stored line. Strings are cut to 300 characters, a
     bad `type` is refused, and `target` is checked per kind.

**Review focus**:
- no slice that was still loading produces events
- someone else's PRs never appear
- titles are plain sentences
- no `AppState` field is added

### Task 2: `ActivityLog` (`main/activityLog.ts`)

**Files**: `app/src/main/activityLog.ts` and `app/src/main/activityLog.test.ts`, both new.

1. **Write the tests first, with a temp dir**:
   - `add(e)` appends one JSON line
   - `list(since, until, limit)` is newest first, bounded
   - a new instance reads the file back
   - **Trim on load**: lines older than 14 days, and anything past 5000 lines, are dropped and the
     file is rewritten through a `.tmp` and `rename`. No `.tmp` is left.
   - **A corrupt line** is skipped, and the file is rewritten without it.
   - **Coalescing** (task 1's `coalesce`):
     - in memory, two adds within 15 minutes give one row
     - after a reload, the newer line wins
   - **A write failure** (the folder made read-only, or an injected `fs` that throws) is
     swallowed, and a later `add` still lands in memory
   - **`onChange`** is throttled to once per 2 s, with an injectable clock and timer
2. **Implement it**. The constructor is `(file, {now?, onChange?, setTimer?})`, and it writes
   with `appendFileSync`. It logs a write error at most once a minute, with no path in the message.

**Review focus**: atomic rewrites only on load and after 5000 appended lines, no unbounded
growth in memory or on disk, no throw reaches a caller.

### Task 3: wiring the log into main

**Files**:
- `main/index.ts`
- `main/sched.ts` (+ test)
- `main/meetings/store.ts` (+ test)
- `main/notes.ts` (+ test)
- `shared/notes.ts`
- `shared/ipc.ts`
- `preload/index.ts`
- `shared/remoteDeck.ts`

1. **Construct the log**: `const activity = new ActivityLog(join(paths.home, "activity.jsonl"),
   { onChange: () => emit(CH.activityChanged) })`.
2. **Diff the state**: in the state callback, right after `notify(diffEvents(prev, state,
   focused))`, add `try { for (const e of diffActivity(prev, state, Date.now())) activity.add(e) }
   catch (e) { console.error(...) }`.
3. **Schedule runs**: `Scheduler` deps gain `onRun?(r: SchedRun)`. It is called once when a run
   reaches `done`, `failed`, `skipped` or `stopped`: in `addRun`, when the stored run with that id
   was `running` or absent. Test it in `main/sched.test.ts`. Main maps the run to `schedule-run`
   ("Nightly triage ran" / "… failed: reason"), with target `{schedules: true}`.
4. **Meetings**: `MeetingStore` gains an optional `onEnded?(m)`, called from `update` when
   `old.ended === null && next.ended !== null`. Test it. Main maps it to `meeting`, "Meeting
   recorded: *title* (42 min)" or "A meeting was recorded (42 min)", with target `{meeting: id}`.
5. **Notes**: `NoteChange` gains `created?: true`, which `NotesStore` sets when the id did not
   exist before the save or append. Test it. Main logs `note-added`: "A note was added", or "A
   note was added to #42" for a ticket note (from `meta.ticket`), with target `{note: id}`.
   
   Add a test in `main/activityLog.test.ts` or a new `main/noteActivity.test.ts` that builds the
   event through the same mapping function. It asserts that no field contains the note's title
   or its preview. Put the mapping in `shared/activityLog.ts` as `noteEvent(change)` so it can be
   tested.
6. **Inbox**: `sources.inbox.on("event")` with `type === "resolved"` gives `needs-you-answered`,
   titled with the item's title and detailed with `resolvedHow`. Skip `dismissed`, and skip a
   resolution made during the first state loads (the inbox is silent then).
7. **Release**:
   - at startup, if `upd.state().updatedFrom` names a version not already logged, log "Updated
     to x (from y)"
   - in `u.on`, a new `offer.version` not seen gives "MasterDeck x is available"
   
   Keep the seen versions in memory, and scan the log on load so a restart does not log them
   twice.
8. **Channels**:
   - `CH.activityList = "activity:list"` and `CH.activityChanged = "activity:changed"`
   - `DeckApi.activityList(since, until): Promise<ActivityEvent[]>` and
     `onActivityChanged(cb): () => void`
   - preload
   - `DECK_ACCESS`: `activityList: invoke(CH.activityList)`, and the event entry as for
     `onSchedChanged`
   - handler: `reg.handle(CH.activityList, (_e, since, until) => …)`, which validates both (finite
     numbers, `since ≤ until`, at most 31 days) or answers `[]`
9. **Run** `remoteDeck.test.ts`, the touched store tests and typecheck.

**Review focus**:
- every hook is wrapped so a failure cannot break the state callback or a store write
- the note mapping has no text in it
- nothing goes into `AppState` or `toRemoteSnapshot`

### Task 4: `procs:all` with strays (`main/sessionProcs.ts`)

**Files**: `shared/sessionProcs.ts` (+ test), `main/sessionProcs.ts` (+ test), `shared/ipc.ts`,
preload, `shared/remoteDeck.ts` and `main/index.ts`.

1. **Write the tests first**, with fixture `ps` / `lsof` outputs (reuse the fixtures in
   `sessionProcs.test.ts`):
   - `listAll([{key, pid, cwd, worktrees}])` runs `ps` once and `lsof` once for the pids, plus
     one `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` for the strays. Assert the number of runner calls.
   - It gives the running processes per session, never `exited`, and leaves the `seen` state of
     `list()` untouched.
   - **A stray** is a listening process whose cwd is inside a session folder or worktree, and
     whose pid is not below any session pid. A listener elsewhere on the machine is not a stray,
     and one below a live session is not either.
   - Windows gives `{at, sessions: {}, strays: []}`.
2. **Implement it**:
   - add `StrayProc` and `ProcsAll` to `shared/sessionProcs.ts`
   - add a pure `findStrays(rows, listens, folders, sessionPids)`
   - add `SessionProcs.listAll`
3. **Channel**: `CH.procsAll = "procs:all"`, `DeckApi.procsAll()`, preload, and `DECK_ACCESS`
   `invoke`. The handler builds the session list from `latest.sessions` (pid and cwd) plus
   `latest.sessionWorktrees`.

**Review focus**: the number of process spawns per call (three at most), no change to
Details → Processes, and cwd matching on whole path segments (`/a/b` must not match `/a/bc`).

### Task 5: an account on cost entries

**Files**: `shared/costs.ts` (+ `costs.test.ts`) and `main/sources.ts`.

1. **Tests first**:
   - `recordCosts` stores `account` on a new `SessionCost` when the entry has one, keeps an
     existing account when a later entry has none, and updates it when a later entry has another
   - `validBook` accepts and keeps `account` (a string of at most 39 characters) and drops a bad
     one
   - an old book without it reads unchanged
2. **Implement it**: `CostEntry.account?`, `SessionCost.account?`. In `Sources`, where the entries
   are built (`sources.ts`, around line 1136), add `account: s?.account`.

**Review focus**: no change to how costs are summed. `pruneBook` keeps the field.

### Task 6: the Dashboard's logic (`shared/dashboard.ts`)

**Files**: `app/src/shared/dashboard.ts` and `app/src/shared/dashboard.test.ts`, both new.

Write each test before its function.

1. **`attentionItems(input, now)`**, exactly as the spec's Needs attention section.
   - **Input type**: `AttentionInput` (inbox, sessions, prs, teamPrs, sessionPrs, me, logins,
     watches, prWatches, sched, update, dismissed, max).
   - **Tests**:
     - the tier boundaries at 79/80 and 29/30
     - snoozed items left out
     - each derived source, with its title and `why`
     - "mine" through a second account's login
     - an inbox `ci` item for a session hides that session's PR CI item
     - a `review` item hides changes and threads
     - an `offer` item hides its PR
     - a PR with CI failing and changes gives one item, with both in `why`
     - the review request from `prs[].reviewRequested`, and from `teamPrs[].requested`
     - a failed run with a later run of the same schedule gives nothing
     - a run older than 24 h gives nothing
     - a watch error, and a PR watch row error
     - an update row only when the phase is downloaded or ready with an offer
     - the sort with ties at each level
     - a dismissed derived item stays hidden while its fingerprint matches, and comes back when
       it changes
     - `max` and `more`
     - `now` counts only the *now* tier
   - Export `fingerprintOf(item)` and `pruneDismissed(dismissed, items)`.
2. **`nowView(input, now)`**: the session rows in the spec's order, with chips and labels, up to
   6 plus `more`; the processes with ports; watching (PR watches, monitors, auto reviews
   `queued` / `reviewing`); and the next three runs (enabled, `nextAt` ascending). Test each part
   empty and full.
3. **`deliveryView(input, now)`**:
   - the sprint cards counted per `board.columns` (in order, the board's names)
   - the burndown from `boardHistory` and the `sprints` entry
   - the sprintless case (no burndown)
   - the derived-board case
   - the no-board case
   - the PR KPIs and stages
   
   Test each case.
4. **`usageView(input, now)`**:
   - today's and the week's cost from `costBook` (`sessionSpendIn`, the ranges from
     `resolveRange({preset:'today'})` and Monday 00:00)
   - per account, with Unknown account
   - one account gives no table
   - the 7-day series (`dailySpend`)
   - the top 3 sessions
   - tokens from a passed-in `tokensByDay` answer (or null while loading)
   - warnings: a failure within 24 h, GitHub paused, over-budget tickets
   
   Test each.
5. **`healthView(input)`**: every row of the spec's Health table in each status, "All good" when
   all are ok, the update row absent when `update` is null, and the strays and janitor rows from
   passed-in answers (or "not checked").
6. **`relTime(at, now)`**: "just now", "5 min ago", "2 h ago", "yesterday 18:05", "Mon 09:30",
   and for the future (next runs) "tonight 02:00", "tomorrow 09:30", "Mon 09:30". Reuse
   `formatRefreshed` where it fits; do not change it.

**Review focus**: matches the spec's tables line by line, all logic pure (no `Date.now()` inside),
and plain-language titles.

### Task 7: the layout logic (`shared/dashboardLayout.ts`)

**Files**: `app/src/shared/dashboardLayout.ts` and its test, both new.

1. **Tests first**:
   - `cleanLayout` with junk, repeats, unknown ids and non-arrays
   - `layoutOrder` places a new card after its predecessor, or first
   - `moveTo` / `moveStep` at the ends
   - `isDefault` / `toSaved` (the default saves as empty)
   - hidden cards keep their place in `order`
   - `dropNearest` on a 3-column, 2-row set of rects: the before/after side, a pointer outside
     the grid, a wide (span-2) card
   - `phoneOrder(layout)` keeps the saved order (Needs attention is outside the layout and is
     always drawn first)
2. **Implement it.** Model it on `shared/railOrder.ts`; do not import from it (different ids).

### Task 8: the shell, and the Open on setting

**Files**:
- `renderer/src/components/Sidebar.tsx` (`View`)
- `shared/railOrder.ts` (+ test)
- `renderer/src/components/Rail.tsx`
- `renderer/src/web.ts` (+ test)
- `renderer/src/components/CommandPalette.tsx`
- `renderer/src/App.tsx`
- `shared/settings.ts` (+ test)
- `main/remoteGuards.ts` (+ test)
- `renderer/src/components/SettingsView.tsx`
- a placeholder `renderer/src/components/DashboardView.tsx` that renders the header only

1. **Tests first**:
   - `RAIL_DEFAULT[0] === 'dashboard'`, and a saved order without it gets it first
   - `normalizeSettings` cleans `startView` to `"last"` or `"dashboard"`
   - `remoteSettings` drops a `startView` from a browser, keeping the Mac's
   - `web.test.ts` lists `dashboard` among the web screens
2. **The rail**: `ICONS.dashboard` (the four-tile path from the mock-up), its tooltip "Dashboard",
   and the phone's More list.
3. **The palette**: `view:dashboard`, "Go to Dashboard".
4. **App.tsx**:
   - the `view` allowlist gains it
   - the route `{view === "dashboard" && <DashboardView …/>}`
   - **Open on**: the web reads `md.startView` in the initialiser. The Mac applies
     `settings.startView === "dashboard"` once, on the first state, unless the user already
     switched views this launch.
5. **Settings → General**: a row **Open MasterDeck on**, with a segmented control Last view ·
   Dashboard. On the web it reads and writes `md.startView`, the theme's pattern at
   `SettingsView.tsx:89`.

**Review focus**: the rail's existing order tests are unchanged, there is no flash of another
view on launch with Dashboard set, and the web never writes `startView` to the Mac.

### Task 9: move `InboxCard` into its own file

**Files**: `renderer/src/components/Sidebar.tsx`, and `renderer/src/components/InboxCard.tsx`
(new).

1. **Move** `InboxCard`, `ItemControls`, `untilTomorrow`, `detailsClick`, and every card it draws
   that only it uses (`MeetingCard`, `ProposalCard`, `OfferRow`, `NeedsCard`…) into
   `InboxCard.tsx`, **without changing a line of their bodies**. Sidebar imports them. Anything
   Sidebar uses elsewhere stays exported from where it is.
2. **Check**:
   - `git diff --stat`, and `git diff -M` / `--color-moved`, show a move with no edits
   - typecheck and vitest pass
   - in the web preview, the Needs-you list's markup before and after is identical: compare
     `document.querySelector('.inbox')?.outerHTML` over CDP on `main` and on the branch

**Review focus**: a pure move. Any edit found is a finding.

### Task 10: the cards

**Files**: `renderer/src/components/DashboardView.tsx`,
`renderer/src/components/dashboard/{Card,AttentionCard,NowCard,TimelineCard,DeliveryCard,UsageCard,HealthCard,Sparkline}.tsx`
and `styles.css`.

1. **`Card`**: the frame (title, a count with its `title` tooltip, a `… →` link), the `loading`
   prop drawing the static skeleton, and the `empty` prop drawing the sentence. Children are the
   body.
2. **`Sparkline`**: inline SVG, `viewBox` scaled, a line in `var(--accent)`, an optional dashed
   ideal in `var(--line-3)`, a last-point dot, `role="img"` and an `aria-label` passed in.
3. **`DashboardView`**:
   - `useNow(60_000)`, with `now` rounded to the minute
   - per-card `useMemo` slices from `state`
   - pulls:
     - `schedList` + `onSchedChanged`
     - `useUpdate()` (null on the web)
     - `activityList` for the Timeline's range + `onActivityChanged`
     - `tokensByDay(ids)` when the cost ids change
     - `procsAll()` on mount, on Refresh, and when the set of working session keys changes (at
       most once a minute)
     - `janitor` on Check worktrees
   - module-level caches for the last `procsAll` and `janitor` answers
   - `md.dashboard.dismissed` read and written in try/catch
4. **`AttentionCard`**:
   - rows from `attentionItems`
   - a derived item's buttons call `openPr` / `openSession` / `schedRunNow` / `updateRestart` /
     `setView`
   - an inbox item: its primary action through `inboxAct`, **Open**, and **Reply…**, which
     expands `<InboxCard full={false}>` under the row
   - × dismisses: `inboxAct(id, 'dismiss')`, or the device list
   - "and n more in Needs you →" opens Terminals with the Needs-you list
5. **`NowCard`**, **`TimelineCard`** (chips, range seg, account and repo selects, day groups,
   sticky labels, max-height scroll, Show more, empty states, `md.dashboard.timeline`),
   **`DeliveryCard`**, **`UsageCard`** and **`HealthCard`**, each as in the spec and the mock-up.
   Each row is a `<button>` that navigates.
6. **CSS**:
   - `.dash-*` classes in `styles.css`, with `var(--token)` only (`themes.lint.test.ts`)
   - no `@keyframes`, no transitions
   - the grid `repeat(auto-fill, minmax(360px, 1fr))`, and Timeline `grid-column: span 2` from
     800 px of container width
   - Needs attention's frame and header band, the tier pills
   - one column at ≤ 760 px of container width (a `ResizeObserver` class toggle, or
     `@container`, which the current Electron supports)

**Review focus**:
- no `setInterval`
- no whole-`state` dependency in any `useMemo`
- each card `memo()`'d
- every number has a tooltip
- no colour literal
- buttons and links are real elements

### Task 11: Customise mode

**Files**: `DashboardView.tsx`, `dashboard/Card.tsx` and `styles.css`.

1. **The header**:
   - **Customise** shows the hint, **Reset** (disabled at the default) and **Done**
   - Esc leaves Customise mode, and cancels a drag first
2. **Each card**:
   - a handle, ← → buttons and an eye
   - rows inert while Customise is on (`inert` on the body)
   - hidden cards appear as placeholders with **Show**
3. **Dragging** from the handle only:
   - pointer events, capture and a 4 px threshold, as `Rail.tsx:182-345` does
   - the dragged card follows with `transform`
   - a drop marker comes from `dropNearest` over the cards' `getBoundingClientRect()` taken at
     drag start
   - Esc or a lost capture cancels
4. **Keyboard**: ⌥ + arrows on a focused card, with focus kept.
5. **Persistence**: `md.dashboard.layout` through `toSaved`, in try/catch.

**Review focus**: a click on a row never starts a drag, a swallowed click after a drag, and
keyboard reachability.

### Task 12: the phone and the web app

**Files**: `web/web.css`, the cards and `DashboardView.tsx`.

1. **Phone**, under `.app.phone.view-dashboard`:
   - Needs attention first, with `max: 5`
   - each card trimmed as the spec says (a `compact` prop)
   - Timeline's chips behind **Filter · All** in a sheet (reuse the phone's sheet styles,
     `PhoneFilters.tsx`)
   - touch targets of at least 40 px
2. **Web**:
   - the update row and **Restart** are hidden
   - ports are text, not links
   - **Merge…** and **Open PR** open GitHub (`openPr` does this already)
   - check that every `deck()` call the Dashboard makes is `invoke` or `event` in `DECK_ACCESS`,
     not `blocked`

### Task 13: the web preview's fixtures

**Files**: `web/preview/fixture.ts` and `web/preview/preview.tsx`.

1. **Fixtures**:
   - `teamPrs` with mine in each stage, a review request and one merged this week
   - a failing `watches` entry
   - `costBook` entries across two accounts
   - a `boardHistory` for the fixture sprint
2. **The preview deck**:
   - `activityList`: two days of events covering every type
   - `onActivityChanged`
   - `procsAll`: two sessions with ports and one stray
   - `schedList`, with a failed run
   - `janitor`: three rows
   - `tokensByDay`
3. **`?preview=empty`**: an empty state and empty answers for every card.

### Task 14: checks

1. **Run**, in `app`: `npm run typecheck`, `npm test` and `npm run build:web`.
2. **Web preview over CDP** (`npm run dev:web`, `/?preview` and `/?preview=empty`):
   - at 1440 × 900 and 390 × 844, in Light and in Dark
   - a screenshot of each card
   - each row's navigation (the view or popup it opens)
   - Needs attention:
     - **Reply…** expands the card
     - Dismiss for an inbox item (preview stub) and for a derived one, which comes back after a
       fingerprint change
   - Timeline's chips, range and selects
   - Customise:
     - a drag across rows
     - ⌥ → and ⌥ ↓
     - hide, Show and Reset
     - kept after a reload
   - phone: Needs attention first, the Filter sheet
3. **The isolated Electron app**, per the OPERATIONS recipe:
   - temp `MASTERDECK_HOME`, `MASTERDECK_USER_DATA` and `MASTER_HOME`, and
     `MASTERDECK_ISOLATED=1`
   - a stand-in `claude` on the PATH listing two sessions in temp repos
   - `MASTERDECK_BOARD_FIXTURE`
   - `npx electron . --remote-debugging-port=9333`
   
   Check that:
   - Dashboard is the first rail icon, and the palette has it
   - Settings → Open on Dashboard holds after a restart
   - `activity.jsonl` gains `session-started` when the stand-in lists a third session, and
     `ticket-moved` when the board fixture's status is changed
   - `procs:all` answers against this Mac's real `ps` / `lsof` (a `python3 -m http.server` in a
     session's temp folder, then killed)
   - the log survives a restart
   
   Never a real session, a real Needs-you item or a GitHub write.
4. **Idle CPU**: the isolated app idle for 2 minutes on Terminals, then 2 minutes on Dashboard.
   Use `top -l 3 -s 60 -stats pid,command,cpu,idlew` on its renderer. Record both in the PR. The
   Dashboard must not be higher.
5. **Final review**: one reviewer subagent over the whole branch diff against the spec. Its
   findings are fixed and re-checked.

### Task 15: docs (in the same commit as the last code change, or one docs commit before the PR)

- **`docs/GUIDE.md`**: a Dashboard section (each card, Customise, Open on, what the timeline
  records and from when, the commit-pushed caveat).
- **`docs/ARCHITECTURE.md`**: the Dashboard (files, pulls, the idle rules) and the activity log
  (file, events, coalescing, channels, the note rule).
- **`docs/REMOTE.md`**: `activity:list`, `activity:changed` and `procs:all`, open to the web.
- **`docs/TODO.md`**: Recently done (#183, with the commit), and the open points:
  - a merge action
  - Claude plan limits
  - #176's rows
  - a live procs list after #160
  - strays without ports
  - layout sync
  - backfill
- **`CLAUDE.md`**: a row in "Where things live", the Notes-style rule for the activity log's note
  entries in Gotchas, and a "Current state" bullet.
- **The spec's Files section**: the `InboxCard` refinement.

### Task 16: the PR

1. Commit, push the branch and open a **draft PR** that closes #183. Its body covers:
   - what changed
   - what was checked, and what was not
   - the idle numbers
   - screenshots via `/ui-screenshots`
2. MasterDeck watches it and sends review comments, conflicts and the merge. Act on comments and
   do not merge.
3. Do not rebuild or reinstall the real app until the user says so.

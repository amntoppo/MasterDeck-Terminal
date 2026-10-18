# Dashboard (#183): design

The information MasterDeck has is spread over a dozen views. The Dashboard is one view, first on
the rail, that answers four questions at a glance:

- **What needs me?**
- **What's happening now?**
- **What happened?**
- **How are things going?**

It is built from what the renderer already has. One new store, the activity log, records what
happened. Nothing new is polled (#160).

Mock-up (approved 2026-10-18): https://claude.ai/artifact/YNLSLuijAmcrApcaSsxtsj (a desktop page
with light/dark, empty, loading and Customise states, and a 390 px phone).

## Decisions

The user's, 2026-10-18:

1. **The Timeline comes from a new activity log** in main, fed by the state diffs main already
   makes and by events its stores already raise. There is **no backfill**: history starts on the
   day it ships.
2. **One PR** for the whole issue.
3. **An HTML mock-up was reviewed first** (approved).
4. **Usage & cost shows only data that exists**: cost and tokens per account, plus the warnings
   MasterDeck already sees (a turn that ended on an API error or rate limit, GitHub paused,
   tickets over budget). There is no new source for Claude plan limits.

Taken in this spec (the recommended ones):

5. **MasterDeck has no merge action, and this adds none.** **Merge…** opens the PR popup (the web
   app: the PR on GitHub).
6. **Processes, ports, stray processes and worktrees are read on demand**: when the dashboard
   opens and on a click, never on a timer.
7. **The layout is saved per device** (localStorage), and so is the web's *Open on* choice. The
   Mac's *Open on* is in Settings.
8. **Cards move only in Customise mode**, so a click on a row never starts a drag.
9. **A note's timeline entry never carries its title or text** (notes are private: CLAUDE.md).
10. **Cost entries gain an optional `account`**. Entries without one show as **Unknown account**.

## The view

- **Navigation**
  - `View` (`Sidebar.tsx`) gains `"dashboard"`.
  - It goes first in `RAIL_DEFAULT` (`shared/railOrder.ts`). `railOrder()` puts a missing default
    id after its predecessor, else first, so a saved custom order also gets it on top.
  - Its rail icon is four tiles: `ICONS.dashboard` in `Rail.tsx`, the path from the mock-up.
  - `WEB_VIEWS` and `SCREEN_NEEDS` (`renderer/src/web.ts`) gain it, with no needs.
  - The palette gains `view:dashboard`, "Go to Dashboard".
  - The phone bar's **More** list gains it. The fixed phone tabs are unchanged.
  - The `view` allowlist in `App.tsx` gains it.
- **Open on**
  - Settings → General gets a row **Open MasterDeck on: Last view · Dashboard**.
  - On the Mac it is `Settings.startView: "last" | "dashboard"`, default `"last"`, cleaned by
    `normalizeSettings` (anything else becomes `"last"`).
  - In the web app it is per browser, in localStorage `md.startView`, the theme's pattern. A
    browser never changes the Mac's value: `remoteSettings` drops `startView`.
  - The `view` initialiser in `App.tsx` uses it before the saved `view`. Settings arrive with
    the first state, so the Mac applies it once, on the first state, only if the user has not
    picked a view yet.
- **Layout**
  - The header reads **Dashboard** and "updated just now" (the state's `lastSnapshotAt`), with a
    **Customise** button.
  - Below it, Needs attention runs full width, then a CSS grid of the other five cards:
    `repeat(auto-fill, minmax(360px, 1fr))`. Timeline spans two columns where there are two or
    more.
  - At ≤ 760 px there is one column, and Needs attention is always first. That width is
    `usePhone()` in the web app, and a container width check in the window.
- **Each card** has:
  - a title and a count in plain words, e.g. "3 running"
  - a `title` tooltip on every number, saying what it counts
  - a **… →** link to the view it summarises
  - a static skeleton until its data is in: grey blocks, no animation
  - an empty state in a sentence
  
  Each card is `memo()`'d and gets only its slices.
- **Colours** are tokens only (`themes.lint.test.ts`):
  - red (`--red`) means act now, amber means soon, green means fine; nothing else is coloured
  - tier pills: **Now** red, **Soon** amber, **Ready** green, grey for information
  - Needs attention has a stronger frame (`--line-2`) and a `--bg-3` header band with a red
    "N now" pill
- **Times** are relative ("5 min ago", via `formatRefreshed` / `formatAgo`). They tick with
  `useNow(60_000)`, never faster.
- **Navigation** from any row goes through what App already has:
  - `openSession(s)` for a session
  - `openPr(url, issue, title, review?)` for a PR
  - `onIssue(issue)` for a ticket
  - `setView(v)`, or `setSettingsAt({section})` + `setView("settings")`, for a view

## Needs attention

`attentionItems(input, now): AttentionList`, pure, in `shared/dashboard.ts`.

```ts
type Tier = 'now' | 'soon' | 'ready' | 'info'
interface AttentionItem {
  id: string              // inbox id, or "pr:<url>:<why>", "run:<id>", "watch:<id>", "update:<version>"
  tier: Tier
  rank: number            // inbox priority; derived items: fixed below
  title: string           // "CI failed on your PR acme/web#218"
  why: string             // one line: "2 checks failing · session web-billing-221"
  at: number              // since when (ms)
  target: AttentionTarget // { session: key } | { pr: url } | { schedules: true } | { view: View } | { settings: section }
  actions: AttentionAction[]
  fingerprint: string     // derived items: what makes it news again after a dismissal
  inboxId?: string        // set for Needs-you items: acted on through inboxAct
}
type AttentionAction =
  | { type: 'inbox'; action: InboxActionType; label: string; primary?: boolean } // the item's own actions
  | { type: 'open' | 'review' | 'merge' | 'retry' | 'update'; label: string; primary?: boolean }
interface AttentionList { items: AttentionItem[]; total: number; now: number; more: number } // items: at most `max`
```

**Input**, all from the renderer:

- `inbox`, `sessions`, `prs`, `teamPrs`, `sessionPrs`, `me`, `ghAccounts` (logins)
- `watches`, `prWatches`
- `sched` (`SchedList | null`, from `sched:list`)
- `update` (`UpdateState | null`; null on the web)
- `dismissed` (this device's `{id, fingerprint}[]`)
- `max` (8 on desktop, 5 on the phone)

**What goes in, one item per subject:**

| Source | Tier | Rank | Title |
|---|---|---|---|
| `inbox.open` (never snoozed), priority ≥ 80 (input, menu, error, question, external, blocked) | now | priority | the item's title |
| `inbox.open`, 30 ≤ priority < 80 (account, loop, loop-paused, ci, proposal, review, budget, meeting, context) | soon | priority | the item's title |
| `inbox.open`, priority < 30 (waiting, idle, mods, notice, held) | info | priority | the item's title |
| My open, non-draft PR (`teamPrs`), `ci === "failure"` | now | 70 | CI failed on your PR *repo#n* |
| My PR, `reviewDecision === "CHANGES_REQUESTED"` | soon | 55 | Changes requested on *repo#n* |
| My PR, `unresolvedThreads > 0` (and not the row above) | soon | 50 | *n* unresolved threads on *repo#n* |
| A review requested from me: `prs[].reviewRequested`, or `teamPrs[].requested` holding one of my logins | soon | 45 | Your review is requested on *repo#n* |
| A schedule's last run `failed` in the last 24 h, with no later run of it | soon | 42 | Schedule "*name*" failed |
| A `watches` entry with `error`, or a `prWatches` row with `error` | soon | 40 | Monitor / PR watch "*name*" cannot read its source |
| My PR approved, `ci` success or null, no unresolved threads, not draft | ready | 20 | *repo#n* is ready to merge |
| `update.phase` `ready`, with an `offer` | info | 15 | MasterDeck *version* is ready to install |

- **"Mine"** means the author is `me`, or any login in `ghAccounts`.
- **Dedupe** works by subject:
  - An inbox item with a `sessionKey` covers that session's PRs (`sessionPrs[key]`) for the
    matching kind: `ci` covers CI failed, and `review` covers changes requested and unresolved
    threads.
  - An inbox item whose detail is an `offer` covers its PR.
  - A PR appears at most once. Its strongest reason wins (CI > changes > threads > ready), and
    the others go into `why`.
- **Sort** is stable: tier (now, soon, ready, info), then `rank` descending, then `at` ascending
  (waiting longest first), then `id`.
- **Dismiss**
  - An inbox item is dismissed through `inboxAct(id, "dismiss")`, as the Needs-you card does.
  - A derived item is hidden on this device while its `fingerprint` matches the stored one:
    - a PR: `ci|reviewDecision|unresolvedThreads|updatedAt`
    - a run: its run id
    - a watch: `error|errorAt`
    - an update: its version
  - Dismissals are stored in localStorage `md.dashboard.dismissed`, at most 200, and pruned of
    subjects no longer present.
- **The count** is "*n* things need you" with "*k* now" as a pill. `more = total − items.length`
  shows as "and *more* more in Needs you →".

**Actions**, all through paths that exist (never a card acting directly):

| Item | Buttons |
|---|---|
| Needs-you item | Its primary action (`inboxAct`), **Open** (the session) and **Reply…**, which expands the real Needs-you card (`InboxCard`, moved unchanged from `Sidebar.tsx` into `InboxCard.tsx`) under the row, so every kind (menu answers, options, proposals, trust…) acts exactly as in the Needs-you list, through `inboxAct` → `runInboxAction`. |
| My PR (CI, changes, threads) | **Open PR** (`openPr`), and **Open session** when a session owns it (`ownerOf`, shared/offers.ts) |
| Review request | **Review**: the PR popup (`openPr`), which has **Review with Claude**; the web app opens the PR on GitHub |
| Ready to merge | **Merge…** (`openPr`; the web app opens GitHub) |
| Failed run | **Retry** (`schedRunNow(id)`), and **Open** (Schedules) |
| Monitor / PR watch error | **Open** (the session's Details → GitHub, or Pull requests' Watched PRs) |
| Update | **Restart** (`updateRestart`; window only) |

Every row also has **Dismiss** (×). A row's title opens its target.

## Now

`nowView(input, now)`, pure:

- **Sessions**: listed sessions whose state is `working`, or `idle` with `busyWith` (background
  work), `waitingOn` (a monitor or wakeup) or `needs-input`, in that order.
  - Each row has the name, the account badge (`AccountBits`, only with two or more accounts),
    and a state chip: Working, Background command, Waiting on *x*, Needs you.
  - It shows for how long (`startedAt`), the ticket or task (`issue` + its card's title, else the
    session's first prompt summary if the state has it, else nothing), and the last tool and
    when (`tails[key].lastTool`, `lastToolAt`).
  - At most 6 rows, then "*n* more →" (Terminals). Empty state: "No session is working. Start
    one from the Board or with New."
- **Processes and ports** come from `procs:all` (below): the running processes with ports, and
  each port a link (`openPort`; blocked on the web, so there it shows as text).
  - There is a "Read *n* min ago" line with **Refresh**.
  - A process whose session is gone or done is not shown here; it goes to Health as stray.
- **Watching**:
  - `prWatches` rows: "PR watch · repo#n", with the last event time
  - `watches` (monitors), with the last event time
  - `autoReview.prs` whose status is `queued` or `reviewing`: "Reviewing repo#n". #176's
    parallel reviews add rows here when that lands.
- **Next runs**: the next three enabled schedules by `nextAt` (`sched:list`), with "tonight 02:00"
  style times.

## Timeline and the activity log

### Shape

```ts
// shared/activityLog.ts
type ActivityType =
  | 'session-started' | 'session-finished' | 'session-ended'
  | 'pr-opened' | 'pr-reviewed' | 'pr-merged' | 'pr-closed'
  | 'ticket-moved' | 'commit-pushed'
  | 'schedule-run' | 'meeting' | 'note-added'
  | 'release' | 'needs-you-answered'
interface ActivityEvent {
  id: string              // `${at}-${random}`
  at: number
  type: ActivityType
  title: string           // plain sentence: "#42 Fix token refresh moved In Dev → PR Raised"
  detail?: string         // second line: "acme board", "api-auth-42 · acme/api"
  account?: string        // the GitHub account, when known
  repo?: string           // owner/name, when there is one
  subject: string         // what it is about, for coalescing: "session:<key>", "pr:<url>", "ticket:<repo#n>", "run:<id>" …
  target?: ActivityTarget // { session: key } | { pr: url } | { ticket: Ticket } | { schedules: true } | { note: id } | { meeting: id }
}
```

### What records it

`diffActivity(prev: AppState | null, next: AppState, now): ActivityEvent[]` is pure. Main calls it
in the state callback beside `diffEvents`, wrapped in try/catch: a failure there never breaks the
callback.

- It returns `[]` when `prev` is null (a restart is not news).
- For each slice it skips when that slice was not loaded in `prev`:
  - `board` was null
  - `teamPrsAt` was null
  - the `agents` source was not healthy

| Type | When (prev → next) | Subject |
|---|---|---|
| session-started | A key that is new in `sessions` | `session:<key>` |
| session-finished | `working` → `idle` (no `busyWith`); coalesced (below) | `session:<key>` |
| session-ended | State → `done` or `suspended`, or a key that is gone (not one superseded by a copy) | `session:<key>` |
| pr-opened | A `teamPrs` url that is new, `createdAt` within the last hour, and mine or in a listed session's `sessionPrs` | `pr:<url>` |
| pr-reviewed | The same PR's `reviewDecision` changed to APPROVED or CHANGES_REQUESTED, or its `reviews` gained an entry | `pr:<url>` |
| pr-merged / pr-closed | `mergedAt` / `closedAt` newly set (mine or a session's) | `pr:<url>` |
| ticket-moved | A board card (same repo, number, project) whose `status` changed. Not derived cards; not a card that is new or gone. | `ticket:<repo#n>` |
| commit-pushed | `git[key].ahead` went from > 0 to 0 on the same `branch` and `dir`: "Pushed *n* commits to *branch*" | `push:<key>:<branch>` |

From main's stores, through one `activity.add(e)`:

- **schedule-run**: a run's status becomes `done`, `failed`, `skipped` or `stopped`. The
  scheduler gains an `onRun(run)` hook beside `onChange`.
- **meeting**: a meeting whose recording ended. The meetings store (`main/meetings/store.ts`) gains
  an `onEnded(meeting)` hook, called once when a stored meeting's `ended` is set; `meetingEvent`
  skips an empty recording that failed.
- **note-added**: a new note. `NotesStore` passes `created: true` on the change of a note that
  did not exist.
  - The event is "A note was added", or "A note was added to #42" for a ticket note, with
    `target: {note: id}`.
  - No title, no preview and no text. A test asserts this.
- **release**:
  - "Updated to *x* (from *y*)", from `UpdateState.updatedFrom` at launch, recorded once per
    version
  - "MasterDeck *x* is available", when an offer for a version not seen before appears
- **needs-you-answered**: the inbox's `resolved` event, with `resolvedHow` ("Allowed from
  desktop", "answered in the session"…).

### The store

`main/activityLog.ts`, `ActivityLog`:

- **File**: `<MASTERDECK_HOME>/activity.jsonl`, one event per line, appended.
- **Load**: it keeps the last 14 days, coalesces them (below), then keeps at most 5000 events.
  A line that does not parse is skipped. When it trimmed, skipped or coalesced a line, or the
  file's last line is torn (no final newline), it rewrites the file atomically (temp file +
  rename) from memory.
- **Growth**: after 5000 lines appended since the last load or rewrite, the file is rewritten
  the same way from memory, so it stays bounded while the app runs.
- **Coalescing**: an event of the same `type` and `subject` within 15 minutes of the last one
  replaces it in memory (time and title updated) and is appended. On the next load the newer
  line wins, matched by `type`, `subject` and the window.
  
  This keeps "session finished" from filling the feed with one line per turn, and a PR's state
  from flapping.
- **`list(since, until, limit = 1000)`**: newest first.
- **Change notice**: `onChange()` is throttled to one call per 2 s, which emits
  `CH.activityChanged`.
- **Errors**: a write failure is logged once per minute and dropped. The log never throws into a
  caller.

### Channels

- `CH.activityList`, `activity:list(since: number, until: number)` → `ActivityEvent[]`.
  - Main checks that both are finite numbers, that `since ≤ until`, and that the range is at
    most 31 days; otherwise `[]`.
  - `DECK_ACCESS`: `remote`.
- `CH.activityChanged`: an event with no payload. `DECK_ACCESS`: `event`.
- Not in `AppState` and not in `toRemoteSnapshot`, so it adds nothing to the state or to the web
  bridge's frame budget (#168).

### The card

- **Range**: `RangeChoice` from `shared/timeline.ts` with the presets **Today**, **Yesterday**
  and **7 days**, drawn with the Costs picker's look (a segmented control). The default is Today.
- **Type chips**: All, Sessions, PRs, Tickets, Commits, Schedules, Meetings and notes,
  Needs you.
- **Selects**: account, and repo (from the events in range).
- **Persistence**: the filters are kept per device in `md.dashboard.timeline`.
- **Filtering** is pure: `filterActivity(events, {types, account, repo})`.
- **Rows** are grouped by day under sticky day labels. Each row shows the time (`HH:mm`), a
  type tag (SES, PR, TKT, GIT, RUN, NOTE, YOU) and the title, with the detail below it.
  - A row opens its target.
  - The list scrolls inside the card (max-height 360 px) and shows 200 rows, then **Show more**.
- **Reads**: `activity:list` for the range when the card mounts, when the range changes, and on
  `activity:changed`. There is no timer.
- **Empty states**:
  - "Nothing happened yet today."
  - Filtered: "Nothing of this kind happened in this range."
  - In the first week: "The timeline starts recording on *date*."

## Delivery

`deliveryView(input, now)`, pure.

**The sprint**: `board` cards of the selected sprint.

- **Counts** are per board column in `board.columns` order, using the board's own names: no
  renaming and no fixed four. They are drawn as a stacked bar with a legend; each column's
  colour comes from a fixed token sequence.
- **Burndown**: `burndown(boardHistory[sprint], start, days)` from the `sprints` entry
  (`startDate`, `duration`). It is a sparkline with an ideal dashed line, plus "*n* left, *m*
  planned" for today.
- **No sprint field** (sprintless board): the counts show without a burndown.
- **Derived board**: "No sprint: this account has no GitHub board", and the column counts.
- **No board**: "No board yet. Pick one in Setup, or create a GitHub board."

**PRs**, from `teamPrs` (mine as defined above):

- **KPIs**:
  - mine open
  - waiting on you (review requests)
  - merged this week (my PRs with `mergedAt` in the last 7 days)
  - ready to merge
- **By stage**: Draft · In review · Changes requested · Approved.
- Each KPI opens Pull requests on its preset tab: Mine, Needs my review, Recently merged.

## Usage & cost

`usageView(input, now)`, pure.

- **`CostEntry.account?: string`**: main sets it in `Sources` where it builds the entries, from
  the session's `account` (`s?.account`). `recordCosts` stores it on `SessionCost.account` when it
  is given and keeps an older one otherwise. `validBook` accepts it as optional.
- **Today and this week**: cost (`sessionSpendIn` over `costBook`, the range from
  `resolveRange`) and tokens (`tokensByDay(ids)`, read when the set of ids changes, as CostsView
  does).
- **Per account**: a table of today, the week and tokens per account. Entries with no account
  are listed as **Unknown account**. With one account there is no table, only the totals.
- **Trend**: a 7-day cost sparkline (`dailySpend`).
- **Top sessions this week**: the top 3 by cost, each opening its session when listed.
- **Warnings** (amber), each with an action:
  - a session whose `hookInfo[key].failure` is within 24 h: "*name* stopped on a rate limit 40
    minutes ago", with **Open session**
  - `ghCache.pausedUntil` in the future: "GitHub is paused until 15:20 (rate limit)"
  - tickets over `settings.budgetPerTicketUsd` (`ticketSpend`), with **Costs**

## Health

`healthView(input)`, pure. It returns rows of `{ id, status: 'ok' | 'warn' | 'bad' | 'unknown',
label, detail, action? }`. When every row is ok the card shows **All good** and lists them only in
a collapsed "Details".

| Row | ok | warn / bad |
|---|---|---|
| Remote | `remote.conn` connected (and the browsers connected) | connecting / error (its `message`) / off when enabled |
| GitHub | every `ghAccounts` healthy, no `ghCache.pausedUntil`, no `boardError` / `teamPrsError` | the first problem, in words |
| Claude | `sources.agents` ok | its error; `missingBinaries` |
| Hooks and status line | `hooks` installed (the status line is optional: without it the row stays ok, "status line off") | a hook missing, with **Fix** (Settings → Hooks, mods & skills) |
| Errors | `errors` empty | the first one, "and *n* more" |
| Stray processes | none found | "vite :5174 in web, not started by a session" with **Show** (it expands the list, each with its port and folder) |
| Worktrees | "Not checked", with **Check worktrees** | after a check: "*n* can be removed →" (Janitor) |
| MasterDeck | the version, up to date | an update available or ready (**Restart to update**), an update error |

The MasterDeck row and the update action are the window's only. On the web `useUpdate()` is null
and the row is hidden.

## On-demand reads

- **`procs:all`**: `CH.procsAll`, `procsAll()` → `ProcsAll`.

  ```ts
  interface ProcsAll {
    at: number
    sessions: Record<string, SessionProc[]>  // by Session.key: running processes only
    strays: StrayProc[]
  }
  interface StrayProc { pid: number; command: string; cwd: string | null; ports: Listen[]; startedAt: number; folderOf: string | null }
  ```

  `SessionProcs.listAll(sessions)` runs **one `ps` and one `lsof`** for every listed session with
  a pid (it reuses `parsePs`, `sessionGroups` and `parseLsof`). It does not touch the per-session
  `seen` state that Details uses.
  
  A **stray** is a process listening on a TCP port whose cwd is inside a listed session's folder
  or one of its worktrees (`sessionWorktrees`) and that is not below any running session's pid.
  It is found from one `lsof -nP -iTCP -sTCP:LISTEN` and the same `ps` table.
  
  `folderOf` names the session folder it sits in. The read is `remote` in `DECK_ACCESS`. On
  Windows it answers `{ at, sessions: {}, strays: [] }` and the rows say "Not available on
  Windows".
  
  ponytail: strays are found only for processes with ports. A stray without a port is not seen,
  and the fix is a full table walk per check.
- **`janitor`**: the existing `janitor(liveDirs(state), false)`, already `remote`. It runs on
  **Check worktrees** only.
- **When**: both are read when the Dashboard mounts and on their buttons.

  `procs:all` is also read again when the set of working sessions changes, at most once a minute.
  The last answers are kept in a module-level cache for the window's life, so switching views
  does not read again within a minute.

## Customise

- **The layout**: `shared/dashboardLayout.ts`.
  - `type CardId = 'now' | 'timeline' | 'delivery' | 'usage' | 'health'`. Needs attention is
    fixed and not in the layout.
  - `DASH_DEFAULT = ['now', 'timeline', 'delivery', 'usage', 'health']`.
  - `interface Layout { order: CardId[]; hidden: CardId[] }`. `{ order: [], hidden: [] }` is the
    default, so a later default applies in full.
  - `cleanLayout(raw)` keeps known ids, without repeats.
  - `layoutOrder(saved)`: a new card goes in after its predecessor in the default, else first,
    as `railOrder` does.
  - `moveTo(order, id, before)`, `moveStep(order, id, dir)`, `isDefault(layout)`,
    `toSaved(layout)`.
  - `dropNearest(rects, x, y)`: the index of the card whose centre is nearest the pointer, and
    whether the drop goes before or after it, by the pointer's side of that centre on the main
    axis.
- **Storage**: localStorage `md.dashboard.layout`, per device, wrapped in try/catch. A failed read
  means the default.
- **Customise mode**:
  - The header button **Customise** swaps for a hint ("Drag a card by its handle, or press ⌥ and
    an arrow. The eye hides it."), **Reset** and **Done**.
  - Each card's header shows a drag handle, ← → buttons and an eye. Rows do not navigate while it
    is on.
  - Hidden cards appear as slim "*Card* is hidden · **Show**" placeholders at the end of the
    grid.
  - **Esc** leaves Customise mode, and cancels a drag first.
- **Dragging**:
  - It works only from the handle. It uses pointer events and capture, with a 4 px threshold.
    The dragged card follows the pointer (`transform`), and an accent drop marker shows where it
    lands. Esc or a lost capture cancels.
  - ⌥←/→ or ⌥↑/↓ on a focused card moves it one place, and focus stays on it.
- **Reset** writes the default layout (it is disabled while the layout is the default).

## Speed and idle CPU (#160)

- **Slices**: `DashboardView` picks each card's slices with `useMemo` keyed on those slices,
  never on `state` as a whole. Cards are `memo()`'d. Derivations are the pure functions above.
- **Clocks**: `useNow(60_000)`, and `now` is rounded to the minute in sums.
- **No animation**: no `@keyframes` and no transitions on the view, apart from the drag
  transform. Skeletons are static.
- **No timer**: reads are on mount, on a click, or on an existing event (`activity:changed`,
  `sched:changed`, `update:changed`). There is no `setInterval` anywhere in the Dashboard.
- **Unmount**: the view unmounts when another view is picked, as views do today.

## The web app and the phone

- **The same view**:
  - Rows the web cannot act on are hidden or drawn as text: the update row, a port's open link,
    and **Restart**.
  - Needs-you actions go through the bridge as on the Needs-you list (`inboxAct` is `remote`; the
    window-only kinds stay refused as today).
  - The PR popup opens GitHub.
- **Phone (≤ 760 px)**:
  - one column, Needs attention first and capped at 5 rows
  - each card trimmed (Now: the session lines and one summary line; Timeline: the range control
    and **Filter · All**, which opens the chips in a sheet; Delivery: the bar and two KPIs; Usage:
    two KPIs and the accounts; Health: the summary)
  - touch targets of at least 40 px
  
  The CSS lives under `.app.phone.view-dashboard` in `web/web.css`.
- **Web preview (`/?preview`)**: fixtures for every card:
  - activity events over two days
  - `procsAll` with a stray
  - `schedList` with a failed run
  - my PRs in every stage, and a review request
  - a failing monitor
  - a cost book across two accounts
  
  `?preview=empty` shows every empty state.

## Files

As built.

New:

- `shared/activityLog.ts` (+ test): `diffActivity`, the stores' mappers (`runEvent`,
  `meetingEvent`, `noteEvent`, `releaseEvents`, `inboxEvent`), `coalesce`, `filterActivity`,
  `mergeActivity`, `activityRows`, `cleanEvent`, `forRemote`
- `main/activityLog.ts` (+ test): `ActivityLog`
- `shared/dashboard.ts` (+ test): `attentionItems`, `pruneDismissed`, `nowView`, `deliveryView`,
  `usageView`, `healthView`, `relTime`
- `shared/dashboardLayout.ts` (+ test)
- `renderer/src/components/DashboardView.tsx`
- `renderer/src/components/dashboard/{Card,AttentionCard,NowCard,TimelineCard,DeliveryCard,UsageCard,HealthCard,Sparkline}.tsx`
- `renderer/src/components/dashboard/nav.ts` (`DashNav`, `go`) and `customise.ts` (`useCustomise`)
- `renderer/src/components/InboxCard.tsx` (moved from `Sidebar.tsx`, unchanged)
- `renderer/src/useStable.ts` (+ test): keeps a derived value's reference while its JSON is the same
- `web/preview/dashboardFixture.ts`

Changed:

- Shell:
  - `Sidebar.tsx` (`View`)
  - `shared/railOrder.ts` (+ test)
  - `Rail.tsx`
  - `web.ts` (+ test; `webStartView`, `setWebStartView`)
  - `CommandPalette.tsx`
  - `App.tsx`
  - `HygieneViews.tsx` (`liveDirs` exported)
- Settings:
  - `shared/settings.ts` (+ test, `startView`)
  - `SettingsView.tsx`
  - `main/remoteGuards.ts` (+ test; `remoteSettings` keeps the Mac's `startView`)
- Channels and wiring:
  - `shared/ipc.ts` (`activityList`, `activityChanged`, `procsAll`)
  - `preload/index.ts`
  - `shared/remoteDeck.ts` (+ test)
  - `main/index.ts` (handlers, `diffActivity` beside `diffEvents`, `logActivity`, `processStart`,
    the store hooks)
- Stores:
  - `main/sched.ts` (+ test, `onRun`)
  - `main/meetings/store.ts` (+ test, `onEnded`) and `main/meetingsIpc.ts` (`onMeetingEnded`)
  - `main/notes.ts` (+ test) and `shared/notes.ts` (`created` on `NoteChange`)
  - `main/sessionProcs.ts` (+ test; `listAll`, `strayFolders`) and `shared/sessionProcs.ts` (+ test;
    `ProcsAll`, `StrayProc`, `findStrays`, `insideFolder`, `commandName`)
  - `shared/costs.ts` (+ test) + `main/sources.ts` (`account`)
- Sidebar:
  - `Sidebar.tsx` (imports `InboxCard`)
- Styles and preview:
  - `styles.css`
  - `web/web.css`
  - `web/preview/fixture.ts`, `web/preview/preview.tsx`

No `AppState` field is added, so `shared/notify.test.ts`'s fixture and `toRemoteSnapshot` are
unchanged.

## Tests

- **`attentionItems`**:
  - the tier boundaries (79/80, 29/30)
  - snoozed items left out
  - each derived source
  - "mine" across several accounts
  - the dedupe against inbox `ci` / `review` / `offer` items and between a PR's own reasons
  - the sort with every tie-break
  - dismissals and their fingerprints coming back
  - the cap and `more`
- **`diffActivity`**:
  - each type, positive and negative
  - the first state is silent
  - a slice that was not loaded is silent
  - a copy's superseded key is not "ended"
  - someone else's PR is not logged
  - a branch switch is not a push
  - derived cards are not moved
- **`ActivityLog`** (temp dir):
  - append and list
  - the 14-day and 5000-line trim, rewritten atomically
  - a corrupt line skipped
  - coalescing within 15 minutes, and on reload
  - a write failure swallowed
  - the throttled change notice
- **Note privacy**: a note's activity event carries no title, preview or text.
- **`nowView`, `deliveryView`, `usageView`, `healthView`**:
  - with data, empty and loading inputs
  - a derived board, and no board
  - one account against two, and Unknown account
  - each health row's states
- **`dashboardLayout`**:
  - clean
  - a new card merged into a saved layout
  - moves
  - `dropNearest` in a 3 × 2 grid
  - hidden cards keep their place
  - default ↔ empty
- **Shell**:
  - `railOrder` with `dashboard` (a saved order gains it on top)
  - `normalizeSettings` for `startView`, and the remote settings patch drops it
  - `DECK_ACCESS` for the new channels
  - `WEB_VIEWS`
- **`SessionProcs.listAll`**: fixture `ps` / `lsof` output, one call each, and strays only with
  ports inside a session folder.
- **`recordCosts`** with and without `account`, and an old `costs.json` still reads.

## Out of scope

- A merge action.
- Claude plan or rate-limit usage.
- Backfilling the activity log.
- #176's parallel reviews (rows are added when it lands).
- A live process list, until #160 brings a shared scheduler.
- Syncing the layout between devices.
- Activity events on the phone/API snapshot.

## Open points to watch in review

- **Commit-pushed** is inferred from `ahead` dropping to 0, so a `git reset` to the upstream
  reads as a push. It is accepted and named in the GUIDE.
- **Session-finished coalescing** makes a busy session show one line per 15 minutes, not per
  turn. It is tunable.

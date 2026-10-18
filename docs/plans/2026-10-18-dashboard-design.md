# Dashboard (#183): design

One view, first on the rail, that answers four questions at a glance: **What needs me? What's
happening now? What happened? How are things going?** It is built from what MasterDeck already
has, plus one new store (the activity log). Nothing new is polled.

The user's decisions (2026-10-18):

- The Timeline comes from a **new activity log** in main. It is fed by the state diffs main
  already makes, with no backfill: history starts on the day the dashboard ships.
- **One PR** for the whole issue.
- An **HTML mock-up** is reviewed before any app code is written.
- **Usage & cost** shows only data that exists: cost and tokens per account, and the warnings
  MasterDeck already sees. No new source for Claude plan limits.

## Decisions

### The view

1. **`dashboard` is a new `View`** (`Sidebar.tsx`). It is first in `RAIL_DEFAULT` and gets an
   `ICONS` entry. `railOrder()` puts a missing default id after its predecessor, else first, so
   users with a saved rail order also get it at the top. It is also added to `WEB_VIEWS`, to
   `SCREEN_NEEDS` (none), to the palette as `view:dashboard` ("Go to Dashboard") and to the phone
   bar's **More** list. The fixed phone tabs stay as they are.
2. **Open on**: a setting under Settings → General → **Open MasterDeck on**: *Last view*
   (default, today's behaviour) or *Dashboard*. On the Mac it is `Settings.startView`
   (`'last' | 'dashboard'`). In the web app it is per browser, like the theme (`md.startView`),
   because a browser never changes the Mac's choice. The `view` initialiser in `App.tsx` reads it.
3. **A grid of cards**, CSS grid with `auto-fill, minmax(340px, 1fr)`. Needs attention spans the
   full width; the others take one column, and Timeline spans two where there is room. At
   ≤ 760 px (`usePhone()`, and the same width in the window) the cards stack in one column, with
   Needs attention always first whatever the saved order.
4. **Every card** has:
   - a title with a count, e.g. "Needs attention · 4"
   - a body, an empty state in plain words ("Nothing needs you. 🎉" is not our style: "Nothing
     needs you right now.")
   - a **View all →** link to the view it summarises
   - while its data has not arrived, a **static** skeleton: grey blocks with no animation (#160).
   
   Every row is a button that goes where the row is about: the session (`openSession`), the PR
   popup (`openPr`), the ticket (`onIssue`), or a view (`setView`, or Settings at a section).
5. **Colour sparingly**: red = act now, amber = soon, green = fine, through tokens only (`--red`,
   `--amber`, `--green`; `themes.lint.test.ts`). Everything else is `--text` / `--muted` on
   `--bg-2`. Needs attention gets a stronger frame (`--line-2`, a `--bg-3` header band and a red
   "N now" pill) so it stands out and the rest stays calm. Tiers show as pills: **Now** (red),
   **Soon** (amber), **Ready** (green), and grey for information.
   Mock-up: https://claude.ai/artifact/YNLSLuijAmcrApcaSsxtsj (desktop interactive + phone).
6. **Plain words, every number explained**: each count and KPI carries a `title` tooltip that says
   what it counts ("3 of your open PRs have a failing check"). Relative times use
   `formatRefreshed` ("5 minutes ago"), ticked by `useNow(60_000)`, never faster.

### Cards and their data

| Card | Data (all already in the renderer unless noted) | View all → |
|---|---|---|
| Needs attention | `inbox.open`, `sessions` (needs-input, asking), `prs` / `teamPrs` / `prLive` / `prStage`, `watches[].error`, `prWatches`, schedule runs (`sched:list`, push), `useUpdate()` (window only) | Terminals (Needs you) |
| Now | `sessions` (working / `busyWith` / `waitingOn`), `tails` (last tool, last activity), `stats`, `startedAt`; `watches`, `prWatches`, `autoReview`, `loops`; next runs from `sched:list`; processes and ports from one `procs` read (below) | Terminals |
| Timeline | **new** `activity:list` (+ `activity:changed`) | (none; the card is the feed) |
| Delivery | `board` + `summarize()` (sprintSummary), `burndown(boardHistory[sprint])`, `teamPrs` (mine by stage, waiting on me, merged this week) | Board, Pull requests |
| Usage & cost | `costBook` (+ account, below), `tokensByDay(ids)` pulled when the ids change (as CostsView), `hookInfo[*].failure`, `ghCache.pausedUntil`, budget (`settings.budgetPerTicketUsd`) | Costs |
| Health | `remote`, `browsers`, `ghAccounts`, `ghCache`, `sources`, `errors`, `boardError`, `teamPrsError`, `missingBinaries`, `statuslineInstalled`, `hooks`, `mods`; `useUpdate()`; Janitor and stray processes on demand (below) | Settings / Janitor |

### Needs attention: what goes in, and the order

7. **One pure function**, `attentionItems(input, now)` in `shared/dashboard.ts`, builds the list.
   Each item has `{ id, tier: 'now' | 'soon' | 'fyi', rank, title, why, at, target, actions }`.
   Most of the urgency tests cover this function.
8. **Sources, deduplicated** (one item per subject):
   - **Needs-you items** (`inbox.open`, never the snoozed ones): tier from the inbox `PRIORITY`.
     ≥ 80 is *now* (input, menu, error, question, external, blocked); 30-79 is *soon* (account,
     loops, ci, proposal, review, budget, meeting, context); below 30 is *fyi* (waiting, idle,
     notice, mods, held). `rank` = the inbox priority. The inbox already covers sessions waiting
     for input or permission and failed CI on a session's PR.
   - **My PRs** (`teamPrs`, `authorIsMe`, open, not draft) that no Needs-you item already covers
     (matched by PR url, or the session's ticket):
     - failing CI → *now*
     - changes requested → *soon*
     - unresolved threads → *soon*
     - approved, CI green and no threads → **ready to merge**, *fyi* (green)
   - **Review requests for me** (`requested` holds `me`, or one of my teams) → *soon*.
   - **Failed schedule runs** in the last 24 h that were not run again after → *soon*.
   - **Monitors / PR watches** with `error` → *soon*.
   - **Update available** (`useUpdate().offer`, the window only) → *fyi*.
9. **Sort**: by tier (*now* > *soon* > *fyi*), then `rank` (higher first), then the one waiting
   longest first (older `at`). Ties break by id, so the order is stable and does not jump between
   renders.
10. **One-click actions**, each going through the path that already exists:
    - **Open**: go to the subject.
    - **Reply**: the item's inbox `reply` / `option` / `menu` actions, rendered with the same
      compact controls the Needs-you card uses (extract that small piece of `Sidebar.tsx` into
      `InboxActions.tsx` rather than copying it).
    - **Review**: `openPr(url, …, review = true)`.
    - **Merge**: opens the PR popup on its merge-ready state. MasterDeck has no merge write, and
      adding one is out of scope; on the web it opens the PR on GitHub.
    - **Retry**: `schedRunNow` for a failed run; the inbox `retry` for an inbox item.
    - **Dismiss**: `inboxAct(id, 'dismiss')` for inbox items. A derived item (a PR, a run, a
      monitor) is hidden on this device until its fingerprint changes (e.g. a PR's
      `ci + reviewDecision + unresolvedThreads + updatedAt`), in `md.dashboard.dismissed` (at most
      200, pruned when the subject is gone).
    
    Actions run only through `inboxAct` / `runInboxAction` (the CLAUDE.md rule), never straight
    from the card. The dashboard never answers a Needs-you item by itself.
11. **At most 8 rows**, then "and 5 more →" to Terminals (Needs you). The title says it in words:
    "4 things need you · 2 now".

### Now

12. **Running sessions**: state chip, account badge (`AccountBits`), the ticket or task, how long
    (from `startedAt`), and the last tool or line (`tails.lastTool`, `lastActivityAt`). Ordered
    working → busy → waiting.
13. **Processes and ports**: no timer. When the dashboard opens, one read covers every listed
    session: a new `procs:all` that runs `ps` and `lsof` once (the `SessionProcs` parsers already
    group by session). It is read again only on the card's **Refresh**, or when the set of
    working sessions changes, at most once a minute. On the web it is the same read; opening a
    port stays blocked there (`openPort`).
    
    ponytail: one read per open plus a manual refresh; a live list is a later choice once #160
    settles a shared scheduler.
14. **Monitors and PR watches** (`watches`, `prWatches`), with last event time and error.
    **Reviews in progress**: `autoReview` runs and review sessions (`kind`). #176 is not built yet;
    the card shows what `autoReview` has, and #176 adds its own rows when it lands.
15. **Next scheduled runs**: the next three `nextAt` from `sched:list` (push-driven, already used
    by SchedulesView).

### Timeline: the activity log

16. **`shared/activity.ts`**:
    - `ActivityEvent = { id, at, type, title, account?, repo?, target }`
    - the type list: `session-started | session-ended | pr-opened | pr-reviewed | pr-merged |
      ticket-moved | commit-pushed | schedule-run | meeting | note-added | release |
      needs-you-answered`
    - **`diffActivity(prev, next, now)`**, pure, is called in main next to `diffEvents` on every
      state. It returns nothing on the first state (`prev === null`), and nothing for a slice
      whose previous value was still loading (`board === null`, `teamPrs` before the first read),
      so a restart does not flood the log.
    
    What it derives:
    - **session-started**: a key that is new.
    - **session-ended**: state → `done`, or a key gone. Not every turn end: that is too noisy.
    - **pr-opened / pr-merged**: a `teamPrs` url that is new, or whose `mergedAt` was just set. Only
      PRs that are mine or that a listed session made.
    - **pr-reviewed**: `reviewDecision` changed, or a new entry in `reviews`.
    - **ticket-moved**: a board card's `status` changed. This catches moves made by MasterDeck and
      on GitHub alike.
    - **commit-pushed**: `git[key].ahead` dropped to 0 on the same branch. That is a push seen
      without reading git again.
    **Events from stores**, not from the state:
    - **schedule-run**: when a run finishes, `scheduler`'s change event.
    - **meeting**: a meeting saved.
    - **note-added**: `NotesStore`'s change. It carries only "A note was added" or "Ticket note
      added to #42" and the note's id, **never its title or text** (notes are private, CLAUDE.md).
    - **release**: the app version at launch differs from the last one recorded (installed), or a
      new update offer appears.
    - **needs-you-answered**: the inbox's `resolved` event, with how it was resolved.
17. **`main/activity.ts` `ActivityLog`**:
    - appends to `<MASTERDECK_HOME>/activity.jsonl`
    - on load, keeps 14 days and at most 5000 lines, and rewrites atomically (temp file + rename)
      when it trimmed
    - holds the list in memory
    - `list(since, until)`
    - emits `activity:changed`, throttled to one per 2 s
    
    A write failure is logged and dropped: the log never breaks the state callback.
18. **Channels**: `activity:list(since, until)` → `ActivityEvent[]` (at most 1000, newest first)
    and the `activity:changed` event. `DECK_ACCESS` has the list as `remote` and the event as
    `event`, so the web app reads it too. It is **not in `AppState`**: no state growth, and no
    budget pressure on the web bridge's 1.05 MB frame.
19. **Filters**: type (chips), account, repo, and range (**Today / Yesterday / 7 days**) with the
    same range model and picker look as Costs (`shared/timeline.ts`, `resolveRange`). Filtering is
    pure, `filterActivity(events, f)`. Filters persist per device (`md.dashboard.timeline`). Rows
    are grouped by day, scroll inside the card (fixed max height), and show at most 200 with
    "Show more".

### Delivery

20. **The sprint**: Todo / In Dev / PR Raised / Done counts from `summarize(board)`, mapped to the
    board's own column names (no renaming), with a burndown sparkline from
    `burndown(boardHistory[sprint.title], …)`. With a derived board (no GitHub project) the card
    says "No sprint: this account's board is derived" and shows the column counts only. With no
    board at all it shows the empty state.
21. **PRs**:
    - mine by stage (draft · in review · changes requested · approved), from `teamPrs`
    - waiting on me (review requested)
    - merged this week (`mergedAt` in the last 7 days)
    
    Each count opens the Pull requests view on the matching preset tab.

### Usage & cost

22. **Per account**: `costBook` entries carry no account today. Add an optional `account` to
    `CostEntry`, set by main when it records a cost (from `sessionAccounts`). Older entries, and
    sessions with no recorded account, show as **Unknown account**, as Hours does. One account
    shows no split.
23. **Today and this week**: cost and tokens per account, a 7-day cost sparkline (`dailySpend`),
    and the top 3 sessions by cost this week. Tokens come from `tokensByDay(ids)`, pulled only
    when the set of ids changes (as CostsView).
24. **Warnings**:
    - sessions whose last turn failed on an API error or rate limit (`hookInfo[*].failure`, in the
      last 24 h)
    - GitHub paused (`ghCache.pausedUntil`)
    - tickets over budget (`settings.budgetPerTicketUsd`)
    
    No Claude plan limits: MasterDeck has no such data (decision above).

### Health

25. Green "All good" when nothing below is wrong; otherwise one row per problem:
    - **Remote** (`remote.conn` and `message`, the browsers connected)
    - **GitHub** (`ghAccounts` with a failing token, `ghCache` paused, `boardError`,
      `teamPrsError`)
    - **Claude** (`sources.agents` error, `missingBinaries`)
    - **Hooks / status line / mods** not installed
    - **Errors** (`errors[]`)
    - **App version and update**, the window only: `useUpdate()` is blocked on the web
26. **Janitor and stray processes are on demand**: a **Check worktrees** button runs
    `janitor(liveDirs, false)` (gh cache, not forced) and shows "3 worktrees can be removed →".
    Stray processes come from the same `procs:all` read as Now: processes whose session is gone or
    done. The last result is kept for the window's life; nothing runs by itself.

### Customise

27. **The layout**, in `shared/dashboardLayout.ts`:
    - `{ order: CardId[], hidden: CardId[] }`
    - `cleanLayout` / `layoutOf(saved)`: unknown ids dropped, new cards put after their predecessor
      in the default, as `railOrder` does
    - `moveTo`, `moveStep`
    - `isDefault`
    
    Stored **per device** in localStorage `md.dashboard.layout` (the issue: "Save the layout per
    device"). `[]` means the default, so later defaults apply in full.
28. **Customise mode**: a **Customise** button on the view's header turns it on. Cards then show a
    drag handle and an eye toggle (hide / show), and the rows stop navigating. Hidden cards appear
    as slim placeholders at their place so they can be shown again. **Reset** and **Done** sit in
    the header.
    
    Drag works only in this mode, so a click on a row never starts a drag. It uses pointer events,
    as on the rail (#170): a 4 px threshold, pointer capture, a drop marker and Esc to cancel. The
    target is the card whose centre is nearest the pointer in 2-D (`dropNearest`, pure and
    tested). Keyboard: ⌥←/→ or ⌥↑/↓ on a focused card moves it one place.

### Speed and idle CPU (#160)

29. **Each card is `memo()`'d** and gets only its slices, picked by `useMemo` in `DashboardView`
    and keyed on those slices, never on the whole `state`. Derivations are pure functions in
    `shared/`. Clocks run at 60 s (`useNow(60_000)`), with `now` rounded to the minute for sums.
    No CSS animations: skeletons are static. While the view is hidden (another view selected) it
    is unmounted, as views are today.
30. **Pulls**:
    - `activity:list`: on open and on `activity:changed`
    - `sched:list`: push
    - `tokensByDay`: when the ids change
    - `procs:all` and `janitor`: on open, or by a click
    
    No `setInterval`.

### Everywhere

31. **Web app**: the same view. Parts blocked on the web hide themselves:
    - the update row (`useUpdate` is null)
    - opening a port
    - Check worktrees, if `janitor` is blocked: check `DECK_ACCESS`
    
    `procs:all` and `activity:list` are `remote` reads.
32. **Phone**: one column, Needs attention first, the card bodies trimmed (5 rows, then "more →"),
    and the Timeline's filters folded into one **Filter** button.
33. **Web preview** (`/?preview`): fixture data for every card (activity events, procs, sched
    runs), so the mock-up's states can be checked in the real view.

## Out of scope

- A merge action (needs a GitHub write and its own decision).
- Claude plan or rate-limit usage.
- Backfilling the activity log.
- #176's parallel reviews (the card shows them once that lands).
- Any new polling (#160 owns the scheduler).

## Code

New:

- `shared/dashboard.ts`: `attentionItems`, `nowRows`, `deliverySummary`, `usageByAccount`,
  `healthRows`, with tests
- `shared/dashboardLayout.ts`: the layout, `dropNearest`, with tests
- `shared/activity.ts`: types, `diffActivity`, `filterActivity`, with tests
- `main/activity.ts`: `ActivityLog`, with tests
- `renderer/.../DashboardView.tsx` and `dashboard/*.tsx`, one file per card
- `renderer/.../InboxActions.tsx`, extracted from `Sidebar.tsx`

Changed:

- `Sidebar.tsx` (`View`)
- `shared/railOrder.ts` (default)
- `Rail.tsx` (icon, phone More)
- `web.ts` (`WEB_VIEWS`)
- `CommandPalette.tsx`
- `App.tsx` (route, start view, `onIssue` / `openPr` / `openSession` passed in)
- `shared/settings.ts` (`startView`) and `SettingsView.tsx`
- `shared/ipc.ts` (`activity:*`, `procs:all`) and `preload/index.ts`
- `shared/remoteDeck.ts` (`DECK_ACCESS`)
- `main/index.ts` (handlers, `diffActivity` beside `diffEvents`, store events)
- `shared/costs.ts` and the cost recorder (`account`)
- `styles.css` and `web/web.css` (phone)
- `web/preview/*` (fixtures)

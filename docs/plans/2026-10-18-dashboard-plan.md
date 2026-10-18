# Dashboard (#183): plan

Design: [2026-10-18-dashboard-design.md](2026-10-18-dashboard-design.md). One branch, one PR.

The work is done subagent by subagent. Each task is reviewed before the next one starts, and the
whole branch gets a final review. Pure logic is written test first.

## Gate 0: mock-up (before any app code)

0. An HTML mock-up artifact for the user to review:
   - the six cards with fixture data, in light and dark (the real tokens)
   - desktop at 1440 px and the phone at 390 px
   - Customise mode
   - the empty states and skeletons
   - Needs attention with each kind of item and its actions
   
   Comments from the review go back into the design doc. **Nothing below starts until the user
   approves it.**

## Tasks

1. **The activity log's logic** (`shared/activity.ts`, TDD). Write the types and
   `diffActivity(prev, next, now)`. Each event type gets a test, each with a "first state is
   silent" and a "loading slice is silent" case:
   - a session starting, and ending
   - a PR opened, reviewed and merged (mine, or a listed session's, and not someone else's)
   - a ticket moved (a card's status changed; a card that is new, or one removed, is not a move)
   - a commit pushed (`ahead` → 0, same branch; a branch switch is not a push)
   
   Also `filterActivity` (type, account, repo, range through `resolveRange`).
2. **`main/activity.ts` `ActivityLog`** (TDD with a temp dir):
   - append, list by range
   - trim to 14 days and 5000 lines on load, with an atomic rewrite
   - skip and log a corrupt line
   - a write failure is swallowed
   - the change event is throttled
3. **Wiring the log** in `main/index.ts`. `diffActivity` runs beside `diffEvents`, wrapped in
   try/catch. Then the store events:
   - the scheduler's run end
   - a meeting saved
   - a note added (id only: a test asserts that no note text or title reaches the event)
   - the inbox's `resolved`
   - the version at launch and an update offer
   
   Add the channels `CH.activityList` / `CH.activityChanged`, `DeckApi`, preload, and
   `DECK_ACCESS` (`remote` / `event`). Validate `since` / `until` (numbers, a range of at most
   31 days).
4. **`procs:all`**: one `ps` and one `lsof` for every listed session, reusing `parsePs`,
   `sessionGroups` and `parseLsof`. Add the channel, `DECK_ACCESS` `remote`, and a test with
   fixture `ps` / `lsof` output. Also check `janitor`'s access entry, and decide whether Check
   worktrees shows on the web.
5. **`CostEntry.account`**: set where main records costs (from `sessionAccounts`), optional on
   read. Tests: an old `costs.json` still reads, and a new entry carries the account.
6. **The dashboard's derivations** (`shared/dashboard.ts`, TDD). The bulk of the tests named in
   the acceptance criteria:
   - `attentionItems`:
     - the tier mapping from inbox priority
     - snoozed items left out
     - dedupe of a PR that an inbox item already covers
     - mine vs others' PRs
     - review requests by user and by team
     - ready to merge only when approved, green and with no threads
     - a failed run that was run again after is gone
     - monitor errors
     - the update row
     - the order: tier, then rank, then the oldest first, then the id
     - device dismissals, and a dismissal coming back when the fingerprint changes
     - the 8-row cap with the "more" count
   - `nowRows`
   - `deliverySummary`: a board, a derived board, no board; the burndown points
   - `usageByAccount`: today and week, Unknown account, one account with no split, the top
     sessions
   - `healthRows`: all good, and each problem row
7. **The layout** (`shared/dashboardLayout.ts`, TDD):
   - clean, and the new-card merge
   - `moveTo` / `moveStep`
   - `dropNearest` in 2-D
   - hidden cards keep their place
   - default ↔ `[]`
   - the phone order (attention first)
8. **The view's shell**:
   - `View` gets `dashboard`, and `RAIL_DEFAULT` puts it first (`railOrder` tests: a saved order
     gains it at the top)
   - the `ICONS` path, `WEB_VIEWS`, and the phone More list
   - the palette's `view:dashboard`
   - `App.tsx`: the route and the `view` allowlist
   - `Settings.startView`, with `normalizeSettings` and its tests, the Settings → General row, and
     the web's per-browser `md.startView`
9. **`InboxActions.tsx`**, taken out of `Sidebar.tsx` with no change in behaviour. Sidebar uses it.
   Check the existing Needs-you markup by hand: it must be identical.
10. **The cards**:
    - `DashboardView.tsx` (the grid, slice selection with `useMemo`, memoised cards, `useNow(60_000)`)
    - `dashboard/AttentionCard.tsx`, `NowCard.tsx`, `TimelineCard.tsx` (filters, day groups,
      "Show more"), `DeliveryCard.tsx` (counts, and a `Sparkline` drawn as inline SVG with
      `currentColor` and token colours), `UsageCard.tsx`, `HealthCard.tsx`
    - the shared `Card` frame (title + count + tooltip, View all →, static skeleton, empty state)
11. **Customise mode**:
    - the header buttons
    - the drag handle with pointer drag (threshold, capture, marker, Esc)
    - ⌥ + arrows
    - the eye toggle and hidden placeholders
    - Reset
    - persisted in `md.dashboard.layout`
12. **CSS**: tokens only, in `styles.css` and `web/web.css` (`.app.phone.view-dashboard`). No
    `@keyframes` for the dashboard.
13. **The web preview's fixtures** (`web/preview/fixture.ts`, `preview.tsx`): activity events,
    `procsAll`, `schedList` runs (a failed one), my PRs in every stage, a review request, a
    failing monitor and a cost history across two accounts. Add the `AppState` fixture fields to
    `shared/notify.test.ts` if any are new (none planned).

## Checks

14. Run `npm run typecheck`, `npm test` (vitest) and `npm run build:web`.
15. **Web preview over CDP** (`npm run dev:web`, `/?preview`), at 1440 px and 390 px, in light and
    dark:
    - every card with data, and empty (a `?preview=empty` variant)
    - each row's navigation
    - Needs attention's actions (preview stubs)
    - Timeline's filters and range
    - Customise: drag, ⌥ + arrows, hide, show, Reset, kept after a reload
    - the phone order
16. **Isolated Electron app** (`MASTERDECK_HOME` / `MASTERDECK_USER_DATA` / `MASTERDECK_ISOLATED=1`
    in a temp dir, `--remote-debugging-port=9333`), with a stand-in `claude` listing sessions and
    `MASTERDECK_BOARD_FIXTURE`:
    - the rail's first icon and the palette
    - Open on → Dashboard after a restart
    - `activity.jsonl` gaining a session-started and a ticket-moved (a fixture swap), and
      surviving a restart
    - `procs:all` against this Mac's real `ps`
    
    Never type into a real session or answer a real Needs-you item.
17. **Idle CPU**: with the dashboard open and the window idle for 2 minutes, compare renderer CPU
    and wakeups against Terminals. Use `top -l` on the isolated app and record the numbers in the
    PR. The dashboard must not be worse than Terminals.

## Docs (same commit as the code)

18. Update the docs:
    - **GUIDE**: a Dashboard section, and Settings → Open MasterDeck on
    - **ARCHITECTURE**: the Dashboard, and the activity log (file, channels, what feeds it, the
      privacy rule for notes)
    - **REMOTE**: the new `remote` reads
    - **TODO**: Recently done, plus the open points (merge action, plan limits, the #176 rows,
      the live procs once #160 has a scheduler, backfill)
    - **CLAUDE.md**: a "Where things live" row, and "Current state"
    
    Close #183 from the PR.

## Finish

19. Commit, push the branch, and open a draft PR. Post screenshots with `/ui-screenshots`. Do
    **not** rebuild or reinstall the real app until the user says so, as with the other branches.
    Do not merge.

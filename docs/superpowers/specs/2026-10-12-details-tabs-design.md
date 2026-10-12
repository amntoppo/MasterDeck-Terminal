# Session Details in three tabs (#103)

Issue: amntoppo/MasterDeck-Terminal#103. Related: #86 (mods, merged), #20.

## Problem

Session details (`renderer/src/components/SessionDetails.tsx`) is one long list mixing the session
itself with GitHub things (ticket, PRs, monitors). GitHub items are one line each and cannot be
explored: a monitor shows a count of events but never the events, a PR shows "CI failing" but not
which check, nor the reviews, threads or comments.

## What changes

The panel has three tabs: **Session · GitHub · Mods**. The picked tab is kept in localStorage
(`md.detailsTab`), so it stays across sessions and restarts (the window and each browser).

### Session tab (no GitHub UI)

In order: what waits on you (AskPanel), API error, the status row (status, star, compacting), the
workflow widget, schedules, linked sessions, worktrees / folder / branch (git, local), the stats grid
(context, tokens, model, diff, started, compacted) and the actions (Compact, Ask master, copy
commands, Link sessions, Close terminal, Stop). Moved out: Ticket (with its note and steps), Pull
requests, Monitors, and the Account line.

### GitHub tab

A list of collapsible rows. A row is a button with `aria-expanded`; collapsed it shows a title, a
count and status badges; expanded it shows its children, which can be rows too. Which rows are open
is kept per session in memory (a `Set` of row ids in a module map keyed by `Session.key`), so
switching tabs or sessions and back keeps them open. Every item that has a GitHub page has a `↗`
link (`deck().openExternal`), separate from the expand toggle.

1. **Works as** line (not a row): the session's account (`s.account`, or "gh's active account").
2. **Ticket** — collapsed: `repo#n`, title, the step (`3/5 Review`, its tone). Expanded: the steps
   bar, the ticket note (Edit / Add note, as today), and **Sub-issues (done/total)**, itself a row:
   expanded, each sub-issue with its state and link (reuse `useSubIssues` / `subIssueRows` from
   `SubIssues.tsx`; read when the row first opens). No ticket: "No issue linked".
3. **Pull requests (n)** — collapsed: the count and the worst status over open PRs (CI failing >
   changes requested > threads > CI running > approved/passed; merged/closed counted apart).
   Expanded: one row per PR (today's `PrLine` badges as the collapsed line). A PR expanded reads its
   detail (below) and shows four rows:
   - **Checks** (`n passed · n failed · n running`): each check with its state and link, failing
     first.
   - **Reviews** (latest per reviewer, decision badge): reviewer, state, when, link.
   - **Threads** (unresolved count): file path, last commenter, a one-line excerpt, link; resolved
     ones are left out.
   - **Comments** (count): newest first; author, when, excerpt, link.
   - **PR watch** when MasterDeck watches it: on/off, events, waiting; expanded its events newest
     first (time, kind, by, excerpt); **Stop** as today.
4. **Monitors (n)** — the monitors MasterDeck runs for the session (not PR watches: those sit under
   their PR). Collapsed: count, the blinking dot, "last event 3m ago". Each monitor is a row
   (description, events, waiting, Stop; the command in its title) and expands to its events newest
   first (time, the line). No monitors: the row is left out.

Empty tab (no ticket, no PR, no monitor): one line, "Nothing on GitHub for this session yet".

### Mods tab

Unchanged: `SessionMods` (#86 is merged). Its tab label keeps "· n off".

Later (2026-10-12): Mods moved to the right panel's Tools tab (`SessionTools.tsx`, after Queue and
BTW), so Details has two tabs, **Session · GitHub**; a remembered `md.detailsTab` of `mods` opens
Session.

## New data (read on demand, not in AppState)

AppState stays as it is (the web bridge drops states over ~1.05 MB), so both new things are reads
the renderer makes when a row opens, and makes again when the state says something changed.

- **`watch:events` (`deck.watchEvents(id)`)**: the last events of a monitor or PR watch, newest
  first. `Watches` keeps a ring of the last 50 lines per monitor (`{at, text}`, text cut to 500
  chars) beside its queue; `PrWatch` keeps the last 50 items it found (`{at, kind, by, text}`) and
  its notes (baseline, merged, stopped). Kept in memory only (not in `watches.json` /
  `pr-watch.json`): after a restart the list starts empty while the count carries on; the UI says
  "Events since MasterDeck started". Refetched when that watch's `events` or `lastEventAt` in
  `state.watches` changes. `DECK_ACCESS`: `remote` (a read of the session's own output, which the
  web app can already see in its terminal).
- **`pr:detail` (`deck.prDetail(url)`)**: one GraphQL read (through ghc, ttl 60 s) of the PR's
  checks (`commits(last:1){…statusCheckRollup{contexts(first:100)}}`: CheckRun name, status,
  conclusion, detailsUrl; StatusContext context, state, targetUrl), reviews (last 50: author,
  state, submittedAt, url), unresolved review threads (last 100: path, last comment's author, body,
  url) and comments (last 50: author, createdAt, body, url). Bodies cut to 300 chars. Parsed by a
  pure `shared/prDetail.ts` (query builder + parser + `checkCounts` + `worstPrStatus`), with tests.
  As the card's account (`forCard(prRepo(url))`, like `prSummary`). Refetched while the PR is open
  when `state.prLive[url]` changes, and each 60 s. The query text must not contain the word
  `mutation` (ghcache treats it as a write). `DECK_ACCESS`: `remote` (a read).

Both validate input in main (`id` a string ≤ 200; `url` must parse with `parsePrUrl`).

## Live updates

The tab redraws on every state push like today; rows that hold a read refetch on the triggers above
and keep their last answer on screen while refetching (no flicker), with an error line on failure.

## Look

Existing tokens and classes only (`.dsec`, `.eyebrow`, `.d-pr`, `.ok/.bad/.wait/.merged`,
`.mon-dot`), new `.gh-row` / `.gh-kids` / `.gh-badge` in `styles.css`. Narrow panels: the title
truncates with ellipsis, badges wrap to a second line, no horizontal scroll (checked at 280 px).
The app has one (dark) theme; colours come from the `:root` tokens, so a light theme would follow.

## Not in scope

Writing anything to GitHub from the tab (resolve, re-run, reply). Monitors that Claude Code runs
itself (MasterDeck cannot see their events). Persisting events across restarts.

## Tests

- `shared/prDetail.test.ts`: parser on a fixture answer (check runs + status contexts, reviews,
  threads resolved/unresolved, missing fields), `checkCounts`, `worstPrStatus`, the query never
  containing `mutation`.
- `main/watches.test.ts` / `main/prWatch.test.ts` (or a pure helper): the ring keeps 50, newest
  first, text cut.
- `remoteDeck.test.ts` covers the two new `DECK_ACCESS` entries.
- On screen: the isolated app (or `/?preview`) at panel widths 280 and 420 px: tabs, the tab kept
  after a reload, Session without GitHub items, rows expanding.

## Docs

GUIDE (Session details), ARCHITECTURE (the two reads), TODO (Recently done; open: events across
restarts), CLAUDE.md "Current state".

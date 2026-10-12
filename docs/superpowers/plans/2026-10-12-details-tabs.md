# Plan: Session Details in three tabs (#103)

Spec: `docs/superpowers/specs/2026-10-12-details-tabs-design.md`. Branch
`worktree-MasterDeck-Terminal-103-details-tabs`. Run from `app/`.

## Task 1: `shared/prDetail.ts` (pure)

- `PrDetail` type: `checks[] {name, state: 'success'|'failure'|'pending'|'neutral', url}`,
  `reviews[] {author, state, at, url}` (latest per reviewer), `threads[] {path, author, text, url}`
  (unresolved, not outdated), `comments[] {author, at, text, url}` (newest first).
- `prDetailQuery(ref)` (uses `safeRef` from `prWatch.ts`), `parsePrDetail(text)`,
  `checkCounts(checks)`, `worstPrStatus(rows)` (for the Pull requests row), `clipLine`.
- `prDetail.test.ts`: fixture answer, missing fields, StatusContext + CheckRun, latest review per
  reviewer, no `mutation` in the query, worst-status order.

## Task 2: events rings (main)

- `shared/watches.ts`: `WatchEvent {at, text, kind?, by?}`, `EVENTS_MAX = 50`,
  `pushEvents(ring, events)` (keeps the newest 50, cuts text to 500).
- `main/watches.ts`: `events: WatchEvent[]` on `Watch` (not saved); filled in the stdout handler
  and in `finish`/`stop`; `events(id)` newest first.
- `main/prWatch.ts`: `log: WatchEvent[]` on entries (stripped in `save`), filled where `pending` /
  `notes` grow; `events(id)` for `pr:<url>`.
- Tests: `pushEvents` in `shared/watches.test.ts`; a Watches test that a printed line shows up in
  `events(id)` (bash `echo`).

## Task 3: IPC

- `CH.watchEvents = "watch:events"`, `CH.prDetail = "pr:detail"`; `DeckApi.watchEvents(id)`,
  `DeckApi.prDetail(url)`; preload; `DECK_ACCESS` both `remote`; handlers in `main/index.ts`
  validating input (`GitHub.prDetail(url)` in `main/github.ts`, ttl 60 through `this.api`-style
  graphql call, as `forCard(prRepo(url))`).
- Web preview (`web/preview/preview.tsx`): fake answers for both; fixture gets a monitor and
  `prLive` for its PR.

## Task 4: UI

- `components/GitHubDetails.tsx`: `GhRow` (toggle, title, badges, link, children; open-state per
  session in a module `Map<string, Set<string>>`), Ticket row (steps, note, Sub-issues via
  `useSubIssues`), Pull requests row (`PrRow` with Checks / Reviews / Threads / Comments / PR watch,
  `usePrDetail(url, live)` refetching on `prLive[url]` change + 60 s), Monitors row (`useWatchEvents`
  refetching on `events`/`lastEventAt`), Works-as line, empty line.
- `SessionDetails.tsx`: three tabs (`load/save('md.detailsTab')`), Session tab without Ticket,
  PRs, Monitors, Account; `PrLine` moves to GitHubDetails. `MonitorWidget.tsx` removed if unused.
- `styles.css`: `.gh-row`, `.gh-kids`, `.gh-badge`, `.gh-ev`; narrow-safe (wrap, ellipsis).

## Task 5: check

- `npm run typecheck`, `npm test`.
- Web preview (`npm run dev:web`, `/?preview`) over CDP: each tab, rows expanding, panel at 280 and
  420 px, tab kept after reload. Screenshots.

## Task 6: docs, commit, install

- GUIDE (Session details), ARCHITECTURE (two reads), TODO (Recently done + "events across
  restarts"), CLAUDE.md Current state + Where things live row.
- Commit; rebuild/reinstall/relaunch per CLAUDE.md. The user asked for a PR with screenshots: push the branch, open the PR, post the screenshots on it
  and on the issue (ui-screenshots skill).

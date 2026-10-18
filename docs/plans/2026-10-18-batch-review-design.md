# Review selected: several PRs reviewed in parallel: design (#176)

Issue: [#176](https://github.com/amntoppo/MasterDeck-Terminal/issues/176). Related: #149 (Review
with Claude), #157 (Automate Review), #142.

## Goal

The Pull requests view's **Review with Claude** session reviews one PR at a time: the one selected
in the list. Its post script refuses any `--pr` but the guard's single `url`, so a user who clicks
four PRs in a row gets only the last one reviewed. The user can now tick several PRs and press
**Review selected**: main writes that batch where the session can read it but not widen it, the
session reviews them in parallel (one subagent per PR) and posts each review when it is ready,
and the panel and the rows show each PR's progress.

## Decisions (taken as recommended, 2026-10-18)

| Question | Decision |
|---|---|
| Who owns the batch | Main: a per-tab store, `ReviewBatch` (`main/reviewBatch.ts`), kept in `<home>/review-batch.json`. Its pure rules live in `shared/reviewBatch.ts`. |
| What the session sees | `context.json` gets `batch: [...]`: each PR's facts from MasterDeck's own PR list (as `selected` has them), plus `id` and `status`. Main rewrites it when the batch changes. |
| What the post script trusts | A second file beside the guard, `<home>/pr-review-guard/tab-<id>.batch.json`, written by main only: `[{url, id}]` of the PRs that may still be posted (queued, reviewing, failed). Outside the folder, as the guard and Automate Review's queue are. |
| Posting without asking | A new `--batch` form of the post script, allowed by a prefix rule as `--auto` is. Pressing **Review selected** is the user's request for those PRs. It posts a **comment** review only, and only to a PR in the batch file. Approve / request changes still go through the asked form, which now accepts the selected PR or any PR in the batch. |
| One review per PR per run | Each batch entry has an `id` (a new one each time it is queued). The script refuses `--batch` for an id it already logged as posted. |
| How progress gets back | The script appends one JSON line per event to `tab-<id>.batch-log.jsonl` (beside the guard): `reviewing` (`--start`), `posted` (with the review URL and the inline comment count), `skipped` (`--skip <reason>`), `failed` (GitHub refused, or `--fail <reason>`). Main reads new lines every 2 s (the Automate Review tick) and folds them into the store. A line with an unknown id, or an id no longer active, is ignored (a cancelled PR stays cancelled; a `posted` line is always taken: it happened). |
| Statuses | `queued` → `reviewing` → `posted` / `skipped` / `failed`, plus `cancelled`. |
| Parallel | The briefing tells the session to run one subagent per PR (Agent tool), at most 4 at a time, and post each as it is done. MasterDeck does not run the reviews itself. |
| Unchanged PRs | The subagent compares the PR's head with the commit of the account's latest review (`gh pr view --json headRefOid,reviews`); equal: `--skip "no changes since the last review"`. |
| Adding during a batch | **Review selected** while a batch runs adds the new PRs (one already queued or reviewing stays as it is; one that ended is queued again with a new id). When every entry has ended, the next **Review selected** starts a new batch (the ended ones are dropped). |
| Telling the session | The window types one line into the tab's session (or starts it with that line), as the row's Review with Claude does: `[MasterDeck batch-review] Review these PRs as "Batch reviews" in CLAUDE.md says: acme/web#1, acme/web#2.` A busy session queues it. Retry types the same line for the one PR. |
| Cancel | Main marks every queued, reviewing and failed entry `cancelled` and drops it from the batch file: the script refuses it from then on. Nothing is typed (a running turn is not interrupted). The briefing says a refused PR ends that subagent. |
| Selection | Per tab in the renderer (not saved): a checkbox per open PR, ⌘/Ctrl-click toggles, Shift-click ticks a range from the last ticked row, a header checkbox ticks every shown open PR. A plain click still selects one PR as today. Closed or merged PRs have no checkbox. |
| Limits | At most 30 active entries per tab; more are refused with a message. Notes are cut to 300 characters, control characters removed. |
| Web | The three channels (`reviewBatch:add`, `:cancel`, `:retry`) are `remote`: a browser can start a batch as it can switch Automate Review on. The account checks of `prReviewPrepare` apply. |
| Phone/API snapshot | Not added (`AppState.reviewBatch` only; it reaches the web app through the bridge). |

## Parts

### Shared (pure, tested): `shared/reviewBatch.ts`

- Types: `BatchStatus`, `BatchItem {id, url, repo, number, title, status, note, reviewUrl,
  comments, at}`, `BatchTab {items, startedAt}`, `BatchView` (per tab: items, `running`,
  `summary`), `BatchLine` (a log line).
- `addToBatch(tab, prs, now, newId)`: the add rule above; returns the new tab state, the URLs
  added and refused (not in the list, not open, over the limit).
- `applyLine(tab, line, now)`: one log line folded in (the rules above).
- `cancelBatch(tab, now)`, `retryItem(tab, url, now, newId)`.
- `activeEntries(tab)`: what the batch file holds.
- `batchSummary(items)`: "Reviewed 4: 3 posted, 1 skipped (no changes)"; null while anything is
  queued or reviewing.
- `parseLogLines(text)`: the JSONL, defensively.
- `batchPrompt(labels)`: the typed line (never starts with `/` or `!`).

`shared/prReview.ts`: `prReviewSelected(p)` (the facts of one PR, now shared by `selected` and
`batch`), `PrReviewContext.batch`, the briefing's **Batch reviews** section.

### Main

- `main/reviewBatch.ts` (`ReviewBatch`): load/save (atomic), `add`, `cancel`, `retry`, `tick`
  (reads each tab's log from the last offset), `view()`; on every change it writes the batch file
  and the context's `batch` (through `deps`), and calls `onChange`.
- `main/prReviewDirs.ts`: `prReviewBatch(guard)`, `prReviewBatchLog(guard)`,
  `writePrReviewBatch`, the script's `--batch` / `--start` / `--skip` / `--fail` forms and the log,
  the asked form accepting batch PRs, and the settings' allow rule for `--batch`.
  `writePrReviewContext` keeps the batch the context already has unless given one.
- `main/index.ts`: the three handlers (account checks as `prReviewPrepare`; folder written when
  missing), `ReviewBatch` wiring, its tick in the 2 s Automate Review interval, `state.reviewBatch`
  through `Sources`.

### Renderer

- `PrsView.tsx`: per-tab ticks, checkbox column, header checkbox, ⌘/Ctrl / Shift click, the
  selection bar ("N selected · Review selected · Clear"), a status chip in each row, and a batch
  block in the Review with Claude panel (each PR's status, link, Retry, **Cancel batch**, the
  summary). **Review selected** calls `reviewBatchAdd`, then opens the panel and types the line
  (or starts the session with it).
- Web preview stub for the three channels.

## Not done (open points for TODO)

- A `reviewing` entry whose session died stays `reviewing` until Cancel or Retry (no timeout).
- Cancel does not stop a subagent already running; it only stops its post.
- The selection is not kept across restarts.

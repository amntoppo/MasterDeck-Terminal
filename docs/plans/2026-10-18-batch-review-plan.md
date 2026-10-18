# Review selected: implementation plan (#176)

Design: [2026-10-18-batch-review-design.md](2026-10-18-batch-review-design.md).

1. **Shared rules** (`shared/reviewBatch.ts` + test): types, `addToBatch`, `applyLine`,
   `cancelBatch`, `retryItem`, `activeEntries`, `batchSummary`, `parseLogLines`, `batchPrompt`,
   `batchView`. Tests: add (new, duplicate active, re-queue ended, refused, limit, new batch after
   the end), every status move from a log line (unknown id, cancelled, posted always), cancel,
   retry, summary text.
2. **Context** (`shared/prReview.ts` + test): `prReviewSelected`, `batch` in the context, the
   briefing's Batch reviews section; the asked form's text says it accepts batch PRs.
3. **Guard and script** (`main/prReviewDirs.ts` + test): batch file and log paths, writer,
   `--batch` / `--start` / `--skip` / `--fail`, the asked form accepting batch PRs, the log lines,
   the allow rule. Tests run the real script with a stand-in `gh`: accepts a batch PR, refuses
   another, refuses a second `--batch` post of the same id, `--batch` is comment only, the asked
   form posts to a batch PR, `--skip` / `--start` log, a GitHub failure logs `failed`.
4. **Store** (`main/reviewBatch.ts` + test): persistence, add/cancel/retry writing the batch file
   and context, `tick` reading the log incrementally (and from 0 when it shrank), `view`.
5. **Wiring**: `CH` + `DeckApi` + preload + `DECK_ACCESS`, handlers in `main/index.ts`, the tick,
   `AppState.reviewBatch` (types, `Sources`, `notify.test.ts` fixture).
6. **UI**: `PrsView.tsx` checkboxes, clicks, selection bar, row chips, panel block; CSS (tokens
   only); web preview stub.
7. **Docs**: ARCHITECTURE (Review with Claude section), GUIDE (Pull requests), TODO (open points,
   recently done), CLAUDE.md current state.
8. **Checks**: typecheck, vitest, `build:web`, the web preview at 1400 and 390 px; final review;
   rebuild and reinstall per CLAUDE.md.

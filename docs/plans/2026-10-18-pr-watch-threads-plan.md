# PR watch: sessions resolve the threads they handled (#177): plan

Design: [2026-10-18-pr-watch-threads-design.md](2026-10-18-pr-watch-threads-design.md).

1. **`shared/prWatch.ts`, the read**: the heavy query reads `id path line` and the first comment's
   `url` per thread; `HeavyPr.threads` gains `id`, `path`, `line`, `url`, `isOutdated` (outdated
   threads are kept for the follow-up, skipped as items). `PrItem.thread` carries
   `{id, path, line, url}`. `prItems` also returns `replied`: unresolved threads whose last comment
   is the session's own.
2. **`shared/prWatch.ts`, outcomes**: `TrackedThread`, `trackThreads` (add delivered ones),
   `threadOutcomes` (update from a read), `followUpMessage` (the one reminder). Tests: outcomes,
   the reminder lists only unreplied threads, never twice, none for `open` threads.
3. **`shared/prWatch.ts`, the message**: per-thread lines with id, path:line, link; the three-way
   rule; reply/resolve commands; "post as <viewer>". `prWatchMessage` takes the viewer. Tests on
   the ids and the rule text.
4. **`main/prWatch.ts`**: `viewer`, `threads`, `follow` on the entry; the delivery records them;
   `deliver()` tracks the turn; a due check makes the next light poll read in full and queues the
   reminder; `info()` adds `threads`; `openThreads()` for Needs you. Tests: follow-up reminder
   once, no reminder for replied threads, outcomes after resolve.
5. **Needs you**: `InboxInput.prThreads`, a `review` item per PR with open threads (`detail:
   threads`); `Sources.setPrThreads`; the card's View on GitHub. Tests in `inbox.test.ts`.
6. **Details**: `WatchInfo.threads`; a Threads list in the PR watch row (`GitHubDetails.tsx`).
7. **Docs**: ARCHITECTURE (PR watch), GUIDE (PR watch, Needs you), TODO (recently done, open
   points), CLAUDE.md's current state.
8. Typecheck, vitest, rebuild per CLAUDE.md is the user's word (not installed), PR.

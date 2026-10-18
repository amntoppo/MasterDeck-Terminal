# Watch any PR (#182): plan

Spec: `docs/superpowers/specs/2026-10-18-watch-any-pr-design.md`.

1. **shared/watchPr.ts** (new, tested): `parsePrInput(text, primaryRepo)`, `primaryRepoOf(tab
   filters, account)`, `PrWatchRow`, `watchTip(row, tabId, tabs)`, `reviewWatchLine(ref, title,
   items)`, `watchReady(light)`, `watchReadError(text, ref)`, `MANUAL_MAX`.
2. **shared/prWatch.ts**: the light query's new fields (`title headRefOid reviewDecision
   mergeStateStatus`, check rollup) in `LightPr` and `parseLight`.
3. **main/prWatch.ts**: entry fields; `start()` (reuse, done cleared, quiet); `sync(state, on,
   now, owner)` keeps manual watches and gives them their owner; poll: no author end for manual
   ones, head changes and readiness for review-routed ones, ends told through `review.notify`;
   deliver: review-routed watches typed through `review.say`, a gone session's manual watches
   rerouted; `stop()` tells AutoReview; `forgetTab()`; `rows()`. Tests.
4. **main/autoReview.ts**: watched tracks (`rereview`, `unwatch`), `say` (type now or start the
   pane, shares the turn clock), `watchNotice` (skips what a track tells itself), stand-in tabs in
   `poll`/`deliver`/`writeQueue`/`due`/`load`/`set`. Tests.
5. **shared/prReview.ts**: the review folder's CLAUDE.md learns `[MasterDeck PR watch]` lines.
6. **IPC**: `CH.prWatchSet`, `DeckApi.prWatchSet`, preload, `DECK_ACCESS` (`remote`), handler in
   main/index.ts (validation read, account check, native confirm for an automatic watch, reuse),
   `forget` also ends the tab's manual watches; `AppState.prWatches` via `Sources.setPrWatches`;
   the `notify.test.ts` fixture.
7. **Renderer**: `WatchEye` (PrsView rows, PrPopup), the widget's Watched PRs list and Add field,
   styles with tokens only.
8. **Docs**: GUIDE (Pull requests view, Review with Claude), ARCHITECTURE (PR watch), TODO,
   CLAUDE.md's current state.
9. Typecheck, vitest, the web preview; a final review; PR.

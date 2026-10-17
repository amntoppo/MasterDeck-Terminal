# Plan: Automate Review and Merge automatically (#157)

Spec: `docs/superpowers/specs/2026-10-17-auto-review-design.md`. Branch
`worktree-MasterDeck-Terminal-157-auto-review`, stacked on #149's branch (PR #151).

1. **shared/autoReview.ts** (pure): types (`AutoReviewTab`, `AutoTrack`, `AutoPr`, status),
   `autoSearch` (query + scope), `autoQuery` (search + tracked PRs in one GraphQL read),
   `parseAutoAnswer`, `stepTrack` (the state machine: what to send, notify, merge), `readyToMerge`,
   `mergeGuard`, `mergeArgs`, `autoPrompt`, `parseTurn`, `autoStatusLine`. Tests first.
2. **shared/notifications.ts**: the `auto-review` type; `Notice.url` and the notice item's link
   (`shared/inbox.ts`, `main/notices.ts`), the card's **View on GitHub** (Sidebar).
3. **main/prReviewDirs.ts**: settings with turn hooks and the `--auto` allow rule, the turn and
   auto files, `post-review.sh --auto`, split `writePrReviewFiles` / `writePrReviewContext`. Tests.
4. **main/autoReview.ts** (`AutoReview`): the store file, `set` (switches), `poll` (per account),
   `deliver` (panes), `merge`, `info` / `events` / `stop` (monitor), `view` (AppState). Tests with
   a fake gh and fake panes.
5. **Wiring**: `PtyManager.ids(prefix)`; `CH.autoReviewSet`, `DeckApi.autoReviewSet`, preload,
   `DECK_ACCESS` (remote; main refuses Merge on from a browser); `state.autoReview` (types,
   notify.test fixture); `setWatchInfo`, `watchStop` / `watchEvents` for `review:`; the poll timer
   and `deliver` in `pumpWatches`.
6. **Renderer**: the widget (`AutoReviewWidget.tsx`), the input box finder in `TerminalView`
   (`onInputBox`), the toggle, adoption of a pane MasterDeck started, the warning dialog, the tab
   close / account change turning the switches off. CSS through tokens only.
7. **Docs**: GUIDE (Pull requests → Automate Review), ARCHITECTURE, TODO, CLAUDE.md state.
8. **Checks**: typecheck, vitest, `build:web`, the web preview at 1440 and 390 px; the isolated app
   with a stand-in `claude` and a fake gh answer where possible. No real GitHub writes.

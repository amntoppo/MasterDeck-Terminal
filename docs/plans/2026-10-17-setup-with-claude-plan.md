# Let Claude do it (#156): plan

Design: [2026-10-17-setup-with-claude-design.md](2026-10-17-setup-with-claude-design.md).

1. `shared/setupClaude.ts` (+ test): `SETUP_CLAUDE_NAME`, `SETUP_PANE`, `readSetupDraft`,
   `draftSummary`, `setupBriefing(platform)`, `setupScript(dir, platform)`, `SETUP_REQ_ID`.
2. `renderer/.../setupAccounts.ts` (+ test): `setupPatch` (the wizard's save checks and patch, moved
   out of `SetupDialog.save`), `selFromDraft`.
3. `PaneSpec` `setup-claude`, `paneCommand` (+ test), `PtyManager` folder for it, the session hidden
   in `Sources.build()`.
4. `main/setupClaude.ts` (+ test): `prepareSetupDir`, `SetupPump` (claim, answer main-side commands,
   hand window-side ones and discover data to the poll, write answers atomically).
5. IPC: `CH.setupClaudePrepare`, `setupClaudePoll`, `setupClaudeAnswer`; `DeckApi`, preload,
   handlers in `main/index.ts`, `DECK_ACCESS` blocked.
6. `SetupDialog.tsx`: the button, the panel (terminal, gh login, summary card), the poll, apply a
   draft, save through `setupPatch`, the success view, leaving early; CSS in `styles.css` (tokens only).
7. Docs: GUIDE (Setup), ARCHITECTURE (panes, folders, the helper), TODO, CLAUDE.md current state.
8. Check: typecheck, vitest, the isolated app with a stand-in `claude` that runs the helper (the
   panel, a review, Save writing the config, the success view, leaving early), screenshots.

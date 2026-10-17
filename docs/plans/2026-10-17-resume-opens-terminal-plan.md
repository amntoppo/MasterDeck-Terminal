# Resuming a session opens its terminal (#133): plan

Design: [2026-10-17-resume-opens-terminal-design.md](2026-10-17-resume-opens-terminal-design.md).

1. **Shared rule.** `shared/resumeOpen.ts`: `ResumeTarget`, `resumedSession(sessions, target)`;
   tests in `shared/resumeOpen.test.ts` (key, sessionId, name after `at`, stopped rows skipped,
   interactive rows skipped).
2. **Main.** `ResumeResult` in `shared/types.ts`; `DeckApi.resumeSession` returns it; `resumeAs`
   keeps returning `stdout`; `resumeBg` adds `key` from the output (`bgIdFromOutput`, else `wokeFromOutput`).
3. **Window.** `App.tsx`: the `resumed` pending tab, `openResumed`, the resolver using
   `resumedSession`, the wake mark; `SessionPane` reattaches on a wake when exited and passes
   `focusAt` to `TerminalView`, which focuses on a new `focusAt` while visible.
4. **Call sites.** `BoardView` (`onResumed` through `Card` to `ResumeButton`), `HistoryDialog`,
   `AssignDialog` take `onResumed`; App passes `openResumed`.
5. **Docs.** GUIDE (resume opens the terminal), ARCHITECTURE (the resume answer's `key`), TODO
   (recently done), CLAUDE.md current state.
6. **Check.** typecheck, vitest; the isolated app with a stand-in `claude` (a stopped background
   session resumed from History: the dialog closes, the session's terminal is focused); the web
   preview's History dialog.

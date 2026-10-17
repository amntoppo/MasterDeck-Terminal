# Plan: New Claude session remembers per account (#153)

Spec: `docs/superpowers/specs/2026-10-17-new-session-memory-design.md`.

1. **Pure logic** `shared/newSessionPrefs.ts` with tests: parse (junk dropped, caps), key per
   account (one account → `""`), `rememberChoice` (sets `last`, replaces the account's set, keeps
   the others), `choiceFor`, `initialAccount` (last only when a healthy choice), `resolveChoice`
   (folder gone, model gone / equal to configured, workflow gone, mode gone, notes).
2. **Read** `CH.folderExists`: `ipc.ts` channel + `DeckApi`, handler in `main/index.ts`,
   `preload/index.ts`, `DECK_ACCESS` remote; the web's `remoteDeck` picks it up from the table.
3. **Dialog** `NewSessionDialog`: account select first; on open load prefs, preselect the account,
   apply its choice once the lists are loaded; a `touched` set for cwd/model/workflow/mode; a pick
   of another account applies its choice to untouched fields; save on Start; notes line.
4. **Docs**: GUIDE, ARCHITECTURE, TODO (recently done + open), CLAUDE.md "Current state".
5. Typecheck, vitest, the web preview (`/?preview`) on screen: account first, a remembered
   choice applied after a restart of the page, a switch keeping a touched field.

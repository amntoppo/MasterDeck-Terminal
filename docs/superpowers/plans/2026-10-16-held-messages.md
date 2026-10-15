# Plan: held messages (#123)

Spec: `docs/superpowers/specs/2026-10-16-held-messages-design.md`.

1. **Pure logic** `shared/heldMessages.ts`: `HeldMessage`, `HeldView`, `heldViews`, `heldReason`
   texts, `promptDraft(lines)` (box parser), `heldAnswer(text)` (Stop hook answer), `isCommand`.
   Tests with screens rendered from the probe (empty with placeholder, draft, multi-line, no box).
2. **Mod** `mods/masterdeck`: `hooks/deliver.ts` (request names, the pass), `register.ts` wires it
   on the 2 s timer and adds `deliver: 1` to the beat; version 0.6.0 (plugin.json too). Tests in
   `core.test.ts` style with a fake `$`.
3. **App side of the handshake** `main/modDeliver.ts` (`ModDelivery.deliver`, `prune`);
   `parseModBeat` reads `deliver`.
4. **Screen** `main/screen.ts` `promptLines(raw, cols, rows)` (dim cells blanked); `PtyManager`
   keeps each pane's size and the time of the user's last input (`input()` from `CH.ptyWrite`).
5. **Sender**: mod first, the draft guard on the pane and attach routes, the hold, `pumpHeld`,
   `sendHeld` (Send now), `dropHeld`; `HeldStore` in `main/held.ts`. Tests: typing while a
   message arrives, for pane, attach (mocked node-pty), master and mod.
6. **Stop hook**: hook.sh asks MasterDeck when `deck/held/<sid>` exists; `pumpQueue` answers a held
   message first (`heldAnswer`); `setHeldMarks`.
7. **Wiring and UI**: `AppState.held`, `CH.heldSend` / `CH.heldDrop` (+ `DeckApi`, preload,
   `DECK_ACCESS` remote), the pump in main, the ✉ badge on `SessionRow`, `HeldBar` above the
   session's tabs, CSS with tokens only; the preview fixture.
8. **Docs**: ARCHITECTURE (sending), GUIDE, MODS, TODO, CLAUDE.md state; comment on #123.
9. Typecheck, vitest, mod validate/test, a live probe of the real core mod with a draft.

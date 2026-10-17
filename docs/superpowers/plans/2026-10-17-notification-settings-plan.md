# Notification settings (#135): plan

Spec: [2026-10-17-notification-settings-design.md](../specs/2026-10-17-notification-settings-design.md).

1. **Registry** — `shared/notifications.ts` + `notifications.test.ts`: channels, types, defaults,
   `normalizeRoutes` (migration from `notifyNeedsYou`, unknown keys dropped, fixed cells forced),
   `routeOf` (pause, availability, fixed), `typeOfKind`, `showsInNeedsYou`, `cellOf`.
2. **Settings** — `shared/settings.ts`: `notifications`, `notifyPaused`, drop `notifyNeedsYou`;
   tests for the migration through `normalizeSettings`.
3. **Inbox** — `shared/inbox.ts`: kind `notice` (priority, resolved text, detail, `inboxNotice`
   returns null for it), `InboxInput.notices`; `main/inbox.ts`: `view(shows?)`. Tests.
4. **Notices store** — `main/notices.ts` + test (add, expiry, cap, atomic file, bad file).
5. **Notifier** — `main/notifier.ts` + test with fake senders: routing per type and channel,
   pause, unavailable channel, inbox items not re-added to Needs you, coalescing, `test()`.
6. **Wiring** — `main/index.ts`: system sender (today's Electron code), needsYou sender (notices),
   `notify()` / `notifyItem()` / meetings / workflow through the notifier; monitor lines
   (`Watches` `onLines`); updater offers; `CH.notifyTest`. `main/sources.ts`: notices into
   `collectItems`, `inbox.view(shows)`. `ipc.ts`, `preload`, `remoteDeck.ts` (`remote`), the
   web's `remoteDeck` if it lists methods.
7. **UI** — `SettingsView.tsx` Notifications section; CSS with tokens only; `SetupDialog`.
8. **Docs** — GUIDE (Settings → Notifications), ARCHITECTURE (notifications), TODO, CLAUDE.md
   "Where things live" row and current state.
9. **Checks** — typecheck, vitest, the web preview of the section at desktop and phone width,
   the isolated app: toggle a cell, the test button, a restart keeps the choices.

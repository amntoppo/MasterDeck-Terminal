# Notification settings (#135): design

Settings → **Notifications**: which events notify the user, and where. One registry of
notification types and channels, one dispatcher that routes each event to the channels the user
picked.

## Today

| Event | Where it is made | Gate |
|---|---|---|
| Session finished (went idle) | `diffEvents` (`shared/notify.ts`) → `notify()` | none |
| PR ready for review / merged | `diffEvents` → `notify()` | none |
| New Needs-you item (input, menu, question, CI, proposal…) | inbox `added` event → `notifyItem()` | `notifyNeedsYou` |
| Workflow notify block | `pumpWatches` → `notify()` | none |
| Meetings notice / offer | `meetings` deps in `main/index.ts` | none (meetings' own offer setting) |
| "Could not do that" (a notification's action failed) | `notifyItem` → `notify()` | none |
| Monitor event, update available | no notification | n/a |

Every Needs-you item is in the list whatever the setting.

## Decisions

1. **Types** (registry ids, in this order): `session-finished`, `session-input`, `needs-you`,
   `pr-ready`, `pr-merged`, `ci-failed`, `monitor`, `update`, `workflow`, `meeting`. The last two
   are not in the issue's list but notify today; they are types so that every notification goes
   through the dispatcher.
2. **Inbox kinds map to types**: `input`, `menu`, `question`, `blocked`, `waiting` →
   `session-input`; `ci` → `ci-failed`; `notice` → the type it carries; every other kind →
   `needs-you`.
3. **Channels**: `system` (Electron `Notification`), `needsYou` (the in-app list), `mobile`
   (listed, `available: false`, "Coming with the mobile app", #134). A channel that is not
   available routes nothing whatever is stored.
4. **Needs you as a channel** works two ways, decided by the type's `source`:
   - `inbox` types (`session-input`, `needs-you`, `ci-failed`) are inbox items already. Off means
     the item is left out of the *view* (`Inbox.view(shows)`): it stays in the store, keeps its
     state, is not resolved, and comes back as it was when switched on again. The dock badge and
     the web/phone follow the view.
   - `event` types (the rest) are added to Needs you as a **notice**: a new inbox kind `notice`,
     kept in `<home>/notices.json` (`main/notices.ts`, atomic, 50 at most, 3 days), with **Open**
     and **Done** (dismiss). It goes when it expires.
   - `needs-you` × Needs you is fixed on (disabled checkbox): the list is where those items live.
5. **Defaults** match today: system on for `session-finished`, `pr-ready`, `pr-merged`,
   `workflow`, `meeting`; system = old `notifyNeedsYou` for `session-input`, `needs-you`,
   `ci-failed`; Needs you on for the three inbox types, off for every event type; `monitor` and
   `update` off everywhere; mobile off.
6. **Settings shape**: `notifications: { [type]: { [channel]: boolean } }` and `notifyPaused:
   boolean`. `normalizeSettings` fills each cell from the stored value, else the default; when
   `notifications` is absent, the old `notifyNeedsYou` decides the three gated cells. The field
   `notifyNeedsYou` is dropped from `Settings` (an old file keeps working, the next save drops it).
   Unknown types or channels in a stored file are dropped.
7. **Pause all** stops every *pausable* channel (`system`, later `mobile`); Needs you is not
   paused. The per-type choices stay as they are.
8. **Send test notification** sends one through every available channel, ignoring Pause and the
   per-type choices (it checks the OS permission and shows what a notice looks like), and says
   where it went.
9. **Monitor events**: only monitors MasterDeck runs (`monitorsBy: masterdeck`) are seen; one
   notification per monitor per minute at most (the dispatcher's `coalesce` key). The Settings
   hint says so.
10. **Update available**: once per offered version, when the updater first reaches `available`
    or `ready`; a click opens Settings → Updates (`CH.updateOpen`).
11. A notification's failed action ("Could not do that") goes out as the item's type.
12. The web app can change these settings (they are the user's, not the Mac's machinery); the
    test button is `remote` too (it only shows a notification on the Mac).

## Shape

- `shared/notifications.ts`: `CHANNELS`, `NOTIFY_TYPES` (id, label, hint, source, defaults,
  fixed), `defaultRoutes`, `normalizeRoutes(raw, legacy)`, `routeOf(settings, type)` (the channels
  an event goes to), `typeOfKind(kind)`, `showsInNeedsYou(settings, item)`, `cellOf` (value,
  disabled, why) for the UI.
- `main/notifier.ts`: `Notifier` with one sender per channel (`Record<ChannelId, Sender>`, so a
  new channel cannot be forgotten), `dispatch(type, note)`, `test()`, coalescing.
- `main/notices.ts`: the notices store; `Sources` passes `notices` to `collectItems`.
- `main/index.ts`: `notify()`, `notifyItem()` and the meetings notifications call the notifier;
  the system sender keeps today's Electron details (click, macOS action button, reply, `shown`).
- `SettingsView.tsx`: a **Notifications** section (between General and Needs you & alerts):
  Pause all, the table (rows = types, columns = channels, a checkbox per cell, the mobile column
  disabled with its note), Send test notification. The old toggle leaves "Needs you & alerts".
  `SetupDialog` sets the three gated system cells where it set `notifyNeedsYou`.
- `CH.notifyTest` / `DeckApi.notifyTest`, `DECK_ACCESS: remote`.

## Adding later

- A type: one entry in `NOTIFY_TYPES` and a `dispatch` where the event happens.
- A channel: one entry in `CHANNELS` and its sender in the notifier's map.

## Not in scope

Mobile push itself (#134), per-session or per-repository rules, quiet hours, sounds.

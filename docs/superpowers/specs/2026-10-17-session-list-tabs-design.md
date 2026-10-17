# Tabs in the session list (#146)

Issue: amntoppo/MasterDeck-Terminal#146. Related: #136 (Clone), #113 (a session's own tabs:
Terminal, files, diffs — a different thing; internally this feature is "session groups" so the two
never share a name).

## Problem

With many sessions the Sessions column is one long list (Needs you, Starred, status groups,
Parked). There is no way to group sessions by project or topic and switch between the groups.

## What changes

A tab bar at the top of the session list, under the column head (`Sidebar.tsx`).

- **All** is always first: the default, every session, never renamed, moved or deleted.
- **+** adds a tab, named inline (Enter saves, Esc or an empty name cancels).
- A tab is renamed (double-click or the right-click menu), reordered by dragging it, and deleted
  (right-click → Delete). Deleting only removes the grouping; its sessions stay in All.
- A session is dragged onto a tab to put it there; the tab under the pointer is highlighted. The
  list's own drag (reorder) keeps working: dropping on a row reorders, dropping on a tab assigns.
- A session is in at most one tab: dropping it on another moves it, dropping it on **All** takes it
  out. It always also shows in All.
- Right-click a session → **Move to tab ▸** opens the list of tabs in the menu (the current one is
  marked; **All** is "No tab"), the same without dragging.
- Each tab shows its number of sessions (live and parked, as listed) and a red badge with the number
  of its sessions that have an open Needs-you item (held and idle items excluded, as the Needs you
  count's "hot" is).
- Inside a tab the list works as today: Starred, the status groups, Parked, filters and search apply
  to that tab's sessions only (the filter's choices too). Needs you stays global (it is not a session
  list). Shells and starting sessions show in every tab (they are terminals, not sessions, and cannot
  be grouped). Cleanup picks among what the tab lists.
- The bar scrolls sideways when the tabs do not fit (no wrapping), so it fits a narrow sidebar and
  the phone; the selected tab is scrolled into view.

## Decisions (the recommended ones, taken)

1. **Stored in main, not localStorage.** `session-groups.json` under `MASTERDECK_HOME`
   (`main/sessionGroups.ts`, written atomically). Reasons: a copy made by a resume (`resumeAs` →
   `noteCopy`) happens in main, so the assignment can follow it there, as linked sessions'
   (`PeerStore.carry`) do; and the window and every web tab see the same tabs.
2. **Reaches the UI in `AppState.sessionGroups`** (set in the state callback, like `modOff`). Not in
   `toRemoteSnapshot`: the phone/API protocol does not change. Tiny (≤ 30 tabs, names ≤ 40 chars).
3. **One action channel**, `sessionGroups:act` (`CH.sessionGroupsAct`, `DeckApi.sessionGroupsAct`),
   taking one operation: `add {name}`, `rename {id, name}`, `move {id, before}`, `remove {id}`,
   `assign {key, group|null}`. Validated in main by the pure functions of
   `shared/sessionGroups.ts`; `DECK_ACCESS` `remote` (grouping is harmless, as stars are).
4. **Keys.** Assignments are by `Session.key` (the background id survives a plain resume). A copy
   (`noteCopy(old, copyBg)`) moves the old key's assignment to the copy's.
5. **Pruning.** An assignment whose session is missing from a real (non-empty, healthy) session list
   for 10 minutes is dropped (in-memory grace, like stars, so one missed poll loses nothing). Done
   sessions are still listed by `claude agents`, so a stopped and later resumed session keeps its tab.
6. **Names**: trimmed, 1–40 characters, no control characters, unique ignoring case, never "All".
   At most 30 tabs.
7. **Selected tab** is per window / browser (`localStorage` `sessionGroup`), falls back to All when
   the tab is gone.
8. **Delete asks nothing** (it removes no session); the column's note says "Deleted tab X. Its
   sessions are in All."
9. Tab ids are `g` + 8 random hex characters, made in main.

## Data

```ts
interface SessionGroup { id: string; name: string }
interface SessionGroups { groups: SessionGroup[]; of: Record<string, string> } // Session.key → group id
```

File: `{ "version": 1, "groups": [...], "of": {...} }`. An unreadable file is renamed
`.corrupt-<ms>` and starts empty (as `PeerStore`). Assignments to an unknown group are dropped on read.

## Not in scope

Tabs on the phone/API snapshot; per-tab sort or filters; nesting; colors.

## Testing

Unit: `shared/sessionGroups.test.ts` (every op and refusal, carry, prune with grace, parse),
`main/sessionGroups.test.ts` (load/save, corrupt file, atomic write). The UI in the web preview
(`/?preview`) and the isolated app with a stand-in `claude` listing fake sessions: add, rename,
reorder, delete, drag a session onto a tab and onto All, Move to tab, counts and badge, filters
inside a tab, a narrow sidebar, kept after a restart.

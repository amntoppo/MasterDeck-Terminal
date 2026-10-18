# A new session goes into the selected session-list tab (#171): design

## Problem

The session list has tabs (#146). A session started from **+** while a named tab is shown lands in
**All** only; the user has to find it and drag it over. The Board's Start dialog has the same gap,
and there the user is not looking at the session list at all.

## Decisions

1. **Both start dialogs get a "Session list tab" picker**: New Claude session (the + menu) and the
   Start dialog (`AssignDialog`: the Board, ⌘K / Start from an issue…, a proposal). It is shown
   only when there is at least one named tab (so more than one tab to pick from); otherwise nothing
   changes on screen. Options: **All (no tab)** and each named tab, in the bar's order.
2. **Default: the tab the session list shows** (`shownTab` of the remembered pick), in both
   dialogs. The Board's Start dialog follows the same rule, so it is never a guess: the picker says
   where the session goes.
3. **On Start the session list switches to the picked tab** (All included), so the new session,
   opened as today, is the selected row in the tab on screen.
4. **Main keeps a pending "target tab" per start, matched by the session's name** (as the peers
   and account stores do). The start request carries `group` (a tab id). Main records
   `{name, group, skip, at}` just before it starts the session; `skip` holds the keys of the
   sessions with that name already listed (done ones too), so an older session is never pulled in.
   A failed or thrown start drops it.
5. **Claimed in the state callback**, before the groups are put in the state: the first state that
   lists the session already shows it in its tab. A session already in a tab is left as it is.
6. **Dropped without a word** when the tab is deleted first (the session stays in All) or after
   `GROUP_GRACE_MS` (10 minutes, the missing-session rule) without the session appearing. Pending
   targets live in memory only: a restart of MasterDeck before the session shows up leaves it in All.
7. **Resume / copy**: once in its tab, `carryGroup` keeps it there across a resume that makes a copy.
8. **The web app** sends the same requests over the bridge (`startClaude`, `assign`): the browser's
   own remembered tab is its default; main checks the id like any other.
9. Not covered: **New terminal** (a shell, not a listed session), **Resume a past session…**, a
   PR review started from the PR popup, master's spawns and schedules: they stay in All (TODO).

## Model

`shared/sessionGroups.ts`:

```ts
export interface GroupWait { name: string; group: string; skip: string[]; at: number }
export function claimWaits(d, waits, sessions, now, ms = GROUP_GRACE_MS): { groups; waits }
```

- a wait whose tab is gone or older than `ms` is dropped;
- a session with the wait's name and a key not in `skip` claims it (also one already done by its
  first poll): it is put in the tab unless it is in one already; the wait goes.
- returns `d` itself (and the same `waits` array) when nothing changed.

`main/sessionGroups.ts` (`SessionGroupStore`): `expect(name, group, skip)` (ignored for All or an
unknown tab), `unexpect(name)`, `claim(sessions)` (saves only when an assignment was made).

## Wire

- `NewSessionReq.group?: string`, `AssignRequest.group?: string`: the picked tab id, or `"all"`
  when the picker was shown and All picked (the renderer then switches the list to All; main
  ignores it). Absent when no picker was shown.
- `startSession` (main): `expect` before `claude --bg`, `unexpect` on failure.
- `CH.assign`: the same around `assignNow`.

## Renderer

- `renderer/src/sessionGroupPick.ts`: the remembered tab (localStorage `sessionGroup`, as today),
  `pickedGroup()`, `pickGroup(id)`, `usePickedGroup()` (`useSyncExternalStore`), so the Sidebar
  and App share it.
- `SessionTabSelect` (in `SessionGroupBar.tsx`): the picker; renders nothing without named tabs.
- `App.startClaude` / `startSession`: `if (req.group) pickGroup(req.group)`.

## Tests

- `claimWaits`: claim on appearance, a later poll, skip of an older same-name session, done
  sessions ignored, already-grouped kept, deleted tab dropped, timeout dropped, identity when
  nothing changed.
- `SessionGroupStore`: expect/claim writes the file; `unexpect`; All / unknown tab ignored; a copy
  after the claim carries the tab.

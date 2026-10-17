# Plan: tabs in the session list (#146)

Spec: `docs/superpowers/specs/2026-10-17-session-list-tabs-design.md`.

1. **Model** — `app/src/shared/sessionGroups.ts`: types, `GROUP_MAX`, `NAME_MAX`, `cleanName`,
   `applyGroupOp` (add, rename, move, remove, assign; returns a new value or an error message),
   `carryGroup`, `pruneGroups` (grace), `parseGroups`, `groupOf`, `inGroup`. Tests first in
   `sessionGroups.test.ts`.
2. **Store** — `app/src/main/sessionGroups.ts` (`SessionGroupStore`: load, all, act, carry, prune;
   atomic write, corrupt file renamed). Tests in `sessionGroups.test.ts`.
3. **Wiring** — `AppState.sessionGroups` (`shared/types.ts`, the `notify.test.ts` fixture),
   `CH.sessionGroupsAct` + `DeckApi.sessionGroupsAct` (`shared/ipc.ts`), preload, `DECK_ACCESS`
   (`remote`), the handler and the state callback (set + prune) and `copied` → `carry` in
   `main/index.ts`. The web preview's fixture state.
4. **Tab bar** — `renderer/src/components/SessionGroupBar.tsx`: All + tabs with count and badge,
   +, inline naming and renaming, tab drag reorder, session drop (highlight), right-click menu
   (Rename, Move left / right, Delete), horizontal scroll. CSS in `styles.css` with tokens only.
5. **Sidebar** — selected tab (localStorage), `sessions` narrowed to the tab before filters,
   Starred, groups, Parked and Cleanup; the empty state of a tab; the session row drag carries on
   to tabs.
6. **Session menu** — **Move to tab ▸** with the tab list inline.
7. **Docs** — GUIDE (Sessions column), ARCHITECTURE (files on disk, the state field), TODO (open
   points, Recently done), CLAUDE.md "Where things live" and "Current state".
8. **Checks** — typecheck, vitest, `build:web`, the web preview at 1400 and 390 px, the isolated app
   with a stand-in `claude` (restart keeps tabs). Review pass, then PR.

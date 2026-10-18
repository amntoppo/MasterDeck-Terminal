# A new session goes into the selected session-list tab (#171): plan

Design: [2026-10-18-new-session-tab-design.md](2026-10-18-new-session-tab-design.md).

1. **Model** — `shared/sessionGroups.ts`: `GroupWait`, `claimWaits`. Tests in
   `shared/sessionGroups.test.ts` (appearance, later poll, skip, done, already grouped, deleted
   tab, timeout, identity).
2. **Store** — `main/sessionGroups.ts`: `expect`, `unexpect`, `claim`. Tests in
   `main/sessionGroups.test.ts` (file written on claim, All/unknown ignored, unexpect, carry after
   claim).
3. **Wire** — `group?: string` on `NewSessionReq` (`NewMenu.tsx`) and `AssignRequest`
   (`shared/ipc.ts`).
4. **Main** — `startSession`: read `o.group`, `expect` before `claude --bg` with the skip list,
   `unexpect` on failure. `CH.assign`: same around `assignNow`. State callback: `claim` before
   `prune` while the agents source is healthy.
5. **Renderer** — `sessionGroupPick.ts` (remembered tab + subscribe); Sidebar uses it.
   `SessionTabSelect` in `SessionGroupBar.tsx`. NewSessionDialog and AssignDialog: the picker,
   default `shownTab(groups, pickedGroup())`, `group` in the request. App: `pickGroup(req.group)`
   on start.
6. **Check** — typecheck, vitest; the web preview (`/?preview`, fixture has two tabs) for both
   dialogs at desktop and phone width; the isolated app with a stand-in `claude` that lists the new
   session on a later poll.
7. **Docs** — ARCHITECTURE (#146 section, state table), GUIDE (session list tabs, both dialogs),
   TODO (done + open points), CLAUDE.md current state.

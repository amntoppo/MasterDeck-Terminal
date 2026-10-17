# Schedules (#140): plan

Design: [2026-10-17-schedules-design.md](2026-10-17-schedules-design.md).

1. **`shared/sched.ts` (pure) + tests.** Types (`Schedule`, `SchedRun`, `SchedWhen`, `SchedView`);
   `normalizeSchedule(raw, now, known)` (validation, defaults, messages); `whenCron`, `whenText`;
   `zonedParts`, `nextSlot(cron, from, tz)`; `dueSlots(s, now)` → `{latest, count}`; `planTick`
   (what each schedule does this tick: run / missed-run / skip-row / nothing, one missed run per
   tick); `runName(s, slot, taken)`; `runProgress(run, session, now)`; `runCost(run, state)`;
   `withRun` / history trim; `schedView`. Export the cron field reader from `shared/schedules.ts`.
2. **`main/sched.ts` + tests.** `SchedStore` (`<home>/schedules.json`, atomic, `onChange`) and
   `Scheduler` (`tick(now)`: progress, cost limit, notifications, due starts; `runNow(id)`), with
   deps injected (`start`, `stop`, `state`, `notify`, `templateName`).
3. **Main wiring.** `startSession()` out of `CH.startClaude` (returns bg id); `CH.sched*` handlers;
   30 s timer, launch tick, `powerMonitor` `resume`; `AppState.schedRuns` (state callback), fixture
   in `notify.test.ts`.
4. **IPC.** `CH`, `DeckApi`, preload, `DECK_ACCESS` + `REMOTE_EVENTS`.
5. **Renderer.** `View` `schedules`, Rail tool + icon, App routing and saved view, palette action,
   `web.ts` (`WEB_VIEWS`, `SCREEN_NEEDS`), `SchedulesView.tsx` (list, runs, editor), CSS with tokens
   only, the ⏱ chip in the session row, web preview fixture.
6. **Docs.** GUIDE (Schedules), ARCHITECTURE (Schedules section, files on disk, IPC), TODO (done +
   open points, #135 hook-up), CLAUDE.md (Where things live, Current state).
7. **Check.** typecheck, vitest, `build:web`, the web preview (1400 / 390 px), the isolated app
   with a stand-in `claude` (create, Run now, a due slot, a missed run after a restart, skip if
   running, the chip, history after a restart). Final review (subagent), fixes, PR.

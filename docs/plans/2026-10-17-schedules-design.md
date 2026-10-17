# Schedules: sessions that start on a timer (#140): design

The user's first instruction was "take the recommended decisions, write the spec and the plan and
do this end to end"; the decisions below are the recommended ones, taken without a brainstorm round.

## Goal

Work that should run without anyone starting it (triage every morning, nightly dependency updates,
a weekly audit): a **schedule** starts a real `claude --bg` session with a prompt, optionally under
a saved workflow (#82, #104), in a folder, as a GitHub account, with a model, on a timer.

## Names

`schedules` is taken: `shared/schedules.ts` / `AppState.schedules` are the CronCreate jobs a session
made itself (Details → Scheduled). The new feature is **Schedules** in the UI and `sched*` in code:
`shared/sched.ts` (pure), `main/sched.ts` (store and runner), `CH.sched*`,
`renderer/.../SchedulesView.tsx`. The cron field reader of `shared/schedules.ts` is shared.

## Approaches considered

- **A. Through master's ledger** (`master add --kind START` + approve + spawn). It reuses the CLI's
  account and trust handling, but every run adds a proposal master-agent and the Master view see,
  and the run's bg id comes back as text in a note. Rejected: a daily schedule is not a proposal.
- **B. Through the app's own start (`CH.startClaude`).** Chosen. The handler's body becomes
  `startSession()` (name check, folder check, account `--settings`, pending workflow, peers,
  `claude --bg`), returning the bg id; the + menu and the scheduler both call it. Account,
  workflow and model behave exactly as in **New Claude session**.
- **C. launchd / Task Scheduler.** Runs with MasterDeck closed, but two platforms, a second writer,
  and no session tracking. Rejected; missed runs are caught up when MasterDeck runs again.

## A schedule

```
{ id, name, enabled,
  what: { prompt, workflow: template id | null },   // workflow null = the default workflow
  cwd, account: login | null, model: string | null, mode: permission mode | null,
  when: { kind: 'daily', time } | { kind: 'weekdays', time } | { kind: 'weekly', days, time }
      | { kind: 'hours', every: 1..23, minute } | { kind: 'cron', expr },
  tz: IANA zone (default the Mac's),
  skipIfRunning: true, maxCostUsd: number | null,
  notify: { finish: true, failure: true },
  missed: 'once' | 'skip',                           // default 'once'
  createdAt, updatedAt, lastSlot }                   // the last slot handled (fired, skipped or missed)
```

- "Workflow or prompt": the prompt is always the session's first message (a session without one
  sits idle and never "runs"). With a workflow picked, the prompt may be left empty; it then is
  `Scheduled run of "<schedule>": follow the workflow "<template name>".`. The workflow is attached
  as the + menu does it (`WorkflowStore.setPending`), so its hooks drive the session.
- Every `when` compiles to a 5-field cron (`daily 09:00` → `0 9 * * *`, `weekdays` → `… 1-5`,
  `weekly` → `… 1,3`, `hours` every N → `m */N * * *`, `cron` as typed, checked with the same field
  reader). Slots are minutes of wall-clock time **in the schedule's zone** (`Intl.DateTimeFormat`),
  so "09:00 Europe/Berlin" stays 09:00 there across DST and Mac zone changes.
- A schedule made or re-enabled starts counting from that moment (`lastSlot = now`): nothing in the
  past is "missed".

## Runs

```
{ id, scheduleId, scheduleName, slot (planned time) | null (Run now),
  trigger: 'schedule' | 'missed' | 'manual',
  status: 'running' | 'done' | 'failed' | 'skipped' | 'stopped',
  reason?, startedAt, endedAt | null, sessionName, bgId | null, sessionId | null,
  seenWorking, costUsd }
```

- **Session name**: `<slug of schedule name>-<MMDD-HHmm>` (slot time in the schedule's zone; `-2`
  … when taken). The session list shows a **⏱ <schedule>** chip on it (`AppState.schedRuns`:
  session key → schedule id and name, for runs of the last 30 days).
- **Start**: `startSession` as above. A refusal (folder gone, account not connected, trust, claude
  failing) is a `failed` run with Claude Code's message.
- **Progress** (every tick, from `latest.sessions`, matched by bg id, else by name):
  `working` / `needs-input` → running (`seenWorking`); `idle` with nothing busy or waited on, after
  it worked (or 3 minutes after the start) → `done`; `done` (process ended) → `done` if it worked,
  else `failed`; never listed 10 minutes after the start → `failed`. A run that waits on the user
  (`needs-input`) stays running: it is not finished.
- **Cost**: the run's session's cost book entries (`key === bgId`, all ids after resumes) and its
  live status-line cost, the larger. Updated while running and for 10 minutes after the end.
- **Max cost**: a running run above `maxCostUsd` is stopped (`claude stop <bg>`), status `stopped`,
  reason "over the run's cost limit". Its conversation is kept, as with any Stop.
- **Overlap**: with `skipIfRunning`, a slot or Run now while a run of the schedule is `running` is
  recorded as `skipped` ("the previous run is still going"). Without it a second session starts.
- **History**: the last 50 runs per schedule; a schedule's delete removes its runs.

## When runs start

A tick every 30 s (and at once at launch and on `powerMonitor` `resume`):

1. Update running runs (progress, cost, max cost, notifications).
2. For each enabled schedule, the slots after `lastSlot` up to now (at most 10 000 looked at):
   - none: nothing;
   - the latest is at most 5 minutes old: it runs (`trigger: 'schedule'`); older ones in between
     are dropped without a row;
   - the latest is older (the Mac slept or MasterDeck was closed): `missed: 'once'` → one run now
     (`trigger: 'missed'`, reason "N missed while MasterDeck was not running"); `'skip'` → one
     `skipped` row saying so.
   - `lastSlot` becomes that latest slot either way, so a schedule fires **at most once per tick**
     and a missed day is never run twice.
3. Starts go one after the other, and at most one **missed** run starts per tick (the rest wait for
   the next ticks), so a wake never starts a burst.

The store is written (temp + rename) before a session is started, so a crash between the two never
starts it again. Two MasterDeck instances are not a case (single-instance lock).

DST: a fall-back hour repeats its wall-clock minutes; a schedule inside it may run twice
(ponytail: compare wall-clock slots instead of instants if it matters).

## Notifications

On finish (`done`) and failure (`failed`, `stopped`) when the schedule's own switch is on, a system
notification "<schedule>: finished · $0.42" / "<schedule>: failed — reason"; clicking opens the
session (`target.sessionKey`). Notifications (#135) is being built in parallel: until it lands,
these go out through `notify()` like the workflow notify step; when it lands, the type
`schedule-run` (System on, Needs you off) is added to `NOTIFY_TYPES` and these route through its
dispatcher, so Pause all and the per-type cells apply (TODO item for whichever lands second).
Skipped runs never notify.

## The Schedules view

A rail tool (clock icon), also under More on a phone, `Go to Schedules` in the palette:

- **List**: name, what (prompt start / workflow), when in words + zone, folder, next run, last run's
  status and cost, an on/off switch, **Run now**, **Edit**, **Delete** (asks first).
- **Detail** (a row opened): the last runs: started, ended, trigger, status (+ reason), cost, and
  the session (click focuses it in Terminals).
- **Editor** (New schedule / Edit): name, prompt, workflow, folder (workspace repos or Other
  folder…), account (two or more), model, permissions, when (kind + fields, cron with a preview of
  the next 3 runs), time zone, skip if running, max cost, notify on finish / failure, missed runs
  (Run once / Skip).
- Empty state: what schedules are for and **New schedule**.

## IPC and the web

`sched:list` (schedules with `nextAt`, `running`, last run; runs), `sched:save`, `sched:delete`,
`sched:enable`, `sched:runNow`, event `sched:changed`. All `remote`: the web app may already start
any session with **New Claude session** (`startClaude` is remote and takes any folder), and a
schedule is the same start, later. Delete asks with `webConfirm` on the web, a native dialog on the
Mac. Input is validated in main (`normalizeSchedule`). Schedules never enter `toRemoteSnapshot`.

## Out of scope

Runs while MasterDeck is closed (launchd), per-run worktrees, a schedule started from a board
filter, chaining schedules, Windows-specific testing.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { accountChoices, isMulti } from '@shared/accounts'
import { actionCount, DEFAULT_TEMPLATE, type WorkflowTemplate } from '@shared/flow'
import { formatAgo, formatCost } from '@shared/format'
import { defaultModelLabel, MODELS } from '@shared/models'
import { nextSlots, SCHED_EVERY, validZone, whenCron, type SchedInput, type SchedList, type SchedRun, type SchedView, type SchedWhen } from '@shared/sched'
import type { AppState, Session } from '@shared/types'
import { deck, useNow } from '../deck'
import { can } from '../web'
import { webConfirm } from '../webConfirm'
import { RepoPicker } from './RepoPicker'
import { TrustNote, useTrust } from './TrustFix'
import { isNotTrusted } from '@shared/trust'

/** The list, kept fresh by `sched:changed` (subscribed before the first read, so nothing is missed). */
function useSchedules(): [SchedList | null, () => void] {
  const [list, setList] = useState<SchedList | null>(null)
  const load = useCallback(() => {
    void deck()
      .schedList()
      .then(setList)
      .catch(() => {})
  }, [])
  useEffect(() => {
    const off = deck().onSchedChanged(load)
    load()
    return off
  }, [load])
  return [list, load]
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A time in the viewer's zone, with how far off it is. */
function when(t: number | null, now: number): string {
  if (t === null) return '—'
  const d = new Date(t)
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const rel = t >= now ? `in ${formatAgo(t - now)}` : `${formatAgo(now - t)} ago`
  return `${day} ${hm} (${rel})`
}

const STATUS: Record<SchedRun['status'], string> = {
  running: 'Running',
  done: 'Finished',
  failed: 'Failed',
  skipped: 'Skipped',
  stopped: 'Stopped',
}
const TRIGGER: Record<SchedRun['trigger'], string> = { schedule: 'on time', missed: 'catch-up', manual: 'Run now' }

function RunStatus({ r }: { r: SchedRun }) {
  return (
    <span className={`sched-status sched-${r.status}`} title={r.reason}>
      {STATUS[r.status]}
    </span>
  )
}

/**
 * Schedules (#140): sessions MasterDeck starts on a timer, with a prompt and optionally a workflow.
 * The list (on/off, Run now, Edit, Delete), a schedule's last runs, and the editor.
 */
export function SchedulesView({ state, onOpenSession }: { state: AppState; onOpenSession: (s: Session) => void }) {
  const now = useNow(30_000)
  const [list] = useSchedules()
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<SchedView | 'new' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const canEdit = can('schedSave')

  const act = async (id: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(id)
    try {
      const r = await fn()
      setMsg(r.ok ? null : r.message)
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (s: SchedView) => {
    if (!(await webConfirm(`Delete the schedule "${s.name}"? Its run history goes; sessions it started keep running.`, { confirmLabel: 'Delete', danger: true }))) return
    await act(s.id, () => deck().schedDelete(s.id))
    if (open === s.id) setOpen(null)
  }
  const sessionOf = (r: SchedRun) => (r.bgId ? (state.sessions.find((s) => s.key === r.bgId || s.bgId === r.bgId) ?? null) : null)
  const shown = list?.schedules.find((s) => s.id === open) ?? null
  const runs = shown ? list!.runs.filter((r) => r.scheduleId === shown.id) : []

  return (
    <section className="board-view panel sched-view">
      <header className="board-head">
        <h2>Schedules</h2>
        <span className="muted">sessions that start on a timer, as claude --bg sessions on this Mac</span>
        <span style={{ flex: 1 }} />
        {msg && <span className="error small">{msg}</span>}
        {canEdit && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            New schedule
          </button>
        )}
      </header>
      <div className="panel-body">
        {list === null && <div className="muted">Loading…</div>}
        {list?.schedules.length === 0 && (
          <div className="sched-empty">
            <p>
              A schedule starts a Claude session for you: triage new issues every morning, update dependencies every night, run a security audit every
              Monday. Each run is a normal background session in the session list, with a prompt and, if you pick one, a workflow.
            </p>
            <p className="muted">Runs start while MasterDeck is open. A run missed while the Mac slept or MasterDeck was closed runs once when it is back (or is skipped, as you choose).</p>
            {canEdit && (
              <button className="btn primary" onClick={() => setEditing('new')}>
                New schedule
              </button>
            )}
          </div>
        )}
        {!!list?.schedules.length && (
          <table className="tbl sched-tbl">
            <thead>
              <tr>
                <th>On</th>
                <th>Schedule</th>
                <th>When</th>
                <th>Next run</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.schedules.map((s) => (
                <tr key={s.id} className={open === s.id ? 'sel' : undefined} onClick={() => setOpen(open === s.id ? null : s.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={busy === s.id}
                      title={s.enabled ? 'On: pause it' : 'Paused: turn it on (it counts from now)'}
                      aria-label={s.enabled ? `Pause ${s.name}` : `Turn on ${s.name}`}
                      onChange={(e) => void act(s.id, () => deck().schedEnable(s.id, e.target.checked))}
                    />
                  </td>
                  <td>
                    <div className="sched-name">{s.name}</div>
                    <div className="muted small sched-what" title={s.prompt}>
                      {s.workflow ? `workflow ${s.workflow}` : 'prompt'} · <span className="mono">{s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd}</span>
                      {s.account ? ` · @${s.account}` : ''}
                    </div>
                  </td>
                  <td>
                    {s.whenText}
                    <div className="muted small">{s.tz}</div>
                  </td>
                  <td>{s.enabled ? when(s.nextAt, now) : <span className="muted">paused</span>}</td>
                  <td>
                    {s.lastRun ? (
                      <>
                        <RunStatus r={s.lastRun} /> <span className="muted small">{formatAgo(now - s.lastRun.startedAt)} ago</span>
                        {s.lastRun.costUsd > 0 && <span className="muted small"> · {formatCost(s.lastRun.costUsd)}</span>}
                      </>
                    ) : (
                      <span className="muted">never</span>
                    )}
                  </td>
                  <td className="r sched-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn small"
                      disabled={busy === s.id || (s.running && s.skipIfRunning)}
                      title={s.running && s.skipIfRunning ? 'A run is still going' : 'Start a run now'}
                      onClick={() => void act(s.id, () => deck().schedRunNow(s.id))}
                    >
                      Run now
                    </button>
                    {canEdit && (
                      <button className="btn small" onClick={() => setEditing(s)}>
                        Edit
                      </button>
                    )}
                    {can('schedDelete') && (
                      <button className="btn small danger" onClick={() => void remove(s)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {shown && (
          <>
            <h3 className="sec">Runs of {shown.name}</h3>
            <SchedTrust cwd={shown.cwd} refused={runs.some((r) => r.status === 'failed' && isNotTrusted(r.reason))} />
            <table className="tbl sched-runs">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Took</th>
                  <th className="r">Cost</th>
                  <th>Session</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No runs yet.
                    </td>
                  </tr>
                )}
                {runs.map((r) => {
                  const s = sessionOf(r)
                  return (
                    <tr key={r.id}>
                      <td>
                        {when(r.startedAt, now)}
                        <div className="muted small">{TRIGGER[r.trigger]}</div>
                      </td>
                      <td>
                        <RunStatus r={r} />
                        {r.reason && (
                          <div className="muted small sched-reason" title={r.reason}>
                            {isNotTrusted(r.reason) ? 'Claude Code was not allowed to work in its folder (see above).' : r.reason}
                          </div>
                        )}
                      </td>
                      <td>{r.status === 'skipped' ? '—' : formatAgo((r.endedAt ?? now) - r.startedAt)}</td>
                      <td className="r">{r.status === 'skipped' ? '—' : formatCost(r.costUsd)}</td>
                      <td>
                        {s ? (
                          <button className="link mono" onClick={() => onOpenSession(s)} title="Open its terminal">
                            {r.sessionName}
                          </button>
                        ) : (
                          <span className="mono muted">{r.sessionName || '—'}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
      {editing && list && <SchedEditor state={state} sched={editing === 'new' ? null : editing} tz={list.tz} onClose={() => setEditing(null)} />}
    </section>
  )
}

/**
 * Claude Code's trust prompt for a schedule's folder: every run there is refused until the user
 * answers it (**Open Claude there…**; MasterDeck never does). Said when the folder is known not to
 * be trusted, or a run was refused for it; nothing for a trusted folder or one nothing is known about.
 */
function SchedTrust({ cwd, refused }: { cwd: string | null; refused: boolean }) {
  const trust = useTrust(cwd, undefined)
  // After Open Claude there… it stays to say the folder is now allowed.
  const show = !!cwd && (trust.opened || (trust.trusted !== true && (trust.trusted === false || refused)))
  if (!show) return null
  return (
    <div className="sched-trust">
      <TrustNote trust={trust} />
    </div>
  )
}

type WhenKind = SchedWhen['kind']

/** The editor's fields as typed (strings), turned into a `SchedInput` on save. */
interface Draft {
  name: string
  prompt: string
  workflow: string
  cwd: string
  account: string
  model: string
  mode: string
  kind: WhenKind
  time: string
  days: number[]
  every: string
  minute: string
  expr: string
  tz: string
  skipIfRunning: boolean
  maxCost: string
  finish: boolean
  failure: boolean
  missed: 'once' | 'skip'
}

function draftOf(s: SchedView | null, tz: string): Draft {
  const w = s?.when
  return {
    name: s?.name ?? '',
    prompt: s?.prompt ?? '',
    workflow: s?.workflow ?? DEFAULT_TEMPLATE,
    cwd: s?.cwd ?? '',
    account: s?.account ?? '',
    model: s?.model ?? '',
    mode: s?.mode ?? '',
    kind: w?.kind ?? 'weekdays',
    time: w && 'time' in w ? w.time : '09:00',
    days: w?.kind === 'weekly' ? w.days : [1],
    every: w?.kind === 'hours' ? String(w.every) : '4',
    minute: w?.kind === 'hours' ? String(w.minute) : '0',
    expr: w?.kind === 'cron' ? w.expr : '0 9 * * 1-5',
    tz: s?.tz ?? tz,
    skipIfRunning: s?.skipIfRunning ?? true,
    maxCost: s?.maxCostUsd != null ? String(s.maxCostUsd) : '',
    finish: s?.notify.finish ?? true,
    failure: s?.notify.failure ?? true,
    missed: s?.missed ?? 'once',
  }
}

function whenOf(d: Draft): SchedWhen {
  switch (d.kind) {
    case 'daily':
    case 'weekdays':
      return { kind: d.kind, time: d.time }
    case 'weekly':
      return { kind: 'weekly', days: d.days, time: d.time }
    case 'hours':
      return { kind: 'hours', every: Number(d.every), minute: Number(d.minute) }
    case 'cron':
      return { kind: 'cron', expr: d.expr }
  }
}

const MODES: [string, string][] = [
  ['', 'As in your settings'],
  ['plan', 'Plan first (read-only until you approve)'],
  ['acceptEdits', 'Accept edits (asks before commands)'],
  ['auto', 'Auto (Claude decides what is safe)'],
  ['manual', 'Ask for everything'],
]

const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
})()

function SchedEditor({ state, sched, tz, onClose }: { state: AppState; sched: SchedView | null; tz: string; onClose: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(sched, tz))
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const [repos, setRepos] = useState<{ name: string; path: string }[]>([])
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [configured, setConfigured] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const multi = isMulti(state.config)

  useEffect(() => {
    void deck()
      .workspaceRepos()
      .then((r) => {
        setRepos(r)
        if (r[0]) setD((x) => (x.cwd ? x : { ...x, cwd: r[0].path }))
      })
    void deck().defaultModel().then(setConfigured)
    if (can('workflowGet'))
      void deck()
        .workflowGet()
        .then((w) => setTemplates(w.templates))
  }, [])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const when = whenOf(d)
  const cron = whenCron(when)
  const zoneOk = validZone(d.tz)
  const preview = useMemo(() => (cron && zoneOk ? nextSlots(cron, Date.now(), d.tz, 3) : []), [cron, zoneOk, d.tz])
  const other = d.cwd && !repos.some((r) => r.path === d.cwd)
  const wf = d.workflow !== DEFAULT_TEMPLATE
  const ready = !!d.name.trim() && !!d.cwd && !!cron && zoneOk && (!!d.prompt.trim() || wf)

  const save = async () => {
    if (!ready || saving) return
    const input: SchedInput & { id?: string } = {
      // An edit leaves on/off alone (a pause made meanwhile stays).
      ...(sched ? { id: sched.id } : { enabled: true }),
      name: d.name,
      prompt: d.prompt,
      workflow: wf ? d.workflow : null,
      cwd: d.cwd,
      account: d.account || null,
      model: d.model || null,
      mode: d.mode || null,
      when,
      tz: d.tz,
      skipIfRunning: d.skipIfRunning,
      maxCostUsd: d.maxCost.trim() ? Number(d.maxCost) : null,
      notify: { finish: d.finish, failure: d.failure },
      missed: d.missed,
    }
    setSaving(true)
    const r = await deck().schedSave(input)
    setSaving(false)
    if (r.ok) onClose()
    else setError(r.message)
  }

  const pickOther = async () => {
    if (!can('pickFolder')) return setPicking(true)
    const p = await deck().pickFolder(d.cwd || undefined)
    if (p) set('cwd', p)
  }

  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog new-session sched-editor" role="dialog" aria-label={sched ? 'Edit schedule' : 'New schedule'}>
        <h3>{sched ? 'Edit schedule' : 'New schedule'}</h3>
        <label>Name</label>
        <input value={d.name} autoFocus placeholder="Morning triage" onChange={(e) => set('name', e.target.value)} />
        <label>Prompt{wf ? ' (optional with a workflow)' : ''}</label>
        <textarea
          value={d.prompt}
          placeholder="What should each run do? e.g. Triage the issues opened since yesterday: label them and ask for what is missing."
          onChange={(e) => set('prompt', e.target.value)}
        />
        <div className="ns-grid">
          <div>
            <label>Workflow</label>
            <select className="fsel full" value={d.workflow} onChange={(e) => set('workflow', e.target.value)}>
              {!templates.some((t) => t.id === d.workflow) && <option value={d.workflow}>{d.workflow === DEFAULT_TEMPLATE ? 'Default' : `${d.workflow} (missing)`}</option>}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({actionCount(t.flow)} blocks)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Model</label>
            <select className="fsel full" value={d.model} onChange={(e) => set('model', e.target.value)}>
              <option value="">{defaultModelLabel(configured)}</option>
              {MODELS.filter((m) => m.value !== configured).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label>Folder</label>
        <select className="fsel full" value={other ? '__other' : d.cwd} onChange={(e) => (e.target.value === '__other' ? void pickOther() : set('cwd', e.target.value))}>
          {repos.map((r) => (
            <option key={r.path} value={r.path}>
              {r.name}
            </option>
          ))}
          {other && <option value="__other">{d.cwd}</option>}
          <option value="__other">Other folder…</option>
        </select>
        {d.cwd && <div className="meta mono">{d.cwd}</div>}
        <SchedTrust cwd={d.cwd || null} refused={false} />
        <div className="ns-grid">
          {multi && (
            <div>
              <label>Account</label>
              <select className="fsel full" value={d.account} onChange={(e) => set('account', e.target.value)} title="The GitHub account each run works as">
                <option value="">The folder&apos;s account</option>
                {accountChoices(state.config, state.ghAccounts).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label>Permissions</label>
            <select className="fsel full" value={d.mode} onChange={(e) => set('mode', e.target.value)}>
              {MODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label>When</label>
        <div className="sched-when">
          <select className="fsel" value={d.kind} onChange={(e) => set('kind', e.target.value as WhenKind)}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">On days</option>
            <option value="hours">Every N hours</option>
            <option value="cron">Cron expression</option>
          </select>
          {(d.kind === 'daily' || d.kind === 'weekdays' || d.kind === 'weekly') && (
            <>
              <span className="muted">at</span>
              <input type="time" className="sched-time" value={d.time} onChange={(e) => set('time', e.target.value)} />
            </>
          )}
          {d.kind === 'hours' && (
            <>
              <span className="muted">every</span>
              <select className="fsel" value={d.every} onChange={(e) => set('every', e.target.value)} aria-label="Hours">
                {SCHED_EVERY.map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="muted">hours at minute</span>
              <input className="sched-num" inputMode="numeric" value={d.minute} onChange={(e) => set('minute', e.target.value)} aria-label="Minute" />
            </>
          )}
          {d.kind === 'cron' && <input className="mono sched-cron" value={d.expr} spellCheck={false} placeholder="minute hour day month weekday" onChange={(e) => set('expr', e.target.value)} />}
        </div>
        {d.kind === 'weekly' && (
          <div className="sched-days">
            {DAYS.map((name, i) => (
              <label key={name} className="check">
                <input type="checkbox" checked={d.days.includes(i)} onChange={(e) => set('days', e.target.checked ? [...d.days, i] : d.days.filter((x) => x !== i))} />
                {name}
              </label>
            ))}
          </div>
        )}
        <label>Time zone</label>
        <input value={d.tz} list="sched-zones" spellCheck={false} onChange={(e) => set('tz', e.target.value)} />
        <datalist id="sched-zones">
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <div className="meta">
          {!cron
            ? 'Not a schedule yet: check the time, the days or the cron.'
            : !zoneOk
              ? 'Unknown time zone.'
              : preview.length
                ? `Next: ${preview.map((t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ')} (your time)`
                : 'It never runs.'}
        </div>

        <label className="check">
          <input type="checkbox" checked={d.skipIfRunning} onChange={(e) => set('skipIfRunning', e.target.checked)} />
          Skip a run while the previous one is still going
        </label>
        <label className="check">
          <input type="checkbox" checked={d.finish} onChange={(e) => set('finish', e.target.checked)} />
          Notify when a run finishes
        </label>
        <label className="check">
          <input type="checkbox" checked={d.failure} onChange={(e) => set('failure', e.target.checked)} />
          Notify when a run fails or is stopped
        </label>
        <div className="ns-grid">
          <div>
            <label>Cost limit per run (USD)</label>
            <input inputMode="decimal" value={d.maxCost} placeholder="none" onChange={(e) => set('maxCost', e.target.value)} title="A run that spends more is stopped (its conversation is kept)" />
          </div>
          <div>
            <label>Missed runs</label>
            <select className="fsel full" value={d.missed} onChange={(e) => set('missed', e.target.value as 'once' | 'skip')} title="Runs due while the Mac slept or MasterDeck was closed">
              <option value="once">Run once when back</option>
              <option value="skip">Skip them</option>
            </select>
          </div>
        </div>
        <div className="meta">Each run is a claude --bg session named after the schedule and its time, in the session list. Runs start while MasterDeck is open.</div>
        {error && <div className="error small">{error}</div>}
        <div className="form-buttons">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready || saving} onClick={() => void save()}>
            {sched ? 'Save' : 'Create schedule'}
          </button>
        </div>
      </div>
      {picking && (
        <RepoPicker
          start={d.cwd}
          onDone={(p) => {
            setPicking(false)
            if (p) set('cwd', p)
          }}
        />
      )}
    </div>,
    document.body,
  )
}

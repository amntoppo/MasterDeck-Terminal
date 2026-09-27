import { useCallback, useEffect, useState } from 'react'
import { STAGES, stageOf, TRIGGERS, type CustomStep, type HookEntry, type Stage, type StageId } from '@shared/workflow'
import type { AppState } from '@shared/types'
import { deck } from '../deck'

type Data = { hooks: HookEntry[]; skills: { name: string; description: string }[]; steps: CustomStep[] }

const SOURCE: Record<HookEntry['source'], string> = { user: 'your settings', project: 'project', plugin: 'plugin' }

function whereLabel(h: HookEntry): string {
  return h.source === 'user' ? SOURCE.user : `${SOURCE[h.source]} ${h.where ?? ''}`.trim()
}

/** A command, short: what runs, without the shell plumbing. */
function short(c: string): string {
  const one = c.replace(/\s+/g, ' ').trim()
  return one.length > 110 ? `${one.slice(0, 110)}…` : one
}

/**
 * The workflow a ticket goes through, with every hook Claude Code runs at each point (from your
 * settings, the workspace's repos and enabled plugins) and custom steps: a skill attached to a
 * point, run by a hook.
 */
export function WorkflowView({ state }: { state: AppState }) {
  const [data, setData] = useState<Data | null>(null)
  const [adding, setAdding] = useState<StageId | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => setData(await deck().workflowGet()), [])
  useEffect(() => void load(), [load])

  const save = async (steps: CustomStep[]) => {
    setBusy(true)
    const r = await deck().workflowSave(steps)
    setBusy(false)
    setMsg(r.message)
    if (r.ok) await load()
    return r.ok
  }

  const hooksAt = (id: StageId) => (data?.hooks ?? []).filter((h) => h.event !== 'StatusLine' && stageOf(h, data?.steps) === id)
  const byEvent = new Map<string, HookEntry[]>()
  for (const h of data?.hooks ?? []) byEvent.set(h.event, [...(byEvent.get(h.event) ?? []), h])

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Workflow</h2>
        <span className="muted">what happens from an issue to a merged PR, the hooks that run at each point, and your own steps</span>
        <span style={{ flex: 1 }} />
        {msg && <span className="muted">{msg}</span>}
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      <div className="panel-body">
        <div className="flow-strip">
          {STAGES.map((s, i) => (
            <span key={s.id} className="flow-item">
              {i > 0 && <span className="flow-arrow">→</span>}
              <a
                className="flow-chip"
                href={`#stage-${s.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(`stage-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                {s.title}
              </a>
            </span>
          ))}
        </div>

        {!data ? (
          <div className="empty">Reading the hooks…</div>
        ) : (
          <div className="stages">
            {STAGES.map((s, i) => (
              <StageCard
                key={s.id}
                n={i + 1}
                stage={s}
                hooks={hooksAt(s.id)}
                steps={data.steps.filter((x) => STAGES.find((st) => st.trigger === x.trigger)?.id === s.id)}
                skills={data.skills}
                masterOn={state.config.masterEnabled}
                adding={adding === s.id}
                busy={busy}
                onAdd={() => setAdding(adding === s.id ? null : s.id)}
                onSave={async (step) => (await save([...data.steps, step])) && setAdding(null)}
                onRemove={(id) => void save(data.steps.filter((x) => x.id !== id))}
              />
            ))}
          </div>
        )}

        {data && (
          <>
            <h3 className="sec">Every hook Claude Code runs ({data.hooks.length})</h3>
            <div className="meta">
              From <code>~/.claude/settings.json</code>, the <code>.claude/settings*.json</code> of the repos in your workspace, and
              your enabled plugins. Hooks in other repos run only in sessions there.
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>From</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {[...byEvent].flatMap(([event, list]) =>
                  list.map((h, i) => (
                    <tr key={`${event}-${i}`}>
                      <td className="mono nowrap">
                        {i === 0 ? event : ''}
                        {h.matcher ? <span className="muted"> · {h.matcher}</span> : null}
                      </td>
                      <td className="nowrap">
                        <span className={`src src-${h.source}`}>{whereLabel(h)}</span>
                      </td>
                      <td title={h.command}>{h.owner ? <b>{h.owner}</b> : <span className="mono muted">{short(h.command)}</span>}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  )
}

function StageCard(p: {
  n: number
  stage: Stage
  hooks: HookEntry[]
  steps: CustomStep[]
  skills: { name: string; description: string }[]
  masterOn: boolean
  adding: boolean
  busy: boolean
  onAdd: () => void
  onSave: (s: CustomStep) => void
  onRemove: (id: string) => void
}) {
  const s = p.stage
  const trigger = TRIGGERS.find((t) => t.id === s.trigger)
  const others = p.hooks.filter((h) => !h.owner?.startsWith('custom step'))
  return (
    <div className="stage" id={`stage-${s.id}`}>
      <div className="stage-n">{p.n}</div>
      <div className="stage-body">
        <div className="stage-head">
          <b>{s.title}</b>
          <span className="muted">· {s.actor}</span>
        </div>
        <div className="stage-what">{s.what}</div>
        <ul className="stage-list">
          {s.builtin
            .filter((b) => p.masterOn || !b.startsWith('master-agent'))
            .map((b) => (
              <li key={b}>{b}</li>
            ))}
        </ul>
        {others.length > 0 && (
          <div className="stage-hooks">
            {others.map((h, i) => (
              <div key={i} className="hook-row" title={h.command}>
                <span className="ev">{h.event}</span>
                <span className={`src src-${h.source}`}>{whereLabel(h)}</span>
                <span className="grow">{h.owner ?? <span className="mono muted">{short(h.command)}</span>}</span>
              </div>
            ))}
          </div>
        )}
        {p.steps.map((st) => (
          <div key={st.id} className="custom-step">
            <span className="ev">your step</span>
            <span className="grow">
              <b>{st.skill}</b> <span className="muted">· {st.mode === 'background' ? 'background subagent' : 'in the session'}</span>
              {st.instructions && <span className="muted"> · {st.instructions}</span>}
            </span>
            <button className="link-btn" disabled={p.busy} onClick={() => p.onRemove(st.id)}>
              Remove
            </button>
          </div>
        ))}
        {trigger && (
          <button className="add-step" onClick={p.onAdd}>
            {p.adding ? 'Cancel' : `+ Add a skill · ${trigger.label}`}
          </button>
        )}
        {p.adding && trigger && <AddStep trigger={trigger.id} skills={p.skills} busy={p.busy} onSave={p.onSave} />}
      </div>
    </div>
  )
}

function AddStep({ trigger, skills, busy, onSave }: { trigger: CustomStep['trigger']; skills: { name: string; description: string }[]; busy: boolean; onSave: (s: CustomStep) => void }) {
  const [skill, setSkill] = useState('')
  const [mode, setMode] = useState<CustomStep['mode']>('background')
  const [instructions, setInstructions] = useState('')
  const picked = skills.find((s) => s.name === skill)
  return (
    <div className="add-form">
      <label>Skill</label>
      <select className="fsel full" value={skill} onChange={(e) => setSkill(e.target.value)}>
        <option value="">Choose a skill in ~/.claude/skills…</option>
        {skills.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      {picked?.description && <div className="meta">{picked.description}</div>}
      <label>How it runs</label>
      <div className="seg">
        <button className={mode === 'background' ? 'on' : ''} onClick={() => setMode('background')}>
          Background subagent (doesn't block)
        </button>
        <button className={mode === 'session' ? 'on' : ''} onClick={() => setMode('session')}>
          In the session
        </button>
      </div>
      <label>Extra instructions (optional)</label>
      <input value={instructions} placeholder="e.g. deploy to staging, then post the URL on the issue" onChange={(e) => setInstructions(e.target.value)} />
      <div className="meta">
        A hook in <code>~/.claude/settings.json</code> (a backup is kept) tells each session to run it at this point. A skill you create later
        shows up here once it is in <code>~/.claude/skills</code>.
      </div>
      <button
        className="btn primary"
        disabled={!skill || busy}
        onClick={() =>
          onSave({
            id: `${skill.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`,
            trigger,
            skill,
            mode,
            instructions,
          })
        }
      >
        {busy ? 'Saving…' : 'Add to the workflow'}
      </button>
    </div>
  )
}

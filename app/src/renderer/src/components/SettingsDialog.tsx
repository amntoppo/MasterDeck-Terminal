import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import type { AppState, SkillStatus } from '@shared/types'
import { deck } from '../deck'

const SKILL_TEXT: Record<SkillStatus['state'], string> = {
  installed: 'installed',
  outdated: 'update pending',
  modified: 'changed by you',
  custom: 'your own copy',
  linked: 'symlink (left alone)',
  missing: 'not installed',
}

export function SettingsDialog({ settings, state, onClose, onSetup }: { settings: Settings; state: AppState; onClose: () => void; onSetup: () => void }) {
  const [skillMsg, setSkillMsg] = useState<string | null>(null)
  const [s, setS] = useState<Settings>(settings)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) })
  const save = async () => {
    setS(await deck().setSettings(s))
    setSaved(true)
    setTimeout(onClose, 400)
  }
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Settings">
        <h3>Settings</h3>
        <label>GitHub & board</label>
        <div className="setup-summary">
          {state.config.configured ? (
            <span>
              <code>{state.config.owner}/{state.config.issueRepo}</code>
              {state.config.project ? ` · project #${state.config.project}` : ' · no board'}
            </span>
          ) : (
            <span className="bad">Not set up</span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onSetup}>
            {state.config.configured ? 'Change…' : 'Set up…'}
          </button>
        </div>
        <label>Skills (in ~/.claude/skills)</label>
        <div className="skills-list">
          {state.skills.map((k) => (
            <div key={k.name} className="skill-row">
              <code>{k.name}</code>
              <span className={k.state === 'installed' ? 'ok' : k.state === 'missing' ? 'bad' : 'muted'}>{SKILL_TEXT[k.state]}</span>
              <span style={{ flex: 1 }} />
              {k.state !== 'installed' && (
                <button
                  className="link-btn"
                  title="Replace with the version bundled with MasterDeck; the current folder is kept in ~/.claude/skills/.masterdeck-backup"
                  onClick={async () => setSkillMsg((await deck().skillReinstall(k.name)).message)}
                >
                  {k.state === 'missing' ? 'Install' : 'Replace with bundled'}
                </button>
              )}
            </div>
          ))}
          {skillMsg && <div className="muted small">{skillMsg}</div>}
        </div>
        <div className="muted small">
          Hooks: babysit-ticket {state.hooks.ticket ? 'on' : 'off'} · babysit-pr {state.hooks.pr ? 'on' : 'off'} (change them in GitHub & board)
        </div>
        <label>Nudge a quiet session after (minutes)</label>
        <input type="number" min={1} value={s.idleNudgeMinutes} onChange={num('idleNudgeMinutes')} />
        <label>Budget per ticket (USD, 0 = off)</label>
        <input type="number" min={0} value={s.budgetPerTicketUsd} onChange={num('budgetPerTicketUsd')} />
        <label>Context warning at (%)</label>
        <input type="number" min={10} max={100} value={s.contextWarnPct} onChange={num('contextWarnPct')} />
        <label className="mpick-row">
          <input type="checkbox" checked={s.autoOpenNeedsInput} onChange={(e) => setS({ ...s, autoOpenNeedsInput: e.target.checked })} />
          <span>Open a session's tab when it blocks on a prompt</span>
        </label>
        <label className="mpick-row">
          <input type="checkbox" checked={s.dockBadge} onChange={(e) => setS({ ...s, dockBadge: e.target.checked })} />
          <span>Show the Needs-you count on the dock icon</span>
        </label>
        <div className="foot">
          <span className="grow meta">{saved ? 'Saved' : ''}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

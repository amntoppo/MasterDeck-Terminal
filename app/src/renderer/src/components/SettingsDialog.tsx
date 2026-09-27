import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import type { AppState } from '@shared/types'
import { deck } from '../deck'

export function SettingsDialog({ settings, state, onClose, onSetup }: { settings: Settings; state: AppState; onClose: () => void; onSetup: () => void }) {
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
        <label>After the Mac restarts, background sessions it stopped</label>
        <select className="fsel full" value={s.afterRestart} onChange={(e) => setS({ ...s, afterRestart: e.target.value as typeof s.afterRestart })}>
          <option value="ask">Offer to resume them</option>
          <option value="resume">Resume them when MasterDeck starts</option>
          <option value="off">Do nothing</option>
        </select>
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

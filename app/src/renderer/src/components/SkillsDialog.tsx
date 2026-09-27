import { useEffect, useState } from 'react'
import { SKILL_INFO } from '@shared/skillInfo'
import type { AppState, HookStatus, SkillStatus } from '@shared/types'
import { deck } from '../deck'

const STATE_TEXT: Record<SkillStatus['state'], string> = {
  installed: 'installed',
  outdated: 'update pending',
  modified: 'changed by you',
  custom: 'your own copy',
  linked: 'linked (left alone)',
  missing: 'not added',
}

/**
 * The skills MasterDeck ships: add or remove each one (in ~/.claude/skills), and switch on the
 * hooks that run some of them automatically. Opens once after onboarding, then from the sidebar.
 */
export function SkillsDialog({ state, onClose, firstRun }: { state: AppState; onClose: () => void; firstRun: boolean }) {
  // First run: the recommended hooks start ticked; later, what is installed.
  const [hooks, setHooks] = useState<HookStatus>(() =>
    firstRun
      ? { ticket: true, pr: true, queue: true, proof: state.hooks.proof }
      : state.hooks,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const act = async (name: string, what: 'add' | 'remove') => {
    setBusy(name)
    const r = what === 'add' ? await deck().skillReinstall(name) : await deck().skillRemove(name)
    setBusy(null)
    setMsg(r.message)
    const key = SKILL_INFO[name]?.hook?.key
    if (what === 'remove' && key) setHooks((h) => ({ ...h, [key]: false }))
  }

  const changed = (Object.keys(hooks) as (keyof HookStatus)[]).some((k) => hooks[k] !== state.hooks[k])
  const save = async () => {
    if (changed) {
      setBusy('hooks')
      const r = await deck().hooksInstall(hooks)
      setBusy(null)
      if (!r.ok) return setMsg(`Hooks: ${r.message}`)
    }
    onClose()
  }

  const installed = (s: SkillStatus) => s.state !== 'missing'

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog skills" role="dialog" aria-label="Skills">
        <h3>Skills</h3>
        <div className="meta">
          {firstRun ? 'MasterDeck comes with these Claude Code skills. ' : ''}Added skills live in <code>~/.claude/skills</code>, so
          every Claude Code session can use them; some can also run by themselves through a hook in{' '}
          <code>~/.claude/settings.json</code> (a backup is kept).
        </div>
        <div className="skill-cards">
          {state.skills.map((s) => {
            const info = SKILL_INFO[s.name]
            const on = installed(s)
            return (
              <div key={s.name} className={`skill-card ${on ? '' : 'off'}`}>
                <div className="skill-head">
                  <code>{s.name}</code>
                  <span className={s.state === 'installed' ? 'ok' : s.state === 'missing' ? 'muted' : 'wait'}>{STATE_TEXT[s.state]}</span>
                  <span style={{ flex: 1 }} />
                  {on ? (
                    <>
                      {s.state !== 'installed' && s.state !== 'linked' && (
                        <button
                          className="link-btn"
                          disabled={busy !== null}
                          title="Replace it with the version bundled with MasterDeck; the current folder is kept in ~/.claude/skills/.masterdeck-backup"
                          onClick={() => void act(s.name, 'add')}
                        >
                          Replace with bundled
                        </button>
                      )}
                      <button className="btn" disabled={busy !== null} title="Take it out of ~/.claude/skills (kept in .masterdeck-backup); MasterDeck won't add it back" onClick={() => void act(s.name, 'remove')}>
                        {busy === s.name ? 'Removing…' : 'Remove'}
                      </button>
                    </>
                  ) : (
                    <button className="btn primary" disabled={busy !== null} onClick={() => void act(s.name, 'add')}>
                      {busy === s.name ? 'Adding…' : 'Add'}
                    </button>
                  )}
                </div>
                {info && <div className="skill-what">{info.what}</div>}
                {info?.hook && (
                  <label className={`mpick-row ${on ? '' : 'disabled'}`} title={on ? '' : 'Add the skill first'}>
                    <input
                      type="checkbox"
                      disabled={!on}
                      checked={on && hooks[info.hook.key]}
                      onChange={(e) => setHooks({ ...hooks, [info.hook!.key]: e.target.checked })}
                    />
                    <span>
                      Automatic: {info.hook.label}
                      {info.hook.recommended ? '' : ' (uses extra time and tokens)'}
                    </span>
                  </label>
                )}
              </div>
            )
          })}
        </div>
        <div className="foot">
          <span className="grow meta">{msg}</span>
          <button className="btn" onClick={onClose}>
            {firstRun ? 'Later' : 'Cancel'}
          </button>
          <button className="btn primary" disabled={busy !== null} onClick={save}>
            {busy === 'hooks' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

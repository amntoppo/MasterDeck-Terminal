import { useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/settings'
import { SHORTCUTS, showKeys } from '@shared/shortcuts'
import type { AppState, HookStatus } from '@shared/types'
import { formatAgo } from '@shared/format'
import { deck, useNow } from '../deck'

export type SettingsSection = Section
type Section = 'general' | 'alerts' | 'sessions' | 'hooks' | 'remote' | 'keys' | 'about'

const SECTIONS: [Section, string][] = [
  ['general', 'General'],
  ['alerts', 'Needs you & alerts'],
  ['sessions', 'Sessions'],
  ['hooks', 'Hooks & skills'],
  ['remote', 'Remote (phone)'],
  ['keys', 'Keyboard shortcuts'],
  ['about', 'About'],
]

/** Settings as a page (Command Center): sections on the left; changes save as you make them. */
export function SettingsView({ settings, state, onSetup, onSkills, initial }: { settings: Settings; state: AppState; onSetup: () => void; onSkills: () => void; initial?: { section: Section; at: number } | null }) {
  const [section, setSection] = useState<Section>(initial?.section ?? 'general')
  useEffect(() => {
    if (initial) setSection(initial.section)
  }, [initial])
  const [s, setS] = useState<Settings>(settings)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => setS(settings), [settings])
  const flash = (t: string) => {
    setNote(t)
    setTimeout(() => setNote((cur) => (cur === t ? null : cur)), 1800)
  }
  const put = async (next: Settings) => {
    setS(next)
    setS(await deck().setSettings(next))
    flash('Saved')
  }
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => void put({ ...s, [k]: v })
  const num = (k: keyof Settings, min: number, max?: number) => (
    <input
      className="input narrow"
      type="number"
      min={min}
      max={max}
      value={s[k] as number}
      onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })}
      onBlur={(e) => set(k, Math.max(min, Math.min(max ?? Infinity, Number(e.target.value) || min)) as never)}
    />
  )
  const toggle = (k: keyof Settings, label: string) => (
    <button className={`switch ${s[k] ? 'on' : ''}`} role="switch" aria-checked={!!s[k]} aria-label={label} onClick={() => set(k, !s[k] as never)} />
  )

  const [url, setUrl] = useState(settings.remoteUrl)
  useEffect(() => setUrl(settings.remoteUrl), [settings.remoteUrl])
  const [token, setToken] = useState('')
  const now = useNow(5_000)
  const r = state.remote
  const dot = !r || r.conn === 'off' ? 'off' : r.conn === 'connected' ? 'ok' : r.conn === 'error' ? 'bad' : 'wait'

  const c = state.config
  const hooks = state.hooks
  const setHook = async (key: keyof HookStatus, on: boolean) => {
    const r = await deck().hooksInstall({ ...hooks, [key]: on })
    flash(r.ok ? (on ? 'Hook installed' : 'Hook removed') : r.message)
  }

  const body: Record<Section, ReactNode> = {
    general: (
      <>
        <Field label="GitHub and boards" hint="Your account, repositories and boards (Setup).">
          <div className="f-row">
            {c.configured ? (
              <span>
                <code>
                  {c.owner}/{c.issueRepo}
                </code>
                {c.allRepos ? ' · all repositories' : c.repos.length > 1 ? ` + ${c.repos.length - 1} more` : ''}
                {c.allProjects ? ' · all boards' : c.projects.length > 1 ? ` · ${c.projects.length} boards` : c.projects.length === 1 ? ` · ${c.projects[0].title}` : ' · no board'}
              </span>
            ) : (
              <span className="bad">Not set up</span>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={onSetup}>
              {c.configured ? 'Open setup…' : 'Set up…'}
            </button>
          </div>
        </Field>
        <Field label="Workspace" hint="+ Shell opens here, on its default branch (changes on another branch are stashed first).">
          <code>{c.workspace || 'not set'}</code>
        </Field>
        <Field label="After the Mac restarts" hint="Background sessions the restart stopped.">
          <select className="input" value={s.afterRestart} onChange={(e) => set('afterRestart', e.target.value as Settings['afterRestart'])}>
            <option value="ask">Offer to resume them</option>
            <option value="resume">Resume them when MasterDeck starts</option>
            <option value="off">Do nothing</option>
          </select>
        </Field>
      </>
    ),
    alerts: (
      <>
        <Field label="Notifications" hint="A notification for each new Needs-you item: a question, a permission, a session waiting, a proposal, failing CI.">
          {toggle('notifyNeedsYou', 'Notifications')}
        </Field>
        <Field label="Dock badge" hint="The Needs-you count on the dock icon.">
          {toggle('dockBadge', 'Dock badge')}
        </Field>
        <Field label="Open a session when it blocks" hint="Switch to a session's terminal when it waits on a prompt.">
          {toggle('autoOpenNeedsInput', 'Open a session when it blocks')}
        </Field>
        <Field label="Nudge a quiet session after" hint="A session working a ticket but quiet this long shows in Needs you.">
          {num('idleNudgeMinutes', 1)} <span className="muted">minutes</span>
        </Field>
        <Field label="Ready for Review after" hint="A PR with no new comments for this long counts as ready for review.">
          {num('reviewQuietMinutes', 1)} <span className="muted">minutes</span>
        </Field>
      </>
    ),
    sessions: (
      <>
        <Field label="Budget per ticket" hint="USD; 0 turns it off. Over budget shows in Needs you.">
          {num('budgetPerTicketUsd', 0)} <span className="muted">USD</span>
        </Field>
        <Field
          label="Monitors run by"
          hint="Claude Code stops each monitor after 30 minutes, so sessions re-arm them. MasterDeck runs them with no limit and sends each event to the session once its turn is over, but only while MasterDeck is open (closed: the session's monitor goes to Claude Code). Sessions started before a change keep the old way until restarted."
        >
          <select className="input" value={s.monitorsBy} onChange={(e) => set('monitorsBy', e.target.value as Settings['monitorsBy'])}>
            <option value="claude">Claude Code (30 minutes, re-armed)</option>
            <option value="masterdeck">MasterDeck (no time limit)</option>
          </select>
        </Field>
        <Field label="Context warning at" hint="From this much context used, Details offers Compact now.">
          {num('contextWarnPct', 10, 100)} <span className="muted">%</span>
        </Field>
      </>
    ),
    hooks: (
      <>
        <Field label="Status line" hint="Exact cost and context for every session (a status line command in Claude Code's settings).">
          <div className="f-row">
            <span className={state.statuslineInstalled ? 'ok' : 'muted'}>{state.statuslineInstalled ? 'Installed' : 'Not installed'}</span>
            <span style={{ flex: 1 }} />
            <button
              className="btn"
              onClick={async () => {
                const r = state.statuslineInstalled ? await deck().statuslineUninstall() : await deck().statuslineInstall()
                flash(r.ok ? 'Done' : r.message)
              }}
            >
              {state.statuslineInstalled ? 'Remove' : 'Install'}
            </button>
          </div>
        </Field>
        <Field label="babysit-ticket" hint="Moves board cards as a session works (after each Bash call, at session start).">
          <button className={`switch ${hooks.ticket ? 'on' : ''}`} role="switch" aria-checked={hooks.ticket} aria-label="babysit-ticket hook" onClick={() => void setHook('ticket', !hooks.ticket)} />
        </Field>
        <Field label="babysit-pr" hint="Self-review before gh pr create, then a reminder to babysit the PR.">
          <button className={`switch ${hooks.pr ? 'on' : ''}`} role="switch" aria-checked={hooks.pr} aria-label="babysit-pr hooks" onClick={() => void setHook('pr', !hooks.pr)} />
        </Field>
        <Field label="Queue" hint="/queue stores a prompt; the next one runs when a response ends.">
          <button className={`switch ${hooks.queue ? 'on' : ''}`} role="switch" aria-checked={hooks.queue} aria-label="queue hooks" onClick={() => void setHook('queue', !hooks.queue)} />
        </Field>
        <Field label="MasterDeck hook" hint="Permissions from Needs you, exact status, API errors, compactions and ticket context. Installed at launch (macOS and Linux).">
          <span className="ok">Managed by MasterDeck</span>
        </Field>
        <Field label="Skills" hint="The bundled skills, and which run automatically.">
          <button className="btn" onClick={onSkills}>
            Manage skills…
          </button>
        </Field>
      </>
    ),
    remote: (
      <>
        <p className="set-hint" style={{ padding: '12px 0 0' }}>
          Sends Tasks and Needs you to your MasterDeck backend, and runs what you do from the phone: answers, starting a session from a board issue, stopping,
          resuming and messaging sessions. Anyone with the client token can drive your sessions, so keep it secret.
        </p>
        <Field label="Connect to the backend" hint="Off by default. Needs the backend address and the desktop token.">
          {toggle('remoteEnabled', 'Connect to the backend')}
        </Field>
        <Field label="Backend address" hint="https://…, or http://localhost:8787 for a local wrangler dev.">
          <input
            className="input"
            style={{ width: '100%' }}
            value={url}
            placeholder="https://masterdeck-backend.<account>.workers.dev"
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => url !== s.remoteUrl && set('remoteUrl', url)}
          />
          {url.trim() && !/^https:\/\/[^\s/]|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/*$/.test(url.trim()) && (
            <div className="set-hint">Use https://… or http://localhost:&lt;port&gt;</div>
          )}
        </Field>
        <Field label="Desktop token" hint={r?.hasToken ? 'Saved in the Keychain. Paste a new one to replace it.' : 'The backend\'s DESKTOP_TOKEN. Stored in the Keychain, never in settings.json.'}>
          <form
            className="f-row"
            style={{ width: '100%' }}
            onSubmit={async (e) => {
              e.preventDefault()
              const res = await deck().remoteSetToken(token)
              flash(res.message)
              if (res.ok) setToken('')
            }}
          >
            <input className="input" style={{ flex: 1 }} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={r?.hasToken ? 'paste a new token' : 'paste the token'} />
            <button className="btn" type="submit" disabled={!token}>
              Save
            </button>
            {r?.hasToken && (
              <button className="btn" type="button" onClick={async () => flash((await deck().remoteSetToken(null)).message)}>
                Remove
              </button>
            )}
          </form>
        </Field>
        <Field label="Status">
          <span className={`remote-dot ${dot}`} aria-hidden="true" />
          <span>
            {r?.conn === 'connected'
              ? `Connected${r.lastSyncAt ? ` · last sync ${formatAgo(now - r.lastSyncAt)} ago` : ''}`
              : (r?.message ?? (s.remoteEnabled ? 'Connecting…' : 'Off'))}
          </span>
        </Field>
      </>
    ),
    keys: (
      <div className="keys">
        {(['Move around', 'Tabs', 'Sessions', 'App'] as const).map((g) => (
          <div key={g} className="keys-group">
            <div className="eyebrow">{g}</div>
            {SHORTCUTS.filter((k) => k.group === g).map((k) => (
              <div key={k.id} className="keys-row">
                <kbd>{showKeys(k.keys, deck().platform)}</kbd>
                <span>{k.what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    ),
    about: (
      <>
        <Field label="MasterDeck" hint="One window for many Claude Code sessions.">
          <span className="muted">Open source · github.com/amntoppo/MasterDeck-Terminal</span>
        </Field>
        <Field label="Setup" hint="Run the first-run setup again: tools, GitHub, repositories and boards.">
          <button className="btn" onClick={onSetup}>
            Open setup…
          </button>
        </Field>
      </>
    ),
  }

  return (
    <section className="board-view settings-view">
      <nav className="set-nav" aria-label="Settings sections">
        <div className="eyebrow" style={{ padding: '0 12px 8px' }}>
          Settings
        </div>
        {SECTIONS.map(([k, label]) => (
          <button key={k} className={section === k ? 'on' : ''} aria-current={section === k ? 'page' : undefined} onClick={() => setSection(k)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="set-main">
        <header className="board-head">
          <h2>{SECTIONS.find(([k]) => k === section)![1]}</h2>
          <span style={{ flex: 1 }} />
          <span className="muted">{note ?? 'Changes save as you make them'}</span>
        </header>
        <div className="set-body">{body[section]}</div>
      </div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-field">
      <div>
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  )
}

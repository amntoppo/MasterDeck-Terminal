import { useState } from 'react'
import type { Settings } from '@shared/settings'
import { formatAgo } from '@shared/format'
import { readyLine, shouldPrompt, statusLine, type UpdateState } from '@shared/updates'
import { deck, useNow } from '../deck'
import { retryAction, updateBusy } from '../updates'
import { Field } from './AccountPanel'
import { MarkdownView } from './MarkdownView'

/** Settings → Updates (the Mac's window only). */
export function UpdatesPanel({ u, settings, set }: { u: UpdateState; settings: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void }) {
  const now = useNow(15_000)
  const [msg, setMsg] = useState<string | null>(null)
  const busy = updateBusy(u.phase)
  const restart = async () => {
    setMsg(null)
    const r = await deck().updateRestart()
    if (!r.ok) setMsg(r.message ?? 'Could not restart')
  }
  const retry = () => {
    const a = retryAction(u.errorKind)
    if (a === 'restart') void restart()
    else void (a === 'download' ? deck().updateDownload() : deck().updateCheck())
  }
  const pct = Math.round((u.progress ?? 0) * 100)
  const pending = u.offer && (u.phase === 'available' || u.phase === 'downloading' || u.phase === 'verifying' || u.phase === 'ready')

  return (
    <>
      <Field label="Version" hint={u.updatedFrom ? `Updated from v${u.updatedFrom.from}.` : undefined}>
        <code>v{u.current}</code>
      </Field>
      {u.rolledBack && (
        <p className="set-hint error" role="status">
          Rolled back from v{u.rolledBack.version}: it did not start. MasterDeck skips that version until a newer one comes out.
        </p>
      )}
      <Field label="Status" hint={u.lastChecked ? `Last checked ${formatAgo(now - u.lastChecked)} ago.` : 'Not checked yet.'}>
        <div className="update-status">
          <div className="f-row">
            <span className={u.phase === 'error' ? 'bad' : u.phase === 'up-to-date' ? 'ok' : u.enabled ? '' : 'muted'} aria-live="polite">
              {statusLine(u)}
            </span>
            <span style={{ flex: 1 }} />
            {u.enabled && u.phase === 'available' && !settings.autoDownloadUpdates && (
              <button className="btn primary" onClick={() => void deck().updateDownload()}>
                Download
              </button>
            )}
            {u.enabled && u.phase === 'ready' && (
              <button className="btn primary" onClick={() => void restart()}>
                Restart now
              </button>
            )}
            <button className="btn" disabled={!u.enabled || busy} onClick={() => void deck().updateCheck()}>
              Check for updates
            </button>
          </div>
          {u.phase === 'downloading' && (
            <div className="update-bar" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <i style={{ width: `${pct}%` }} />
            </div>
          )}
          {u.phase === 'error' && (
            <div className="f-row set-hint error" role="alert">
              <span className="grow">{u.error ?? statusLine(u)}</span>
              <button className="btn" onClick={retry}>
                Try again
              </button>
            </div>
          )}
          {msg && (
            <div className="set-hint error" role="alert">
              {msg}
            </div>
          )}
          {u.needsAdmin && pending && <div className="set-hint">macOS will ask for your password to replace MasterDeck in its folder.</div>}
        </div>
      </Field>
      {u.offer && pending && (
        <Field label={`What's new in v${u.offer.version}`}>
          {u.offer.notes.trim() ? <MarkdownView text={u.offer.notes} html={false} className="update-notes" /> : <span className="muted">No release notes.</span>}
        </Field>
      )}
      <Field label="Automatically download updates" hint="Download a new version as soon as it is found. Off: press Download.">
        <button
          className={`switch ${settings.autoDownloadUpdates ? 'on' : ''}`}
          role="switch"
          aria-checked={settings.autoDownloadUpdates}
          aria-label="Automatically download updates"
          disabled={!u.enabled}
          onClick={() => set('autoDownloadUpdates', !settings.autoDownloadUpdates)}
        />
      </Field>
      <Field label="Beta channel" hint="Get beta versions before they are released. They may have more bugs.">
        <button
          className={`switch ${settings.updateChannel === 'beta' ? 'on' : ''}`}
          role="switch"
          aria-checked={settings.updateChannel === 'beta'}
          aria-label="Beta channel"
          disabled={!u.enabled}
          onClick={() => set('updateChannel', settings.updateChannel === 'beta' ? 'stable' : 'beta')}
        />
      </Field>
    </>
  )
}

/** "MasterDeck 0.10.0 is ready. Restart now to update.": a card, never a native popup; Remind me later hides it four hours. */
export function UpdatePrompt({ u }: { u: UpdateState | null }) {
  const now = useNow(30_000)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  if (!u || !shouldPrompt(u, now)) return null
  return (
    <div className="update-prompt" role="dialog" aria-labelledby="update-prompt-text">
      <div id="update-prompt-text">{readyLine(u)}</div>
      {u.needsAdmin && <div className="muted">macOS will ask for your password.</div>}
      {msg && (
        <div className="bad" role="alert">
          {msg}
        </div>
      )}
      <div className="f-row">
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={busy} onClick={() => (setMsg(null), void deck().updateLater())}>
          Remind me later
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setMsg(null)
            try {
              const r = await deck().updateRestart()
              if (!r.ok) setMsg(r.message ?? 'Could not restart')
            } finally {
              setBusy(false)
            }
          }}
        >
          Restart now
        </button>
      </div>
    </div>
  )
}

/** A required update: this version is no longer supported. No dismiss; it leads to Settings → Updates. */
export function UpdateBanner({ u, onOpen }: { u: UpdateState | null; onOpen: () => void }) {
  if (!u || !u.enabled || !u.mandatory) return null
  return (
    <div className="banner restore" role="alert">
      <span className="grow">
        <b>Required update</b>
        {' · '}This version is no longer supported{u.offer ? `: update to v${u.offer.version}` : ''}.
      </span>
      <button className="btn primary" onClick={onOpen}>
        Open Updates
      </button>
    </div>
  )
}

import { useState } from 'react'
import { MODS_MIN_CLAUDE, versionAtLeast } from '@shared/mods'
import type { AppState } from '@shared/types'
import { deck } from '../deck'
import { webConfirm } from '../webConfirm'

/** What the mods are, in one line (Setup's Mods step, Settings → Hooks, mods & skills). */
export const MODS_ABOUT =
  "MasterDeck's mods show inside each Claude Code session what MasterDeck knows: the ticket line above the prompt, alerts, /md-note, /md-loop and /md-board. Each one switches per session in Session details → Mods."

/**
 * Install or remove MasterDeck's mods in Claude Code (the marketplace, every mod, and the core first
 * in prependPlugins), say why it cannot be done here, and reload idle sessions that run older ones.
 */
export function ModsPanel({ state }: { state: AppState }) {
  const m = state.mods
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const offer = state.inbox.open.find((e) => e.item.detail.type === 'mods')?.item.detail
  const idle = offer?.type === 'mods' ? offer.idle.length : 0
  const tooOld = !!m?.claude && !versionAtLeast(m.claude, MODS_MIN_CLAUDE)
  const run = async (what: string, f: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(what)
    setMsg(null)
    const r = await f()
    setBusy(null)
    setMsg({ ok: r.ok, text: r.message })
  }
  const on = m?.state === 'installed' || m?.state === 'partial'
  return (
    <div className="mods-panel">
      <div className="f-row">
        <span className={m?.state === 'installed' ? 'ok' : m?.state === 'partial' ? 'wait' : 'muted'}>
          {!m
            ? 'Checking…'
            : m.state === 'installed'
              ? `Installed${m.version ? ` (${m.version})` : ''}`
              : m.state === 'partial'
                ? `Partly installed: ${m.missing.join(', ')} missing`
                : 'Not installed'}
        </span>
        <span style={{ flex: 1 }} />
        {m && !m.unavailable && (
          <>
            {m.state !== 'installed' && (
              <button
                className="btn primary"
                disabled={!!busy || tooOld}
                onClick={async () => {
                  if (!(await webConfirm("Install MasterDeck's mods in Claude Code on your Mac?", { confirmLabel: 'Install' }))) return
                  await run('install', () => deck().modsInstall())
                }}
              >
                {busy === 'install' ? 'Installing…' : m.state === 'partial' ? 'Repair' : 'Install mods'}
              </button>
            )}
            {on && (
              <button
                className="btn"
                disabled={!!busy}
                onClick={async () => {
                  if (!(await webConfirm("Remove MasterDeck's mods from Claude Code on your Mac?", { confirmLabel: 'Remove', danger: true }))) return
                  await run('remove', () => deck().modsUninstall())
                }}
              >
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </>
        )}
      </div>
      {m?.unavailable && <div className="muted">{m.unavailable}</div>}
      {m && !m.unavailable && (
        <div className={tooOld ? 'bad' : 'muted'}>
          {!m.claude
            ? `Needs Claude Code ${MODS_MIN_CLAUDE} or later.`
            : tooOld
              ? `Needs Claude Code ${MODS_MIN_CLAUDE} or later; this Mac has ${m.claude}. Update it (claude update), then install.`
              : `Claude Code ${m.claude}. Claude Code's settings.json is backed up before every change.`}
        </div>
      )}
      {m?.prependNote && <div className="wait">{m.prependNote}</div>}
      {idle > 0 && (
        <div className="f-row">
          <span className="muted">
            {idle} idle session{idle === 1 ? ' runs' : 's run'} older mods.
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={!!busy} onClick={() => void run('reload', () => deck().modsReload())}>
            {busy === 'reload' ? 'Reloading…' : 'Reload idle sessions'}
          </button>
        </div>
      )}
      {msg && <div className={msg.ok ? 'ok' : 'bad'}>{msg.text}</div>}
    </div>
  )
}

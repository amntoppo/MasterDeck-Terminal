import { useEffect, useRef, useState } from 'react'
import type { AppState } from '@shared/types'
import { deck } from '../deck'
import { StartHereDialog } from './StartHereDialog'
import { TerminalView } from './TerminalView'

export function masterPaneId(bgId: string): string {
  return `master:${bgId}`
}

/** `shown` false hides the pane without detaching master's terminal. */
export function MasterPane({ state, shown = true }: { state: AppState; shown?: boolean }) {
  const m = state.master
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  const [gen, setGen] = useState(0)
  const [askHere, setAskHere] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const bgId = m.kind === 'attached' ? m.session.bgId! : null
  useEffect(() => {
    setExited(false)
    // When master changes (restart, or it goes away), end the attach to the old one.
    return () => {
      if (bgId) deck().ptyClose(masterPaneId(bgId))
    }
  }, [bgId])

  const start = async () => {
    setBusy(true)
    setMsg(null)
    const r = await deck().masterStart()
    setBusy(false)
    setMsg(r.ok ? 'Starting master-agent… it appears here in a few seconds.' : r.message)
  }

  const status = m.kind === 'attached' ? m.session.state : m.kind === 'elsewhere' ? 'external' : m.kind

  return (
    <section className="master" style={shown ? undefined : { display: 'none' }}>
      <div className="mhead">
        <span className="star">★</span>
        <strong>master-agent</strong>
        <span className="chip muted">
          {m.kind === 'attached' && <span className={`dot ${m.session.state}`} />}
          {status}
        </span>
        <span style={{ flex: 1 }} />
        <div className="menu-wrap" ref={menuRef}>
          <button className="icon-btn" onClick={() => setMenu(!menu)} title="More">
            ⋯
          </button>
          {menu && (
            <div className="menu">
              <button
                onClick={async () => {
                  setMenu(false)
                  const r = await deck().refresh()
                  setMsg(r.ok ? 'Issues refreshed' : r.message)
                }}
              >
                Refresh issues and PRs
              </button>
              {bgId && (
                <button
                  onClick={() => {
                    setMenu(false)
                    deck().ptyWrite(masterPaneId(bgId), '/master sweep')
                    setTimeout(() => deck().ptyWrite(masterPaneId(bgId), '\r'), 120)
                  }}
                >
                  Run /master sweep
                </button>
              )}
              <hr />
              {state.statuslineInstalled ? (
                <button
                  onClick={async () => {
                    setMenu(false)
                    const r = await deck().statuslineUninstall()
                    setMsg(r.message)
                  }}
                >
                  Remove status line hook (exact cost)
                </button>
              ) : (
                <button
                  onClick={async () => {
                    setMenu(false)
                    const r = await deck().statuslineInstall()
                    setMsg(r.message)
                  }}
                >
                  Install status line hook (exact cost)
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {msg && (
        <div className="banner" style={{ color: 'var(--muted)', background: 'var(--bg-2)' }} onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}
      {m.kind === 'attached' && bgId && (
        <>
          <TerminalView
            key={bgId}
            paneId={masterPaneId(bgId)}
            spec={{ kind: 'attach', bgId }}
            visible={shown}
            generation={gen}
            onExit={() => setExited(true)}
          />
          {exited && (
            <div className="notice" style={{ flex: 'none', paddingTop: 8 }}>
              <span>Detached from master.</span>
              <button
                className="btn primary"
                onClick={() => {
                  deck().ptyClose(masterPaneId(bgId))
                  setExited(false)
                  setGen(gen + 1)
                }}
              >
                Reattach
              </button>
            </div>
          )}
        </>
      )}
      {m.kind === 'elsewhere' && (
        <div className="notice">
          <h3>master-agent is running in another terminal</h3>
          <div>
            pid {m.session.pid} · {m.session.cwd}
          </div>
          <div>
            An interactive session can't be attached here. To run master inside MasterDeck, exit it there, then start it
            here. It starts as a background session you can attach from anywhere.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => deck().copy(`claude --resume ${m.session.sessionId}`)}>
              Copy resume command
            </button>
            <button className="btn primary" disabled={busy} onClick={() => setAskHere(true)}>
              {busy ? 'Starting…' : 'Start master here'}
            </button>
          </div>
          {askHere && (
            <StartHereDialog
              session={m.session}
              isMaster
              onClose={() => setAskHere(false)}
              onStart={async () => {
                setBusy(true)
                setMsg(null)
                const s = m.session
                const r = await deck().startHere({ sessionId: s.sessionId, name: s.name, cwd: s.cwd, pid: s.pid, stopOther: true })
                setBusy(false)
                setMsg(r.ok ? 'master-agent is starting here; it attaches in a few seconds.' : r.message)
              }}
            />
          )}
        </div>
      )}
      {m.kind === 'duplicate' && (
        <div className="notice">
          <h3>{m.count} sessions are named master-agent</h3>
          <div>The master CLI refuses every write until only one is left. Stop or rename the extra ones.</div>
        </div>
      )}
      {m.kind === 'absent' && (
        <div className="notice">
          <h3>master-agent is not running</h3>
          <div>
            Starts <code>claude --bg -n master-agent "/master"</code> in <code>{state.masterWorkspace}</code>.
          </div>
          <button className="btn primary" onClick={start} disabled={busy}>
            {busy ? 'Starting…' : 'Start master'}
          </button>
        </div>
      )}
    </section>
  )
}

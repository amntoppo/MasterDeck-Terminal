import { useCallback, useEffect, useState } from 'react'
import { formatAgo } from '@shared/format'
import type { HistoryHit } from '@shared/history'
import type { JanitorRow } from '@shared/ipc'
import { needsTypedConfirm } from '@shared/janitor'
import type { AppState, Session } from '@shared/types'
import { deck, useNow } from '../deck'

const CLS_ORDER = ['SAFE', 'PUSHED', 'DIRTY', 'UNPUSHED', 'IN USE']

/** The dirs live sessions work in: a worktree containing any of them is IN USE. */
function liveDirs(state: AppState): string[] {
  const dirs: string[] = []
  for (const s of state.sessions) {
    if (s.state === 'done') continue
    if (s.cwd) dirs.push(s.cwd)
    const cur = state.stats[s.sessionId]?.currentDir ?? state.tails[s.sessionId]?.cwd
    if (cur) dirs.push(cur)
  }
  for (const g of Object.values(state.git)) dirs.push(g.dir)
  return dirs
}

export function JanitorView({ state }: { state: AppState }) {
  const now = useNow(60_000)
  const [rows, setRows] = useState<JanitorRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ row: JanitorRow; typed: string } | null>(null)

  const load = useCallback(async () => {
    setRows(null)
    setRows(await deck().janitor(liveDirs(state)))
    // Only when opened or after a removal; not on every state tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => void load(), [load])

  const remove = async (row: JanitorRow, force: boolean) => {
    setBusy(row.path)
    const r = await deck().removeWorktree(row.repo, row.path, force)
    setBusy(null)
    setMsg(r.message)
    if (r.ok) setRows((cur) => cur?.filter((x) => x.path !== row.path) ?? null)
  }
  const parked = state.sessions.filter((s) => s.state === 'suspended' && s.bgId)
  const counts = CLS_ORDER.map((c) => [c, rows?.filter((r) => r.cls === c).length ?? 0] as const)
  const safeRows = rows?.filter((r) => r.cls === 'SAFE') ?? []

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Janitor</h2>
        <span className="muted">worktrees under each repo's .claude/worktrees, and parked sessions · branches are never deleted</span>
        <span style={{ flex: 1 }} />
        {msg && <span className="muted">{msg}</span>}
        <button className="btn" onClick={() => void load()} disabled={rows === null}>
          Rescan
        </button>
        <button
          className="btn primary"
          disabled={!safeRows.length || !!busy}
          onClick={async () => {
            for (const r of safeRows) await remove(r, false)
          }}
        >
          Remove all SAFE ({safeRows.length})
        </button>
      </header>
      <div className="panel-body">
        <div className="kpis">
          {counts.map(([c, n]) => (
            <div key={c} className={`kpi cls-${c.replace(' ', '-').toLowerCase()}`}>
              <div className="kpi-v">{rows ? n : '…'}</div>
              <div className="kpi-l">{c}</div>
            </div>
          ))}
        </div>
        <h3 className="sec">Worktrees</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Class</th>
              <th>Repo / worktree</th>
              <th>Branch</th>
              <th>Why</th>
              <th className="r">Last commit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={6} className="muted">
                  Scanning repos…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No worktrees. Nothing to clean.
                </td>
              </tr>
            )}
            {rows
              ?.slice()
              .sort((a, b) => CLS_ORDER.indexOf(a.cls) - CLS_ORDER.indexOf(b.cls) || a.path.localeCompare(b.path))
              .map((r) => (
                <tr key={r.path}>
                  <td>
                    <span className={`cls cls-${r.cls.replace(' ', '-').toLowerCase()}`}>{r.cls}</span>
                  </td>
                  <td className="mono" title={r.path}>
                    {r.repo.split('/').pop()}/<b>{r.path.split('/').pop()}</b>
                  </td>
                  <td className="mono">{r.branch ?? '(detached)'}</td>
                  <td className="muted">{r.reason}</td>
                  <td className="r muted">{r.lastCommitAt ? `${formatAgo(now - r.lastCommitAt)} ago` : '—'}</td>
                  <td className="r nowrap">
                    <button className="icon-btn" title="Copy path" onClick={() => deck().copy(r.path)}>
                      ⧉
                    </button>
                    {r.cls !== 'IN USE' && (
                      <button
                        className={`btn ${needsTypedConfirm(r.cls) ? 'danger' : ''}`}
                        disabled={busy === r.path}
                        onClick={() => (needsTypedConfirm(r.cls) ? setConfirm({ row: r, typed: '' }) : void remove(r, false))}
                      >
                        {busy === r.path ? 'Removing…' : 'Remove'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <h3 className="sec">Parked sessions ({parked.length})</h3>
        <table className="tbl">
          <tbody>
            {parked.length === 0 && (
              <tr>
                <td className="muted">No parked background sessions.</td>
              </tr>
            )}
            {parked.map((s) => (
              <ParkedRow key={s.key} s={s} now={now} lastActivity={state.lastActivity[s.sessionId]} />
            ))}
          </tbody>
        </table>
      </div>
      {confirm && (
        <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && setConfirm(null)}>
          <div className="dialog" style={{ borderTopColor: 'var(--red)' }}>
            <h3>Remove a {confirm.row.cls} worktree?</h3>
            <p>
              <code>{confirm.row.path}</code>: {confirm.row.reason}. {confirm.row.cls === 'DIRTY' ? 'The uncommitted changes are lost.' : 'Commits only here may become hard to find.'} The branch itself is
              kept.
            </p>
            <label>Type the worktree name ({confirm.row.path.split('/').pop()}) to confirm</label>
            <input value={confirm.typed} onChange={(e) => setConfirm({ ...confirm, typed: e.target.value })} autoFocus />
            <div className="foot">
              <span className="grow" />
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={confirm.typed !== confirm.row.path.split('/').pop()}
                onClick={() => {
                  const r = confirm.row
                  setConfirm(null)
                  void remove(r, true)
                }}
              >
                Remove anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function ParkedRow({ s, now, lastActivity }: { s: Session; now: number; lastActivity?: number }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy' | string>('idle')
  return (
    <tr>
      <td>
        <span className="dot suspended" /> {s.name}
      </td>
      <td className="mono muted">{s.bgId}</td>
      <td className="muted">{s.issue !== null ? `#${s.issue}` : ''}</td>
      <td className="r muted">{lastActivity ? `quiet for ${formatAgo(now - lastActivity)}` : ''}</td>
      <td className="r nowrap">
        {state === 'idle' && (
          <button className="btn" onClick={() => setState('confirm')}>
            Remove session
          </button>
        )}
        {state === 'confirm' && (
          <>
            <span className="muted">Its transcript stays on disk. </span>
            <button className="btn" onClick={() => setState('idle')}>
              Cancel
            </button>{' '}
            <button
              className="btn danger"
              onClick={async () => {
                setState('busy')
                const r = await deck().removeSession(s.bgId!)
                setState(r.message)
              }}
            >
              Remove
            </button>
          </>
        )}
        {state !== 'idle' && state !== 'confirm' && state !== 'busy' && <span className="muted">{state}</span>}
      </td>
    </tr>
  )
}

export function HistoryView({ state, onOpenSession }: { state: AppState; onOpenSession: (s: Session) => void }) {
  const now = useNow(60_000)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<HistoryHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [took, setTook] = useState<number | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const search = async () => {
    if (q.trim().length < 2) return
    setBusy(true)
    const t = Date.now()
    setHits(await deck().searchHistory(q))
    setTook(Date.now() - t)
    setBusy(false)
  }
  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>History</h2>
        <input
          className="filter search wide"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
          placeholder="Search every session transcript, e.g. paywall_sheet.dart"
          autoFocus
          spellCheck={false}
        />
        <button className="btn primary" onClick={search} disabled={busy || q.trim().length < 2}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        <span className="muted">{hits && took !== null ? `${hits.length} sessions · ${(took / 1000).toFixed(1)} s` : ''}</span>
      </header>
      <div className="panel-body">
        {!hits && !busy && <div className="empty">Exact text, any case. Finds the sessions that mentioned or touched it, newest first.</div>}
        {busy && <div className="empty">Searching all transcripts…</div>}
        {hits?.length === 0 && <div className="empty">No session mentions “{q}”.</div>}
        {hits?.map((h) => {
          const live = state.sessions.find((s) => s.sessionId === h.sessionId && s.state !== 'done')
          return (
            <div key={h.path} className="hit">
              <div className="hit-top">
                {live && <span className={`dot ${live.state}`} />}
                <strong>{live?.name ?? h.title}</strong>
                <span className="muted mono">{h.sessionId.slice(0, 8)}</span>
                <span className="muted">{h.cwd?.replace(deck().home, '~')}</span>
                <span style={{ flex: 1 }} />
                <span className="muted">
                  {h.matches} match{h.matches === 1 ? '' : 'es'} · {formatAgo(now - h.lastActivity)} ago
                </span>
                {msg[h.sessionId] && <span className="muted">{msg[h.sessionId]}</span>}
                <button className="icon-btn" title="Copy session id" onClick={() => deck().copy(h.sessionId)}>
                  ⧉
                </button>
                {live ? (
                  <button className="btn primary" onClick={() => onOpenSession(live)}>
                    Open
                  </button>
                ) : (
                  <button
                    className="btn"
                    disabled={!!msg[h.sessionId]}
                    onClick={async () => {
                      setMsg((m) => ({ ...m, [h.sessionId]: 'resuming…' }))
                      const r = await deck().resumeSession(h.sessionId, h.title.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60) || 'resumed', h.cwd)
                      setMsg((m) => ({ ...m, [h.sessionId]: r.ok ? `resuming as ${r.message}…` : r.message }))
                    }}
                  >
                    Resume here
                  </button>
                )}
              </div>
              {h.files.length > 0 && (
                <div className="hit-files">
                  {h.files.map((f) => (
                    <code key={f}>{f.replace(deck().home, '~')}</code>
                  ))}
                </div>
              )}
              {h.snippets.map((s, i) => (
                <div key={i} className="hit-snip">
                  …{s}…
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

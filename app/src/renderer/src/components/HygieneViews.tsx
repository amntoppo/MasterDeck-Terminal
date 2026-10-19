import { useCallback, useEffect, useState } from 'react'
import { ticketLabel } from '@shared/ticket'
import { formatAgo } from '@shared/format'
import type { HistoryHit } from '@shared/history'
import type { JanitorRow } from '@shared/ipc'
import { isCleanupTarget, needsTypedConfirm } from '@shared/janitor'
import type { AppState, Session } from '@shared/types'
import { JANITOR_PICKS, janitorTotals, needsTypedCount, pickOlder, sizeLabel, type CleanWhat, type JanitorMeetingRow } from '@shared/meetingJanitor'
import { meetingWhen } from '@shared/meetingMatch'
import { deck, useNow } from '../deck'
import { meetingsHere } from '../meetingLinks'
import { webConfirm } from '../webConfirm'

const CLS_ORDER = ['SAFE', 'PUSHED', 'DIRTY', 'UNPUSHED', 'IN USE']

/** The dirs live sessions work in: a worktree containing any of them is IN USE. */
export function liveDirs(state: Pick<AppState, 'sessions' | 'stats' | 'tails' | 'git'>): string[] {
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

  // Opening reads PR status from the shared gh cache; Refresh asks GitHub again.
  const load = useCallback(async (force = false) => {
    setRows(null)
    setRows(await deck().janitor(liveDirs(state), force))
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
    return r.ok
  }
  const wts = (n: number) => `${n} worktree${n === 1 ? '' : 's'}`
  const cleanUp = async (targets: JanitorRow[]) => {
    if (!(await webConfirm(`Remove ${wts(targets.length)} whose PR is merged? Branches are kept.`, { confirmLabel: 'Remove', danger: true }))) return
    let removed = 0
    for (const r of targets) if (await remove(r, false)) removed++
    const failed = targets.length - removed
    setMsg(`Cleaned up ${removed} worktree${removed === 1 ? '' : 's'}${failed ? `; ${failed} not removed` : ''}`)
  }
  const parked = state.sessions.filter((s) => s.state === 'suspended' && s.bgId)
  const counts = CLS_ORDER.map((c) => [c, rows?.filter((r) => r.cls === c).length ?? 0] as const)
  const safeRows = rows?.filter((r) => r.cls === 'SAFE') ?? []
  const mergedRows = rows?.filter(isCleanupTarget) ?? []

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Janitor</h2>
        <span className="muted">worktrees under each repo's .claude/worktrees, and parked sessions · branches are never deleted</span>
        <span style={{ flex: 1 }} />
        {msg && <span className="muted">{msg}</span>}
        <button className="btn" onClick={() => void load(true)} disabled={rows === null} title="Rescan worktrees and fetch PR status from GitHub">
          Refresh
        </button>
        <button
          className="btn primary"
          disabled={!mergedRows.length || !!busy}
          title="Remove every clean worktree whose PR is merged; branches are kept"
          onClick={() => void cleanUp(mergedRows)}
        >
          Clean up ({mergedRows.length})
        </button>
        <button
          className="btn"
          disabled={!safeRows.length || !!busy}
          onClick={async () => {
            if (!(await webConfirm(`Remove ${wts(safeRows.length)} marked SAFE?`, { confirmLabel: 'Remove', danger: true }))) return
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
              <th>PR</th>
              <th>Why</th>
              <th className="r">Last commit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={7} className="muted">
                  Scanning repos…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
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
                  <td className="nowrap">
                    {r.pr ? (
                      <button className="link-btn" title={r.pr.url} onClick={() => deck().openExternal(r.pr!.url)}>
                        <span className={`pr-state ${r.pr.state.toLowerCase()}`}>#{r.pr.number} {r.pr.state.toLowerCase()}</span>
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
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
                        onClick={() => (needsTypedConfirm(r.cls) ? setConfirm({ row: r, typed: '' }) : void webConfirm(`Remove the worktree ${r.path}?`, { confirmLabel: 'Remove', danger: true }).then((y) => y && remove(r, false)))}
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
        {meetingsHere() && <JanitorMeetings />}
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

/**
 * Janitor → Meetings (spec §7; macOS, the window only): every meeting with its audio and transcript
 * sizes, a pick of the older ones, Delete audio / Delete meetings. Main asks on the Mac before
 * anything goes; more than 10 at once need the count typed here first.
 */
function JanitorMeetings() {
  const now = useNow(60_000)
  const [rows, setRows] = useState<JanitorMeetingRow[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [typed, setTyped] = useState<{ what: CleanWhat; text: string } | null>(null)

  const load = useCallback(async () => {
    const r = await deck().meetingsJanitor()
    if (!r.ok) return setMsg(r.message)
    setRows(r.rows)
    // Only what is still listed and not being recorded stays picked.
    setPicked((cur) => new Set(r.rows.filter((x) => cur.has(x.id) && !x.recording).map((x) => x.id)))
  }, [])
  useEffect(() => {
    void load()
    return deck().onMeetingsChanged(() => void load())
  }, [load])

  const ids = [...picked]
  const all = rows ? janitorTotals(rows) : null
  const sel = rows ? janitorTotals(rows, ids) : null
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const clean = async (what: CleanWhat) => {
    setBusy(true)
    setTyped(null)
    try {
      const r = await deck().meetingsClean({ ids, what })
      if (!r.ok) return setMsg(r.message === 'cancelled' ? null : r.message)
      const noun = what === 'audio' ? 'Deleted the audio of' : 'Deleted'
      setMsg(`${noun} ${r.done} meeting${r.done === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} not (${r.message ?? 'being recorded or gone'})` : ''}`)
      setPicked(new Set())
      await load()
    } finally {
      setBusy(false)
    }
  }
  const ask = (what: CleanWhat) => (needsTypedCount(ids.length) ? setTyped({ what, text: '' }) : void clean(what))

  return (
    <>
      <h3 className="sec">Meetings{all ? ` (${all.meetings})` : ''}</h3>
      <div className="janitor-meetings-bar">
        {all && (
          <span className="muted">
            Audio {sizeLabel(all.audioBytes)} · transcripts {sizeLabel(all.transcriptBytes)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {JANITOR_PICKS.map((d) => (
          <button key={d} className="btn" disabled={!rows?.length} onClick={() => rows && setPicked(new Set(pickOlder(rows, d, now)))}>
            Older than {d} days
          </button>
        ))}
        <button className="btn" disabled={!ids.length || busy} onClick={() => ask('audio')} title="The transcripts and notes stay">
          Delete audio{ids.length ? ` (${ids.length})` : ''}
        </button>
        <button className="btn danger" disabled={!ids.length || busy} onClick={() => ask('meetings')} title="Transcripts and audio go; the notes stay">
          Delete meetings{ids.length ? ` (${ids.length})` : ''}
        </button>
      </div>
      {(msg || (sel && ids.length > 0)) && (
        <p className="muted janitor-meetings-msg">
          {sel && ids.length > 0 ? `${sel.meetings} picked: audio ${sizeLabel(sel.audioBytes)}, transcripts ${sizeLabel(sel.transcriptBytes)}. Notes from meetings always stay. ` : ''}
          {msg}
        </p>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Pick every meeting"
                disabled={!rows?.some((r) => !r.recording)}
                checked={!!rows?.length && rows.filter((r) => !r.recording).every((r) => picked.has(r.id))}
                onChange={(e) => setPicked(new Set(e.target.checked ? (rows ?? []).filter((r) => !r.recording).map((r) => r.id) : []))}
              />
            </th>
            <th>Date</th>
            <th>Meeting</th>
            <th className="r">Audio</th>
            <th className="r">Transcript</th>
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <tr>
              <td colSpan={5} className="muted">
                Reading meetings…
              </td>
            </tr>
          )}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No meetings recorded.
              </td>
            </tr>
          )}
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>
                <input type="checkbox" aria-label={`Pick ${r.title || meetingWhen(r.started)}`} disabled={r.recording} checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
              </td>
              <td className="nowrap muted">{meetingWhen(r.started)}</td>
              <td>
                {r.title || <span className="muted">Unnamed</span>}
                {r.recording && <span className="muted"> · recording</span>}
              </td>
              <td className="r muted">{r.audioBytes ? sizeLabel(r.audioBytes) : '—'}</td>
              <td className="r muted">{sizeLabel(r.transcriptBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {typed && (
        <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && setTyped(null)}>
          <div className="dialog" style={{ borderTopColor: 'var(--red)' }}>
            <h3>{typed.what === 'audio' ? `Delete the audio of ${ids.length} meetings?` : `Delete ${ids.length} meetings?`}</h3>
            <p>
              {typed.what === 'audio'
                ? 'Their recordings go; the transcripts and the notes they added stay.'
                : 'Their transcripts and audio go. The notes they added stay: they are your notes now.'}
            </p>
            <label>Type the number of meetings ({ids.length}) to confirm</label>
            <input value={typed.text} onChange={(e) => setTyped({ ...typed, text: e.target.value })} autoFocus />
            <div className="foot">
              <span className="grow" />
              <button className="btn" onClick={() => setTyped(null)}>
                Cancel
              </button>
              <button className="btn danger" disabled={typed.text.trim() !== String(ids.length)} onClick={() => void clean(typed.what)}>
                {typed.what === 'audio' ? 'Delete audio' : 'Delete meetings'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
      <td className="muted">{s.issue !== null ? ticketLabel(s.issueRepo, s.issue) : ''}</td>
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

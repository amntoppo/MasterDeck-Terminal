import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { formatMem, formatUptime, portLabel, portUrl, type ProcsAnswer, type SessionProc } from '@shared/sessionProcs'
import { deck } from '../deck'
import { can } from '../web'

/** How often the open section reads the list again (one `ps`, two `lsof`). */
const POLL_MS = 2500

/** The session's processes, read again every POLL_MS while the section is on screen and the window visible. */
function useProcs(key: string): ProcsAnswer | null {
  const [answer, setAnswer] = useState<ProcsAnswer | null>(null)
  useEffect(() => {
    setAnswer(null)
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        const r = await deck()
          .procsList(key)
          .catch((e: unknown) => ({ ok: false as const, message: String(e) }))
        if (!live) return
        setAnswer(r)
      }
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [key])
  return answer
}

const KIND: Record<SessionProc['kind'], string> = {
  background: 'Background command',
  foreground: 'Running now (a tool call)',
  detached: 'Left running by a command that ended',
}

/**
 * Details → Session → Processes (#115): what the session started that is still running (its
 * background shells, a tool call running now, what a command left behind), with their folders,
 * pids, uptime, listening ports (a click opens one in the browser) and, opened, the processes
 * below and the last output.
 */
export function SessionProcs({ session: s, now }: { session: Session; now: number }) {
  const answer = useProcs(s.key)
  const [open, setOpen] = useState<number | null>(null)
  const procs = answer?.ok && answer.supported ? answer.procs : []
  const running = procs.filter((p) => p.state === 'running').length
  return (
    <section className="dsec">
      <div className="eyebrow">
        Processes{running > 0 && <span className="d-tab-count"> {running}</span>}
      </div>
      {!answer && <div className="d-text muted">Looking…</div>}
      {answer && !answer.ok && <div className="d-text muted">Could not list them: {answer.message}</div>}
      {answer?.ok && !answer.supported && <div className="d-text muted">Not available on Windows yet.</div>}
      {answer?.ok && answer.supported && procs.length === 0 && (
        <div className="d-text muted">
          {answer.running
            ? 'Nothing running. A command this session starts (a dev server, npm run dev) shows here with its ports.'
            : 'The session is not running.'}
        </div>
      )}
      {procs.map((p) => (
        <ProcRow
          key={`${p.pid}-${p.state}`}
          sessionKey={s.key}
          p={p}
          now={now}
          open={open === p.pid && p.state === 'running'}
          onToggle={() => setOpen((o) => (o === p.pid ? null : p.pid))}
        />
      ))}
    </section>
  )
}

function ProcRow({ sessionKey, p, now, open, onToggle }: { sessionKey: string; p: SessionProc; now: number; open: boolean; onToggle: () => void }) {
  const exited = p.state === 'exited'
  const status = exited
    ? `exited${p.exitCode !== null ? ` ${p.exitCode}` : ''} · ${formatUptime(now - (p.endedAt ?? now))} ago`
    : `up ${formatUptime(now - p.startedAt)}`
  return (
    <div className={`d-proc${exited ? ' ended' : ''}${exited && p.exitCode ? ' failed' : ''}`}>
      <div className="d-proc-head">
        <button
          className="d-proc-cmd mono"
          disabled={exited}
          aria-expanded={open}
          onClick={onToggle}
          title={`${p.command}\n${KIND[p.kind]}${exited ? '' : '\nClick for its processes and output'}`}
        >
          <i className={`dot ${exited ? (p.exitCode ? 'needs-input' : 'done') : 'working'}`} />
          <span>{p.command}</span>
          {!exited && <span className="muted"> {open ? '▾' : '▸'}</span>}
        </button>
        {p.ports.map((l) =>
          can('openPort') ? (
            <button key={l.port} className="d-port" title={`Open ${portUrl(l)} in the browser`} onClick={() => deck().openPort(portUrl(l))}>
              {portLabel(l)} ↗
            </button>
          ) : (
            <span key={l.port} className="d-port" title="Listening on the Mac">
              {portLabel(l)}
            </span>
          ),
        )}
      </div>
      <div className="d-proc-meta muted">
        <span className={exited && p.exitCode ? 'bad' : undefined}>{status}</span>
        <span>pid {p.pid}</span>
        {!exited && p.cpu > 0 && <span>{p.cpu}% CPU</span>}
        {!exited && p.memKb > 0 && <span>{formatMem(p.memKb)}</span>}
        {p.kind !== 'foreground' && <span>{p.kind === 'background' ? 'background' : 'detached'}</span>}
      </div>
      {p.cwd && (
        <div className="d-proc-cwd mono muted" title={p.cwd}>
          {p.cwd}
        </div>
      )}
      {open && <ProcDetail sessionKey={sessionKey} p={p} />}
    </div>
  )
}

/** The processes below it and its last output, read again while it is open. */
function ProcDetail({ sessionKey, p }: { sessionKey: string; p: SessionProc }) {
  const [out, setOut] = useState<{ ok: true; text: string } | { ok: false; message: string } | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  const text = out?.ok ? out.text : null
  // Follow the end of the output, as a terminal does.
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [text])
  useEffect(() => {
    if (!p.hasOutput) return
    let live = true
    const read = () =>
      void deck()
        .procsOutput(sessionKey, p.pid)
        .then((r) => live && setOut(r))
        .catch(() => {})
    read()
    const t = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [sessionKey, p.pid, p.hasOutput])
  return (
    <div className="d-proc-detail">
      {p.children.length > 0 && (
        <ul className="d-proc-kids mono">
          {p.children.slice(0, 20).map((c) => (
            <li key={c.pid} title={c.command}>
              <span className="muted">{c.pid}</span> {c.command}
            </li>
          ))}
          {p.children.length > 20 && <li className="muted">… {p.children.length - 20} more</li>}
        </ul>
      )}
      {!p.hasOutput ? (
        <div className="d-text muted">Its output goes straight to Claude Code; see the terminal.</div>
      ) : !out ? (
        <div className="d-text muted">Reading output…</div>
      ) : !out.ok ? (
        <div className="d-text muted">{out.message}</div>
      ) : (
        <pre ref={pre} className="d-proc-out mono">{out.text || '(no output yet)'}</pre>
      )}
    </div>
  )
}

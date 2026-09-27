import { useState, type ReactNode } from 'react'
import { reportQuestion, textOptions, withoutReport, type MenuAnswer, type ScreenMenu, type SessionAsk } from '@shared/ask'
import type { Session } from '@shared/types'
import { deck } from '../deck'
import { Markdown } from './SummaryPanel'

/**
 * What a session is asking, with ways to answer it without opening the session: the options of its
 * AskUserQuestion menu, the choices listed in a question asked in words, or a reply typed here.
 * `full` is the Needs-you popup: every detail, nothing clipped.
 */
export function AskPanel({
  session,
  ask,
  menu,
  fallback,
  full,
  actions,
  itemId,
}: {
  session: Session | null
  ask: SessionAsk | undefined
  menu?: ScreenMenu
  fallback: string | null
  full: boolean
  /** The card's own buttons (Open), on the same row as Reply / Submit. */
  actions?: ReactNode
  /** The Needs-you item this answers: replies and menu answers go through the inbox (shared/inbox.ts). */
  itemId?: string
}) {
  if (session && menu) return <MenuForm key={menu.question?.question ?? 'review'} session={session} menu={menu} full={full} actions={actions} itemId={itemId} />
  const text = (ask?.said ? withoutReport(ask.said.text) : null) ?? (ask?.report ? reportQuestion(ask.report) : null) ?? fallback ?? ''
  const options = ask?.said?.options ?? textOptions(text)
  return (
    <div className="ask">
      {text && (
        <div className={`ask-text ${full ? 'full' : ''}`}>
          <Markdown text={text} />
        </div>
      )}
      {session ? (
        <TextAnswer session={session} options={options} actions={actions} itemId={itemId} />
      ) : (
        <>
          <div className="ask-note">No live session to reply to.</div>
          {actions && <div className="actions">{actions}</div>}
        </>
      )}
    </div>
  )
}

function useSend() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (f: () => Promise<{ ok: boolean; message: string }>, done: string) => {
    setBusy(true)
    setMsg(null)
    const r = await f()
    setBusy(false)
    setMsg({ ok: r.ok, text: r.ok ? done : r.message })
    return r.ok
  }
  return { busy, msg, run }
}

/** An option's first sentence: enough to say which one, as the reply. */
function short(text: string): string {
  const first = text.split(/(?<=[.!?])\s/)[0]
  return first.length > 140 ? `${first.slice(0, 140)}…` : first
}

/** Choices from the question's own list (sent as "B: …"), or a reply in your words. */
function TextAnswer({ session, options, actions, itemId }: { session: Session; options: { key: string; text: string }[]; actions?: ReactNode; itemId?: string }) {
  const [text, setText] = useState('')
  const { busy, msg, run } = useSend()
  const send = async (t: string, option?: { key: string; text: string }) => {
    if (!t.trim() || busy) return
    const go = () =>
      !itemId ? deck().sendText(session.key, t) : option ? deck().inboxAct(itemId, 'option', { key: option.key, text: option.text }) : deck().inboxAct(itemId, 'reply', { text: t })
    if (await run(go, `Sent to ${session.name}`)) setText('')
  }
  return (
    <>
      {options.length > 0 && (
        <div className="ask-opts">
          {options.map((o) => (
            <button key={o.key} className="ask-opt" disabled={busy} title={`Reply "${o.key}: ${short(o.text)}"\n\n${o.text}`} onClick={() => void send(`${o.key}: ${short(o.text)}`, { key: o.key, text: short(o.text) })}>
              <span className="ask-key">{o.key}</span>
              {o.text.length > 160 ? `${o.text.slice(0, 160)}…` : o.text}
            </button>
          ))}
        </div>
      )}
      <div className="quick-reply">
        <textarea
          value={text}
          placeholder={options.length ? 'Or write a reply…' : `Reply to ${session.name}…`}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void send(text)}
        />
        <div className="actions">
          {msg && (
            <span className="error" style={{ color: msg.ok ? 'var(--green)' : undefined }}>
              {msg.text}
            </span>
          )}
          {actions}
          <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void send(text)} title="⌘↵">
            {busy ? 'Sending…' : 'Reply'}
          </button>
        </div>
      </div>
    </>
  )
}

/**
 * An AskUserQuestion menu, one question at a time as the session shows them: clicking an option
 * answers it (a multi-select sends its ticks with Next), and after the last one, Submit sends them.
 */
function MenuForm({ session, menu, full, actions, itemId }: { session: Session; menu: ScreenMenu; full: boolean; actions?: ReactNode; itemId?: string }) {
  const q = menu.question
  const [ticks, setTicks] = useState<number[]>(() => menu.checked.map((k) => k - 1))
  const [own, setOwn] = useState('')
  const { busy, msg, run } = useSend()
  const answer = (a: MenuAnswer | 'submit') =>
    run(
      () => (itemId ? deck().inboxAct(itemId, 'menu', { question: q?.question ?? null, answer: a }) : deck().answerMenu(session.key, q?.question ?? null, a)),
      a === 'submit' ? `Answered ${session.name}` : 'Sent',
    )

  return (
    <div className="ask">
      {menu.tabs.length > 1 && (
        <div className="ask-qhead">
          {menu.tabs.map((t, i) => (
            <span key={i} className={`chip ${t.answered ? 'ask-done' : q && t.label === q.header ? 'ask-now' : ''}`}>
              {t.answered ? '✓ ' : ''}
              {t.label}
            </span>
          ))}
        </div>
      )}
      {menu.review ? (
        <>
          <div className="ask-note">Your answers, ready to submit:</div>
          <ul className="ask-review">
            {menu.review.map((r, i) => (
              <li key={i}>
                {r.question} <b>→ {r.answer}</b>
              </li>
            ))}
          </ul>
          <div className="actions">
            {msg && (
              <span className="error" style={{ color: msg.ok ? 'var(--green)' : undefined }}>
                {msg.text}
              </span>
            )}
            {actions}
            <button className="btn primary" disabled={busy} onClick={() => void answer('submit')}>
              {busy ? 'Submitting…' : 'Submit answers'}
            </button>
          </div>
        </>
      ) : q ? (
        <>
          <div className="ask-text full">
            {q.question}
            {q.multiSelect && <span className="ask-note"> (pick any)</span>}
          </div>
          <div className={`ask-opts ${full ? 'col' : ''}`}>
            {q.options.map((o, j) => (
              <button
                key={j}
                className={`ask-opt ${ticks.includes(j) ? 'on' : ''}`}
                disabled={busy}
                title={o.description}
                onClick={() => (q.multiSelect ? setTicks(ticks.includes(j) ? ticks.filter((t) => t !== j) : [...ticks, j]) : void answer({ picks: [j] }))}
              >
                <span className="ask-key">{q.multiSelect ? (ticks.includes(j) ? '☑' : '☐') : j + 1}</span>
                <span>
                  {o.label}
                  {full && o.description && <span className="ask-desc">{o.description}</span>}
                </span>
              </button>
            ))}
          </div>
          {!q.multiSelect && (
            <input
              className="ask-own"
              value={own}
              placeholder="Or write your own answer and press Enter…"
              disabled={busy}
              onChange={(e) => setOwn(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && own.trim() && void answer({ picks: [], text: own.trim() })}
            />
          )}
          <div className="actions">
            {msg && (
              <span className="error" style={{ color: msg.ok ? 'var(--green)' : undefined }}>
                {msg.text}
              </span>
            )}
            {busy && <span className="ask-note">Answering…</span>}
            {actions}
            {q.multiSelect && (
              <button className="btn primary" disabled={busy || !ticks.length} onClick={() => void answer({ picks: ticks })}>
                Next
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

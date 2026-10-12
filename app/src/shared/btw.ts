/**
 * Side questions about a session, as Claude Code's `/btw` asks them: answered from the
 * conversation so far, with no tools, never added to the conversation. The Details panel's BTW tab
 * asks them through a forked `claude -p` (main/btw.ts); a `/btw` typed in the terminal is picked
 * up from Claude Code's prompt history (`history.jsonl`), and its answer, which Claude Code keeps
 * nowhere, from the session's screen.
 */

export const BTW_QUESTION_MAX = 4000
export const BTW_ANSWER_MAX = 64_000
export const BTW_ENTRIES_MAX = 200
/** Earlier side questions a new one sees, as `/btw` does (its newest 20 exchanges). */
export const BTW_EARLIER = 20
/** Each earlier answer is cut to this in the prompt. */
const EARLIER_ANSWER_MAX = 2000

export type BtwStatus = 'asking' | 'done' | 'error' | 'stopped'

export interface BtwEntry {
  id: string
  question: string
  /** Markdown as Claude wrote it; '' until text arrives (and for a terminal answer not read). */
  answer: string
  /** When it was asked (epoch ms). */
  at: number
  doneAt: number | null
  /** Asked from the tab, or typed as `/btw` in the session's terminal. */
  source: 'panel' | 'terminal'
  status: BtwStatus
  error?: string
  /** Terminal: the answer was longer than its box; only what fit on the screen was read. */
  partial?: boolean
  /** Terminal: false when the answer could not be read (the session is not a background one, or it closed first). */
  captured?: boolean
  costUsd?: number
  model?: string
}

export type BtwEvent = { key: string; entry: BtwEntry } | { key: string; removed: string }

export type BtwAskResult = { ok: true; id: string } | { ok: false; message: string }

/** What a question may be: text, not empty, not too long. Returns the cleaned question or a message. */
export function checkQuestion(raw: unknown): { ok: true; question: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'no question' }
  const question = raw.replace(/\r\n?/g, '\n').trim()
  if (!question) return { ok: false, message: 'Type a question first.' }
  if (question.length > BTW_QUESTION_MAX) return { ok: false, message: `Questions are at most ${BTW_QUESTION_MAX} characters.` }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(question)) return { ok: false, message: 'The question has control characters.' }
  return { ok: true, question }
}

/** The text `claude -p` gets: what a side question is, the earlier ones, then the question. */
export function btwPrompt(question: string, earlier: BtwEntry[]): string {
  const past = earlier
    .filter((e) => e.status === 'done' && e.answer.trim())
    .slice(-BTW_EARLIER)
    .map((e) => {
      const a = e.answer.length > EARLIER_ANSWER_MAX ? `${e.answer.slice(0, EARLIER_ANSWER_MAX)}…` : e.answer
      return `<side_question>\n${e.question}\n</side_question>\n<side_answer>\n${a}\n</side_answer>`
    })
  return [
    'This is a side question (/btw) about the conversation above, asked while the session goes on with its work.',
    'Answer it from what is already in the conversation, briefly and directly. You have no tools: do not try to read files, run commands or search.',
    'Your answer is shown to the user beside the session and is not added to the conversation.',
    ...(past.length ? ['', 'Earlier side questions and their answers:', ...past] : []),
    '',
    `Side question: ${question}`,
  ].join('\n')
}

/** A model id the session used that `--model` takes; null for anything else. */
export function btwModel(model: string | null | undefined): string | null {
  return model && /^[A-Za-z0-9][A-Za-z0-9.\-_[\]]{0,80}$/.test(model) && model !== '<synthetic>' ? model : null
}

export type StreamItem =
  | { kind: 'delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'result'; ok: boolean; text: string; costUsd: number | null; model: string | null }
  | { kind: 'model'; model: string }

/** One line of `claude -p --output-format stream-json --include-partial-messages`. */
export function parseStreamLine(line: string): StreamItem | null {
  if (!line.trim().startsWith('{')) return null
  let d: Record<string, unknown>
  try {
    d = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (d.type === 'stream_event') {
    const ev = d.event as { type?: string; delta?: { type?: string; text?: string }; message?: { model?: string } } | undefined
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string')
      return { kind: 'delta', text: ev.delta.text }
    if (ev?.type === 'message_start' && typeof ev.message?.model === 'string') return { kind: 'model', model: ev.message.model }
    return null
  }
  if (d.type === 'assistant') {
    const content = (d.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return null
    const text = content
      .filter((c): c is { type: string; text: string } => !!c && (c as { type?: string }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
      .map((c) => c.text)
      .join('')
    return text ? { kind: 'text', text } : null
  }
  if (d.type === 'result') {
    const ok = d.subtype === 'success' && d.is_error !== true
    const text = typeof d.result === 'string' ? d.result : Array.isArray(d.errors) ? d.errors.map(String).join('\n') : ''
    const costUsd = typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null
    const usage = d.modelUsage && typeof d.modelUsage === 'object' ? Object.keys(d.modelUsage as object) : []
    return { kind: 'result', ok, text, costUsd, model: usage[0] ?? null }
  }
  return null
}

/** A `/btw` line of Claude Code's prompt history (`history.jsonl`). `/btw` alone only reopens the last answer. */
export function parseHistoryLine(line: string): { sessionId: string; question: string; at: number } | null {
  if (!line.includes('/btw')) return null
  let d: { display?: unknown; timestamp?: unknown; sessionId?: unknown }
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof d.display !== 'string' || typeof d.sessionId !== 'string' || typeof d.timestamp !== 'number') return null
  const m = /^\/btw\s+([\s\S]+)$/.exec(d.display.trim())
  if (!m) return null
  const question = m[1].trim().slice(0, BTW_QUESTION_MAX)
  return question ? { sessionId: d.sessionId, question, at: d.timestamp } : null
}

export interface BtwScreen {
  /** The question as the overlay shows it (wrapped lines joined). */
  question: string
  answer: string
  /** Still answering (the answer may grow). */
  answering: boolean
  /** The box scrolls: the answer goes on below what is shown. */
  more: boolean
}

const FOOTER = /c to copy\b.*Esc to close|·\s*Esc to close|^\s*Esc to close/
const ANSWERING = /^\s*\S?\s*Answering…\s*$/

/**
 * The `/btw` box on a session's rendered screen (`claude logs`), or null. Claude Code 2.1.x draws
 * it at the bottom: `/btw <question>` (wrapped), a blank line, the answer indented, and a footer
 * (`↑/↓ to scroll · c to copy · f to fork · Esc to close`, or `Esc to close` while answering).
 */
export function parseBtwScreen(screen: string): BtwScreen | null {
  const lines = screen.split('\n')
  let foot = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i])) {
      foot = i
      break
    }
  }
  if (foot < 0) return null
  let head = -1
  for (let i = foot - 1; i >= 0 && i >= foot - 400; i--) {
    if (/^\s*\/btw\s+\S/.test(lines[i])) {
      head = i
      break
    }
  }
  if (head < 0) return null
  // The question runs on until the first blank line.
  let i = head
  const q: string[] = []
  while (i < foot && lines[i].trim()) q.push(lines[i++].trim())
  const question = q.join(' ').replace(/^\/btw\s+/, '').replace(/\s+/g, ' ').trim()
  const body = lines.slice(i, foot)
  const answering = body.some((l) => ANSWERING.test(l))
  const text = body.filter((l) => !ANSWERING.test(l))
  while (text.length && !text[0].trim()) text.shift()
  while (text.length && !text[text.length - 1].trim()) text.pop()
  const indent = Math.min(...text.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99)
  const answer = text.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)).trimEnd()).join('\n')
  return { question, answer, answering, more: /↑\/↓/.test(lines[foot]) }
}

/** The screen's question is the one asked: the box may cut or rewrap a long one, so the start is compared. */
export function sameQuestion(asked: string, onScreen: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const a = norm(asked)
  const b = norm(onScreen).replace(/…$/, '')
  const n = Math.min(a.length, b.length, 60)
  return n > 0 && a.slice(0, n) === b.slice(0, n)
}

/** Keep the newest BTW_ENTRIES_MAX, oldest first. */
export function capEntries(list: BtwEntry[]): BtwEntry[] {
  const sorted = [...list].sort((a, b) => a.at - b.at)
  return sorted.length > BTW_ENTRIES_MAX ? sorted.slice(-BTW_ENTRIES_MAX) : sorted
}

export function capAnswer(text: string): string {
  return text.length > BTW_ANSWER_MAX ? `${text.slice(0, BTW_ANSWER_MAX)}\n\n… (cut at ${BTW_ANSWER_MAX} characters)` : text
}

/** A list with one entry put in (replaced by id, or added), oldest first. */
export function withEntry(list: BtwEntry[], e: BtwEntry): BtwEntry[] {
  const i = list.findIndex((x) => x.id === e.id)
  if (i < 0) return capEntries([...list, e])
  const out = list.slice()
  out[i] = e
  return out
}

export function applyBtwEvent(list: BtwEntry[], ev: BtwEvent): BtwEntry[] {
  return 'removed' in ev ? list.filter((e) => e.id !== ev.removed) : withEntry(list, ev.entry)
}

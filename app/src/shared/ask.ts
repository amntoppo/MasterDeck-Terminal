/**
 * What a session is asking the user. A question in plain words (the `#N: question — …` a session
 * reports to master-agent, and what it then asks the user directly) comes from its transcript. An
 * AskUserQuestion menu does not: Claude Code writes it there only once it is answered, so it is read
 * from the session's screen (`claude logs`), one question at a time as the menu shows them.
 */

export interface AskOption {
  label: string
  description: string
}

export interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: AskOption[]
}

/** A numbered or lettered choice in a plain-words question: `key` is what the list used (1, 2, A, B). */
export interface TextOption {
  key: string
  text: string
}

export interface SessionAsk {
  /** The last `#N: question — …` report (to master-agent, or said in the session). */
  report: { issue: number; at: number; text: string } | null
  /** What the session last said to the user since they last wrote: the full question, usually. */
  said: { at: number; text: string; options: TextOption[] } | null
  /** When the user last wrote to the session (typed, not hooks, skills or other sessions). */
  userAt: number | null
}

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A user text block the user actually wrote (not a hook note, a skill, a command or another session). */
export function isUserWords(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/^<(command-|local-command|system-reminder|bash-|cross-session-message|task-notification|user-prompt-submit-hook)/.test(t)) return false
  if (t.startsWith('[Cross-session') || t.startsWith('Base directory for this skill') || t.startsWith('Caveat:')) return false
  if (t.includes('<system-reminder>') && t.indexOf('<system-reminder>') === 0) return false
  return true
}

const REPORT = /#(\d+):\s*question\b\s*[—–-]*\s*/

/**
 * The choices in a plain-words question: the last list of 2+ items marked 1, 2, 3… or A, B, C… in
 * order (`1.`, `2)`, `**A.**`, `- Option B:`). Only when the text asks something (has a `?`).
 */
export function textOptions(text: string): TextOption[] {
  if (!text.includes('?')) return []
  const item = /^\s*(?:[-*•]\s+)?(?:\*\*)?(?:Option\s+)?([1-9]|[A-Ha-h])(?:\*\*)?[.):](?:\*\*)?\s+(.+)$/
  const lists: TextOption[][] = []
  let cur: TextOption[] = []
  const close = () => {
    if (cur.length >= 2) lists.push(cur)
    cur = []
  }
  for (const line of text.split('\n')) {
    // Lines between items (their details, bullets under them) keep the list open; a list ends
    // where another one starts.
    const m = item.exec(line)
    if (!m) continue
    const key = m[1].toUpperCase()
    const want = cur.length === 0 ? (key === '1' || key === 'A' ? key : null) : next(cur[cur.length - 1].key)
    if (key !== want) {
      close()
      if (key !== '1' && key !== 'A') continue
    }
    cur.push({ key, text: m[2].replace(/\*\*/g, '').trim() })
  }
  close()
  return lists[lists.length - 1] ?? []
}

function next(key: string): string {
  return /\d/.test(key) ? String(Number(key) + 1) : String.fromCharCode(key.charCodeAt(0) + 1)
}

/** Read a session's transcript lines (oldest first) for what it is asking. */
export function sessionAsk(lines: string[]): SessionAsk {
  const out: SessionAsk = { report: null, said: null, userAt: null }
  let said: { at: number; parts: string[] } | null = null

  for (const line of lines) {
    if (!line.includes('"message"')) continue
    let d: Obj
    try {
      d = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (d.isSidechain === true) continue
    const at = Date.parse(str(d.timestamp)) || 0
    const m = obj(d.message)
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content.map(obj) : []
    for (const b of blocks) {
      if (d.type === 'user') {
        if (b.type === 'text' && d.isMeta !== true && isUserWords(str(b.text))) {
          out.userAt = at
          said = null
        }
      } else if (d.type === 'assistant') {
        if (b.type === 'text' && str(b.text).trim()) {
          const text = str(b.text).trim()
          const r = REPORT.exec(text)
          if (r) out.report = { issue: Number(r[1]), at, text: text.slice(r.index) }
          // The question itself starts a fresh "said"; working notes before it are not the question.
          said = said && !r ? { at, parts: [...said.parts, text].slice(-3) } : { at, parts: [text] }
        } else if (b.type === 'tool_use' && b.name === 'SendMessage') {
          const input = obj(b.input)
          const text = str(input.message) || str(input.content)
          const r = REPORT.exec(text)
          if (r) {
            out.report = { issue: Number(r[1]), at, text: text.slice(r.index) }
            // What it says next is the full question, asked of the user directly.
            said = null
          }
        }
      }
    }
  }
  if (said) {
    const text = said.parts.join('\n\n')
    out.said = { at: said.at, text, options: textOptions(text) }
  }
  return out
}

/** The report's question without the `#N: question —` prefix. */
export function reportQuestion(report: { text: string }): string {
  return report.text.replace(REPORT, '').trim()
}

/** What the session said, without a leading `#N: question —` (the card already says it is a question). */
export function withoutReport(text: string): string {
  const m = REPORT.exec(text)
  return m && !text.slice(0, m.index).trim() ? text.slice(m.index + m[0].length).trim() : text
}

/** A question proposal that the user answered in the session itself: they wrote after the last report. */
export function answeredInSession(ask: SessionAsk | undefined, issue: number): boolean {
  if (!ask?.report || ask.report.issue !== issue || ask.userAt === null) return false
  return ask.userAt > ask.report.at
}

/** The AskUserQuestion menu on a session's screen. */
export interface ScreenMenu {
  /** The tabs across its top: one per question, `answered` once picked. */
  tabs: { label: string; answered: boolean }[]
  /** The question showing now (null on the review screen). */
  question: AskQuestion | null
  /** Options already ticked in a multi-select (1-based). */
  checked: number[]
  /** The review screen before submitting: each question and its answer. */
  review: { question: string; answer: string }[] | null
}

const TABS = /^\s*←\s+(.*?)\s+→\s*$/
const SEPARATOR = /^\s*[─━]{8,}/
const OPTION = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[([ ✔✓xX])\]\s+)?(.*)$/

/**
 * Read the menu from a rendered screen (lines of text): the tab row `← ☐ Colour ☒ Pets ✔ Submit →`,
 * the question under it, and its numbered options with their descriptions. Null when no menu shows.
 */
export function parseMenuScreen(screen: string): ScreenMenu | null {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TABS.exec(lines[i])
    if (m && /✔\s*Submit/.test(m[1])) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const tabs = [...TABS.exec(lines[at])![1].matchAll(/([☐☒])\s+(.+?)(?=\s+[☐☒✔]|$)/g)].map((m) => ({ label: m[2].trim(), answered: m[1] === '☒' }))
  const rest = lines.slice(at + 1)

  if (rest.some((l) => /Review your answers|Ready to submit your answers/.test(l))) {
    const review: { question: string; answer: string }[] = []
    for (const l of rest) {
      const q = /^\s*●\s+(.*)$/.exec(l)
      const a = /^\s*→\s+(.*)$/.exec(l)
      if (q) review.push({ question: q[1].trim(), answer: '' })
      else if (a && review.length) review[review.length - 1].answer = a[1].trim()
    }
    return { tabs, question: null, checked: [], review }
  }

  let i = 0
  while (i < rest.length && !rest[i].trim()) i++
  const qLines: string[] = []
  while (i < rest.length && rest[i].trim() && !OPTION.test(rest[i])) qLines.push(rest[i++].trim())
  const options: AskOption[] = []
  const checked: number[] = []
  let multiSelect = false
  for (; i < rest.length; i++) {
    const l = rest[i]
    if (SEPARATOR.test(l) || /Enter to select|Esc to cancel/.test(l)) break
    const m = OPTION.exec(l)
    if (m) {
      const label = m[3].trim()
      if (/^Type something\.?$/.test(label) || /^Chat about this$/.test(label)) break
      if (m[2] !== undefined) multiSelect = true
      if (m[2] && m[2].trim()) checked.push(Number(m[1]))
      options.push({ label, description: '' })
    } else if (l.trim() && options.length && l.trim() !== 'Submit') {
      const o = options[options.length - 1]
      o.description = o.description ? `${o.description} ${l.trim()}` : l.trim()
    }
  }
  if (!qLines.length || !options.length) return null
  const header = tabs.find((t) => !t.answered)?.label ?? ''
  return { tabs, question: { question: qLines.join(' '), header, multiSelect, options }, checked, review: null }
}

/** An answer to the question on screen: options picked (0-based), or a typed answer. */
export interface MenuAnswer {
  picks: number[]
  text?: string
}

export type KeyStep = { keys: string; wait: number } | { expect: RegExp; keys: string; wait: number }

const ENTER = '\r'
const RIGHT = '\x1b[C'

/**
 * The keys that answer the question on screen, as Claude Code's menu takes them: a digit picks an
 * option (and moves on); "Type something" is the option after the last one, then the text and Enter;
 * a multi-select toggles digits (from what is ticked now to what was picked) and moves on with →.
 * `answer` 'submit' sends the review screen's "Submit answers".
 */
export function answerKeys(menu: ScreenMenu, answer: MenuAnswer | 'submit'): KeyStep[] | string {
  if (answer === 'submit') return menu.review ? [{ expect: /Submit answers/, keys: ENTER, wait: 500 }] : 'the answers are not ready to submit yet'
  const q = menu.question
  if (!q) return 'no question on screen'
  const n = q.options.length
  if (n > 8) return 'too many options to pick by number'
  if (answer.picks.some((p) => !Number.isInteger(p) || p < 0 || p >= n)) return 'no such option'
  const typed = answer.text?.replace(/[\r\n]+/g, ' ').trim()
  if (q.multiSelect) {
    if (typed) return 'a multi-select question takes its options only'
    if (!answer.picks.length) return 'pick at least one option'
    const want = new Set(answer.picks.map((p) => p + 1))
    const toggle = [...new Set([...want, ...menu.checked])].filter((k) => want.has(k) !== menu.checked.includes(k)).sort()
    return [...toggle.map((k) => ({ keys: String(k), wait: 300 })), { keys: RIGHT, wait: 700 }]
  }
  if (typed) return [{ keys: String(n + 1), wait: 500 }, { keys: typed, wait: 300 }, { keys: ENTER, wait: 700 }]
  if (answer.picks.length !== 1) return 'pick one option'
  return [{ keys: String(answer.picks[0] + 1), wait: 700 }]
}

/** Terminal output without escape sequences, for looking for text on screen. */
export function plainScreen(s: string): string {
  return s.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][A-Z0-9]/g, '')
}

/** An AskUserQuestion menu (or its review screen) is on screen: its tab row ends in "✔ Submit →". */
export function menuOnScreen(screen: string): boolean {
  return /✔\s*Submit\s*→/.test(plainScreen(screen).slice(-6000))
}

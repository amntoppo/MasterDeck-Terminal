export interface HistoryHit {
  sessionId: string
  path: string
  title: string
  cwd: string | null
  matches: number
  /** Files the session touched (tool_use file_path) whose path contains the query. */
  files: string[]
  /** A few short text snippets around the match. */
  snippets: string[]
  /** The transcript entry (its uuid) each snippet came from, so a click can open it there. */
  snippetIds?: (string | null)[]
  lastActivity: number
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Summarise one transcript for a query: its title (custom name, else AI title), cwd, matching
 * lines, files touched whose path contains the query, and snippets. Case-insensitive, fixed string.
 */
export function summarizeTranscript(sessionId: string, path: string, lines: string[], query: string, mtime: number): HistoryHit | null {
  const q = query.toLowerCase()
  let custom: string | null = null
  let ai: string | null = null
  let cwd: string | null = null
  let matches = 0
  const files = new Set<string>()
  const snippets: string[] = []
  const snippetIds: (string | null)[] = []
  const snip = (text: string, i: number, id: string | null) => {
    snippets.push(text.slice(Math.max(0, i - 60), i + q.length + 60).replace(/\s+/g, ' ').trim())
    snippetIds.push(id)
  }
  for (const line of lines) {
    const hit = line.toLowerCase().includes(q)
    const titleLine = line.includes('"custom-title"') || line.includes('"ai-title"')
    if (!hit && !titleLine && cwd) continue
    let o: Record<string, unknown>
    try {
      o = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') ai = o.aiTitle
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd
    if (!hit) continue
    matches++
    const id = typeof o.uuid === 'string' ? o.uuid : null
    const content = obj(o.message).content
    for (const b of Array.isArray(content) ? content.map(obj) : []) {
      const fp = obj(b.input).file_path
      if (b.type === 'tool_use' && typeof fp === 'string' && fp.toLowerCase().includes(q)) files.add(fp)
      const text = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : ''
      const i = text.toLowerCase().indexOf(q)
      if (i >= 0 && snippets.length < 5) snip(text, i, id)
    }
    if (typeof content === 'string' && snippets.length < 5) {
      const i = content.toLowerCase().indexOf(q)
      if (i >= 0) snip(content, i, id)
    }
  }
  if (matches === 0) return null
  return { sessionId, path, title: custom ?? ai ?? sessionId.slice(0, 8), cwd, matches, files: [...files].slice(0, 8), snippets, snippetIds, lastActivity: mtime }
}

/** One entry of a conversation as the History reader shows it. */
export interface TranscriptMessage {
  uuid: string
  role: 'user' | 'assistant' | 'tool' | 'result'
  text: string
  at: number | null
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * A transcript as readable messages, oldest first: what the user wrote, Claude's replies, each tool
 * call (name and input) and each tool result (shortened). Sidechains (subagents) are left out.
 */
export function transcriptMessages(lines: string[], maxResult = 1500): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const line of lines) {
    if (!line.includes('"message"')) continue
    let o: Record<string, unknown>
    try {
      o = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (o.isSidechain === true || typeof o.uuid !== 'string') continue
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || null : null
    const m = obj(o.message)
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content.map(obj) : []
    const parts: { role: TranscriptMessage['role']; text: string }[] = []
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push({ role: o.type === 'assistant' ? 'assistant' : 'user', text: b.text })
      else if (b.type === 'tool_use') parts.push({ role: 'tool', text: `${String(b.name ?? 'tool')} ${clip(JSON.stringify(b.input ?? {}), 600)}` })
      else if (b.type === 'tool_result') {
        const c = b.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => String(obj(x).text ?? '')).join('\n') : ''
        if (text.trim()) parts.push({ role: 'result', text: clip(text, maxResult) })
      }
    }
    // One entry per line (one uuid), so a hit's uuid finds it; its parts joined.
    if (!parts.length) continue
    const role = parts.some((p) => p.role === 'assistant') ? 'assistant' : parts.some((p) => p.role === 'user') ? 'user' : parts[0].role
    out.push({ uuid: o.uuid, role, text: parts.map((p) => (p.role === 'tool' ? `⏺ ${p.text}` : p.role === 'result' ? `⎿ ${p.text}` : p.text)).join('\n\n'), at })
  }
  return out
}

/** A slice of a conversation for the reader, around the message to show. */
export interface TranscriptWindow {
  messages: TranscriptMessage[]
  /** Index of messages[0] in the whole conversation, and its length. */
  start: number
  total: number
  /** Every message (uuid) holding the query, in order: the reader steps through these. */
  matches: string[]
  /** The message to scroll to: `focus` when it is in the conversation, else the first match. */
  focus: string | null
}

/** The window of `all` around `focus` (or the first match of `query`), at most `size` messages. */
export function transcriptWindow(all: TranscriptMessage[], query: string, focus: string | null, size = 300): TranscriptWindow {
  const q = query.trim().toLowerCase()
  const matches = q ? all.filter((m) => m.text.toLowerCase().includes(q)).map((m) => m.uuid) : []
  let at = focus ? all.findIndex((m) => m.uuid === focus) : -1
  if (at < 0 && matches.length) at = all.findIndex((m) => m.uuid === matches[0])
  const start = Math.max(0, Math.min(Math.max(0, all.length - size), (at < 0 ? 0 : at) - Math.floor(size / 2)))
  return { messages: all.slice(start, start + size), start, total: all.length, matches, focus: at >= 0 ? all[at].uuid : null }
}

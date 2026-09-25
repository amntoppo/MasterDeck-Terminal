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
    const content = obj(o.message).content
    for (const b of Array.isArray(content) ? content.map(obj) : []) {
      const fp = obj(b.input).file_path
      if (b.type === 'tool_use' && typeof fp === 'string' && fp.toLowerCase().includes(q)) files.add(fp)
      const text = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : ''
      const i = text.toLowerCase().indexOf(q)
      if (i >= 0 && snippets.length < 3) snippets.push(text.slice(Math.max(0, i - 60), i + q.length + 60).replace(/\s+/g, ' ').trim())
    }
    if (typeof content === 'string' && snippets.length < 3) {
      const i = content.toLowerCase().indexOf(q)
      if (i >= 0) snippets.push(content.slice(Math.max(0, i - 60), i + q.length + 60).replace(/\s+/g, ' ').trim())
    }
  }
  if (matches === 0) return null
  return { sessionId, path, title: custom ?? ai ?? sessionId.slice(0, 8), cwd, matches, files: [...files].slice(0, 8), snippets, lastActivity: mtime }
}

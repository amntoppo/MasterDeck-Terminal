import type { SessionStats, TranscriptTail } from './types'

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Parse the JSON Claude Code hands its status line command. Null when the text is not JSON. */
export function parseStatusline(text: string, mtimeMs: number): SessionStats | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const r = obj(raw)
  if (Object.keys(r).length === 0) return null
  const cost = obj(r.cost)
  const model = obj(r.model)
  const ws = obj(r.workspace)
  const cw = obj(r.context_window)
  let contextPct = num(cw.used_percentage)
  if (contextPct === null) {
    const cu = obj(cw.current_usage)
    const size = num(cw.context_window_size)
    const used =
      (num(cu.input_tokens) ?? 0) + (num(cu.cache_read_input_tokens) ?? 0) + (num(cu.cache_creation_input_tokens) ?? 0)
    if (size && used > 0) contextPct = (used / size) * 100
  }
  return {
    costUsd: num(cost.total_cost_usd),
    contextPct,
    model: str(model.display_name) ?? str(model.id),
    permissionMode: str(r.permission_mode) ?? str(obj(r.permissions).mode),
    currentDir: str(ws.current_dir) ?? str(r.cwd),
    linesAdded: num(cost.total_lines_added),
    linesRemoved: num(cost.total_lines_removed),
    source: 'statusline',
    updatedAt: mtimeMs,
  }
}

function ts(v: unknown): number | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

/**
 * Parse the tail of a session transcript (.jsonl). `fromStart` false means the text was cut from
 * the middle of the file, so its first line is partial and is skipped. Newest lines win.
 */
export function parseTranscriptTail(text: string, fromStart: boolean): TranscriptTail {
  const lines = text.split('\n')
  if (!fromStart) lines.shift()
  const out: TranscriptTail = {
    model: null,
    contextTokens: null,
    lastTool: null,
    lastToolAt: null,
    lastActivityAt: null,
    cwd: null,
    gitBranch: null,
    permissionMode: null,
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let o: Record<string, unknown>
    try {
      o = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (o.type === 'permission-mode' && out.permissionMode === null) out.permissionMode = str(o.permissionMode)
    if (o.isSidechain === true) continue
    const at = ts(o.timestamp)
    if (at !== null && out.lastActivityAt === null) out.lastActivityAt = at
    if (out.cwd === null) out.cwd = str(o.cwd)
    if (out.gitBranch === null && str(o.gitBranch) && o.gitBranch !== 'HEAD') out.gitBranch = str(o.gitBranch)
    if (o.type !== 'assistant') continue
    const m = obj(o.message)
    if (out.model === null) out.model = str(m.model)
    const u = obj(m.usage)
    if (out.contextTokens === null && Object.keys(u).length > 0) {
      out.contextTokens =
        (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0)
    }
    if (out.lastTool === null && Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const c = obj(m.content[j])
        if (c.type === 'tool_use' && str(c.name)) {
          out.lastTool = str(c.name)
          out.lastToolAt = at
          break
        }
      }
    }
    if (out.model && out.contextTokens !== null && out.lastTool && out.permissionMode && out.cwd) break
  }
  return out
}

/** A 1M-token window when the model id says so or usage already passed 200k. */
export function contextWindowFor(model: string | null, tokens: number | null): number {
  if (model && /\[1m\]|-1m\b/i.test(model)) return 1_000_000
  if (tokens !== null && tokens > 200_000) return 1_000_000
  return 200_000
}

export function statsFromTranscript(t: TranscriptTail, now: number): SessionStats {
  const window = contextWindowFor(t.model, t.contextTokens)
  return {
    costUsd: null,
    contextPct: t.contextTokens === null ? null : (t.contextTokens / window) * 100,
    model: t.model,
    permissionMode: t.permissionMode,
    currentDir: t.cwd,
    linesAdded: null,
    linesRemoved: null,
    source: 'transcript',
    updatedAt: t.lastActivityAt ?? now,
  }
}

export type ContextLevel = 'ok' | 'warn' | 'high'

export function contextLevel(pct: number | null): ContextLevel {
  if (pct === null) return 'ok'
  if (pct >= 85) return 'high'
  if (pct >= 60) return 'warn'
  return 'ok'
}

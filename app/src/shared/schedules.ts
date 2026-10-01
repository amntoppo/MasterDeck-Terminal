/**
 * Scheduled jobs a session made with Claude Code's CronCreate (Details → Scheduled). Read from its
 * transcript: the call gives the cron and prompt, its result the job id ("Scheduled recurring job
 * a782a417 (Every 2 minutes). Session-only …"), and CronDelete removes one. Recurring jobs expire
 * 7 days after they were made; a one-time job is gone once its time has passed.
 */

export interface ScheduleJob {
  id: string
  cron: string
  /** Claude Code's own wording, e.g. "Every 2 minutes" (else the cron). */
  when: string
  prompt: string
  recurring: boolean
  /** Session-only: it ends when the session exits. */
  sessionOnly: boolean
  createdAt: number
}

export interface ScheduleInfo extends ScheduleJob {
  nextAt: number | null
  expiresAt: number | null
}

export interface ScheduleScan {
  calls: Record<string, { cron: string; prompt: string; recurring: boolean; at: number }>
  deletes: Record<string, string>
  jobs: Record<string, ScheduleJob>
}

export const newScheduleScan = (): ScheduleScan => ({ calls: {}, deletes: {}, jobs: {} })

/** Recurring jobs end this long after they were made (Claude Code's limit). */
export const RECURRING_MS = 7 * 24 * 3_600_000

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function resultText(b: Record<string, unknown>): string {
  const c = b.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => str((x as Record<string, unknown>)?.text)).join('\n')
  return ''
}

export function scanScheduleLines(lines: string[], s: ScheduleScan): void {
  for (const line of lines) {
    // Cheap skip: a call names Cron…; its result only matters while a call waits for it.
    const waiting = Object.keys(s.calls).length > 0 || Object.keys(s.deletes).length > 0
    if (!line.includes('Cron') && !(waiting && line.includes('tool_result'))) continue
    let o: { timestamp?: unknown; message?: { content?: unknown } }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || 0 : 0
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_use') {
        const input = (b.input ?? {}) as Record<string, unknown>
        if (b.name === 'CronCreate')
          s.calls[str(b.id)] = { cron: str(input.cron).trim(), prompt: str(input.prompt), recurring: input.recurring !== false, at }
        if (b.name === 'CronDelete') s.deletes[str(b.id)] = str(input.id)
        continue
      }
      if (b.type !== 'tool_result' || b.is_error === true) continue
      const useId = str(b.tool_use_id)
      const text = resultText(b)
      const call = s.calls[useId]
      if (call) {
        delete s.calls[useId]
        const m = /Scheduled\s+([\w-]+(?:\s[\w-]+)?)\s+job\s+([0-9A-Za-z_-]{4,})(?:\s*\(([^)]*)\))?/.exec(text)
        if (!m) continue
        s.jobs[m[2]] = {
          id: m[2],
          cron: call.cron,
          when: readable((m[3] ?? '').trim(), call.cron),
          prompt: call.prompt,
          recurring: !/one[- ]?(time|shot)/i.test(m[1]) && call.recurring,
          sessionOnly: /session-only/i.test(text),
          createdAt: at,
        }
        continue
      }
      const del = s.deletes[useId]
      if (del !== undefined) {
        delete s.deletes[useId]
        delete s.jobs[del]
      }
    }
  }
}

/** The jobs still on, with their next run and expiry. */
export function liveSchedules(s: ScheduleScan, now: number): ScheduleInfo[] {
  const out: ScheduleInfo[] = []
  for (const j of Object.values(s.jobs)) {
    const expiresAt = j.recurring ? j.createdAt + RECURRING_MS : null
    if (expiresAt !== null && now >= expiresAt) continue
    const nextAt = nextRun(j.cron, j.recurring ? now : j.createdAt)
    // A one-time job ran at its time (a minute's grace for the turn to start).
    if (!j.recurring && (nextAt === null || now > nextAt + 60_000)) continue
    out.push({ ...j, nextAt, expiresAt })
  }
  return out.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
}

/** One cron field's allowed values (`*`, `n`, `a-b`, `* /n`, `a-b/n`, lists), or null if unreadable. */
function field(f: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of f.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) return null
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) return null
    let a = lo
    let b = hi
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number)
      a = x
      b = y ?? (m[2] ? hi : x)
    }
    if (a < lo || b > hi || a > b) return null
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out
}

/** The next minute after `from` that a 5-field cron matches, in local time; null when unreadable. */
export function nextRun(cron: string, from: number): number | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return null
  const min = field(f[0], 0, 59)
  const hour = field(f[1], 0, 23)
  const dom = field(f[2], 1, 31)
  const mon = field(f[3], 1, 12)
  const dow = field(f[4].replace(/\b7\b/g, '0'), 0, 6)
  if (!min || !hour || !dom || !mon || !dow) return null
  const anyDom = f[2] === '*'
  const anyDow = f[4] === '*'
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  // At most a year of minutes, skipping whole hours and days that cannot match.
  for (let i = 0; i < 600_000; i++) {
    const dayOk = anyDom && anyDow ? true : anyDom ? dow.has(d.getDay()) : anyDow ? dom.has(d.getDate()) : dom.has(d.getDate()) || dow.has(d.getDay())
    if (!mon.has(d.getMonth() + 1) || !dayOk) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (min.has(d.getMinutes())) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

/** A job's name: the start of its prompt, up to its first sentence. */
export function jobName(prompt: string): string {
  const first = prompt.trim().split('\n')[0]
  const cut = first.search(/\.\s|\s\(/)
  const name = cut > 8 ? first.slice(0, cut) : first
  return name.length > 70 ? `${name.slice(0, 69)}…` : name || 'scheduled job'
}

/** Claude Code's wording unless it is just the cron; then plain words for the common shapes. */
export function readable(said: string, cron: string): string {
  if (said && said !== cron) return said
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return cron
  const rest = f.slice(1).join(' ')
  const every = /^(?:\*|(\d+)-59)\/(\d+)$/.exec(f[0])
  if (every && rest === '* * * *') {
    const n = Number(every[2])
    const from = every[1] ? ` from :${every[1].padStart(2, '0')}` : ''
    return n === 1 ? 'Every minute' : `Every ${n} minutes${from}`
  }
  if (f[0] === '*' && rest === '* * * *') return 'Every minute'
  if (/^\d+$/.test(f[0]) && rest === '* * * *') return `Every hour at :${f[0].padStart(2, '0')}`
  if (/^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && f.slice(2).join(' ') === '* * *')
    return `Every day at ${f[1].padStart(2, '0')}:${f[0].padStart(2, '0')}`
  return cron
}

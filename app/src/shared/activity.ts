/**
 * Background work a session is still waiting on, read from its transcript: Monitors, background
 * shell commands and agents it started, and a wakeup it scheduled. Each is pending from its launch
 * until a `<task-notification>` reports it finished (or expired), a TaskStop stops it, or its time
 * runs out. A session that is idle with any of these is waiting on them, not on the user.
 */

export interface PendingTask {
  /** The tool_use id that started it. */
  id: string
  kind: 'monitor' | 'shell' | 'agent' | 'wakeup'
  label: string
  startedAt: number
  /** When it ends by itself (Monitor timeout, wakeup time); null: when it reports back. */
  expiresAt: number | null
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Monitors default to (and are capped at) 30 minutes unless persistent. */
const MONITOR_MS = 30 * 60 * 1000
/** Shells and agents that never report back stop counting after this long. */
const STALE_MS = 6 * 60 * 60 * 1000
/** A wakeup counts a little past its time, while the session starts its next turn. */
const WAKE_GRACE_MS = 2 * 60 * 1000

const TAG = (name: string, text: string): string | null => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null

function launched(name: string, input: Obj, id: string, at: number): PendingTask | null {
  const label = (s: string, fallback: string) => (s.trim() || fallback).replace(/\s+/g, ' ').slice(0, 120)
  if (name === 'Monitor') {
    const ms = typeof input.timeout_ms === 'number' ? Math.min(input.timeout_ms, MONITOR_MS) : MONITOR_MS
    return { id, kind: 'monitor', label: label(str(input.description), 'a monitor'), startedAt: at, expiresAt: input.persistent === true ? null : at + ms }
  }
  if (name === 'Bash' && input.run_in_background === true) return { id, kind: 'shell', label: label(str(input.description), str(input.command)), startedAt: at, expiresAt: null }
  if ((name === 'Agent' || name === 'Task') && input.run_in_background === true)
    return { id, kind: 'agent', label: label(str(input.description), 'a background agent'), startedAt: at, expiresAt: null }
  if (name === 'ScheduleWakeup' && input.stop !== true && typeof input.delaySeconds === 'number')
    return { id, kind: 'wakeup', label: label(str(input.reason), 'a scheduled wakeup'), startedAt: at, expiresAt: at + input.delaySeconds * 1000 + WAKE_GRACE_MS }
  return null
}

/** Background work started in these transcript lines (oldest first) and not finished by `now`. */
export function pendingTasks(lines: string[], now: number): PendingTask[] {
  return stillPending(openTasks(lines), now)
}

/** Of these, the ones whose time has not run out by `now`. */
export function stillPending(tasks: PendingTask[], now: number): PendingTask[] {
  return tasks.filter((t) => (t.expiresAt !== null ? t.expiresAt > now : now - t.startedAt < STALE_MS))
}

/** Background work started in these lines that has not reported back or been stopped (time aside). */
export function openTasks(lines: string[]): PendingTask[] {
  const open = new Map<string, PendingTask>()
  // Background task ids (from tool results and notifications) → the tool_use that started them.
  const byTask = new Map<string, string>()
  const end = (taskId: string | null, toolUseId: string | null) => {
    const id = toolUseId ?? (taskId ? byTask.get(taskId) : undefined)
    if (id) open.delete(id)
  }
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
      if (d.type === 'assistant' && b.type === 'tool_use') {
        const input = obj(b.input)
        const name = str(b.name)
        if (name === 'TaskStop' || name === 'KillShell') {
          end(str(input.task_id) || str(input.shell_id) || null, null)
          continue
        }
        // A new wakeup replaces the last one; `stop` cancels it.
        if (name === 'ScheduleWakeup') {
          for (const [k, t] of open) if (t.kind === 'wakeup') open.delete(k)
        }
        const t = launched(name, input, str(b.id), at)
        if (t) open.set(t.id, t)
      } else if (d.type === 'user' && b.type === 'tool_result') {
        const id = str(b.tool_use_id)
        if (!open.has(id)) continue
        if (b.is_error === true) {
          open.delete(id)
          continue
        }
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => str(obj(c).text)).join('\n') : ''
        const task = /\btask[ :]+([A-Za-z0-9_-]{5,})/i.exec(text)?.[1] ?? /\bID:\s*([A-Za-z0-9_-]{5,})/.exec(text)?.[1] ?? /agentId:\s*([A-Za-z0-9_-]{5,})/.exec(text)?.[1]
        if (task) byTask.set(task, id)
      } else if (d.type === 'user' && b.type === 'text') {
        const text = str(b.text)
        if (!text.includes('<task-notification>')) continue
        for (const n of text.split('</task-notification>')) {
          if (!n.includes('<task-notification>')) continue
          const taskId = TAG('task-id', n)
          const toolUseId = TAG('tool-use-id', n)
          if (taskId && toolUseId) byTask.set(taskId, toolUseId)
          const event = TAG('event', n) ?? ''
          if (TAG('status', n) || /^\[Monitor (expired|stopped|ended)/.test(event)) end(taskId, toolUseId)
        }
      }
    }
  }
  return [...open.values()]
}

/** "a monitor: review comments on #617" style text for a few pending tasks. */
export function describePending(tasks: PendingTask[]): string {
  const kind = { monitor: 'monitor', shell: 'background command', agent: 'background agent', wakeup: 'scheduled wakeup' }
  return tasks
    .slice(-3)
    .map((t) => `${kind[t.kind]}: ${t.label}`)
    .join(' · ')
}

/** Whether what the session last said asks the user something (a question mark near the end, or options). */
export function asksQuestion(said: { text: string; options: unknown[] } | null): string | null {
  if (!said) return null
  if (said.options.length) return said.text
  const paras = said.text.trim().split(/\n\s*\n/)
  const last = paras.slice(-2).join('\n')
  // A question the user is asked: a "?" ending a sentence (not in code or a URL).
  const plain = last.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '')
  return /\?(\s|\*|$)/.test(plain) ? said.text : null
}

/**
 * Whether the session's last turn has ended: its latest message is Claude's, with no tool call
 * still to answer. `claude agents` keeps a session with a live Monitor "busy" between events.
 */
export function turnEnded(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"message"')) continue
    let d: Obj
    try {
      d = obj(JSON.parse(lines[i]))
    } catch {
      continue
    }
    if (d.isSidechain === true || (d.type !== 'user' && d.type !== 'assistant')) continue
    if (d.type === 'user') return false
    const c = obj(d.message).content
    return !(Array.isArray(c) && c.some((b) => obj(b).type === 'tool_use'))
  }
  return false
}

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { QueueEdit } from '@shared/ipc'
import type { CliResult } from '@shared/types'

/**
 * A session's `/queue`: ~/.claude/queue/<session id>.jsonl (MASTERDECK_QUEUE_DIR moves it), one
 * JSON string per prompt. MasterDeck's hook (main/deckHooks.ts) appends `/queue <prompt>`; at the
 * end of a turn the next one is handed to the session by the hook (MasterDeck not running) or by
 * MasterDeck through the hook. The queue skill's own hooks, when installed by hand, use the same
 * file. The app edits it too: writes go to a temp file and are renamed in, and an empty queue has
 * no file, as the hooks leave it.
 */

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function queueDir(): string {
  return process.env.MASTERDECK_QUEUE_DIR || join(homedir(), '.claude', 'queue')
}

/** What the Stop hook prints to run the next queued prompt (the queue skill's exact answer). */
export function queueAnswer(prompt: string, left: number): object {
  return {
    decision: 'block',
    reason: `Next queued user prompt (${left} more after this). Treat it as a new user request and handle it fully:\n\n${prompt}`,
    systemMessage: `▶ queue: ${prompt}`,
  }
}

function file(dir: string, sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? join(dir, `${sessionId}.jsonl`) : null
}

export function readQueue(sessionId: string, dir = queueDir()): string[] {
  const f = file(dir, sessionId)
  if (!f || !existsSync(f)) return []
  const out: string[] = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      out.push(typeof v === 'string' ? v : line)
    } catch {
      out.push(line) // a hand-edited line: show it as is
    }
  }
  return out
}

function writeQueue(f: string, items: string[]): void {
  if (!items.length) return rmSync(f, { force: true })
  const tmp = `${f}.masterdeck-tmp`
  writeFileSync(tmp, items.map((p) => JSON.stringify(p)).join('\n') + '\n')
  renameSync(tmp, f)
}

/** An edit as it comes over IPC: checked before it touches the file. */
export function isQueueEdit(e: unknown): e is QueueEdit {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  const at = Number.isInteger(x.index) && (x.index as number) >= 0 && typeof x.text === 'string'
  if (x.op === 'add') return typeof x.text === 'string'
  if (x.op === 'remove') return at
  if (x.op === 'move') return at && Number.isInteger(x.to)
  return x.op === 'clear'
}

/**
 * Change a session's queue. Remove and move name the item by index and text, so an item the Stop
 * hook sent meanwhile (which shifts the rest) is not mistaken for another.
 */
export function editQueue(sessionId: string, edit: QueueEdit, dir = queueDir()): CliResult & { items: string[] } {
  const f = file(dir, sessionId)
  if (!f) return { ok: false, message: 'bad session id', items: [] }
  const items = readQueue(sessionId, dir)
  const stale = (i: number, text: string) => items[i] !== text
  switch (edit.op) {
    case 'add': {
      const text = edit.text.trim()
      if (!text) return { ok: false, message: 'empty prompt', items }
      items.push(text)
      break
    }
    case 'remove':
      if (stale(edit.index, edit.text)) return { ok: false, message: 'the queue changed; it was probably just sent', items }
      items.splice(edit.index, 1)
      break
    case 'move': {
      if (stale(edit.index, edit.text)) return { ok: false, message: 'the queue changed; try again', items }
      const to = Math.max(0, Math.min(items.length - 1, edit.to))
      items.splice(to, 0, ...items.splice(edit.index, 1))
      break
    }
    case 'clear':
      items.length = 0
      break
  }
  mkdirSync(dir, { recursive: true })
  writeQueue(f, items)
  return { ok: true, message: 'ok', items }
}

/** Take the first prompt off the queue (to send it now); null when empty. */
export function shiftQueue(sessionId: string, dir = queueDir()): string | null {
  const f = file(dir, sessionId)
  if (!f) return null
  const items = readQueue(sessionId, dir)
  const next = items.shift()
  if (next === undefined) return null
  writeQueue(f, items)
  return next
}

/** Put a prompt back at the front (a send that failed). */
export function unshiftQueue(sessionId: string, text: string, dir = queueDir()): void {
  const f = file(dir, sessionId)
  if (!f) return
  mkdirSync(dir, { recursive: true })
  writeQueue(f, [text, ...readQueue(sessionId, dir)])
}

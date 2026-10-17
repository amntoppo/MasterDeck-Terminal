/**
 * Clone a session (#136): a new background session from a copy of another's conversation
 * (`claude --bg --resume <id> --fork-session`). "Clone" is the word the UI uses; "fork" is only the
 * CLI's. The original is never superseded. Pure, for main, the renderer and the tests.
 */
import { remoteTextAllowed } from './remoteGuard'
import { isPermissionMode } from './startOptions'
import type { Session } from './types'
import type { Ticket } from './ticket'

/** The resume name rule plus parentheses: `-n` is one argv element, never a shell word. */
export const CLONE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/
const MAX_NAME = 100
export const MAX_FIRST_MESSAGE = 20_000

export function cloneNameError(name: string): string | null {
  if (!name) return 'Give the clone a name.'
  return CLONE_NAME.test(name) ? null : 'Name: letters, digits, spaces, . _ - ( ), starting with a letter or digit (up to 100).'
}

/** `<name> (clone)`, then `(clone 2)`, … past the names in `taken`; a clone of a clone counts on. */
export function cloneName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let base = name
    .replace(/ \(clone(?: \d+)?\)$/, '')
    .replace(/[^A-Za-z0-9 ._()-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim()
  if (!base) base = 'session'
  for (let n = 1; ; n++) {
    const tag = n === 1 ? ' (clone)' : ` (clone ${n})`
    const out = `${base.slice(0, MAX_NAME - tag.length).trimEnd()}${tag}`
    if (!used.has(out)) return out
  }
}

/** Why Clone is refused for this session, or null. `menuShown`: a question or permission menu is on screen for it. */
export function cloneBlock(s: Pick<Session, 'sessionId' | 'state' | 'noConversation'>, menuShown = false): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(s.sessionId) || s.noConversation) return 'It has no conversation yet.'
  if (s.state === 'needs-input' || menuShown) return 'It is waiting for your answer: answer it first, so the clone does not copy a half-finished question.'
  return null
}

/** A `--model` value as Claude Code writes it in a transcript; never `<synthetic>`. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9.\-_[\]]{0,80}$/
const modelOk = (m: unknown): m is string => typeof m === 'string' && MODEL.test(m)

/**
 * The model and permission mode to carry to the clone (#33's rule: only what can be validated), from
 * the end of the original's transcript. The model: the newest assistant record's `requestedModel`
 * (it keeps `[1m]`), else its `message.model`. The mode: the newest `permission-mode` record, only a
 * mode the Start dialog offers (`default` passes nothing; `bypassPermissions` is never carried).
 */
export function cloneOptions(text: string, fromStart: boolean): { model: string | null; permissionMode: string | null } {
  const lines = text.split('\n')
  if (!fromStart) lines.shift()
  let model: string | null = null
  let permissionMode: string | null = null
  let modeSeen = false
  for (let i = lines.length - 1; i >= 0 && (model === null || !modeSeen); i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!o || typeof o !== 'object') continue
    if (!modeSeen && o.type === 'permission-mode') {
      modeSeen = true
      const m = o.permissionMode
      permissionMode = typeof m === 'string' && m && isPermissionMode(m) ? m : null
    }
    if (model === null && o.type === 'assistant' && o.isSidechain !== true) {
      const msg = (o.message ?? {}) as Record<string, unknown>
      if (modelOk(o.requestedModel)) model = o.requestedModel
      else if (modelOk(msg.model)) model = msg.model
    }
  }
  return { model, permissionMode }
}

/** The first message, trimmed; a browser's must pass the wire's noEscape rule. */
export function checkFirstMessage(raw: unknown, remote: boolean): { ok: true; text: string } | { ok: false; message: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length > MAX_FIRST_MESSAGE) return { ok: false, message: `The first message is too long (over ${MAX_FIRST_MESSAGE} characters).` }
  // It goes as claude's last argument: a leading "-" would read as a flag.
  if (text.startsWith('-')) return { ok: false, message: "The first message can't start with -." }
  if (text && remote && !remoteTextAllowed(text)) return { ok: false, message: 'From a browser the first message may not start with / or ! or hold control characters.' }
  return { ok: true, text }
}

export function cloneArgs(o: { sessionId: string; name: string; settings: string[]; model: string | null; permissionMode: string | null; prompt: string }): string[] {
  return [
    '--bg',
    ...o.settings,
    '--resume',
    o.sessionId,
    '--fork-session',
    '-n',
    o.name,
    ...(o.model ? ['--model', o.model] : []),
    ...(o.permissionMode ? ['--permission-mode', o.permissionMode] : []),
    ...(o.prompt ? [o.prompt] : []),
  ]
}

/** `session-clones.json`, per clone's background id. */
export interface CloneRecord {
  from: { key: string; name: string }
  /** When the clone was started (ms): copied transcript lines are older. */
  at: number
  /** The folder's branch when it was cloned; null: detached or not known. */
  branch: string | null
  /** Keep ticket link: the ticket to link the clone to once it is listed. */
  ticket?: Ticket
  linked?: boolean
}

const BG = /^[0-9a-f]{8}$/

function parseRecord(v: unknown): CloneRecord | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const from = (o.from ?? {}) as Record<string, unknown>
  if (typeof from.key !== 'string' || !from.key || typeof from.name !== 'string' || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null
  const t = o.ticket as Record<string, unknown> | undefined
  const ticket =
    t && typeof t === 'object' && typeof t.number === 'number' && Number.isInteger(t.number) && t.number > 0
      ? { repo: typeof t.repo === 'string' && t.repo ? t.repo : null, number: t.number }
      : undefined
  return {
    from: { key: from.key, name: from.name },
    at: o.at,
    branch: typeof o.branch === 'string' && o.branch ? o.branch : null,
    ...(ticket ? { ticket } : {}),
    ...(o.linked === true ? { linked: true } : {}),
  }
}

export function parseClones(raw: unknown): Record<string, CloneRecord> {
  const out: Record<string, CloneRecord> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    const r = BG.test(k) ? parseRecord(v) : null
    if (r) out[k] = r
  }
  return out
}

/**
 * Does a clone's transcript line count as its own? The copied lines keep the original's timestamps,
 * so a line from before the clone was started belongs to the original (its PRs, worktrees, workflow
 * steps). A line without a timestamp is kept (titles and modes: nothing the scanners take).
 */
export function clonedLine(line: string, at: number): boolean {
  const m = /"timestamp":"([^"]+)"/.exec(line)
  if (!m) return true
  const t = Date.parse(m[1])
  return !Number.isFinite(t) || t >= at
}

/** A clone shares its original's folder: its branch (and that branch's PR) is the clone's only once it moved off the branch it was cloned on. */
export function cloneOwnsBranch(rec: Pick<CloneRecord, 'branch'>, branch: string | null | undefined): boolean {
  return branch !== undefined && branch !== rec.branch
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Session } from '@shared/types'
import type { Runner } from './run'

const LOGIN = /^[A-Za-z0-9-]{1,39}$/
/** ponytail: one entry per session id and key, the oldest dropped past this; a file per session if it ever matters. */
const KEEP = 2000
const PENDING_MS = 10 * 60_000

/**
 * The GitHub account each session was started as (`session-accounts.json`: { [sessionId or key]:
 * login }). Session ids change on resume, the key (background id) does not, so both are kept.
 */
export class SessionAccounts {
  private ids = new Map<string, string>()
  private pending = new Map<string, { login: string; at: number }>()

  constructor(private file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw))
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && LOGIN.test(v)) this.ids.set(k, v)
    } catch {
      // none yet, or unreadable: sessions fall back to their repo's account
    }
  }

  get(s: Pick<Session, 'sessionId' | 'key'>): string | null {
    return this.ids.get(s.sessionId) ?? this.ids.get(s.key) ?? null
  }

  set(ids: string[], login: string): void {
    for (const id of ids)
      if (id) {
        this.ids.delete(id)
        this.ids.set(id, login)
      }
    for (const k of [...this.ids.keys()].slice(0, Math.max(0, this.ids.size - KEEP))) this.ids.delete(k)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.ids)))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`session accounts: ${String(e)}`)
    }
  }

  /** A session started by name (`claude --bg -n`): recorded with its ids once it shows up. */
  expect(name: string, login: string, now = Date.now()): void {
    this.pending.set(name, { login, at: now })
  }

  claim(sessions: Pick<Session, 'sessionId' | 'key' | 'name' | 'state'>[], now = Date.now()): void {
    for (const [name, p] of this.pending) {
      const s = sessions.find((x) => x.name === name && x.state !== 'done')
      if (s) {
        this.pending.delete(name)
        this.set([s.sessionId, s.key], p.login)
      } else if (now - p.at > PENDING_MS) this.pending.delete(name)
    }
    // A live session known by one id only (claude attach resumed it under a new session id, or
    // the bg key wasn't known at start): record the other one too.
    for (const x of sessions) {
      if (x.state === 'done') continue
      const a = this.ids.get(x.sessionId)
      const b = this.ids.get(x.key)
      if ((a ?? b) && !(a && b)) this.set([x.sessionId, x.key], (a ?? b)!)
    }
  }
}

/**
 * The new session's bg id from `claude --bg` stdout: `backgrounded · <id>`, else `claude attach <id>`;
 * null otherwise. Never the first hex token: a resume with flags starts a copy under a new id and
 * its note names the old one first.
 */
export function bgIdFromOutput(out: string): string | null {
  const t = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  return (
    /^\s*backgrounded\s*·\s*([0-9a-f]{8})\b/im.exec(t)?.[1] ?? /^\s*claude attach ([0-9a-f]{8})\b/im.exec(t)?.[1] ?? null
  )
}

type SettingsArgs = { ok: true; args: string[]; account: string | null } | { ok: false; message: string }

/**
 * `--settings` for a session as `account` (or `fallback()`'s). One account (`multi` false): no
 * arguments, as before. Two or more: never a start without `--settings` (it would run as gh's
 * active account), e.g. while the accounts' files are still being written after Setup saved.
 */
export async function sessionSettings(
  multi: boolean,
  settingsArgs: (login: string | null) => SettingsArgs,
  account: string | null | undefined,
  fallback: () => Promise<string | null>,
): Promise<SettingsArgs> {
  if (!multi) return { ok: true, args: [], account: null }
  const r = settingsArgs(account || (await fallback()))
  return r.ok && !r.args.length ? { ok: false, message: 'GitHub accounts are still loading; try again in a few seconds' } : r
}

/** A resume that started a copy (`note: background session <old> keeps its own saved options … started a copy as <copy>`); null: it woke the session itself, or started a new one. */
export function copyFromOutput(out: string): { old: string; copy: string } | null {
  const t = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const m = /background session ([0-9a-f]{8}) keeps its own saved options[^\n]*?started a copy as ([0-9a-f]{8})\b/i.exec(t)
  return m ? { old: m[1], copy: m[2] } : null
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/
type Row = Pick<Session, 'sessionId' | 'key' | 'bgId' | 'name' | 'state' | 'pid' | 'kind'>

/**
 * Resume a session in the background (resumeBg, Start here, the restorer).
 *
 * `claude --bg --resume <id>` with no other flag wakes the background session itself (same ids,
 * its saved options: name, model, `--settings`). ANY flag (`-n`, `--settings`, `--model` …) starts
 * a copy under new ids and leaves the old session listed: two sessions of one name. So:
 * - a listed background session resumes bare, unless something must change: another account than
 *   the one it was started as (recorded in session-accounts.json; a session with no record was
 *   started without `--settings` and would run as gh's active account), or a new name. Then a copy
 *   is meant: refused while the session runs; else started with the flags, recorded under its own
 *   bg id, and the old session removed (`claude rm`), only when the output names it as the copied one.
 * - a session that is not a listed background session (History, an interactive one for Start
 *   here) has no saved options and nothing to copy: `--settings` and `-n` as a new start.
 * - the list not known yet: bare with one account; refused with two or more.
 */
export async function resumeAs(
  d: {
    run: Runner
    claude: string
    accounts: SessionAccounts
    /** `--settings` for `account`, else for `fallback()`'s (settingsFor in index.ts). */
    settings: (account: string | null, fallback: () => Promise<string | null>) => Promise<SettingsArgs>
    /** The account of a session when none is given (accountOfSession with its folder's origin). */
    accountOf: (s: { sessionId: string; key: string; name: string }) => Promise<string | null>
    /** The session list; null: not loaded yet. */
    live: () => Row[] | null
    /** `claude rm <bg id>` (Ops.removeSession). */
    remove: (bgId: string) => Promise<{ ok: boolean; message: string }>
  },
  o: { id: string; key: string | null; name: string; cwd: string; account: string | null; rename?: string | null },
): Promise<{ ok: true; stdout: string; copy: { old: string; copy: string } | null } | { ok: false; message: string }> {
  const key = o.key || o.id.slice(0, 8)
  const as = await d.settings(o.account, () => d.accountOf({ sessionId: o.id, key, name: o.name }))
  if (!as.ok) return as
  const rows = d.live()
  const bg = rows?.find((x) => x.kind === 'background' && (x.sessionId === o.id || (!!o.key && (x.key === o.key || x.bgId === o.key)))) ?? null
  const newName = o.rename && o.rename !== o.name ? o.rename : null
  const name = newName ?? o.name
  const named = SAFE_NAME.test(name) ? ['-n', name] : []
  const recorded = d.accounts.get({ sessionId: o.id, key })
  let args: string[]
  let record = false
  let old: Row | null = null
  if (!rows) {
    // Flags could start a copy that nobody removes; no flags could run as gh's active account.
    if (as.account || newName) return { ok: false, message: 'the session list is not loaded yet; try again in a few seconds' }
    args = ['--resume', o.id]
  } else if (bg) {
    const change = !!newName || (as.account !== null && recorded?.toLowerCase() !== as.account.toLowerCase())
    if (change && bg.pid !== null && bg.state !== 'done')
      return { ok: false, message: `${o.name} is running; stop it first (changing its ${newName ? 'name' : 'account'} starts a copy and removes this session)` }
    args = change ? [...as.args, '--resume', o.id, ...named] : ['--resume', o.id]
    record = change
    old = change ? bg : null
  } else {
    args = [...as.args, '--resume', o.id, ...named]
    record = true
  }
  return finish(await d.run(d.claude, ['--bg', ...args], { cwd: o.cwd, timeoutMs: 60_000 }))

  async function finish(
    r: Awaited<ReturnType<Runner>>,
  ): Promise<{ ok: true; stdout: string; copy: { old: string; copy: string } | null } | { ok: false; message: string }> {
    if (r.code !== 0) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) }
    const id = bgIdFromOutput(r.stdout)
    const copy = copyFromOutput(r.stdout)
    if (as.ok && as.account && record) {
      // A copy has its own ids; anything else keeps the ones it was resumed by.
      d.accounts.set(copy ? [id ?? copy.copy] : [o.id, o.key ?? '', id ?? ''], as.account)
      if (!id && !copy && !(d.live() ?? []).some((x) => x.name === name && x.state !== 'done')) d.accounts.expect(name, as.account)
    }
    // The old session stays listed beside its copy: take it out, but only the one the output named.
    if (copy && old && old.bgId === copy.old && copy.copy !== copy.old) {
      const x = await d.remove(copy.old)
      if (!x.ok) console.error(`resume: the copied session ${copy.old} was not removed: ${x.message}`)
    }
    return { ok: true, stdout: r.stdout, copy }
  }
}

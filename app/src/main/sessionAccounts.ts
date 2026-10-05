import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Session } from '@shared/types'
import type { Runner } from './run'

const LOGIN = /^[A-Za-z0-9-]{1,39}$/
/** ponytail: one entry per session id and key, the oldest dropped past this; a file per session if it ever matters. */
const KEEP = 2000
const PENDING_MS = 10 * 60_000

/** Recorded for a session known to run without `--settings` (as gh's active account). Not a login: `master` skips it. */
const GH_ACTIVE = '*gh-active*'

/**
 * The GitHub account each session was started as (`session-accounts.json`: { [sessionId or key]:
 * login }). Session ids change on resume, the key (background id) does not, so both are kept.
 * `master spawn` adds the copies it starts to the same file: it is read again when it changed, and
 * a write keeps the entries it does not know.
 */
const stamp = (file: string): string => {
  const st = statSync(file)
  return `${st.mtimeMs}:${st.size}`
}

export class SessionAccounts {
  private ids = new Map<string, string>()
  private pending = new Map<string, { login: string; at: number }>()
  /** The file as last read or written: mtime and size (two writes can share a timestamp, on Windows above all). */
  private mtime = ''

  constructor(private file: string) {
    this.sync()
  }

  /** Take in what the file holds that this run does not (ids written by `master spawn`). */
  private sync(): void {
    let m: string
    try {
      m = stamp(this.file)
    } catch {
      return // none yet
    }
    if (m === this.mtime) return
    this.mtime = m
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw))
        for (const [k, v] of Object.entries(raw))
          if (typeof v === 'string' && (LOGIN.test(v) || v === GH_ACTIVE) && !this.ids.has(k)) this.ids.set(k, v)
    } catch {
      // unreadable: sessions fall back to their repo's account
    }
  }

  private raw(s: Pick<Session, 'sessionId' | 'key'>): string | null {
    return this.ids.get(s.sessionId) ?? this.ids.get(s.key) ?? null
  }

  get(s: Pick<Session, 'sessionId' | 'key'>): string | null {
    const v = this.raw(s)
    return v === GH_ACTIVE ? null : v
  }

  /** Woken without `--settings` with two or more accounts: it works as gh's active account, whatever was recorded or guessed. */
  ghActive(s: Pick<Session, 'sessionId' | 'key'>): boolean {
    return this.raw(s) === GH_ACTIVE
  }

  markGhActive(ids: string[]): void {
    this.set(ids, GH_ACTIVE)
  }

  set(ids: string[], login: string): void {
    this.sync()
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
      this.mtime = stamp(this.file)
    } catch (e) {
      console.error(`session accounts: ${String(e)}`)
    }
  }

  /** A session started by name (`claude --bg -n`): recorded with its ids once it shows up. */
  expect(name: string, login: string, now = Date.now()): void {
    this.pending.set(name, { login, at: now })
  }

  claim(sessions: Pick<Session, 'sessionId' | 'key' | 'name' | 'state'>[], now = Date.now()): void {
    this.sync()
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

/**
 * A bare resume's note (`note: woke session <id> with its saved options (-n, --settings, …).`): the
 * options it was started with; null: no such note. `complete` only when the whole list was read (its
 * closing parenthesis is there and nothing was elided): an option missing from a cut list proves nothing.
 */
export function wokeFromOutput(out: string): { id: string; options: string[]; complete: boolean } | null {
  const t = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const m = /woke session ([0-9a-f]{8}) with its saved options \(([^)\n]*)(\)?)/i.exec(t)
  if (!m) return null
  const options = m[2].split(',').map((x) => x.trim()).filter(Boolean)
  return { id: m[1], options, complete: m[3] === ')' && !/…|\.\.\./.test(m[2]) && options.every((x) => /^--?[a-z][a-z-]*$/.test(x)) }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/
type Row = Pick<Session, 'sessionId' | 'key' | 'bgId' | 'name' | 'state' | 'pid' | 'kind'>
type Resumed = { ok: true; stdout: string; copy: { old: string; copy: string } | null } | { ok: false; message: string }

/**
 * Resume a session in the background (resumeBg, Start here, the restorer).
 *
 * `claude --bg --resume <id>` with no other flag wakes the background session itself (same ids,
 * its saved options: name, model, `--settings`). ANY flag (`-n`, `--settings`, `--model` …) starts
 * a copy under new ids and leaves the old session listed: two sessions of one name. So:
 * - a listed background session resumes bare, with one account or several, recorded or not; the
 *   account is not even resolved. With two or more accounts the note says whether it was started
 *   with `--settings`: if not, it works as gh's active account, and is marked so (markGhActive;
 *   a record from an earlier build goes).
 * - a copy only when the user chose one: an account given that is not the recorded one, or a new
 *   name. Refused while the old session has a process, by a fresh read of the list. The copy is
 *   recorded under its own bg id; the old session is left as it is (MasterDeck never removes a
 *   session) and listed as superseded, so it is hidden while it does not run.
 * - not a listed background session (History, an interactive one for Start here): no saved
 *   options and nothing to copy, so `--settings` and `-n` as for a new start.
 * - the list unknown, also after one more read: bare with one account; refused with two or more
 *   (and for a rename).
 */
export async function resumeAs(
  d: {
    run: Runner
    claude: string
    accounts: SessionAccounts
    /** Two or more GitHub accounts. */
    multi: () => boolean
    /** `--settings` for `account`, else for `fallback()`'s (settingsFor in index.ts). */
    settings: (account: string | null, fallback: () => Promise<string | null>) => Promise<SettingsArgs>
    /** The account of a session when none is given (accountOfSession with its folder's origin). */
    accountOf: (s: { sessionId: string; key: string; name: string }) => Promise<string | null>
    /** The session list of the last `claude agents` read; null: none succeeded. */
    live: () => Row[] | null
    /** Read `claude agents` now. */
    refresh: () => Promise<void>
    /** A copy was started: the old side (hidden from the list while it does not run) and the copy's bg id (it inherits the ticket link and PRs). */
    copied: (old: { bgId: string; sessionId: string }, copy: string) => void
  },
  o: { id: string; key: string | null; name: string; cwd: string; account: string | null; rename?: string | null },
): Promise<Resumed> {
  const key = o.key || o.id.slice(0, 8)
  const find = (rows: Row[]) => rows.find((x) => x.kind === 'background' && (x.sessionId === o.id || (!!o.key && (x.key === o.key || x.bgId === o.key)))) ?? null
  const start = (args: string[]) => d.run(d.claude, ['--bg', ...args], { cwd: o.cwd, timeoutMs: 60_000 })
  const failed = (r: { stdout: string; stderr: string }): Resumed => ({ ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) })
  const account = () => d.settings(o.account, () => d.accountOf({ sessionId: o.id, key, name: o.name }))
  const NOT_LOADED: Resumed = { ok: false, message: 'the session list is not loaded yet; try again in a few seconds' }

  let rows = d.live()
  if (!rows) {
    await d.refresh()
    rows = d.live()
  }
  const newName = o.rename && o.rename !== o.name ? o.rename : null
  if (!rows) {
    // Two or more accounts: a flag could start a copy, none could run a past session as gh's
    // active account. One account: bare, which never copies.
    if (d.multi() || newName) return NOT_LOADED
    const r = await start(['--resume', o.id])
    return r.code !== 0 ? failed(r) : { ok: true, stdout: r.stdout, copy: null }
  }
  const bg = find(rows)
  const name = newName ?? o.name
  const named = SAFE_NAME.test(name) ? ['-n', name] : []

  if (bg) {
    const recorded = d.accounts.get({ sessionId: o.id, key })
    const chosen = !!newName || (d.multi() && !!o.account && o.account.toLowerCase() !== (recorded ?? '').toLowerCase())
    if (!chosen) {
      const r = await start(['--resume', o.id])
      if (r.code !== 0) return failed(r)
      const woke = wokeFromOutput(r.stdout)
      // Started without --settings: it works as gh's active account, whatever was recorded.
      if (d.multi() && woke?.complete && !woke.options.includes('--settings')) d.accounts.markGhActive([o.id, key, woke.id])
      return { ok: true, stdout: r.stdout, copy: null }
    }
    const as = await account()
    if (!as.ok) return as
    // A copy beside a running session would be two live sessions of one conversation.
    await d.refresh()
    const fresh = d.live()
    if (!fresh) return NOT_LOADED
    if ((find(fresh) ?? bg).pid !== null)
      return { ok: false, message: `${o.name} is running; stop it first (changing its ${newName ? 'name' : 'account'} starts a copy of it)` }
    const r = await start([...as.args, '--resume', o.id, ...named])
    if (r.code !== 0) return failed(r)
    const id = bgIdFromOutput(r.stdout)
    const copy = copyFromOutput(r.stdout)
    if (as.account) d.accounts.set(copy ? [id ?? copy.copy] : [o.id, key, id ?? ''], as.account)
    // Only the session the output names as copied: it stays (stopped), out of the list.
    if (copy && copy.old === bg.bgId && copy.copy !== copy.old) d.copied({ bgId: copy.old, sessionId: bg.sessionId }, copy.copy)
    return { ok: true, stdout: r.stdout, copy }
  }

  const as = await account()
  if (!as.ok) return as
  const r = await start([...as.args, '--resume', o.id, ...named])
  if (r.code !== 0) return failed(r)
  if (as.account) {
    const id = bgIdFromOutput(r.stdout)
    d.accounts.set([o.id, o.key ?? '', id ?? ''], as.account)
    if (!id && !(d.live() ?? []).some((x) => x.name === name && x.state !== 'done')) d.accounts.expect(name, as.account)
  }
  return { ok: true, stdout: r.stdout, copy: copyFromOutput(r.stdout) }
}

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

/**
 * `claude --bg [--settings <account>] --resume <id> [-n name]` (resumeBg, Start here). A resume gets
 * a new session id and bg id: the account is recorded under the old ids and the bg id it prints
 * (claim then adds the new session id). Nothing printed: by name, unless another live session has it.
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
    live: () => Pick<Session, 'name' | 'state'>[]
  },
  o: { id: string; key: string | null; name: string; named: string[]; cwd: string; account: string | null },
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  const as = await d.settings(o.account, () => d.accountOf({ sessionId: o.id, key: o.key || o.id.slice(0, 8), name: o.name }))
  if (!as.ok) return as
  const r = await d.run(d.claude, ['--bg', ...as.args, '--resume', o.id, ...o.named], { cwd: o.cwd, timeoutMs: 60_000 })
  if (r.code !== 0) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) }
  if (as.account) {
    const bg = bgIdFromOutput(r.stdout)
    d.accounts.set([o.id, o.key ?? '', bg ?? ''], as.account)
    if (!bg && !d.live().some((x) => x.name === o.name && x.state !== 'done')) d.accounts.expect(o.name, as.account)
  }
  return { ok: true, stdout: r.stdout }
}

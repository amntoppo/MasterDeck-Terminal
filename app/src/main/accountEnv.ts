import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { AccountConfig } from '@shared/appConfig'
import { accountEnvBlock, githubSshAliases, isMulti, parseGhUser, primaryLogin, type GhAccountStatus } from '@shared/accounts'
import type { Session } from '@shared/types'
import type { Runner } from './run'

/** What MasterDeck's own gh call for an account gets: its token (none with one account), or why it can't run. */
export type AccountRunEnv = { env: Record<string, string> } | { error: string }

const TOKEN = /^\S{20,}$/
const LOGIN = /^[A-Za-z0-9-]{1,39}$/
const low = (s: string) => s.toLowerCase()

/**
 * An ssh config with the files it Includes appended (best effort: `~`, paths relative to the
 * config's folder, `*` in the last part, 5 levels). Each included file starts outside any Host.
 */
export function readSshConfig(path: string, base = dirname(path), depth = 0): string {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  if (depth >= 5) return text
  const parts = [text]
  for (const m of text.matchAll(/^\s*include\s*(?:=\s*|\s+)(.+?)\s*$/gim))
    for (const pat of m[1].split(/\s+/)) {
      const p = pat.replace(/^~(?=\/|$)/, homedir())
      const full = isAbsolute(p) ? p : join(base, p)
      const name = basename(full)
      let files = [full]
      if (name.includes('*')) {
        const esc = name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
        try {
          files = readdirSync(dirname(full)).filter((f) => new RegExp(`^${esc}$`).test(f)).sort().map((f) => join(dirname(full), f))
        } catch {
          files = []
        }
      }
      for (const f of files) parts.push(`Match all\n${readSshConfig(f, base, depth + 1)}`)
    }
  return parts.join('\n')
}

/**
 * The first `git config --get-regexp '^url\..*\.(push)?insteadof$'` line that sends
 * https://github.com… to an SSH form; null if none. Such a global rule wins over a session's own
 * rewrite, so the push goes with the SSH key's account (git cannot unset it per session).
 */
export function githubSshRewrite(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^url\.(.+)\.(?:push)?insteadof\s+(\S+)\s*$/i.exec(line.trim())
    if (m && /^https:\/\/github\.com(\/|$)/i.test(m[2]) && /^(ssh:\/\/|[^@/\s]+@[^:/\s]+:)/.test(m[1])) return line.trim()
  }
  return null
}

/**
 * Logins that live sessions run as, from `session-accounts.json` ({ [sessionId or key]: login }).
 * `sessions` null (not known yet, at launch): every recorded login, so no file goes too early.
 * A missing or broken file is empty.
 */
export function accountsInUse(file: string, sessions: Pick<Session, 'sessionId' | 'key' | 'state'>[] | null): Set<string> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return new Set()
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Set()
  const ids = sessions && new Set(sessions.filter((s) => s.state !== 'done').flatMap((s) => [s.sessionId, s.key]))
  const out = new Set<string>()
  for (const [id, l] of Object.entries(raw)) if (typeof l === 'string' && LOGIN.test(l) && (!ids || ids.has(id))) out.add(l)
  return out
}

const SSH_WARNING = "your git config sends GitHub pushes over SSH; sessions may push as the SSH key's account"

/**
 * Each connected account's token (in memory) and its Claude Code settings file
 * (`<dir>/<login>.settings.json`, mode 600 in a 700 folder), which `claude --bg --settings` gives a
 * session started as that account. Only with two or more accounts: with one, nothing is read or
 * written, and sessions and calls run as before. Tokens are never logged and never leave main.
 *
 * `refresh` reads tokens locally (gh's keyring) and writes the files; `check` asks GitHub, so
 * launch awaits only `refresh`.
 */
export class AccountEnv {
  private accounts: AccountConfig[] = []
  private tokens = new Map<string, string>()
  /** Why an account can't be used; `token`: the token GitHub refused (a new one clears it). */
  private bad = new Map<string, { reason: string; token?: string }>()
  private aliases: string[] = []
  private warning: string | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private dir: string,
    private run: Runner,
    private sshConfig = join(homedir(), '.ssh', 'config'),
  ) {}

  file(login: string): string {
    return join(this.dir, `${login}.settings.json`)
  }

  private multi(): boolean {
    return isMulti({ accounts: this.accounts })
  }

  /** Read each token and rewrite the files; one refresh at a time. `inUse`: logins live sessions run as (their files stay). */
  refresh(accounts: AccountConfig[], inUse: Set<string> = new Set()): Promise<void> {
    this.queue = this.queue.then(() => this.refreshNow(accounts, inUse)).catch((e) => console.error(`accounts: ${String(e)}`))
    return this.queue
  }

  private async refreshNow(accounts: AccountConfig[], inUse: Set<string>): Promise<void> {
    this.accounts = accounts
    const logins = new Set(accounts.map((a) => a.login))
    for (const m of [this.tokens, this.bad]) for (const l of [...m.keys()]) if (!logins.has(l)) m.delete(l)
    if (!this.multi()) {
      // One account runs as gh's own login: no file is needed, so every file not in use goes.
      this.sweep(new Set(), inUse)
      this.tokens.clear()
      this.bad.clear()
      this.warning = null
      return
    }
    this.sweep(logins, inUse)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
    this.aliases = githubSshAliases(readSshConfig(this.sshConfig))
    await Promise.all(accounts.map((a) => this.readToken(a)))
  }

  private async readToken(a: AccountConfig): Promise<void> {
    const t = await this.run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', a.login], { timeoutMs: 15_000 })
    const token = t.stdout.trim()
    if (t.code !== 0 || !TOKEN.test(token)) {
      this.tokens.delete(a.login)
      this.bad.set(a.login, { reason: `gh is not logged in to ${a.login}` })
      return
    }
    this.tokens.set(a.login, token)
    // A new token (logged in again) is healthy until GitHub says otherwise.
    if (this.bad.get(a.login)?.token !== token) this.bad.delete(a.login)
    if (!this.bad.has(a.login)) this.write(a, token)
  }

  /** Ask GitHub about each token (HTTP 401 or another login: unhealthy; offline: unchanged) and look for git rules sending GitHub over SSH. */
  async check(): Promise<void> {
    if (!this.multi()) return
    const [git] = await Promise.all([
      this.run('git', ['config', '--global', '--get-regexp', '^url\\..*\\.(push)?insteadof$'], { timeoutMs: 5_000 }),
      ...this.accounts.map((a) => this.checkOne(a)),
    ])
    const rule = git.code === 0 ? githubSshRewrite(git.stdout) : null
    this.warning = rule ? `${SSH_WARNING} (${rule})` : null
  }

  private async checkOne(a: AccountConfig): Promise<void> {
    const token = this.tokens.get(a.login)
    if (!token) return
    const r = await this.run('gh', ['api', 'user'], { env: { GH_TOKEN: token }, timeoutMs: 20_000 })
    if (this.tokens.get(a.login) !== token) return // refreshed meanwhile: that answer is stale
    const u = r.code === 0 ? parseGhUser(r.stdout) : null
    if (u && low(u.login) !== low(a.login)) {
      this.bad.set(a.login, { reason: `the token is for ${u.login}`, token })
      rmSync(this.file(a.login), { force: true })
    } else if (u) {
      if (this.bad.delete(a.login)) this.write(a, token)
    } else if (r.code !== 0 && /HTTP 401|Bad credentials/i.test(`${r.stderr}\n${r.stdout}`)) {
      this.bad.set(a.login, { reason: 'the token no longer works', token })
    }
    // Offline or GitHub down: the last answer stands.
  }

  private write(a: AccountConfig, token: string): void {
    const f = this.file(a.login)
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ env: accountEnvBlock(a, token, this.aliases) }, null, 1) + '\n', { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, f)
  }

  /** Files of accounts not in `keep` go, unless a live session still runs as that account. */
  private sweep(keep: Set<string>, inUse: Set<string>): void {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const n of names) {
      const m = /^([A-Za-z0-9-]{1,39})\.settings\.json$/.exec(n)
      if (m && !keep.has(m[1]) && !inUse.has(m[1])) rmSync(join(this.dir, n), { force: true })
    }
  }

  runEnv(login: string): AccountRunEnv {
    if (!this.multi()) return { env: {} }
    const t = this.tokens.get(login)
    return t && !this.bad.has(login) ? { env: { GH_TOKEN: t, GHC_ACCOUNT: login } } : { error: `GitHub account ${login} needs to log in again` }
  }

  /** `claude --bg` arguments for a session as this account (null: the primary); none with one account. */
  settingsArgs(login: string | null | undefined): { ok: true; args: string[]; account: string | null } | { ok: false; message: string } {
    if (!this.multi()) return { ok: true, args: [], account: null }
    if (login && !this.accounts.some((a) => a.login === login)) return { ok: false, message: `${login} is not a connected GitHub account` }
    const l = login || primaryLogin({ accounts: this.accounts })!
    if (this.bad.has(l) || !existsSync(this.file(l))) return { ok: false, message: `GitHub account ${l} needs to log in again (Needs you → Log in)` }
    return { ok: true, args: ['--settings', this.file(l)], account: l }
  }

  status(): GhAccountStatus[] {
    return this.accounts.map((a) => {
      const bad = this.bad.get(a.login)
      return {
        login: a.login,
        primary: !!a.primary,
        healthy: !bad,
        ...(bad ? { error: bad.reason } : {}),
        ...(this.warning ? { warning: this.warning } : {}),
      }
    })
  }
}

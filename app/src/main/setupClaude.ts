import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDetectAll } from '@shared/detect'
import { SETUP_REQ_ID, setupBriefing, setupScript, type SetupWindowRequest } from '@shared/setupClaude'
import { bodyFileAllowed, sweepTicketDirs } from './boardOps'

/**
 * Setup's "Let Claude do it" (#156): the session's folder `<home>/setup-claude/` and the requests
 * its md-setup.sh leaves there (`requests/<id>.req`, NUL-separated arguments; `.taken` once
 * claimed; the answer in `answers/<id>.json`). MasterDeck answers `tools`, `accounts` and
 * `discover` itself; `review` and `gh-login` go to the Setup window, which answers them.
 */
export const setupClaudeDir = (home: string): string => join(home, 'setup-claude')

// GitHub's own rule: never a leading hyphen, so a login is never read as a flag.
const GH_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const DRAFT_MAX = 200_000
const ANSWER_MAX = 400_000

/**
 * `requests/` and `answers/` as real folders: the session could replace one with a link, and the
 * sweep and the answers must never follow it out of the folder. A link is removed (not followed).
 */
function realDirs(dir: string): void {
  for (const sub of ['requests', 'answers']) {
    const p = join(dir, sub)
    try {
      if (!lstatSync(p).isDirectory()) rmSync(p, { force: true })
    } catch {
      /* not there yet */
    }
  }
}

/** A file written whole: a reader never sees half of it. */
function writeAtomic(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

/** A fresh folder for a new conversation: the briefing, the helper, its permissions; no old requests or draft. */
export function prepareSetupDir(dir: string, platform: string): void {
  for (const old of ['requests', 'answers', 'review.json']) rmSync(join(dir, old), { recursive: true, force: true })
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeAtomic(join(dir, 'CLAUDE.md'), setupBriefing(platform))
  const script = join(dir, 'md-setup.sh')
  writeAtomic(script, setupScript(dir, platform))
  chmodSync(script, 0o755)
  // What it may run unasked: the helper and read-only checks. Installs still ask the user.
  writeAtomic(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify(
      {
        permissions: {
          allow: [
            'Bash(./md-setup.sh:*)',
            `Bash(${script}:*)`,
            'Bash(gh auth status:*)',
            'Bash(gh --version)',
            'Bash(git --version)',
            'Bash(jq --version)',
            'Bash(python3 --version)',
            'Bash(claude --version)',
          ],
        },
      },
      null,
      2,
    ) + '\n',
  )
}

export interface SetupHandlers {
  tools: () => Promise<object>
  accounts: () => Promise<object>
  /** What `login` can reach (`master config detect --all` as its token). */
  discover: (login: string) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>
}

/**
 * The folder's requests: claimed by `poll` (the window asks every second or so while the session
 * is open, so nothing answers once Setup is closed), answered here or handed to the window once.
 */
export class SetupPump {
  /** discover's answers, raw, by login: the window fills its Repos & boards step from them. */
  private found = new Map<string, unknown>()
  /** Claimed and not answered yet. */
  private open = new Set<string>()

  constructor(
    private dir: () => string,
    private h: SetupHandlers,
  ) {}

  /** A new conversation: nothing of the last one is kept. */
  reset(): void {
    this.found.clear()
    this.open.clear()
  }

  poll(known: string[] = []): { requests: SetupWindowRequest[]; found: Record<string, unknown> } {
    const dir = this.dir()
    realDirs(dir)
    sweepTicketDirs(dir)
    const requests: SetupWindowRequest[] = []
    let names: string[] = []
    try {
      names = readdirSync(join(dir, 'requests')).filter((n) => n.endsWith('.req'))
    } catch {
      names = []
    }
    for (const n of names) {
      const id = n.slice(0, -4)
      if (!SETUP_REQ_ID.test(id)) continue
      const taken = join(dir, 'requests', `${id}.taken`)
      try {
        renameSync(join(dir, 'requests', n), taken)
      } catch {
        continue // taken back by the script (timed out)
      }
      this.open.add(id)
      let args: string[] = []
      try {
        args = readFileSync(taken, 'utf8').split('\0').slice(0, -1).slice(0, 8)
      } catch {
        /* gone */
      }
      const r = this.claim(id, args)
      if (r) requests.push(r)
    }
    const fresh = [...this.found].filter(([l]) => !known.includes(l))
    return { requests, found: Object.fromEntries(fresh) }
  }

  /** One claimed request: answered here (now or once the handler resolves), or the window's. */
  private claim(id: string, args: string[]): SetupWindowRequest | null {
    const [cmd, arg] = args
    const reply = (p: Promise<object>) =>
      void p.then(
        (a) => this.answer(id, a),
        (e) => this.answer(id, { ok: false, error: String(e) }),
      )
    if (cmd === 'tools') reply(this.h.tools())
    else if (cmd === 'accounts') reply(this.h.accounts())
    else if (cmd === 'discover') {
      if (!arg || !GH_LOGIN.test(arg)) this.answer(id, { ok: false, error: 'discover: give a GitHub login (from ./md-setup.sh accounts)' })
      else reply(this.discover(arg))
    } else if (cmd === 'gh-login') return { id, cmd }
    else if (cmd === 'review') {
      const file = arg ? bodyFileAllowed(this.dir(), arg) : null
      if (!file) this.answer(id, { ok: false, errors: ['review: write review.json in this folder and pass its name'] })
      else {
        try {
          const text = readFileSync(file, 'utf8')
          if (text.length > DRAFT_MAX) throw new Error('too long')
          return { id, cmd, draft: JSON.parse(text) }
        } catch (e) {
          this.answer(id, { ok: false, errors: [`review.json is not valid JSON (${(e as Error).message})`] })
        }
      }
    } else this.answer(id, { ok: false, error: `unknown command ${JSON.stringify(cmd ?? '')}` })
    return null
  }

  private async discover(login: string): Promise<object> {
    const r = await this.h.discover(login)
    if (!r.ok) return { ok: false, error: r.message }
    this.found.set(login, r.data)
    // What the session needs to ask the user; the window keeps the rest (ids, statuses).
    const d = parseDetectAll(r.data)
    return {
      ok: true,
      login,
      owners: d.owners.map((o) => ({
        login: o.login,
        type: o.type,
        repos: o.repos,
        projects: o.projects.map((p) => ({ owner: p.owner, number: p.number, title: p.title, columns: p.columns, sprintField: p.sprintField || null, items: p.items, closed: p.closed })),
      })),
      ...(d.error ? { error: d.error } : {}),
    }
  }

  /** The answer the script is waiting for; false for a request that is not open (answered, swept, or never claimed). */
  answer(id: string, answer: unknown): boolean {
    if (!SETUP_REQ_ID.test(id) || !this.open.has(id)) return false
    this.open.delete(id)
    let text = JSON.stringify(answer ?? { ok: false })
    if (text.length > ANSWER_MAX) text = JSON.stringify({ ok: false, error: 'the answer was too long' })
    const a = join(this.dir(), 'answers')
    try {
      realDirs(this.dir())
      mkdirSync(a, { recursive: true })
      writeAtomic(join(a, `${id}.json`), text)
      return true
    } catch {
      return false
    }
  }
}

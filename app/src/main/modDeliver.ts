import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * - `sent`: the core mod submitted it as a prompt of its own
 * - `handed`: the mod has it (go was written) but did not say it submitted yet (a busy session's
 *   submit waits for the turn to end): counted as delivered, never typed again
 * - `unclaimed`: no mod took it in time; nothing was or will be submitted (type it, or hold it)
 * - `failed`: the mod tried and Claude Code refused; nothing was submitted
 */
export type ModDeliverResult = { kind: 'sent' | 'handed' | 'unclaimed' } | { kind: 'failed'; error: string }

const SID = /^[0-9a-f-]{36}$/i

/**
 * MasterDeck's side of the core mod's delivery (mods/masterdeck/hooks/deliver.ts):
 * `deck/deliver/<session id>/<id>.json` → the mod's `.claim` → our `.go` → the mod's `.done`. The
 * mod can't rename or delete files, so this side decides: `.go` only for a claim that came in
 * time, and the files are removed here.
 */
export class ModDelivery {
  readonly dir: string
  private n = 0

  constructor(
    deckDir: string,
    private times = { claimMs: 5_000, doneMs: 5_000, stepMs: 100 },
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {
    this.dir = join(deckDir, 'deliver')
  }

  async deliver(sessionId: string, text: string): Promise<ModDeliverResult> {
    if (!SID.test(sessionId)) return { kind: 'unclaimed' }
    const d = join(this.dir, sessionId)
    const id = `${Date.now()}-${(this.n++).toString(36)}`
    const file = (ext: string) => join(d, `${id}.${ext}`)
    try {
      mkdirSync(d, { recursive: true })
      writeFileSync(file('tmp'), JSON.stringify({ v: 1, text }))
      renameSync(file('tmp'), file('json'))
    } catch {
      return { kind: 'unclaimed' }
    }
    if (!(await this.waitFor(file('claim'), this.times.claimMs))) {
      // A claim after this finds no request, and never gets a go: the mod skips it.
      rm(file('json'))
      rm(file('claim'))
      return { kind: 'unclaimed' }
    }
    writeFileSync(file('go'), '')
    if (!(await this.waitFor(file('done'), this.times.doneMs))) return { kind: 'handed' }
    let done: { ok?: unknown; error?: unknown } = {}
    try {
      done = JSON.parse(readFileSync(file('done'), 'utf8'))
    } catch {
      // half-written: it did submit (the mod writes done after the submit)
      done = { ok: true }
    }
    for (const ext of ['json', 'claim', 'go', 'done']) rm(file(ext))
    return done.ok === false ? { kind: 'failed', error: typeof done.error === 'string' ? done.error : 'the mod could not submit it' } : { kind: 'sent' }
  }

  private async waitFor(path: string, ms: number): Promise<boolean> {
    for (let waited = 0; ; waited += this.times.stepMs) {
      if (existsSync(path)) return true
      if (waited >= ms) return false
      await this.sleep(this.times.stepMs)
    }
  }

  /** Folders of sessions not live, and files left by a handed message or a crash (10 minutes on). */
  prune(live: Set<string>, now = Date.now()): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const sid of names) {
      const d = join(this.dir, sid)
      if (!live.has(sid)) {
        rmSync(d, { recursive: true, force: true })
        continue
      }
      try {
        for (const n of readdirSync(d)) if (now - statSync(join(d, n)).mtimeMs > 600_000) rm(join(d, n))
      } catch {
        // gone meanwhile
      }
    }
  }
}

function rm(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    // gone
  }
}

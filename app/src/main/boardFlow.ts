import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { statusesFor, statusRank } from '@shared/appConfig'
import type { CompiledStep } from '@shared/flow'
import { canDeliver } from '@shared/watches'
import { MASTER_NAME } from '@shared/derive'
import { boardTarget, ticketPrs, ticketSessions, type LinkFile } from '@shared/ticketLinks'
import { sameTicket, ticketKey, type Ticket } from '@shared/ticket'
import type { AppState, CliResult, Session } from '@shared/types'
import type { BoardOps } from './boardOps'
import type { LinkStore } from './ticketLinks'

export const BOARD_TICK_MS = 30_000
export const RETRY_MS = 30 * 60_000

export interface BoardFlowDeps {
  ops: Pick<BoardOps, 'move' | 'linkPr'>
  links: Pick<LinkStore, 'read' | 'addPr'>
  /** Live state of PRs (through ghc); unknown ones are left out. */
  prStates: (urls: string[]) => Promise<Record<string, { state: string; isDraft: boolean }>>
  link: (t: Ticket, sessionId: string, cwd: string | null) => Promise<CliResult>
  builtinOn: (sessionId: string) => boolean
  onMoved: (t: Ticket, status: string) => void
  log?: (m: string) => void
}

/**
 * The board moves babysit-ticket's hook used to make, done by MasterDeck from what it already
 * knows: a session master spawned for an issue gets linked (In Dev comes with the link); a linked
 * session's new PR is recorded and linked under the issue's Development box; the card moves to PR
 * Raised once a PR is open and ready, and to Dev Done once every PR is merged. Forward only; each
 * (ticket, target) is tried once, again after RETRY_MS if it failed.
 */
export class BoardFlow {
  private last = -Infinity
  private running = false
  private tried = new Map<string, number>()
  private linkTried = new Set<string>()

  constructor(private deps: BoardFlowDeps) {}

  async tick(state: AppState, now = Date.now()): Promise<void> {
    if (this.running || now - this.last < BOARD_TICK_MS) return
    this.running = true
    this.last = now
    try {
      await this.autoLink(state)
      const file = this.deps.links.read()
      await this.recordPrs(state, file)
      await this.move(state, this.deps.links.read(), now)
    } catch (e) {
      this.deps.log?.(`board moves: ${String(e)}`)
    } finally {
      this.running = false
    }
  }

  private async autoLink(state: AppState): Promise<void> {
    for (const s of state.sessions) {
      if (s.issue !== null || s.state === 'done' || s.name === MASTER_NAME || this.linkTried.has(s.sessionId)) continue
      const p = state.proposals.find((x) => x.kind === 'ASSIGN' && ['sent', 'question', 'blocked', 'done'].includes(x.status) && x.target.spawn?.name === s.name)
      if (!p || !this.deps.builtinOn(s.sessionId)) continue
      this.linkTried.add(s.sessionId)
      const r = await this.deps.link({ repo: p.repo ?? null, number: p.issue }, s.sessionId, s.cwd || null)
      if (!r.ok) this.deps.log?.(`link ${s.name}: ${r.message}`)
    }
  }

  private async recordPrs(state: AppState, file: LinkFile): Promise<void> {
    for (const [sid, e] of Object.entries(file.sessions)) {
      for (const url of state.sessionPrs[sid] ?? []) {
        if (e.prs.includes(url)) continue
        try {
          this.deps.links.addPr(sid, url)
        } catch (e) {
          // Not recorded: the next tick tries again (and links it then).
          this.deps.log?.(`ticket links: could not record ${url}: ${String(e)}`)
          continue
        }
        if (this.deps.builtinOn(sid)) await this.deps.ops.linkPr({ repo: e.repo ?? null, number: e.issue }, url)
      }
    }
  }

  private async move(state: AppState, file: LinkFile, now: number): Promise<void> {
    const tickets = new Map<string, Ticket>()
    for (const e of Object.values(file.sessions)) if (!e.adopted) tickets.set(ticketKey(e.repo ?? null, e.issue), { repo: e.repo ?? null, number: e.issue })
    for (const [key, t] of tickets) {
      if (!ticketSessions(file, t).some((sid) => this.deps.builtinOn(sid))) continue
      const urls = ticketPrs(file, t)
      if (!urls.length) continue
      const live = await this.deps.prStates(urls)
      // Dev Done needs every PR known: one we cannot read could still be open.
      const known = urls.filter((u) => live[u]).map((u) => live[u])
      const target = boardTarget(known)
      if (!target || (target === 'devDone' && known.length < urls.length)) continue
      const card = state.board?.cards.find((c) => sameTicket(c, t)) ?? state.issues.find((i) => sameTicket(i, t))
      const project = card?.project ?? null
      const name = statusesFor(project)[target]
      if (card?.status && statusRank(card.status, undefined, project) >= statusRank(name, undefined, project)) continue
      const id = `${key}:${target}`
      if (now - (this.tried.get(id) ?? -Infinity) < RETRY_MS) continue
      this.tried.set(id, now)
      const r = await this.deps.ops.move(t, name)
      if (r.ok) {
        if (!/left at|already/.test(r.message)) this.deps.onMoved(t, name)
      } else this.deps.log?.(`board ${key}: ${r.message}`)
    }
  }
}

export interface LinkedStepsDeps {
  /** Sessions linked whose steps are not delivered yet (survives a restart). */
  file: string
  /** Where the `linked` hook keeps its once-per-session markers (`$TMPDIR`): shared, so a link made by hand with tt.sh does not hand the same steps again. */
  markDir: string
  steps: (sessionId: string) => CompiledStep[]
  send: (s: Session, text: string) => Promise<CliResult>
  logRun: (sessionId: string, trigger: string, ids: string[]) => void
  log?: (m: string) => void
}

/**
 * The `linked` trigger for links MasterDeck makes itself (the Link dialog, sessions master spawned):
 * no `tt.sh link` runs, so the hook never fires. The session's linked steps go to it as one message
 * once its turn is over, once per session and step (the hook's markers).
 */
export class LinkedSteps {
  private pending: string[]
  private sending = new Set<string>()

  constructor(private deps: LinkedStepsDeps) {
    let p: unknown = []
    try {
      if (existsSync(deps.file)) p = JSON.parse(readFileSync(deps.file, 'utf8'))
    } catch (e) {
      deps.log?.(`linked steps: ${String(e)}`)
    }
    this.pending = Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
  }

  private marker = (id: string, sid: string) => join(this.deps.markDir, `masterdeck-workflow-${id}-${sid}`)
  private due = (sid: string) => this.deps.steps(sid).filter((s) => s.trigger === 'linked' && !existsSync(this.marker(s.id, sid)))

  private save(): void {
    try {
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify(this.pending))
      renameSync(`${this.deps.file}.tmp`, this.deps.file)
    } catch (e) {
      this.deps.log?.(`linked steps: ${String(e)}`)
    }
  }

  /** A session was just linked. */
  queue(sessionId: string): void {
    try {
      if (this.pending.includes(sessionId) || !this.due(sessionId).length) return
    } catch (e) {
      return this.deps.log?.(`linked steps: ${String(e)}`)
    }
    this.pending.push(sessionId)
    this.save()
  }

  /** Hand pending steps to sessions whose turn is over; drop the ones that ended. */
  async deliver(sessions: Session[]): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const sid of [...this.pending]) {
      const s = sessions.find((x) => x.sessionId === sid)
      // ponytail: a session briefly missing from the list waits; one that never comes back stays pending.
      if (!s || this.sending.has(sid) || (s.state !== 'done' && !canDeliver(s))) continue
      let steps: CompiledStep[] = []
      try {
        if (s.state !== 'done') steps = this.due(sid)
      } catch (e) {
        this.deps.log?.(`linked steps: ${String(e)}`)
        continue
      }
      if (!steps.length) {
        this.drop(sid)
        continue
      }
      this.sending.add(sid)
      jobs.push(
        this.deps
          .send(s, `Workflow step (linked): ${steps.map((x) => x.note).join('\n\n')}`)
          .then((r) => {
            if (!r.ok) return this.deps.log?.(`linked steps to ${s.name}: ${r.message}`)
            for (const x of steps) writeFileSync(this.marker(x.id, sid), '')
            this.deps.logRun(sid, 'linked', steps.map((x) => x.id))
            this.drop(sid)
          })
          .catch((e) => this.deps.log?.(`linked steps to ${s.name}: ${String(e)}`))
          .finally(() => this.sending.delete(sid)),
      )
    }
    await Promise.all(jobs)
  }

  private drop(sid: string): void {
    this.pending = this.pending.filter((x) => x !== sid)
    this.save()
  }
}

import { isMulti, primaryLogin } from '@shared/accounts'
import type { AppConfig } from '@shared/appConfig'
import {
  addItems, BOARD_ADD_BATCH, BOARD_ADD_MAX, BOARD_MAX_REPOS, boardConfigPatch, boardEntry, cleanTitle, confirmLines, CREATE_PROJECT, createStatusField, defaultBoardTitle, gql, issueIdsQuery,
  lacksProjectScope, LINK_REPO, okId, optionIds, parseField, parsePlan, planQuery, SCOPE_ERROR, scopeFix, setStatuses, STATUS_FIELD, titleTaken, updateStatusField,
  type BoardCreateResult, type BoardPlanResult, type BoardProgress,
} from '@shared/boardCreate'
import { boardless, boardsOf, reposOf, type DerivedColumn } from '@shared/derivedBoard'
import type { GhAccount } from '@shared/ghAuth'
import type { CliResult } from '@shared/types'
import { ghErrorText, ghHasData, type GhRunner } from './ghc'
import type { RunResult } from './run'

/**
 * "Create a GitHub board" for an account that has none: a Projects (v2) project under the
 * account's owner with the four columns, linked to its ticked repositories and filled with their
 * open issues, then written into the account's config. Every call goes out as that account
 * (`deps.gh(login)`); writes pass straight through the shared cache. MasterDeck never deletes
 * what it made: a run that fails half-way says what exists and what to do with it.
 */
export const BATCH_PAUSE_MS = 1000
const RATE = /rate limit|secondary rate|abuse detection|RATE_LIMITED/i
const ON_MAC = 'Create the board from MasterDeck on your Mac'

export interface CreatorDeps {
  config: () => AppConfig
  /** The gh runner of an account (null: the only one, gh's active account). */
  gh: (login: string | null) => GhRunner
  /** `gh auth status`: logins, which one is active, token scopes. */
  ghLogins: () => Promise<GhAccount[]>
  /** The confirmation on the Mac; false cancels before any write. */
  confirm: (message: string, lines: string[]) => Promise<boolean>
  /** `master config save`. */
  save: (patch: unknown) => Promise<CliResult>
  /** Reload the config and refresh from GitHub. */
  refresh: () => void
  /** The column the Board shows for an issue now: its Status on the new board. */
  statusOf: (repo: string, number: number) => DerivedColumn
  progress: (p: BoardProgress) => void
  /** The pause between batches (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>
}

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const graphql = (doc: string, vars: Record<string, string>): string[] => ['api', 'graphql', '-f', `query=${doc}`, ...Object.entries(vars).flatMap(([k, v]) => ['-f', `${k}=${v}`])]

interface IssueRef {
  id: string
  repo: string
  number: number
}
/** A created board and the issues still to add to it. */
interface Job {
  projectId: string
  fieldId: string
  options: Record<DerivedColumn, string>
  issues: IssueRef[]
  url: string
  title: string
}
interface Added {
  added: number
  failed: IssueRef[]
  /** Not tried: GitHub stopped answering (a rate limit, the network). */
  left: IssueRef[]
  unset: number
}

export class BoardCreator {
  /** What the last run could not add, by account ('' with one): kept for Try again, for this app run only. */
  private pending = new Map<string, Job>()
  private running = false
  /** gh's active login, as of the last plan (for the scope fix). */
  private active: string | null = null

  constructor(private d: CreatorDeps) {}

  /** The account a request names: a connected one with two or more accounts (undefined: not one); null with one. */
  private login(account: unknown): string | null | undefined {
    const c = this.d.config()
    if (!isMulti(c)) return null
    return typeof account === 'string' && c.accounts.some((a) => a.login === account) ? account : undefined
  }

  private fail(r: RunResult, login: string | null): { ok: false; message: string; fix?: string[] } {
    const message = (r.stderr || gql(r.stdout).errors[0]?.message || r.stdout || `gh exited ${r.code}`).trim().slice(0, 300)
    return { ok: false, message, ...(SCOPE_ERROR.test(`${r.stderr}\n${r.stdout}`) ? { fix: scopeFix(login, this.active) } : {}) }
  }

  /** What a run would create. One read, as the account; nothing is written. */
  async plan(account: unknown): Promise<BoardPlanResult> {
    const c = this.d.config()
    const login = this.login(account)
    if (login === undefined) return { ok: false, message: 'not a connected GitHub account' }
    if (!boardless(login, c)) return { ok: false, message: boardsOf(login, c).length ? 'this account already has a board selected' : 'select its repositories in Setup first' }
    const acct = c.accounts.find((a) => a.login === (login ?? primaryLogin(c)))
    const owner = acct?.owner || c.owner
    const logins = await this.d.ghLogins()
    this.active = logins.find((a) => a.active)?.login ?? null
    if (lacksProjectScope(logins, login)) return { ok: false, message: `${login ?? "gh's active account"} cannot manage project boards: its token lacks the project scope`, fix: scopeFix(login, this.active) }
    const ticked = reposOf(login, c)
    const repos = ticked.slice(0, BOARD_MAX_REPOS)
    const r = await this.d.gh(login)(graphql(planQuery(repos), { login: owner }), { timeoutMs: 60_000, force: true })
    if (!ghHasData(r)) return this.fail(r, login)
    const p = parsePlan(r.stdout, repos)
    if (!p.ownerId) return { ok: false, message: `GitHub has no account named ${owner}` }
    if (!p.repos.length) return { ok: false, message: `GitHub did not answer for ${repos.join(', ')}` }
    return {
      ok: true, account: login, owner, ownerType: p.ownerType, ownerId: p.ownerId, title: defaultBoardTitle(acct?.issueRepo || c.issueRepo),
      repos: p.repos, missing: p.missing, skipped: ticked.slice(repos.length), total: p.repos.reduce((n, x) => n + x.open, 0), existing: p.existing,
    }
  }

  /** `req`: {account?, title}. Asks on the Mac first; `remote` callers are refused. */
  async create(req: unknown, remote: boolean): Promise<BoardCreateResult> {
    if (remote) return { ok: false, message: ON_MAC }
    if (this.running) return { ok: false, message: 'already creating a board' }
    this.running = true
    try {
      return await this.run(req)
    } finally {
      this.running = false
    }
  }

  private async run(req: unknown): Promise<BoardCreateResult> {
    const x = o(req)
    const title = cleanTitle(x.title)
    if (!title) return { ok: false, message: 'give the board a name (up to 100 characters)' }
    // Main's own fresh read: what the confirmation lists is what will be made.
    const plan = await this.plan(x.account)
    if (!plan.ok) return plan
    const dup = titleTaken(plan.existing, title)
    if (dup) return { ok: false, url: dup.url, message: `${plan.owner} already has a board named "${dup.title}". Pick it in Setup → Repos & boards, or choose another name.` }
    if (!(await this.d.confirm(`Create a GitHub board${plan.account ? ` as ${plan.account}` : ''}?`, confirmLines(plan, title)))) return { ok: false, message: 'cancelled' }

    const gh = this.d.gh(plan.account)
    const say = (text: string, done = 0, total = 0) => this.d.progress({ text, done, total })
    say('Creating the project…')
    const made = await gh(graphql(CREATE_PROJECT, { o: plan.ownerId, t: title }), { timeoutMs: 60_000 })
    const proj = o(o(gql(made.stdout).data.createProjectV2).projectV2)
    const projectId = proj.id
    const number = proj.number
    if (!okId(projectId) || typeof number !== 'number') return this.fail(made, plan.account)
    const url = typeof proj.url === 'string' ? proj.url : ''

    say('Setting its columns…')
    const field = await this.columns(gh, projectId)
    if ('error' in field) return { ok: false, url, message: `The board was created (${url}) but its columns could not be set: ${field.error}. Delete it on GitHub, or pick it in Setup → Repos & boards.` }

    const warnings: string[] = []
    for (const [i, r] of plan.repos.entries()) {
      say(`Linking ${r.repo}…`, i, plan.repos.length)
      const l = await gh(graphql(LINK_REPO, { p: projectId, r: r.id }), { timeoutMs: 60_000 })
      // Not fatal: the board works without the link (GitHub only uses it to list the board under the repository).
      if (!o(gql(l.stdout).data.linkProjectV2ToRepository).repository) warnings.push(`${r.repo} could not be linked to the board`)
    }

    say('Reading the open issues…')
    const found = await this.issues(gh, plan.repos.map((r) => r.repo))
    if (found.capped) warnings.push(`Only the first ${BOARD_ADD_MAX} open issues were added`)
    const job: Job = { projectId, fieldId: field.id, options: field.options, issues: found.issues, url, title }
    const added = await this.add(gh, job)

    // Last: until here the tab still shows the repositories' issues, so nothing vanishes if the run dies.
    say('Selecting the board in MasterDeck…')
    const entry = boardEntry({ owner: plan.owner, ownerType: plan.ownerType, number, id: projectId, title, fieldId: field.id, options: field.options })
    const saved = await this.d.save(boardConfigPatch(this.d.config(), plan.account, entry))
    if (!saved.ok) return { ok: false, url, message: `The board was created (${url}) but MasterDeck could not select it: ${saved.message}. Pick it in Setup → Repos & boards.` }
    this.d.refresh()
    return this.result(plan.account, job, added, warnings)
  }

  /** The Status field with the four columns: the default field's options renamed in place, or a new field when the project came without one. */
  private async columns(gh: GhRunner, projectId: string): Promise<{ id: string; options: Record<DerivedColumn, string> } | { error: string }> {
    const read = await gh(graphql(STATUS_FIELD, { p: projectId }), { timeoutMs: 30_000, force: true })
    // An unread field is not "no field": creating a second Status would be worse than stopping.
    if (!ghHasData(read) || !gql(read.stdout).data.node) return { error: ghErrorText(read).trim().slice(0, 200) || 'the Status field could not be read' }
    const before = parseField(o(gql(read.stdout).data.node).field)
    const w = before
      ? await gh(graphql(updateStatusField(before.options), { f: before.id }), { timeoutMs: 60_000 })
      : await gh(graphql(createStatusField(), { p: projectId }), { timeoutMs: 60_000 })
    const after = parseField(o(gql(w.stdout).data[before ? 'updateProjectV2Field' : 'createProjectV2Field']).projectV2Field)
    const ids = after ? optionIds(after.options) : null
    if (!after || !ids) return { error: (w.stderr || gql(w.stdout).errors[0]?.message || 'GitHub did not return the four columns').trim().slice(0, 200) }
    return { id: after.id, options: ids }
  }

  /** The open issues of the repositories, oldest first, BOARD_ADD_MAX at most. */
  private async issues(gh: GhRunner, repos: string[]): Promise<{ issues: IssueRef[]; capped: boolean }> {
    const out: IssueRef[] = []
    for (const repo of repos) {
      let cursor: string | null = null
      for (let page = 0; page < BOARD_ADD_MAX / 100; page++) {
        const r: RunResult = await gh(graphql(issueIdsQuery(repo), cursor ? { c: cursor } : {}), { timeoutMs: 60_000, force: true })
        const conn = o(o(gql(r.stdout).data.repository).issues)
        for (const n of arr(conn.nodes).map(o)) if (okId(n.id) && typeof n.number === 'number') out.push({ id: n.id, repo, number: n.number })
        if (out.length >= BOARD_ADD_MAX) return { issues: out.slice(0, BOARD_ADD_MAX), capped: true }
        const info = o(conn.pageInfo)
        if (info.hasNextPage !== true || typeof info.endCursor !== 'string') break
        cursor = info.endCursor
      }
    }
    return { issues: out, capped: false }
  }

  /** Add the job's issues, BOARD_ADD_BATCH per request, each with its column as its Status. Goes on past a refused issue; stops when GitHub stops answering. */
  private async add(gh: GhRunner, job: Job): Promise<Added> {
    const wait = this.d.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
    const all = job.issues
    const failed: IssueRef[] = []
    let added = 0
    let unset = 0
    for (let i = 0; i < all.length; i += BOARD_ADD_BATCH) {
      if (i > 0) await wait(BATCH_PAUSE_MS)
      const batch = all.slice(i, i + BOARD_ADD_BATCH)
      this.d.progress({ text: `Adding issues ${i + batch.length} of ${all.length}…`, done: i, total: all.length })
      const r = await gh(graphql(addItems(batch.map((x) => x.id)), { p: job.projectId }), { timeoutMs: 120_000 })
      // No data at all (a rate limit, the network): the rest waits for Try again.
      if (!ghHasData(r) || RATE.test(ghErrorText(r))) return { added, failed, left: all.slice(i), unset }
      const data = gql(r.stdout).data
      const pairs: { item: string; option: string }[] = []
      batch.forEach((x, k) => {
        const item = o(o(data[`a${k}`]).item).id
        if (okId(item)) {
          added++
          pairs.push({ item, option: job.options[this.d.statusOf(x.repo, x.number)] })
        } else failed.push(x)
      })
      if (!pairs.length) continue
      const s = await gh(graphql(setStatuses(pairs), { p: job.projectId, f: job.fieldId }), { timeoutMs: 120_000 })
      const set = gql(s.stdout).data
      unset += pairs.filter((_p, k) => !okId(o(o(set[`s${k}`]).projectV2Item).id)).length
    }
    return { added, failed, left: [], unset }
  }

  private result(account: string | null, job: Job, a: Added, warnings: string[]): BoardCreateResult {
    const missing = [...a.failed, ...a.left]
    if (missing.length) this.pending.set(account ?? '', { ...job, issues: missing })
    else this.pending.delete(account ?? '')
    const total = job.issues.length
    return {
      ok: true, url: job.url, title: job.title, added: a.added, total,
      failed: a.failed.map((x) => `${x.repo.split('/')[1] ?? x.repo}#${x.number}`), left: a.left.length, unset: a.unset, warnings,
      message: missing.length ? `Added ${a.added} of ${total} issues to ${job.title}` : `Added ${a.added} ${a.added === 1 ? 'issue' : 'issues'} to ${job.title}`,
    }
  }

  /** Add what the last run for this account could not (the board exists and is selected already). */
  async retry(account: unknown, remote: boolean): Promise<BoardCreateResult> {
    if (remote) return { ok: false, message: ON_MAC }
    const login = this.login(account)
    const job = login === undefined ? undefined : this.pending.get(login ?? '')
    if (login === undefined || !job) return { ok: false, message: 'nothing left to add' }
    if (this.running) return { ok: false, message: 'already creating a board' }
    this.running = true
    try {
      const added = await this.add(this.d.gh(login), job)
      this.d.refresh()
      return this.result(login, job, added, [])
    } finally {
      this.running = false
    }
  }
}

import { isMulti, primaryLogin } from '@shared/accounts'
import type { AppConfig, ProjectConfig } from '@shared/appConfig'
import {
  addItems, BOARD_ADD_BATCH, BOARD_ADD_MAX, BOARD_MAX_REPOS, boardConfigPatch, boardEntry, cleanTitle, confirmLines, CREATE_PROJECT, createStatusField, defaultBoardTitle, gql, issueIdsQuery,
  lacksProjectScope, LINK_REPO, NO_ANSWER, okId, optionIds, parseField, parsePlan, planQuery, planTotal, SCOPE_ERROR, scopeFix, setStatuses, STATUS_FIELD, titleTaken, updateStatusField,
  type BoardCreateResult, type BoardPlanResult, type BoardProgress,
} from '@shared/boardCreate'
import { boardless, boardsOf, DERIVED_COLUMNS, reposOf, type DerivedColumn } from '@shared/derivedBoard'
import type { GhAccount } from '@shared/ghAuth'
import { sameTicket } from '@shared/ticket'
import type { Board, CliResult } from '@shared/types'
import { ghErrorText, ghHasData, type GhRunner } from './ghc'
import type { RunResult } from './run'

/**
 * "Create a GitHub board" for an account that has none: a Projects (v2) project under the
 * account's owner with the four columns, linked to its ticked repositories and filled with their
 * open issues, then written into the account's config. Every call goes out as that account
 * (`deps.gh(login)`); writes pass straight through the shared cache. MasterDeck never deletes
 * what it made: a run that fails half-way says what exists and what to do with it. Once the
 * project exists nothing may lose its address: every later failure, a throw included, comes back
 * as a result that names it.
 */
export const BATCH_PAUSE_MS = 1000
const RATE = /rate limit|secondary rate|abuse detection|RATE_LIMITED/i
const ON_MAC = 'Create the board from MasterDeck on your Mac'
const BUSY = 'already creating a board'
const PICK = 'Pick it in Setup → Repos & boards'

export interface CreatorDeps {
  config: () => AppConfig
  /** The gh runner of an account (null: the only one, gh's active account). It must fail for a login that is not connected, never run as another one: `accountGh`. */
  gh: (login: string | null) => GhRunner
  /** `gh auth status`: logins, which one is active, token scopes. */
  ghLogins: () => Promise<GhAccount[]>
  /** The confirmation on the Mac; false cancels before any write. */
  confirm: (message: string, lines: string[]) => Promise<boolean>
  /** `master config save`. */
  save: (patch: unknown) => Promise<CliResult>
  /** Reload the config and refresh from GitHub. */
  refresh: () => void
  /**
   * The account's Board as it is now, as a lookup: the column it shows for an issue, which becomes
   * the issue's Status (`columnsOf`). Null when no Board is loaded for the account: a run would
   * then write Todo for every issue, so it is refused. Asked once per board, before anything is
   * written: once the board is selected the tab shows it, and no issue has a derived column.
   */
  columns: (login: string | null) => ((repo: string, number: number) => DerivedColumn) | null
  progress: (p: BoardProgress) => void
  /** The pause between batches (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>
}

/**
 * `CreatorDeps.gh` for the app: an account's runner only while that login is connected, checked on
 * every call. `forAccount` alone answers an unknown login with the primary account's runner, which
 * here would create a board as somebody else.
 */
export function accountGh(config: () => AppConfig, of: (login: string | null) => GhRunner): (login: string | null) => GhRunner {
  return (login) => async (args, opts) => {
    const c = config()
    const known = isMulti(c) ? login !== null && c.accounts.some((a) => a.login === login) : login === null
    if (!known) return notSent(login === null ? 'no GitHub account was named' : `GitHub account ${login} is not connected`)
    return of(login)(args, opts)
  }
}

/** A call that was refused here and never left the Mac. In the shape of a GraphQL refusal, so it reads as "GitHub has nothing of this", not as an answer that got lost. */
const notSent = (message: string): RunResult => ({ code: 1, stdout: JSON.stringify({ errors: [{ type: 'NOT_SENT', message }] }), stderr: message })

/**
 * `CreatorDeps.columns` for the app: the columns of the account's derived cards on the state's
 * board (a copy). Null when the board holds no read of that account's repository issues (nothing
 * loaded yet, or the last read failed). An issue that is not a card (past the card limit) is Todo.
 */
export function columnsOf(board: Board | null | undefined, login: string | null): ((repo: string, number: number) => DerivedColumn) | null {
  if (!board?.derived?.some((d) => (d.account ?? null) === login)) return null
  const shown = board.cards.filter((c) => c.derived).map((c) => ({ repo: c.repo, number: c.number, status: c.status }))
  return (repo, number) => {
    const status = shown.find((c) => sameTicket(c, { repo, number }))?.status
    return DERIVED_COLUMNS.find((c) => c === status) ?? 'Todo'
  }
}

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
// -f, never -F: -F reads "@path" as a file and turns "123", "true" and "null" into other types.
const graphql = (doc: string, vars: Record<string, string>): string[] => ['api', 'graphql', '-f', `query=${doc}`, ...Object.entries(vars).flatMap(([k, v]) => ['-f', `${k}=${v}`])]
const short = (s: string, n = 300): string => s.trim().slice(0, n)
/** " (url)", or nothing when GitHub gave no address. */
const at = (url: string): string => (url ? ` (${url})` : '')
const thrown = (e: unknown): string => short(e instanceof Error && e.message ? e.message : 'an unexpected error', 200)
/** Why a gh call failed: gh's own words or GitHub's error, else a fixed text. Never its raw output, which can be anything (a proxy's page). */
function why(r: RunResult): string {
  const e = gql(r.stdout).errors[0]
  return short(r.stderr || (e && e.type !== 'NO_ANSWER' ? e.message : '') || `${NO_ANSWER} (gh exited ${r.code})`)
}
/** GitHub answered this call (in part at least) and did not say "slow down". */
const answered = (r: RunResult): boolean => ghHasData(r) && gql(r.stdout).ok && !RATE.test(ghErrorText(r))
const label = (x: { repo: string; number: number }): string => `${x.repo.split('/')[1] ?? x.repo}#${x.number}`

interface IssueRef {
  id: string
  repo: string
  number: number
  /** Its column on the Board when the board was made: its Status, in this run and in any retry. */
  column: DerivedColumn
}
/** A created board and what is still to do for it. */
interface Job {
  account: string | null
  /** One account: gh's active login when the board was confirmed (null: gh named none). Every later call must go out as it. */
  as: string | null
  projectId: string
  fieldId: string
  options: Record<DerivedColumn, string>
  url: string
  title: string
  /** The board as the config gets it, and whether it is in there yet. */
  entry: ProjectConfig
  selected: boolean
  /** The Board when the board was made (`CreatorDeps.columns`). */
  columnOf: (repo: string, number: number) => DerivedColumn
  /** Open issues per repository as the plan counted them (null: unknown). */
  open: Map<string, number | null>
  /** How many issues the plan said would be added; null: unknown. */
  expected: number | null
  /** Read and still to add. */
  issues: IssueRef[]
  /** Repositories whose open issues could not be read (all of them, until the first read). */
  unread: string[]
  /** Repositories not linked to the board yet (all of them, until the first try). */
  unlinked: { repo: string; id: string }[]
  /** Issue ids that are on the board with their Status dealt with. */
  done: Set<string>
}
interface Added {
  added: number
  /** GitHub refused them. */
  failed: IssueRef[]
  /** Not tried, or added without an answer about their Status: GitHub stopped answering (a rate limit, the network). */
  left: IssueRef[]
  unset: number
}
type Plan = Extract<BoardPlanResult, { ok: true }>
type Failure = Extract<BoardCreateResult, { ok: false }>

export class BoardCreator {
  /** A board that exists but is not finished, by account ('' with one): kept for Try again, for this app run only. */
  private pending = new Map<string, Job>()
  private running = false
  /** gh's active login, as of the last plan (for the scope fix and the confirmation). */
  private active: string | null = null

  constructor(private d: CreatorDeps) {}

  /** The account a request names: a connected one, in the config's spelling, with two or more accounts (undefined: not one); null with one. */
  private login(account: unknown): string | null | undefined {
    const c = this.d.config()
    if (!isMulti(c)) return null
    if (typeof account !== 'string') return undefined
    return c.accounts.find((a) => a.login.toLowerCase() === account.toLowerCase())?.login
  }

  private scope(r: RunResult, login: string | null): { fix?: string[] } {
    return SCOPE_ERROR.test(`${r.stderr}\n${r.stdout}`) ? { fix: scopeFix(login, this.active) } : {}
  }

  private fail(r: RunResult, login: string | null): { ok: false; message: string; fix?: string[] } {
    return { ok: false, message: why(r), ...this.scope(r, login) }
  }

  /** Progress is for show: a window that is gone must not stop a run that has written to GitHub. */
  private say(text: string, done = 0, total = 0): void {
    try {
      this.d.progress({ text, done, total })
    } catch {
      // nobody is watching
    }
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
    if (lacksProjectScope(logins, login)) return { ok: false, message: `${login ?? this.active ?? "gh's active account"} cannot manage project boards: its token lacks the project scope`, fix: scopeFix(login, this.active) }
    const ticked = reposOf(login, c)
    const repos = ticked.slice(0, BOARD_MAX_REPOS)
    const r = await this.d.gh(login)(graphql(planQuery(repos), { login: owner }), { timeoutMs: 60_000, force: true })
    const p = parsePlan(r.stdout, repos)
    if (!ghHasData(r) || !p.ok) return this.fail(r, login)
    const ownerError = p.errors.find((e) => e.alias === 'repositoryOwner')
    if (!p.ownerId) return ownerError ? this.fail(r, login) : { ok: false, message: `GitHub has no account named ${owner}` }
    // A list that did not come, or came with an error, proves nothing: creating now could make a second board of the same name.
    if (!p.boardsRead) return { ok: false, message: `GitHub did not list ${owner}'s boards${ownerError ? ` (${short(ownerError.message, 200)})` : ''}, so a board of the same name cannot be ruled out`, ...this.scope(r, login) }
    if (!p.repos.length) return { ok: false, message: `GitHub did not answer for ${repos.join(', ')}` }
    return {
      ok: true, account: login, owner, ownerType: p.ownerType, ownerId: p.ownerId, title: defaultBoardTitle(acct?.issueRepo || c.issueRepo),
      repos: p.repos, missing: p.missing, skipped: ticked.slice(repos.length), total: p.repos.reduce((n, x) => n + (x.open ?? 0), 0), existing: p.existing, moreBoards: p.moreBoards,
    }
  }

  /** `req`: {account?, title}. Asks on the Mac first; `remote` callers are refused. */
  async create(req: unknown, remote: boolean): Promise<BoardCreateResult> {
    if (remote) return { ok: false, message: ON_MAC }
    if (this.running) return { ok: false, message: BUSY }
    this.running = true
    try {
      return await this.run(req)
    } finally {
      this.running = false
    }
  }

  /** Everything before the first write: the plan, the name, the confirmation, then the same checks again. Nothing here throws. */
  private async checked(req: unknown): Promise<{ plan: Plan; title: string; columnOf: Job['columnOf']; as: string | null } | Failure> {
    const x = o(req)
    const title = cleanTitle(x.title)
    if (!title) return { ok: false, message: 'give the board a name (up to 100 characters)' }
    const taken = (p: Plan): Failure | null => {
      const dup = titleTaken(p.existing, title)
      return dup ? { ok: false, url: dup.url, message: `${p.owner} already has a board named "${dup.title}". ${PICK}, or choose another name.` } : null
    }
    try {
      // Main's own fresh read: what the confirmation lists is what will be made.
      const plan = await this.plan(x.account)
      if (!plan.ok) return plan
      const dup = taken(plan)
      if (dup) return dup
      const as = plan.account ?? this.active
      if (!(await this.d.confirm(`Create a GitHub board${as ? ` as ${as}` : ''}?`, confirmLines(plan, title)))) return { ok: false, message: 'cancelled' }
      // The confirmation can stay open for minutes, and Setup stays usable behind it: the account may
      // have been disconnected or given a board, a board of this name may have been made. Read again;
      // what is written must be what was confirmed.
      const now = await this.plan(x.account)
      if (!now.ok) return { ...now, message: `Nothing was created: ${now.message}` }
      const same = now.account === plan.account && now.owner === plan.owner && now.ownerId === plan.ownerId && now.repos.map((r) => r.id).join() === plan.repos.map((r) => r.id).join()
      if (!same) return { ok: false, message: 'Nothing was created: the account or its repositories changed while you were confirming. Try again.' }
      // One account: the calls go out as gh's active login, the one the confirmation named.
      if (plan.account === null && this.active !== as) return { ok: false, message: `gh's active account changed${this.active ? ` to ${this.active}` : ''}; nothing was created` }
      const dupNow = taken(now)
      if (dupNow) return dupNow
      // The columns, now: without a loaded Board every issue would get Todo, and after the first
      // write it would be too late to say so.
      const columnOf = this.d.columns(plan.account)
      if (!columnOf) return { ok: false, message: 'Open the Board tab and wait for it to load, then try again. Nothing was created.' }
      return { plan, title, columnOf, as: as ?? null }
    } catch (e) {
      return { ok: false, message: `Nothing was created: ${thrown(e)}` }
    }
  }

  private async run(req: unknown): Promise<BoardCreateResult> {
    const ready = await this.checked(req)
    if ('ok' in ready) return ready
    const { plan, title, columnOf, as } = ready

    const gh = this.d.gh(plan.account)
    this.say('Creating the project…')
    // No answer is not "no": the mutation may have gone through.
    const maybe = (message: string): Failure => ({ ok: false, message: `${message.replace(/\.$/, '')}. The board may have been created all the same: check ${plan.owner}'s projects on GitHub before trying again.` })
    let made: RunResult
    try {
      made = await gh(graphql(CREATE_PROJECT, { o: plan.ownerId, t: title }), { timeoutMs: 60_000 })
    } catch (e) {
      return maybe(thrown(e))
    }
    const answer = gql(made.stdout)
    const proj = o(o(answer.data.createProjectV2).projectV2)
    const projectId = proj.id
    const number = proj.number
    if (!okId(projectId) || typeof number !== 'number') {
      const f = this.fail(made, plan.account)
      // GitHub gave its reason (with or without data), or the call was never sent: nothing was made.
      return answer.errors.some((e) => e.type !== 'NO_ANSWER') ? f : { ...f, ...maybe(f.message) }
    }
    const url = typeof proj.url === 'string' ? proj.url : ''

    // From here the project exists. Whatever happens, the result names it.
    const held: { job: Job | null } = { job: null }
    try {
      return await this.fill(gh, plan, title, columnOf, as, { id: projectId, number, url }, held)
    } catch (e) {
      return this.stopped(held.job, url, e)
    }
  }

  /** A throw after the project was made: its address, and the job kept for Try again when there is one. */
  private stopped(job: Job | null, url: string, e: unknown): Failure {
    if (job) {
      job.issues = job.issues.filter((x) => !job.done.has(x.id))
      this.pending.set(job.account ?? '', job)
    }
    return { ok: false, url, ...(job ? { retry: true } : {}), message: `The board was created${at(url)} but MasterDeck stopped before it was finished: ${thrown(e)}. ${job ? 'Try again to finish it.' : 'Delete it on GitHub, or pick it in Setup → Repos & boards.'}` }
  }

  private async fill(gh: GhRunner, plan: Plan, title: string, columnOf: Job['columnOf'], as: string | null, board: { id: string; number: number; url: string }, held: { job: Job | null }): Promise<BoardCreateResult> {
    const { url } = board
    this.say('Setting its columns…')
    const field = await this.columns(gh, board.id)
    if ('error' in field) return { ok: false, url, message: `The board was created${at(url)} but its columns could not be set: ${field.error}. Delete it on GitHub, or pick it in Setup → Repos & boards.` }

    const total = planTotal(plan)
    const job: Job = {
      account: plan.account, as, projectId: board.id, fieldId: field.id, options: field.options, url, title,
      entry: boardEntry({ owner: plan.owner, ownerType: plan.ownerType, number: board.number, id: board.id, title, fieldId: field.id, options: field.options }),
      selected: false,
      columnOf,
      open: new Map(plan.repos.map((r) => [r.repo, r.open])),
      expected: total === null ? null : Math.min(total, BOARD_ADD_MAX),
      issues: [],
      unread: plan.repos.map((r) => r.repo),
      unlinked: plan.repos.map((r) => ({ repo: r.repo, id: r.id })),
      done: new Set(),
    }
    // The board has its columns: from here a failure can be finished by Try again.
    held.job = job
    return this.work(gh, job)
  }

  /** Link what is not linked, read what is unread, add what is read, select the board: a first run, and every Try again. */
  private async work(gh: GhRunner, job: Job): Promise<BoardCreateResult> {
    const warnings: string[] = []
    const todo = job.unlinked
    for (const [i, r] of todo.entries()) {
      this.say(`Linking ${r.repo}…`, i, todo.length)
      const l = await gh(graphql(LINK_REPO, { p: job.projectId, r: r.id }), { timeoutMs: 60_000 })
      // Not fatal: the board works without the link (GitHub only uses it to list the board under the repository).
      if (o(gql(l.stdout).data.linkProjectV2ToRepository).repository) job.unlinked = job.unlinked.filter((x) => x !== r)
      else warnings.push(`${r.repo} could not be linked to the board`)
    }
    if (job.unread.length) {
      this.say('Reading the open issues…')
      if (await this.read(gh, job)) warnings.push(`Only the first ${BOARD_ADD_MAX} open issues were added`)
    }
    const added = await this.add(gh, job)
    return this.finish(job, added, warnings)
  }

  /** The Status field with the four columns: the default field's options renamed in place, or a new field when the project came without one. */
  private async columns(gh: GhRunner, projectId: string): Promise<{ id: string; options: Record<DerivedColumn, string> } | { error: string }> {
    const read = await gh(graphql(STATUS_FIELD, { p: projectId }), { timeoutMs: 30_000, force: true })
    const got = gql(read.stdout)
    // An unread field is not "no field": creating a second Status would be worse than stopping.
    if (!ghHasData(read) || !got.ok || !got.data.node) return { error: short(why(read), 200) }
    const before = parseField(o(got.data.node).field)
    const w = before
      ? await gh(graphql(updateStatusField(before.options), { f: before.id }), { timeoutMs: 60_000 })
      : await gh(graphql(createStatusField(), { p: projectId }), { timeoutMs: 60_000 })
    const wrote = gql(w.stdout)
    const after = parseField(o(wrote.data[before ? 'updateProjectV2Field' : 'createProjectV2Field']).projectV2Field)
    const ids = after ? optionIds(after.options) : null
    if (!after || !ids) return { error: short(w.stderr || wrote.errors[0]?.message || 'GitHub did not return the four columns', 200) }
    return { id: after.id, options: ids }
  }

  /**
   * Reads the open issues of the job's unread repositories, oldest first, into `job.issues`, each
   * with its column, until the board would hold BOARD_ADD_MAX. A page GitHub does not answer (no
   * data, a null repository, a rate limit, a timeout) leaves that repository in `job.unread`: what
   * was read of it is kept, and a retry reads it again from the start and skips what is known.
   * True when the limit cut something off.
   */
  private async read(gh: GhRunner, job: Job): Promise<boolean> {
    const todo = job.unread
    const unread: string[] = []
    const have = new Set([...job.done, ...job.issues.map((x) => x.id)])
    const room = () => BOARD_ADD_MAX - have.size
    let capped = false
    repos: for (const [i, repo] of todo.entries()) {
      // Full: a repository left with open issues (or an unknown number) is cut off, not unread.
      const rest = () => todo.slice(i + 1).some((r) => job.open.get(r) !== 0)
      if (room() <= 0) {
        capped = job.open.get(repo) !== 0 || rest()
        break
      }
      let cursor: string | null = null
      let whole = false
      for (let page = 0; page < BOARD_ADD_MAX / 100 && !whole; page++) {
        const r: RunResult = await gh(graphql(issueIdsQuery(repo), cursor ? { c: cursor } : {}), { timeoutMs: 60_000, force: true })
        const conn = o(o(gql(r.stdout).data.repository).issues)
        if (!answered(r) || !Array.isArray(conn.nodes)) {
          unread.push(repo)
          // A rate limit: the other repositories would only spend more of it.
          if (RATE.test(ghErrorText(r))) {
            unread.push(...todo.slice(i + 1))
            break repos
          }
          continue repos
        }
        let over = false
        for (const n of arr(conn.nodes).map(o)) {
          if (!okId(n.id) || typeof n.number !== 'number' || have.has(n.id)) continue
          if (room() <= 0) {
            over = true
            break
          }
          have.add(n.id)
          job.issues.push({ id: n.id, repo, number: n.number, column: job.columnOf(repo, n.number) })
        }
        const info = o(conn.pageInfo)
        const next = info.hasNextPage === true && typeof info.endCursor === 'string'
        if (room() <= 0) {
          capped = over || next || rest()
          break repos
        }
        if (next) cursor = info.endCursor as string
        else whole = true
      }
      // Pages ran out before the repository did.
      if (!whole) capped = true
    }
    job.unread = unread
    return capped
  }

  /**
   * Add the job's issues, BOARD_ADD_BATCH per request, each with its column as its Status. Goes on
   * past an issue GitHub refuses; stops when a request gets no answer. An issue counts as added
   * (`job.done`) once its Status request was answered: before that it stays for Try again, which
   * adds it again (GitHub gives the same item back) and sets the Status.
   */
  private async add(gh: GhRunner, job: Job): Promise<Added> {
    const wait = this.d.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
    const all = job.issues
    const failed: IssueRef[] = []
    let added = 0
    let unset = 0
    for (let i = 0; i < all.length; i += BOARD_ADD_BATCH) {
      if (i > 0) await wait(BATCH_PAUSE_MS)
      const batch = all.slice(i, i + BOARD_ADD_BATCH)
      this.say(`Adding issues ${i + batch.length} of ${all.length}…`, i, all.length)
      const r = await gh(graphql(addItems(batch.map((x) => x.id)), { p: job.projectId }), { timeoutMs: 120_000 })
      // No data at all (a rate limit, the network): the rest waits for Try again.
      if (!answered(r)) return { added, failed, left: all.slice(i), unset }
      const data = gql(r.stdout).data
      const got: { issue: IssueRef; item: string }[] = []
      batch.forEach((x, k) => {
        const item = o(o(data[`a${k}`]).item).id
        if (okId(item)) got.push({ issue: x, item })
        else failed.push(x)
      })
      if (!got.length) continue
      const s = await gh(graphql(setStatuses(got.map((x) => ({ item: x.item, option: job.options[x.issue.column] }))), { p: job.projectId, f: job.fieldId }), { timeoutMs: 120_000 })
      // The request itself failed: nothing says which Status was set, and going on would leave more
      // issues in "No status". These and the rest wait for Try again.
      if (!answered(s)) return { added, failed, left: [...got.map((x) => x.issue), ...all.slice(i + batch.length)], unset }
      const set = gql(s.stdout).data
      got.forEach((x, k) => {
        job.done.add(x.issue.id)
        added++
        // GitHub answered and refused this one: it is on the board, in "No status".
        if (!okId(o(o(set[`s${k}`]).projectV2Item).id)) unset++
      })
    }
    return { added, failed, left: [], unset }
  }

  /** After the adding: select the board (last, so the tab shows the repositories' issues until then), keep what is left for Try again, report. */
  private async finish(job: Job, a: Added, warnings: string[]): Promise<BoardCreateResult> {
    const key = job.account ?? ''
    const total = job.issues.length
    job.issues = [...a.failed, ...a.left]
    const failed = a.failed.map(label)
    if (!job.selected) {
      this.say('Selecting the board in MasterDeck…')
      const patch = boardConfigPatch(this.d.config(), job.account, job.entry)
      // The account has it already (picked in Setup meanwhile): nothing to write. No account took
      // the board: nothing would be written, so it is not "selected".
      const saved = patch === 'selected' ? { ok: true, message: '' } : patch ? await this.d.save(patch) : { ok: false, message: `${job.account ?? 'the GitHub account'} is no longer a connected account` }
      if (!saved.ok) {
        this.pending.set(key, job)
        return {
          ok: false, url: job.url, retry: true, added: a.added, total, failed, left: a.left.length,
          message: `The board was created${at(job.url)} and ${a.added} of ${total} issues were added, but MasterDeck could not select it: ${short(saved.message, 200)}. Try again, or pick it in Setup → Repos & boards.`,
        }
      }
      job.selected = true
    }
    this.d.refresh()
    const open = job.issues.length > 0 || job.unread.length > 0
    if (open) this.pending.set(key, job)
    else this.pending.delete(key)
    const of = job.expected === null ? '' : ` of ${job.expected}`
    const notes = job.unread.length ? [...warnings, `Could not read the open issues of ${job.unread.join(', ')}: ${job.done.size}${of} added`] : warnings
    // What this run had to add: what it tried, or with unread repositories what the plan counted less what earlier runs added.
    const goal = job.unread.length && job.expected !== null ? Math.max(total, job.expected - (job.done.size - a.added)) : total
    const message = !open
      ? `Added ${a.added} ${a.added === 1 ? 'issue' : 'issues'} to ${job.title}`
      : job.unread.length && job.expected === null
        ? `Added ${a.added} ${a.added === 1 ? 'issue' : 'issues'} to ${job.title} so far`
        : `Added ${a.added} of ${goal} issues to ${job.title}`
    return { ok: true, url: job.url, title: job.title, added: a.added, total, failed, left: a.left.length, unset: a.unset, unread: [...job.unread], warnings: notes, message }
  }

  /** Finish the board the last run for this account left unfinished: read what was unread, add what was not added (each with the column it had), select the board if that failed, link the repositories that are not linked. */
  async retry(account: unknown, remote: boolean): Promise<BoardCreateResult> {
    if (remote) return { ok: false, message: ON_MAC }
    if (this.running) return { ok: false, message: BUSY }
    const login = this.login(account)
    const job = login === undefined ? undefined : this.pending.get(login ?? '')
    if (login === undefined || !job) return { ok: false, message: 'nothing left to add' }
    this.running = true
    try {
      // One account: the calls go out as gh's active login. Another one now (gh auth switch since
      // the board was made) would add to the board with a token nobody confirmed: nothing is sent.
      if (job.account === null) {
        const active = (await this.d.ghLogins()).find((a) => a.active)?.login ?? null
        if (active !== job.as)
          return { ok: false, url: job.url, retry: true, message: `gh's active account changed${active ? ` to ${active}` : ''}; nothing was added.${job.as ? ` Switch gh back to ${job.as} (gh auth switch --user ${job.as}), then try again.` : ''}` }
      }
      return await this.work(this.d.gh(login), job)
    } catch (e) {
      return this.stopped(job, job.url, e)
    } finally {
      this.running = false
    }
  }
}

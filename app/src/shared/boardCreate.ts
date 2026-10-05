import { primaryLogin } from './accounts'
import type { AppConfig, ProjectConfig } from './appConfig'
import { DERIVED_COLUMNS, type DerivedColumn } from './derivedBoard'
import type { GhAccount } from './ghAuth'

/**
 * Creating a GitHub Projects (v2) board for an account that has none: the GraphQL documents, the
 * parsers of their answers, the config entry. Pure; main/boardCreate.ts runs them. Mutation names
 * and inputs were checked against GitHub's schema by introspection (the spec lists them).
 */
export const BOARD_ADD_BATCH = 20
export const BOARD_ADD_MAX = 1000
export const BOARD_MAX_REPOS = 10

/** A GitHub node or option id: safe inside a GraphQL string (no quote, backslash or space). */
const ID = /^[A-Za-z0-9_=+/-]{1,200}$/
export const okId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const q = (s: string) => JSON.stringify(s)
const id = (v: string): string => {
  if (!okId(v)) throw new Error(`bad id: ${String(v).slice(0, 40)}`)
  return q(v)
}

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export interface PlanRepo {
  repo: string
  id: string
  /** Open issues in it; null: GitHub did not say (unknown, which is not 0). */
  open: number | null
}

export interface BoardPlan {
  /** The account it runs as; null with one account. */
  account: string | null
  owner: string
  ownerType: 'organization' | 'user'
  ownerId: string
  /** The name offered. */
  title: string
  repos: PlanRepo[]
  /** Ticked repositories GitHub answered nothing for, and ones past BOARD_MAX_REPOS. */
  missing: string[]
  skipped: string[]
  /** Open issues in `repos` whose count is known (`planTotal`: null when one is not). */
  total: number
  /** The owner's open boards: a new one may not take the name of one. */
  existing: { title: string; url: string; number: number }[]
}
export type BoardPlanResult = ({ ok: true } & BoardPlan) | { ok: false; message: string; fix?: string[] }

export interface BoardProgress {
  text: string
  done: number
  total: number
}

export type BoardCreateResult =
  | {
      ok: true
      url: string
      title: string
      /** Issues added in this run, of `total` tried. */
      added: number
      total: number
      /** Issues GitHub refused (name#12), and how many were not tried (a rate limit stopped the run). */
      failed: string[]
      left: number
      /** Added, but their Status could not be set: they sit in "No status". */
      unset: number
      /** Repositories whose open issues could not be read: Try again reads them. */
      unread: string[]
      warnings: string[]
      message: string
    }
  | {
      ok: false
      message: string
      /** The board exists on GitHub all the same. */
      url?: string
      fix?: string[]
      /** The board exists and Try again can finish it (add what is left, select it). */
      retry?: boolean
      /** What the run added before it failed. */
      added?: number
      total?: number
      failed?: string[]
      left?: number
    }

export interface GqlError {
  message: string
  /** The aliased field the error is for (errors[].path[0]). */
  alias: string | null
  type: string | null
}

/** The error of a call that brought no data and no reason. */
export const NO_ANSWER = 'GitHub did not answer'

/**
 * A `gh api graphql` answer. `ok`: GitHub sent a `data` object (a partial answer counts). Without
 * one (gh failed, a timeout, `data: null`) the call failed: `ok` is false, `data` is {} and
 * `errors` is never empty, so a caller that counts fields cannot read it as "nothing failed".
 */
export function gql(stdout: string): { ok: boolean; data: Obj; errors: GqlError[] } {
  let j: unknown = null
  try {
    j = JSON.parse(stdout)
  } catch {
    // Not JSON: gh failed before GitHub answered.
  }
  const top = o(j)
  const ok = !!top.data && typeof top.data === 'object' && !Array.isArray(top.data)
  const errors = arr(top.errors).map(o).map((e) => {
    const first = arr(e.path)[0]
    return { message: typeof e.message === 'string' ? e.message : 'GitHub error', alias: typeof first === 'string' ? first : null, type: typeof e.type === 'string' ? e.type : null }
  })
  if (!ok && !errors.length) errors.push({ message: NO_ANSWER, alias: null, type: 'NO_ANSWER' })
  return { ok, data: o(top.data), errors }
}

export const defaultBoardTitle = (issueRepo: string): string => `${issueRepo || 'Issues'} board`

/** Zero-width and direction marks: they hide or reorder text, so a name could read as another one in the confirmation. */
const HIDDEN = /[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/

/** A board name as typed: spaces collapsed, 1-100 characters, no control, zero-width or direction character; else null. */
export function cleanTitle(raw: unknown): string | null {
  // Before the spaces are collapsed: \s takes U+FEFF with it.
  if (typeof raw !== 'string' || HIDDEN.test(raw)) return null
  const t = raw.replace(/\s+/g, ' ').trim()
  return t.length >= 1 && t.length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/.test(t) ? t : null
}

/** The owner's open board that already has this name (case and outer spaces aside), if any. */
export function titleTaken(existing: BoardPlan['existing'], title: string): BoardPlan['existing'][number] | null {
  const t = title.trim().toLowerCase()
  return existing.find((e) => e.title.trim().toLowerCase() === t) ?? null
}

/** One read: the owner's id, kind and open boards, and each repository's id and open-issue count. */
export function planQuery(repos: string[]): string {
  const parts = repos.map((r, i) => {
    const [owner, name] = r.split('/')
    return `r${i}: repository(owner: ${q(owner)}, name: ${q(name ?? '')}) { id nameWithOwner issues(states: OPEN) { totalCount } }`
  })
  return `query($login: String!) { repositoryOwner(login: $login) { __typename id login ... on ProjectV2Owner { projectsV2(first: 100, query: "is:open") { nodes { number title url closed } } } } ${parts.join(' ')} }`
}

export interface ParsedPlan {
  /** GitHub answered at all. */
  ok: boolean
  /** Every error of the answer (a repository GitHub does not know is one: it is in `missing`). */
  errors: GqlError[]
  /** The owner's boards came whole: without that, `existing` proves nothing about a name. */
  boardsRead: boolean
  ownerId: string | null
  ownerType: 'organization' | 'user'
  repos: PlanRepo[]
  missing: string[]
  existing: BoardPlan['existing']
}

export function parsePlan(stdout: string, repos: string[]): ParsedPlan {
  const { ok, data, errors } = gql(stdout)
  const owner = o(data.repositoryOwner)
  const got: PlanRepo[] = []
  const missing: string[] = []
  repos.forEach((repo, i) => {
    const n = o(data[`r${i}`])
    const open = o(n.issues).totalCount
    if (okId(n.id)) got.push({ repo, id: n.id, open: typeof open === 'number' ? open : null })
    else missing.push(repo)
  })
  const existing = arr(o(owner.projectsV2).nodes)
    .map(o)
    .filter((p) => p.closed !== true && typeof p.title === 'string' && typeof p.number === 'number')
    .map((p) => ({ number: p.number as number, title: p.title as string, url: typeof p.url === 'string' ? p.url : '' }))
  const boardsRead = ok && Array.isArray(o(owner.projectsV2).nodes) && !errors.some((e) => e.alias === 'repositoryOwner')
  return { ok, errors, boardsRead, ownerId: okId(owner.id) ? owner.id : null, ownerType: owner.__typename === 'User' ? 'user' : 'organization', repos: got, missing, existing }
}

/** The open issues a run would add; null when GitHub left out a repository's count. */
export function planTotal(p: Pick<BoardPlan, 'repos'>): number | null {
  let n = 0
  for (const r of p.repos) {
    if (r.open === null) return null
    n += r.open
  }
  return n
}

export const CREATE_PROJECT = 'mutation($o: ID!, $t: String!) { createProjectV2(input: {ownerId: $o, title: $t}) { projectV2 { id number url title } } }'
export const STATUS_FIELD = 'query($p: ID!) { node(id: $p) { ... on ProjectV2 { field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }'
export const LINK_REPO = 'mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: {projectId: $p, repositoryId: $r}) { repository { nameWithOwner } } }'
const FIELD_OUT = 'projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } }'

/**
 * The new board's Status options, in column order. `was`: the option of GitHub's default Status
 * field that becomes it. Its id is sent along, which GitHub's schema says keeps the option's
 * identity, so GitHub's built-in project workflows that point at it (item closed: Done) keep working.
 */
export const BOARD_OPTIONS: { name: DerivedColumn; color: string; was: string | null }[] = [
  { name: 'Todo', color: 'GRAY', was: 'Todo' },
  { name: 'In Dev', color: 'YELLOW', was: 'In Progress' },
  { name: 'PR Raised', color: 'BLUE', was: null },
  { name: 'Done', color: 'GREEN', was: 'Done' },
]

function optionsLiteral(existing: { id: string; name: string }[]): string {
  const one = (x: (typeof BOARD_OPTIONS)[number]) => {
    // Its new name first: a field renamed by an earlier run keeps its options too.
    const keep = existing.find((e) => e.name === x.name && okId(e.id)) ?? existing.find((e) => e.name === x.was && okId(e.id))
    return `{${keep ? `id: ${q(keep.id)}, ` : ''}name: ${q(x.name)}, color: ${x.color}, description: ""}`
  }
  return `[${BOARD_OPTIONS.map(one).join(', ')}]`
}

/** Replace the Status field's options with the four columns (`$f`: the field). */
export const updateStatusField = (existing: { id: string; name: string }[]): string =>
  `mutation($f: ID!) { updateProjectV2Field(input: {fieldId: $f, singleSelectOptions: ${optionsLiteral(existing)}}) { ${FIELD_OUT} } }`

/** A project that came without a Status field: make it (`$p`: the project). */
export const createStatusField = (): string =>
  `mutation($p: ID!) { createProjectV2Field(input: {projectId: $p, dataType: SINGLE_SELECT, name: "Status", singleSelectOptions: ${optionsLiteral([])}}) { ${FIELD_OUT} } }`

export function parseField(node: unknown): { id: string; options: { id: string; name: string }[] } | null {
  const f = o(node)
  if (!okId(f.id)) return null
  const options = arr(f.options)
    .map(o)
    .filter((x) => okId(x.id) && typeof x.name === 'string')
    .map((x) => ({ id: x.id as string, name: x.name as string }))
  return { id: f.id, options }
}

/** The option id of each of the four columns; null when one is missing. */
export function optionIds(options: { id: string; name: string }[]): Record<DerivedColumn, string> | null {
  const out: Partial<Record<DerivedColumn, string>> = {}
  for (const c of DERIVED_COLUMNS) {
    const hit = options.find((x) => x.name === c)
    if (!hit) return null
    out[c] = hit.id
  }
  return out as Record<DerivedColumn, string>
}

/** A repository's open issues, oldest first, 100 a page (`$c`: the cursor). */
export function issueIdsQuery(repo: string): string {
  const [owner, name] = repo.split('/')
  return `query($c: String) { repository(owner: ${q(owner)}, name: ${q(name ?? '')}) { issues(states: OPEN, first: 100, after: $c, orderBy: {field: CREATED_AT, direction: ASC}) { pageInfo { hasNextPage endCursor } nodes { id number } } } }`
}

/** Add issues to the project (`$p`), one aliased field each: a0, a1, … */
export const addItems = (ids: string[]): string =>
  `mutation($p: ID!) { ${ids.map((x, i) => `a${i}: addProjectV2ItemById(input: {projectId: $p, contentId: ${id(x)}}) { item { id } }`).join(' ')} }`

/** Set the Status (`$f`) of project items (`$p`): s0, s1, … */
export const setStatuses = (pairs: { item: string; option: string }[]): string =>
  `mutation($p: ID!, $f: ID!) { ${pairs.map((x, i) => `s${i}: updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: ${id(x.item)}, fieldId: $f, value: {singleSelectOptionId: ${id(x.option)}}}) { projectV2Item { id } }`).join(' ')} }`

/** The board as the config keeps it. `sprintless`: it has no sprint field, so the sprint filter never applies to it. */
export function boardEntry(b: { owner: string; ownerType: 'organization' | 'user'; number: number; id: string; title: string; fieldId: string; options: Record<DerivedColumn, string> }): ProjectConfig {
  return {
    owner: b.owner,
    ownerType: b.ownerType,
    number: b.number,
    id: b.id,
    title: b.title,
    statusField: 'Status',
    statusFieldId: b.fieldId,
    statusOptions: { ...b.options },
    columns: [...DERIVED_COLUMNS],
    statuses: { ready: 'Todo', inProgress: 'In Dev', prRaised: 'PR Raised', devDone: 'Done', blocked: [], done: ['Done'], finished: ['Done'], assignable: ['Todo'], resumable: ['In Dev', 'PR Raised'], rank: {} },
    sprintField: '',
    sprintless: true,
  }
}

/**
 * What `master config save` gets: the board added to its account (`login` null: the only one),
 * every other account as it is. A config from before accounts: the top-level list. Null when no
 * account has that login (GitHub logins differ in case only by spelling): nothing would be
 * written, and the caller must not say the board was selected.
 */
export function boardConfigPatch(c: AppConfig, login: string | null, entry: ProjectConfig): Record<string, unknown> | null {
  if (!c.accounts.length) return login === null ? { projects: [...c.projects, entry] } : null
  const who = (login ?? primaryLogin(c) ?? '').toLowerCase()
  const at = c.accounts.findIndex((a) => a.login.toLowerCase() === who)
  if (at < 0) return null
  return { accounts: c.accounts.map((a, i) => (i === at ? { ...a, projects: [...a.projects, entry] } : a)) }
}

/**
 * gh lists this login's token scopes and `project` is not among them (`read:project` cannot
 * create). No scope line at all (a fine-grained token) is not "lacks": GitHub's own answer decides.
 * `login` null: gh's active account.
 */
export function lacksProjectScope(accounts: GhAccount[], login: string | null): boolean {
  const a = login ? accounts.find((x) => x.login.toLowerCase() === login.toLowerCase()) : accounts.find((x) => x.active)
  return !!a && a.scopes.length > 0 && !a.scopes.includes('project')
}

export const SCOPE_ERROR = /INSUFFICIENT_SCOPES|required scopes/i

/**
 * The commands that give an account's token the `project` scope: `gh auth refresh` only works on
 * gh's active account, so a second account is switched to and back. When gh's active account is
 * not known the switch still comes first (a bare refresh would widen whichever account is active);
 * there is then no account to switch back to.
 */
export function scopeFix(login: string | null, ghActive: string | null): string[] {
  const refresh = 'gh auth refresh -h github.com -s project'
  const to = (l: string) => `gh auth switch -h github.com -u ${l}`
  if (!login || (ghActive && login.toLowerCase() === ghActive.toLowerCase())) return [refresh]
  return [to(login), refresh, ...(ghActive ? [to(ghActive)] : [])]
}

/** The confirmation's lines: everything a run creates or changes. */
export function confirmLines(p: BoardPlan, title: string): string[] {
  const n = p.repos.length
  // The plan's own total, unless a repository's count is missing.
  const total = planTotal(p) === null ? null : p.total
  const left = [...p.missing.map((r) => `${r} (GitHub did not answer)`), ...p.skipped.map((r) => `${r} (more than ${BOARD_MAX_REPOS} repositories)`)]
  return [
    `A GitHub project "${title}" under ${p.owner}`,
    `Columns: ${DERIVED_COLUMNS.join(', ')}`,
    `Linked to ${n} ${n === 1 ? 'repository' : 'repositories'}: ${p.repos.map((r) => r.repo).join(', ')}`,
    total === null
      ? `An unknown number of open issues added to it (${BOARD_ADD_MAX} at most)`
      : total > BOARD_ADD_MAX
        ? `The first ${BOARD_ADD_MAX} of ${total} open issues added to it`
        : `${total} open ${total === 1 ? 'issue' : 'issues'} added to it`,
    `The board selected for ${p.account ?? p.owner} in MasterDeck`,
    ...(left.length ? [`Left out: ${left.join(', ')}`] : []),
  ]
}

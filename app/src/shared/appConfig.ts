/**
 * The user's GitHub and board settings (`~/.claude/master/config.json`, shared with the master CLI
 * and babysit-ticket). Main loads it and sends it with every state update; both sides keep the
 * current copy here so helpers can use it without threading it through every call.
 */

export interface StatusMap {
  ready: string
  inProgress: string
  prRaised: string
  devDone: string
  blocked: string[]
  done: string[]
  finished: string[]
  assignable: string[]
  resumable: string[]
  rank: Record<string, number>
}

/** One project board, with its own status field, options, columns and status meanings. */
export interface ProjectConfig {
  owner: string
  ownerType: 'organization' | 'user'
  number: number
  id: string
  title: string
  statusField: string
  statusFieldId: string
  statusOptions: Record<string, string>
  columns: string[]
  statuses: StatusMap
  sprintField: string
  /** A board MasterDeck created: it has no sprint field, so the sprint picker does not apply to it. */
  sprintless?: true
}

/**
 * One connected GitHub account (`accounts` in config.json). The primary one's owner, repos and
 * boards are also written as the top-level fields (`master config save` mirrors them), so the
 * master CLI's older readers, tt.sh and older app builds keep working.
 */
export interface AccountConfig {
  /** gh login: the key. */
  login: string
  /** git user.name in this account's sessions. */
  name: string
  /** git user.email in this account's sessions. */
  email: string
  /** Exactly one: master, plain shells and sessions outside every account's repos use it. */
  primary?: true
  owner: string
  ownerType: 'organization' | 'user'
  issueRepo: string
  repos: string[]
  allRepos?: boolean
  projects: ProjectConfig[]
  allProjects?: boolean
  /** Where this account's checkouts live: a session for one of its tickets starts in its
   * repository's checkout there. Absent: the config's `workspace` (the primary's is always that one). */
  workspace?: string
}

export interface AppConfig {
  configured: boolean
  path: string
  owner: string
  ownerType: 'organization' | 'user'
  issueRepo: string
  project: number
  projectId: string
  statusFieldId: string
  statusOptions: Record<string, string>
  columns: string[]
  statuses: StatusMap
  sprintQuery: string
  sprintField: string
  workspace: string
  masterName: string
  /** False: no master-agent. Proposals, sweeps and session messages to master are off; the rest works. */
  masterEnabled: boolean
  /** Every selected repo (owner/name), the primary one (owner/issueRepo) first. */
  repos: string[]
  /** "Select all": every repo counts, listed or not. */
  allRepos: boolean
  /** Every selected board; older configs: the one project above. */
  projects: ProjectConfig[]
  allProjects: boolean
  /** Connected GitHub accounts, the primary first; [] before the first launch of the multi-account
   * version. A repo is under one account only. `repos`/`projects` above are every account's. */
  accounts: AccountConfig[]
  /** Linked sessions: `auto: false` stops summarizing a linked session on every Stop (Sync now still works). No UI. */
  peerSync?: { auto?: boolean }
  /** Setup's "code lives in": issues filed in `issues` are built in `code` (a tracker and its code
   * repository). A ticket's session starts in `code`'s checkout, as its account. Absent: none. */
  codeRepos?: CodeRepo[]
}

export interface CodeRepo {
  /** owner/name the issues are filed in. */
  issues: string
  /** owner/name their code is in. */
  code: string
}

export const DEFAULT_CONFIG: AppConfig = {
  configured: false,
  path: '',
  owner: '',
  ownerType: 'organization',
  issueRepo: '',
  project: 0,
  projectId: '',
  statusFieldId: '',
  statusOptions: {},
  columns: ['Todo', 'In Progress', 'In Review', 'Done'],
  statuses: {
    ready: 'Todo',
    inProgress: 'In Progress',
    prRaised: 'In Review',
    devDone: 'Done',
    blocked: ['Blocked'],
    done: ['Done'],
    finished: ['Done'],
    assignable: ['Todo'],
    resumable: ['In Progress', 'In Review'],
    rank: {},
  },
  sprintQuery: 'is:issue assignee:@me sprint:@current',
  sprintField: 'Sprint',
  workspace: '',
  masterName: 'master-agent',
  masterEnabled: true,
  repos: [],
  allRepos: false,
  projects: [],
  allProjects: false,
  accounts: [],
}

let current: AppConfig = DEFAULT_CONFIG

export function setConfig(c: AppConfig): void {
  current = c
}

export function getConfig(): AppConfig {
  return current
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const strs = (v: unknown, d: string[]): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : d)
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)

function parseStatuses(v: unknown): StatusMap {
  const s = obj(v)
  const d = DEFAULT_CONFIG
  const rank: Record<string, number> = {}
  for (const [k, x] of Object.entries(obj(s.rank))) if (typeof x === 'number') rank[k] = x
  return {
    ready: str(s.ready, d.statuses.ready),
    inProgress: str(s.inProgress, d.statuses.inProgress),
    prRaised: str(s.prRaised, d.statuses.prRaised),
    devDone: str(s.devDone, d.statuses.devDone),
    blocked: strs(s.blocked, d.statuses.blocked),
    done: strs(s.done, d.statuses.done),
    finished: strs(s.finished, strs(s.done, d.statuses.finished)),
    assignable: strs(s.assignable, d.statuses.assignable),
    resumable: strs(s.resumable, d.statuses.resumable),
    rank,
  }
}

function options(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(obj(v))) if (typeof x === 'string') out[k] = x
  return out
}

const isProject = (p: Obj, owner: string): boolean => typeof p.number === 'number' && p.number > 0 && (typeof p.owner === 'string' || !!owner)

function parseProject(p: Obj, owner: string): ProjectConfig {
  return {
    owner: str(p.owner, owner),
    ownerType: p.ownerType === 'user' ? 'user' : 'organization',
    number: p.number as number,
    id: str(p.id, ''),
    title: str(p.title, `Project ${p.number}`),
    statusField: str(p.statusField, 'Status'),
    statusFieldId: str(p.statusFieldId, ''),
    statusOptions: options(p.statusOptions),
    columns: strs(p.columns, []),
    statuses: parseStatuses(p.statuses),
    sprintField: str(p.sprintField, ''),
    ...(p.sprintless === true ? { sprintless: true as const } : {}),
  }
}

const LOGIN = /^[A-Za-z0-9-]{1,39}$/
const low = (s: string) => s.toLowerCase()

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/** The `accounts` list: the primary first (exactly one), each login once, each repo under the first account that lists it. */
function parseAccounts(v: unknown): AccountConfig[] {
  const raw = (Array.isArray(v) ? v : []).map(obj).filter((a) => typeof a.login === 'string' && LOGIN.test(a.login))
  raw.sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
  const ownerOf = new Map<string, string>()
  const out: AccountConfig[] = []
  for (const a of raw) {
    const login = a.login as string
    if (out.some((x) => low(x.login) === low(login))) continue
    const owner = str(a.owner, '')
    const issueRepo = str(a.issueRepo, '')
    const listed = [owner && issueRepo ? `${owner}/${issueRepo}` : '', ...strs(a.repos, [])].filter((r) => REPO.test(r))
    const repos: string[] = []
    for (const r of listed) {
      const had = ownerOf.get(low(r))
      if (had === login) continue
      if (had) {
        console.warn(`config: ${r} is under ${had} already; left out of ${login}`)
        continue
      }
      ownerOf.set(low(r), login)
      repos.push(r)
    }
    out.push({
      login,
      name: str(a.name, '') || login,
      email: str(a.email, ''),
      ...(out.length === 0 ? { primary: true as const } : {}),
      owner,
      ownerType: a.ownerType === 'user' ? 'user' : 'organization',
      issueRepo,
      repos,
      allRepos: a.allRepos === true,
      projects: (Array.isArray(a.projects) ? a.projects : []).map(obj).filter((p) => isProject(p, owner)).map((p) => parseProject(p, owner)),
      allProjects: a.allProjects === true,
      ...(typeof a.workspace === 'string' && a.workspace.trim() ? { workspace: a.workspace } : {}),
    })
  }
  return out
}

/** The "code lives in" pairs: both owner/name, not the same repository, one per issue repository (the first). */
export function parseCodeRepos(v: unknown): CodeRepo[] {
  const out: CodeRepo[] = []
  for (const e of (Array.isArray(v) ? v : []).map(obj)) {
    const issues = str(e.issues, ''), code = str(e.code, '')
    if (REPO.test(issues) && REPO.test(code) && low(issues) !== low(code) && !out.some((x) => low(x.issues) === low(issues))) out.push({ issues, code })
  }
  return out
}

/** `master config show` output (or anything like it) to an AppConfig, defaults filling gaps. */
export function parseConfig(raw: unknown): AppConfig {
  const top = obj(raw)
  const c = obj(top.config ?? raw)
  const d = DEFAULT_CONFIG
  const owner = str(c.owner, '')
  const issueRepo = str(c.issueRepo, '')
  const primary = owner && issueRepo ? `${owner}/${issueRepo}` : ''
  const listed = strs(c.repos, []).filter((r) => REPO.test(r) && r.toLowerCase() !== primary.toLowerCase())
  const statuses = parseStatuses(c.statuses)
  const columns = strs(c.columns, d.columns)
  const project = typeof c.project === 'number' ? c.project : 0
  let projects: ProjectConfig[] = (Array.isArray(c.projects) ? c.projects : []).map(obj).filter((p) => isProject(p, owner)).map((p) => parseProject(p, owner))
  if (!projects.length && project > 0)
    projects = [
      {
        owner,
        ownerType: c.ownerType === 'user' ? 'user' : 'organization',
        number: project,
        id: str(c.projectId, ''),
        title: `Project ${project}`,
        statusField: 'Status',
        statusFieldId: str(c.statusFieldId, ''),
        statusOptions: options(c.statusOptions),
        columns,
        statuses,
        sprintField: str(c.sprintField, d.sprintField),
      },
    ]
  const accounts = parseAccounts(c.accounts)
  // Every account's repos and boards count (primary first): the Board, tickets and statuses see them all.
  const unionRepos = accounts.flatMap((a) => a.repos)
  const unionProjects = accounts.flatMap((a) => a.projects).filter((p, i, all) => all.findIndex((x) => projectKey(x) === projectKey(p)) === i)
  return {
    configured: typeof top.configured === 'boolean' ? top.configured : !!(owner && issueRepo),
    path: str(top.path, ''),
    owner,
    ownerType: c.ownerType === 'user' ? 'user' : 'organization',
    issueRepo,
    project,
    projectId: str(c.projectId, ''),
    statusFieldId: str(c.statusFieldId, ''),
    statusOptions: options(c.statusOptions),
    columns,
    statuses,
    sprintQuery: str(c.sprintQuery, d.sprintQuery),
    sprintField: str(c.sprintField, d.sprintField),
    workspace: str(c.workspace, d.workspace),
    masterName: str(c.masterName, d.masterName),
    masterEnabled: c.masterEnabled !== false,
    repos: unionRepos.length ? unionRepos : primary ? [primary, ...listed] : listed,
    allRepos: c.allRepos === true || accounts.some((a) => a.allRepos),
    projects: unionProjects.length ? unionProjects : projects,
    allProjects: c.allProjects === true || accounts.some((a) => a.allProjects),
    accounts,
    ...(typeof obj(c.peerSync).auto === 'boolean' ? { peerSync: { auto: obj(c.peerSync).auto as boolean } } : {}),
    ...(parseCodeRepos(c.codeRepos).length ? { codeRepos: parseCodeRepos(c.codeRepos) } : {}),
  }
}

/** owner/name of the primary issue repo: bare issue numbers mean an issue there. */
export function primaryRepo(c: AppConfig = current): string {
  return c.owner && c.issueRepo ? `${c.owner}/${c.issueRepo}` : ''
}

export function projectKey(p: { owner: string; number: number }): string {
  return `${p.owner}/${p.number}`
}

export function projectByKey(key: string | null | undefined, c: AppConfig = current): ProjectConfig | null {
  return c.projects.find((p) => projectKey(p) === key) ?? null
}

/** A board's own status meanings; the config's (first board's) for a card with no known board. */
export function statusesFor(key: string | null | undefined, c: AppConfig = current): StatusMap {
  return projectByKey(key, c)?.statuses ?? c.statuses
}

/** Where the code of an issue in `repo` lives (null = the primary repo): Setup's "code lives in", else `repo`. The CLI's `config.code_repo`. */
export function codeRepoOf(repo: string | null | undefined, c: AppConfig = current): string {
  const full = repo || primaryRepo(c)
  return (full && c.codeRepos?.find((x) => low(x.issues) === low(full))?.code) || full
}

/** Is a ticket in this repo one of ours? Every repo after "Select all". */
export function repoSelected(repo: string | null | undefined, c: AppConfig = current): boolean {
  if (!repo || c.allRepos) return true
  return c.repos.some((r) => r.toLowerCase() === repo.toLowerCase())
}

/** owner/repo of the issue tracker, as used in messages ("acme/tracker#12"). */
export function issueRef(c: AppConfig = current): string {
  return `${c.owner}/${c.issueRepo}`
}

/** An issue's page; `repo` null (or omitted) is the primary repo. */
export function issueUrl(n: number, repo?: string | null, c: AppConfig = current): string {
  return `https://github.com/${repo || primaryRepo(c)}/issues/${n}`
}

/** Board order for forward-only moves: explicit rank, else column position. `project` picks a
 * board's own order; without it, the config's (first board's). */
export function statusRank(status: string | null, c: AppConfig = current, project?: string | null): number {
  if (!status) return -1
  const p = projectByKey(project, c)
  const rank = p ? p.statuses.rank : c.statuses.rank
  if (status in rank) return rank[status]
  return (p ? p.columns : c.columns).indexOf(status)
}

export type StatusGroup = 'todo' | 'progress' | 'review' | 'done' | 'blocked' | 'other'

function groupIn(status: string, s: StatusMap): StatusGroup {
  if (s.blocked.includes(status)) return 'blocked'
  if (s.done.includes(status)) return 'done'
  if (status === s.prRaised) return 'review'
  if (status === s.inProgress || s.resumable.includes(status)) return 'progress'
  if (status === s.ready || s.assignable.includes(status)) return 'todo'
  return 'other'
}

/** What a status means, for colours and sprint summaries: on the card's board when `project` is
 * given, else on the first board that knows the name. */
export function statusGroup(status: string | null, c: AppConfig = current, project?: string | null): StatusGroup {
  if (!status) return 'todo'
  const p = projectByKey(project, c)
  if (p) return groupIn(status, p.statuses)
  for (const s of [c.statuses, ...c.projects.map((x) => x.statuses)]) {
    const g = groupIn(status, s)
    if (g !== 'other') return g
  }
  return 'other'
}

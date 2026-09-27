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

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

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
  let projects: ProjectConfig[] = (Array.isArray(c.projects) ? c.projects : [])
    .map(obj)
    .filter((p) => typeof p.number === 'number' && p.number > 0 && (typeof p.owner === 'string' || owner))
    .map((p) => ({
      owner: str(p.owner, owner),
      ownerType: p.ownerType === 'user' ? ('user' as const) : ('organization' as const),
      number: p.number as number,
      id: str(p.id, ''),
      title: str(p.title, `Project ${p.number}`),
      statusField: str(p.statusField, 'Status'),
      statusFieldId: str(p.statusFieldId, ''),
      statusOptions: options(p.statusOptions),
      columns: strs(p.columns, []),
      statuses: parseStatuses(p.statuses),
      sprintField: str(p.sprintField, ''),
    }))
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
    repos: primary ? [primary, ...listed] : listed,
    allRepos: c.allRepos === true,
    projects,
    allProjects: c.allProjects === true,
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

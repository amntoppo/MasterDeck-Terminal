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

/** `master config show` output (or anything like it) to an AppConfig, defaults filling gaps. */
export function parseConfig(raw: unknown): AppConfig {
  const top = obj(raw)
  const c = obj(top.config ?? raw)
  const s = obj(c.statuses)
  const d = DEFAULT_CONFIG
  const rank: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj(s.rank))) if (typeof v === 'number') rank[k] = v
  const options: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(c.statusOptions))) if (typeof v === 'string') options[k] = v
  const owner = str(c.owner, '')
  const issueRepo = str(c.issueRepo, '')
  return {
    configured: typeof top.configured === 'boolean' ? top.configured : !!(owner && issueRepo),
    path: str(top.path, ''),
    owner,
    ownerType: c.ownerType === 'user' ? 'user' : 'organization',
    issueRepo,
    project: typeof c.project === 'number' ? c.project : 0,
    projectId: str(c.projectId, ''),
    statusFieldId: str(c.statusFieldId, ''),
    statusOptions: options,
    columns: strs(c.columns, d.columns),
    statuses: {
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
    },
    sprintQuery: str(c.sprintQuery, d.sprintQuery),
    sprintField: str(c.sprintField, d.sprintField),
    workspace: str(c.workspace, d.workspace),
    masterName: str(c.masterName, d.masterName),
    masterEnabled: c.masterEnabled !== false,
  }
}

/** owner/repo of the issue tracker, as used in messages ("acme/tracker#12"). */
export function issueRef(c: AppConfig = current): string {
  return `${c.owner}/${c.issueRepo}`
}

export function issueUrl(n: number, c: AppConfig = current): string {
  return `https://github.com/${c.owner}/${c.issueRepo}/issues/${n}`
}

/** Board order for forward-only moves: explicit rank, else column position. */
export function statusRank(status: string | null, c: AppConfig = current): number {
  if (!status) return -1
  if (status in c.statuses.rank) return c.statuses.rank[status]
  return c.columns.indexOf(status)
}

export type StatusGroup = 'todo' | 'progress' | 'review' | 'done' | 'blocked' | 'other'

/** What a status means, for colours and sprint summaries. */
export function statusGroup(status: string | null, c: AppConfig = current): StatusGroup {
  if (!status) return 'todo'
  const s = c.statuses
  if (s.blocked.includes(status)) return 'blocked'
  if (s.done.includes(status)) return 'done'
  if (status === s.prRaised) return 'review'
  if (status === s.inProgress || s.resumable.includes(status)) return 'progress'
  if (status === s.ready || s.assignable.includes(status)) return 'todo'
  return 'other'
}

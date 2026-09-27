import type { ProjectConfig, StatusMap } from './appConfig'

/** What `master config detect --all` found: every owner gh can reach, with repos and boards. */
export interface DetectedBoard extends ProjectConfig {
  closed: boolean
  items: number
  error?: string
}

export interface DetectedOwner {
  login: string
  type: 'user' | 'organization'
  repos: { repo: string; openIssues: number }[]
  projects: DetectedBoard[]
}

export interface DetectAll {
  user: string | null
  owners: DetectedOwner[]
  error?: string
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')

function statuses(v: unknown): StatusMap {
  const s = obj(v)
  const rank: Record<string, number> = {}
  for (const [k, x] of Object.entries(obj(s.rank))) if (typeof x === 'number') rank[k] = x
  return {
    ready: str(s.ready),
    inProgress: str(s.inProgress),
    prRaised: str(s.prRaised),
    devDone: str(s.devDone),
    blocked: strs(s.blocked),
    done: strs(s.done),
    finished: strs(s.finished),
    assignable: strs(s.assignable),
    resumable: strs(s.resumable),
    rank,
  }
}

export function parseDetectAll(raw: unknown): DetectAll {
  const r = obj(raw)
  const owners: DetectedOwner[] = arr(r.owners)
    .map(obj)
    .filter((o) => typeof o.login === 'string')
    .map((o) => ({
      login: o.login as string,
      type: o.type === 'user' ? 'user' : 'organization',
      repos: arr(o.repos)
        .map(obj)
        .filter((x) => typeof x.repo === 'string')
        .map((x) => ({ repo: x.repo as string, openIssues: typeof x.openIssues === 'number' ? x.openIssues : 0 })),
      projects: arr(o.projects)
        .map(obj)
        .filter((p) => typeof p.number === 'number')
        .map((p) => {
          const options: Record<string, string> = {}
          for (const [k, x] of Object.entries(obj(p.statusOptions))) if (typeof x === 'string') options[k] = x
          return {
            owner: str(p.owner, o.login as string),
            ownerType: p.ownerType === 'user' ? ('user' as const) : ('organization' as const),
            number: p.number as number,
            id: str(p.id),
            title: str(p.title, `Project ${p.number}`),
            statusField: str(p.statusField, 'Status'),
            statusFieldId: str(p.statusFieldId),
            statusOptions: options,
            columns: strs(p.columns),
            statuses: statuses(p.statuses),
            sprintField: str(p.sprintField),
            closed: p.closed === true,
            items: typeof p.items === 'number' ? p.items : 0,
            ...(typeof p.error === 'string' ? { error: p.error } : {}),
          }
        }),
    }))
  return { user: typeof r.user === 'string' ? r.user : null, owners, ...(typeof r.error === 'string' ? { error: r.error } : {}) }
}

import { getConfig, statusRank } from './appConfig'
import type { Badge, Board, BoardCard } from './types'

export type Group = 'done' | 'progress' | 'blocked' | 'todo'

/** Where a card counts: Done (dev done and later), In progress, Blocked (column or badge), To do. */
export function groupOf(c: BoardCard, badge?: Badge['kind']): Group {
  const cfg = getConfig()
  const s = cfg.statuses
  if ((c.status && s.blocked.includes(c.status)) || badge === 'blocked') return 'blocked'
  if (!c.status) return 'todo'
  if (s.done.includes(c.status) || (!s.assignable.includes(c.status) && statusRank(c.status, cfg) >= statusRank(s.devDone, cfg) && statusRank(s.devDone, cfg) >= 0)) return 'done'
  if (c.status === s.inProgress || c.status === s.prRaised) return 'progress'
  return 'todo'
}

export interface Summary {
  total: number
  counts: Record<Group, number>
  byGroup: Record<Group, BoardCard[]>
  byAssignee: { login: string; done: number; progress: number; blocked: number; todo: number }[]
}

export function summarize(b: Board, badgeOf: (n: number) => Badge['kind'] | undefined = () => undefined): Summary {
  const byGroup: Record<Group, BoardCard[]> = { done: [], progress: [], blocked: [], todo: [] }
  const people = new Map<string, { login: string; done: number; progress: number; blocked: number; todo: number }>()
  for (const c of b.cards) {
    const g = groupOf(c, badgeOf(c.number))
    byGroup[g].push(c)
    for (const who of c.assignees.length ? c.assignees : ['(unassigned)']) {
      const row = people.get(who) ?? { login: who, done: 0, progress: 0, blocked: 0, todo: 0 }
      row[g]++
      people.set(who, row)
    }
  }
  const counts = { done: byGroup.done.length, progress: byGroup.progress.length, blocked: byGroup.blocked.length, todo: byGroup.todo.length }
  return { total: b.cards.length, counts, byGroup, byAssignee: [...people.values()].sort((x, y) => y.done + y.progress - (x.done + x.progress)) }
}

/** One day's point of a sprint burndown, recorded at each board refresh. */
export interface BurnPoint {
  date: string
  total: number
  done: number
}

/** Keep one point per day (the latest), for a sprint's history. */
export function addBurnPoint(history: BurnPoint[], p: BurnPoint): BurnPoint[] {
  return [...history.filter((h) => h.date !== p.date), p].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Remaining work per sprint day (null for days with no record) and the ideal straight line from
 * the first day's total to zero.
 */
export function burndown(history: BurnPoint[], start: string, days: number): { date: string; remaining: number | null; ideal: number }[] {
  const byDate = new Map(history.map((h) => [h.date, h]))
  const first = history[0]?.total ?? 0
  const out = []
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(`${start}T00:00:00`) + i * 86_400_000)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const h = byDate.get(date)
    out.push({ date, remaining: h ? h.total - h.done : null, ideal: Math.max(0, first - (first * i) / Math.max(1, days - 1)) })
  }
  return out
}

export function summaryMarkdown(sprint: string, s: Summary): string {
  const line = (c: BoardCard) => `- #${c.number} ${c.title}${c.assignees.length ? ` (${c.assignees.join(', ')})` : ''}`
  const part = (title: string, cards: BoardCard[]) => (cards.length ? [`**${title} (${cards.length})**`, ...cards.map(line), ''] : [])
  return [
    `### ${sprint}: ${s.counts.done}/${s.total} done, ${s.counts.progress} in progress, ${s.counts.blocked} blocked`,
    '',
    ...part('Blocked', s.byGroup.blocked),
    ...part('In progress', s.byGroup.progress),
    ...part('Done', s.byGroup.done),
    ...part('To do', s.byGroup.todo),
  ]
    .join('\n')
    .trim()
}

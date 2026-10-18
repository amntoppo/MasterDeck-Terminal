/**
 * Tabs in the session list (#146): named groups the user puts sessions in. "All" is not a group: it
 * is every session, and a session in no group is only there. A session (Session.key) is in at most
 * one group. Kept by main (`session-groups.json`, main/sessionGroups.ts) so a resumed copy keeps its
 * tab and the window and the web app see the same tabs. Internally "groups": a session's own tabs
 * (Terminal, files, diffs) are shared/sessionTabs.ts.
 */

export interface SessionGroup {
  id: string
  name: string
}

export interface SessionGroups {
  /** In the tab bar's order, after All. */
  groups: SessionGroup[]
  /** Session.key → group id. */
  of: Record<string, string>
}

export type GroupOp =
  | { op: 'add'; name: string }
  | { op: 'rename'; id: string; name: string }
  /** Put the tab before `before` (null: last). */
  | { op: 'move'; id: string; before: string | null }
  | { op: 'remove'; id: string }
  /** Put a session in a tab, or (null) take it out: All only. */
  | { op: 'assign'; key: string; group: string | null }

export const GROUP_MAX = 30
export const NAME_MAX = 40
/** The tab that is every session; its id is never a group's. */
export const ALL = 'all'

const ID = /^g[0-9a-f]{8}$/
const KEY = /^[A-Za-z0-9_-]{1,64}$/
const okKey = (k: unknown): k is string => typeof k === 'string' && KEY.test(k) && !(k in Object.prototype)
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

export function emptyGroups(): SessionGroups {
  return { groups: [], of: {} }
}

export function newGroupId(rand: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 8; i++) s += Math.floor(rand() * 16).toString(16)
  return `g${s}`
}

/** A tab name as typed, or an error to show. */
export function cleanName(raw: unknown, groups: SessionGroup[], self: string | null = null): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'Name the tab.' }
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  if (!name) return { error: 'Name the tab.' }
  if (name.length > NAME_MAX) return { error: `A tab name is at most ${NAME_MAX} characters.` }
  const low = name.toLowerCase()
  if (low === 'all') return { error: '"All" is the tab with every session.' }
  const taken = groups.find((g) => g.id !== self && g.name.toLowerCase() === low)
  if (taken) return { error: `There is a tab "${taken.name}" already.` }
  return { name }
}

/**
 * One change from the tab bar or a session's menu. Returns the new value (the old one untouched) or
 * a message saying why not. `id` makes the id of an added tab.
 */
export function applyGroupOp(
  d: SessionGroups,
  raw: unknown,
  id: () => string = newGroupId,
): { ok: true; groups: SessionGroups; id?: string } | { ok: false; message: string } {
  const op = raw as Partial<Record<string, unknown>> | null
  if (!op || typeof op !== 'object') return { ok: false, message: 'bad request' }
  const find = (gid: unknown) => (typeof gid === 'string' ? d.groups.find((g) => g.id === gid) : undefined)
  switch (op.op) {
    case 'add': {
      if (d.groups.length >= GROUP_MAX) return { ok: false, message: `At most ${GROUP_MAX} tabs.` }
      const n = cleanName(op.name, d.groups)
      if ('error' in n) return { ok: false, message: n.error }
      let gid = id()
      while (find(gid)) gid = id()
      return { ok: true, groups: { ...d, groups: [...d.groups, { id: gid, name: n.name }] }, id: gid }
    }
    case 'rename': {
      const g = find(op.id)
      if (!g) return { ok: false, message: 'That tab is gone.' }
      const n = cleanName(op.name, d.groups, g.id)
      if ('error' in n) return { ok: false, message: n.error }
      return { ok: true, groups: { ...d, groups: d.groups.map((x) => (x.id === g.id ? { ...x, name: n.name } : x)) } }
    }
    case 'move': {
      const g = find(op.id)
      if (!g) return { ok: false, message: 'That tab is gone.' }
      if (op.before !== null && !find(op.before)) return { ok: false, message: 'That tab is gone.' }
      if (op.before === g.id) return { ok: true, groups: d }
      const rest = d.groups.filter((x) => x.id !== g.id)
      const at = op.before === null ? -1 : rest.findIndex((x) => x.id === op.before)
      if (at < 0) rest.push(g)
      else rest.splice(at, 0, g)
      return { ok: true, groups: { ...d, groups: rest } }
    }
    case 'remove': {
      const g = find(op.id)
      if (!g) return { ok: true, groups: d }
      const of = Object.fromEntries(Object.entries(d.of).filter(([, v]) => v !== g.id))
      return { ok: true, groups: { groups: d.groups.filter((x) => x.id !== g.id), of } }
    }
    case 'assign': {
      if (!okKey(op.key)) return { ok: false, message: 'bad session' }
      if (op.group === null || op.group === ALL) {
        if (!has(d.of, op.key)) return { ok: true, groups: d }
        const of = { ...d.of }
        delete of[op.key]
        return { ok: true, groups: { ...d, of } }
      }
      const g = find(op.group)
      if (!g) return { ok: false, message: 'That tab is gone.' }
      return { ok: true, groups: { ...d, of: { ...d.of, [op.key]: g.id } } }
    }
    default:
      return { ok: false, message: 'bad request' }
  }
}

/** A resume made a copy (noteCopy): the copy takes the old session's tab. Returns d itself when nothing moves. */
export function carryGroup(d: SessionGroups, oldKey: string, newKey: string): SessionGroups {
  const g = has(d.of, oldKey) ? d.of[oldKey] : undefined
  if (!g || !okKey(newKey) || oldKey === newKey) return d
  const of = { ...d.of, [newKey]: g }
  delete of[oldKey]
  return { ...d, of }
}

/** How long a session may be missing from the list before it leaves its tab (a poll can miss it). */
export const GROUP_GRACE_MS = 10 * 60_000

/**
 * Drop the assignments of sessions no longer listed for `graceMs` (`missingSince` is updated in
 * place). Call only with a real session list; an empty one clears nothing. Returns d itself when
 * nothing changed.
 */
export function pruneGroups(
  d: SessionGroups,
  listed: Set<string>,
  missingSince: Map<string, number>,
  now = Date.now(),
  graceMs = GROUP_GRACE_MS,
): SessionGroups {
  if (!listed.size) return d
  let changed = false
  const of: Record<string, string> = {}
  for (const [k, g] of Object.entries(d.of)) {
    if (listed.has(k)) {
      missingSince.delete(k)
      of[k] = g
      continue
    }
    const since = missingSince.get(k) ?? now
    missingSince.set(k, since)
    if (now - since < graceMs) of[k] = g
    else changed = true
  }
  for (const k of [...missingSince.keys()]) if (!has(of, k)) missingSince.delete(k)
  return changed ? { ...d, of } : d
}

/**
 * A session started into a tab (#171) that is not listed yet: its key is unknown until a poll lists
 * it, so it is matched by name. `skip`: keys of the sessions with that name already listed when it
 * started (done ones too), never pulled in; a new one is claimed even if it is done by its first poll.
 */
export interface GroupWait {
  name: string
  group: string
  skip: string[]
  at: number
}

/**
 * Put each expected session that is now listed in its tab (unless it is in one already). A wait
 * whose tab is gone, or older than `ms` (the session never showed up), is dropped. Returns d and
 * waits themselves when nothing changed.
 */
export function claimWaits(
  d: SessionGroups,
  waits: GroupWait[],
  sessions: { key: string; name: string }[],
  now = Date.now(),
  ms = GROUP_GRACE_MS,
): { groups: SessionGroups; waits: GroupWait[] } {
  let of: Record<string, string> | null = null
  const left: GroupWait[] = []
  for (const w of waits) {
    if (now - w.at > ms || !d.groups.some((g) => g.id === w.group)) continue
    const s = sessions.find((x) => x.name === w.name && !w.skip.includes(x.key))
    if (!s) {
      left.push(w)
      continue
    }
    if (okKey(s.key) && !has(of ?? d.of, s.key)) (of ??= { ...d.of })[s.key] = w.group
  }
  return {
    groups: of ? { ...d, of } : d,
    waits: left.length === waits.length ? waits : left,
  }
}

/** The file's contents, cleaned; null when it is not a groups file at all. */
export function parseGroups(raw: unknown): SessionGroups | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as { groups?: unknown; of?: unknown }
  if (!Array.isArray(r.groups)) return null
  const groups: SessionGroup[] = []
  for (const g of r.groups) {
    if (groups.length >= GROUP_MAX || !g || typeof g !== 'object') continue
    const { id, name } = g as { id?: unknown; name?: unknown }
    if (typeof id !== 'string' || !ID.test(id) || groups.some((x) => x.id === id)) continue
    const n = cleanName(name, groups)
    if ('name' in n) groups.push({ id, name: n.name })
  }
  const ids = new Set(groups.map((g) => g.id))
  const of: Record<string, string> = {}
  if (r.of && typeof r.of === 'object' && !Array.isArray(r.of))
    for (const [k, v] of Object.entries(r.of)) if (okKey(k) && typeof v === 'string' && ids.has(v)) of[k] = v
  return { groups, of }
}

/** The tab a session is in (a group id), or null: All only. */
export function groupOf(d: SessionGroups | undefined, key: string): string | null {
  return d && has(d.of, key) ? d.of[key] : null
}

/** The sessions a tab lists: every one for All (or a tab that is gone), else its own. */
export function inGroup<T extends { key: string }>(sessions: T[], d: SessionGroups | undefined, tab: string): T[] {
  if (tab === ALL || !d?.groups.some((g) => g.id === tab)) return sessions
  return sessions.filter((s) => d.of[s.key] === tab)
}

/** The tab to show: the picked one while it exists, else All. */
export function shownTab(d: SessionGroups | undefined, picked: string): string {
  return picked !== ALL && d?.groups.some((g) => g.id === picked) ? picked : ALL
}

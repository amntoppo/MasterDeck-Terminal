import type { InboxItem, InboxKind } from './inbox'

/**
 * Notifications (#135): the one registry of notification types and channels. Settings →
 * Notifications draws its table from it, settings are normalized against it, and the dispatcher
 * (main/notifier.ts) routes each event with `routeOf`. A new type is one entry in NOTIFY_TYPES (and
 * a dispatch where it happens); a new channel is one entry in CHANNELS (and its sender).
 */

export type ChannelId = 'system' | 'needsYou' | 'mobile'

export interface ChannelDef {
  id: ChannelId
  label: string
  /** False: shown in Settings but routes nothing yet (its `note` says why). */
  available: boolean
  /** Pause all stops it. */
  pausable: boolean
  note?: string
}

export const CHANNELS: readonly ChannelDef[] = [
  { id: 'system', label: 'System notification', available: true, pausable: true },
  { id: 'needsYou', label: 'Needs you', available: true, pausable: false },
  { id: 'mobile', label: 'Mobile push', available: false, pausable: true, note: 'Coming with the mobile app' },
]

export type NotifyTypeId =
  | 'session-finished'
  | 'session-input'
  | 'needs-you'
  | 'pr-ready'
  | 'pr-merged'
  | 'ci-failed'
  | 'monitor'
  | 'update'
  | 'workflow'
  | 'meeting'

export interface NotifyTypeDef {
  id: NotifyTypeId
  label: string
  hint: string
  /** `inbox`: Needs-you items already (the Needs-you channel shows or hides them); `event`: added to Needs you as a notice. */
  source: 'inbox' | 'event'
  /** Per channel, for a user who changed nothing (today's behaviour). */
  defaults: Record<ChannelId, boolean>
  /** Cells the user cannot change, with their value. */
  fixed?: Partial<Record<ChannelId, boolean>>
}

const on = (system: boolean, needsYou: boolean): Record<ChannelId, boolean> => ({ system, needsYou, mobile: false })

export const NOTIFY_TYPES: readonly NotifyTypeDef[] = [
  { id: 'session-finished', label: 'Session finished', hint: 'A working session went idle.', source: 'event', defaults: on(true, false) },
  { id: 'session-input', label: 'Session needs input', hint: 'A permission prompt, a question or a menu waits on you.', source: 'inbox', defaults: on(true, true) },
  {
    id: 'needs-you',
    label: 'New item in Needs you',
    hint: 'Proposals, quiet sessions, budgets, context, accounts, loops, meetings and the rest.',
    source: 'inbox',
    defaults: on(true, true),
    fixed: { needsYou: true },
  },
  { id: 'pr-ready', label: 'PR ready for review', hint: "A session's PR is ready for review.", source: 'event', defaults: on(true, false) },
  { id: 'pr-merged', label: 'PR merged', hint: "A session's PR was merged.", source: 'event', defaults: on(true, false) },
  { id: 'ci-failed', label: 'CI failed', hint: "One of your PRs' checks is failing.", source: 'inbox', defaults: on(true, true) },
  { id: 'monitor', label: 'Monitor event', hint: 'A monitor MasterDeck runs printed something (at most one a minute each).', source: 'event', defaults: on(false, false) },
  { id: 'update', label: 'Update available', hint: 'A new version of MasterDeck is offered.', source: 'event', defaults: on(false, false) },
  { id: 'workflow', label: 'Workflow notify step', hint: "A workflow's notify block ran.", source: 'event', defaults: on(true, false) },
  { id: 'meeting', label: 'Meetings', hint: 'A meeting to record, and what happened to a recording.', source: 'event', defaults: on(true, false) },
]

export type NotifyRoutes = Record<NotifyTypeId, Record<ChannelId, boolean>>

/** The types the old `notifyNeedsYou` switched (the inbox's notifications). */
const LEGACY_GATED: readonly NotifyTypeId[] = ['session-input', 'needs-you', 'ci-failed']

const typeDef = (id: NotifyTypeId): NotifyTypeDef => NOTIFY_TYPES.find((t) => t.id === id)!
const channelDef = (id: ChannelId): ChannelDef => CHANNELS.find((c) => c.id === id)!

/**
 * Every type × channel, from what was stored (else the default). Without stored routes, the old
 * `notifyNeedsYou` (when it was saved) decides the system cell of the types it switched. Unknown
 * types and channels are dropped; fixed cells keep their value.
 */
export function normalizeRoutes(raw: unknown, legacyNotifyNeedsYou?: unknown): NotifyRoutes {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  const out = {} as NotifyRoutes
  for (const t of NOTIFY_TYPES) {
    const row = r?.[t.id] && typeof r[t.id] === 'object' ? (r[t.id] as Record<string, unknown>) : {}
    const cells = {} as Record<ChannelId, boolean>
    for (const c of CHANNELS) {
      const legacy = !r && c.id === 'system' && LEGACY_GATED.includes(t.id) && typeof legacyNotifyNeedsYou === 'boolean' ? legacyNotifyNeedsYou : undefined
      const stored = row[c.id]
      cells[c.id] = t.fixed?.[c.id] ?? (typeof stored === 'boolean' ? stored : (legacy ?? t.defaults[c.id]))
    }
    out[t.id] = cells
  }
  return out
}

export const defaultRoutes = (): NotifyRoutes => normalizeRoutes(undefined)

export interface NotifyPrefs {
  notifications: NotifyRoutes
  notifyPaused: boolean
}

/** Whether an event of this type goes to this channel. */
export function routes(p: NotifyPrefs, type: NotifyTypeId, channel: ChannelId): boolean {
  const c = channelDef(channel)
  if (!c.available || (c.pausable && p.notifyPaused)) return false
  return typeDef(type).fixed?.[channel] ?? p.notifications[type]?.[channel] ?? false
}

/** The channels an event of this type goes to. */
export function routeOf(p: NotifyPrefs, type: NotifyTypeId): ChannelId[] {
  return CHANNELS.filter((c) => routes(p, type, c.id)).map((c) => c.id)
}

/** The type a Needs-you item notifies as. */
export function typeOfKind(item: Pick<InboxItem, 'kind' | 'detail'>): NotifyTypeId {
  const k: InboxKind = item.kind
  if (k === 'notice' && item.detail.type === 'notice') return item.detail.notify
  if (k === 'input' || k === 'menu' || k === 'question' || k === 'blocked' || k === 'waiting') return 'session-input'
  if (k === 'ci') return 'ci-failed'
  return 'needs-you'
}

/** Whether Needs you lists this item (the Needs-you channel of its type; Pause never hides one). */
export function showsInNeedsYou(p: NotifyPrefs, item: Pick<InboxItem, 'kind' | 'detail'>): boolean {
  // A notice was added because its channel was on; switched off later, it goes from the list too.
  return routes(p, typeOfKind(item), 'needsYou')
}

/** One cell of Settings → Notifications: its value, and whether (and why) it cannot be changed. */
export function cellOf(p: NotifyPrefs, type: NotifyTypeId, channel: ChannelId): { checked: boolean; disabled: boolean; why: string | null } {
  const c = channelDef(channel)
  if (!c.available) return { checked: false, disabled: true, why: c.note ?? 'Not available yet' }
  const fixed = typeDef(type).fixed?.[channel]
  if (fixed !== undefined) return { checked: fixed, disabled: true, why: 'These items always show in Needs you' }
  return { checked: p.notifications[type]?.[channel] ?? false, disabled: false, why: null }
}

/** The routes with one cell changed (fixed and unavailable cells stay). */
export function withCell(r: NotifyRoutes, type: NotifyTypeId, channel: ChannelId, value: boolean): NotifyRoutes {
  if (!channelDef(channel).available || typeDef(type).fixed?.[channel] !== undefined) return r
  return { ...r, [type]: { ...r[type], [channel]: value } }
}

/** Setup's one Notifications switch: the system notifications of Needs-you items (what `notifyNeedsYou` was). */
export const needsYouSystemOn = (r: NotifyRoutes): boolean => LEGACY_GATED.some((t) => r[t].system)

export function withNeedsYouSystem(r: NotifyRoutes, value: boolean): NotifyRoutes {
  return LEGACY_GATED.reduce((acc, t) => withCell(acc, t, 'system', value), r)
}

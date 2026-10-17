import { CHANNELS, routeOf, type ChannelId, type NotifyPrefs, type NotifyTypeId } from '@shared/notifications'
import type { NotifyEvent } from '@shared/types'

/** One notification, as each channel needs it. */
export interface Note {
  title: string
  body: string
  target: NotifyEvent['target']
  /** A GitHub page it is about: Needs you shows View on GitHub. */
  url?: string
  /** It is a Needs-you item already (the inbox's own): Needs you has it, whatever the channel says. */
  itemId?: string
  /** Done on click instead of revealing the target (the meetings offer). */
  click?: () => void
  /** macOS: a button on the notification. */
  action?: { label: string; run: () => void }
  /** macOS: a reply field on the notification. */
  reply?: (text: string) => void
  /** Notes with the same key within COALESCE_MS: only the first goes out (a chatty monitor). */
  coalesce?: string
}

export type Sender = (n: Note, type: NotifyTypeId | 'test') => void

export const COALESCE_MS = 60_000

/**
 * The one dispatcher (#135): every notification MasterDeck makes goes through `dispatch`, which
 * sends it to the channels the user picked for its type (shared/notifications.ts `routeOf`). One
 * sender per channel, a Record so a new channel cannot be left without one.
 */
export class Notifier {
  private lastByKey = new Map<string, number>()

  constructor(
    private prefs: () => NotifyPrefs,
    private senders: Record<ChannelId, Sender>,
    private now: () => number = Date.now,
  ) {}

  /** Returns the channels it went to. */
  dispatch(type: NotifyTypeId, note: Note): ChannelId[] {
    if (note.coalesce) {
      const t = this.now()
      const last = this.lastByKey.get(note.coalesce)
      if (last !== undefined && t - last < COALESCE_MS) return []
      this.lastByKey.set(note.coalesce, t)
      if (this.lastByKey.size > 500) this.lastByKey.clear()
    }
    const to = routeOf(this.prefs(), type).filter((c) => !(c === 'needsYou' && note.itemId))
    for (const c of to) this.send(c, note, type)
    return to
  }

  /** Settings' Send test notification: one through every available channel, whatever is picked or paused. */
  test(): ChannelId[] {
    const to = CHANNELS.filter((c) => c.available).map((c) => c.id)
    const note: Note = { title: 'MasterDeck test notification', body: 'Notifications reach you here.', target: { needsYou: true } }
    for (const c of to) this.send(c, note, 'test')
    return to
  }

  private send(c: ChannelId, note: Note, type: NotifyTypeId | 'test'): void {
    try {
      this.senders[c](note, type)
    } catch (e) {
      // One channel failing never stops the others.
      console.error(`notify ${c}: ${String(e)}`)
    }
  }
}

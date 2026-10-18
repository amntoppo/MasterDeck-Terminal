import { DEFAULT_MEETINGS, normalizeMeetings, type MeetingsSettings } from './meetings'
import { isThemePref, type ThemePref } from './themes'
import { defaultRoutes, normalizeRoutes, type NotifyRoutes } from './notifications'
import { cleanRailOrder } from './railOrder'

export interface Settings {
  idleNudgeMinutes: number
  budgetPerTicketUsd: number
  contextWarnPct: number
  autoOpenNeedsInput: boolean
  dockBadge: boolean
  /** Settings → Notifications: per notification type, per channel (shared/notifications.ts). Replaces `notifyNeedsYou`. */
  notifications: NotifyRoutes
  /** Pause all: no system notification (Needs you still lists everything), the choices above kept. */
  notifyPaused: boolean
  /** After the Mac restarts: offer to resume the background sessions it stopped, resume them, or neither. */
  afterRestart: 'ask' | 'resume' | 'off'
  /** A session's open PR is Ready for Review once its automated review is done, or after this many minutes without new comments. */
  reviewQuietMinutes: number
  /** Who runs the monitors sessions arm: Claude Code (30 minutes each, re-armed) or MasterDeck (no limit, while it runs). */
  monitorsBy: 'claude' | 'masterdeck'
  /** Watch each open PR a session makes: review comments, conflicts, a stalled review and the merge reach the session as messages. */
  watchPrs: boolean
  /** Send Tasks and Needs you to the remote backend, and run the commands it relays (Settings → Remote). */
  remoteEnabled: boolean
  /** Web terminal: show typed characters at once, corrected when the Mac's output arrives (predictive local echo). */
  instantTyping: boolean
  /** Settings → Meetings (macOS): the consent, the speech model, offers, how long audio is kept. */
  meetings: MeetingsSettings
  /** Light, Dark or System (follows the OS). The web app keeps its own choice per browser (renderer/src/theme.ts). */
  theme: ThemePref
  /** Settings → Updates: download an offered update at once (else Download in Settings). */
  autoDownloadUpdates: boolean
  /** Settings → Updates: stable releases, or betas too. */
  updateChannel: 'stable' | 'beta'
  /** The left rail's icon order (shared/railOrder.ts); empty is the default. */
  railOrder: string[]
  /** Settings → General → Open MasterDeck on: the last view, or the Dashboard. The web app keeps its own per browser (`md.startView`). */
  startView: 'last' | 'dashboard'
}

export const DEFAULT_SETTINGS: Settings = {
  idleNudgeMinutes: 20,
  budgetPerTicketUsd: 20,
  contextWarnPct: 85,
  autoOpenNeedsInput: true,
  dockBadge: true,
  notifications: defaultRoutes(),
  notifyPaused: false,
  afterRestart: 'ask',
  reviewQuietMinutes: 20,
  monitorsBy: 'claude',
  watchPrs: true,
  remoteEnabled: false,
  instantTyping: true,
  meetings: DEFAULT_MEETINGS,
  // Dark: an update keeps today's look until the user picks another.
  theme: 'dark',
  autoDownloadUpdates: true,
  updateChannel: 'stable',
  railOrder: [],
  startView: 'last',
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt

/** Fill gaps with defaults and keep numbers in sane ranges. */
export function normalizeSettings(raw: unknown): Settings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    idleNudgeMinutes: clamp(r.idleNudgeMinutes, 1, 24 * 60, DEFAULT_SETTINGS.idleNudgeMinutes),
    budgetPerTicketUsd: clamp(r.budgetPerTicketUsd, 0, 100_000, DEFAULT_SETTINGS.budgetPerTicketUsd),
    contextWarnPct: clamp(r.contextWarnPct, 10, 100, DEFAULT_SETTINGS.contextWarnPct),
    autoOpenNeedsInput: typeof r.autoOpenNeedsInput === 'boolean' ? r.autoOpenNeedsInput : DEFAULT_SETTINGS.autoOpenNeedsInput,
    dockBadge: typeof r.dockBadge === 'boolean' ? r.dockBadge : DEFAULT_SETTINGS.dockBadge,
    // A file from before #135 has `notifyNeedsYou` and no `notifications`: it decides the inbox's notifications.
    notifications: normalizeRoutes(r.notifications, r.notifyNeedsYou),
    notifyPaused: r.notifyPaused === true,
    afterRestart: r.afterRestart === 'resume' || r.afterRestart === 'off' ? r.afterRestart : DEFAULT_SETTINGS.afterRestart,
    reviewQuietMinutes: clamp(r.reviewQuietMinutes, 1, 24 * 60, DEFAULT_SETTINGS.reviewQuietMinutes),
    monitorsBy: r.monitorsBy === 'masterdeck' ? 'masterdeck' : 'claude',
    watchPrs: typeof r.watchPrs === 'boolean' ? r.watchPrs : DEFAULT_SETTINGS.watchPrs,
    remoteEnabled: typeof r.remoteEnabled === 'boolean' ? r.remoteEnabled : DEFAULT_SETTINGS.remoteEnabled,
    instantTyping: typeof r.instantTyping === 'boolean' ? r.instantTyping : DEFAULT_SETTINGS.instantTyping,
    meetings: normalizeMeetings(r.meetings),
    theme: isThemePref(r.theme) ? r.theme : DEFAULT_SETTINGS.theme,
    autoDownloadUpdates: typeof r.autoDownloadUpdates === 'boolean' ? r.autoDownloadUpdates : DEFAULT_SETTINGS.autoDownloadUpdates,
    updateChannel: r.updateChannel === 'beta' ? 'beta' : 'stable',
    railOrder: cleanRailOrder(r.railOrder),
    startView: r.startView === 'dashboard' ? 'dashboard' : 'last',
  }
}

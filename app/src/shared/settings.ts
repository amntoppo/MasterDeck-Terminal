export interface Settings {
  idleNudgeMinutes: number
  budgetPerTicketUsd: number
  contextWarnPct: number
  autoOpenNeedsInput: boolean
  dockBadge: boolean
  /** A desktop notification when something new lands in Needs you. */
  notifyNeedsYou: boolean
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
}

export const DEFAULT_SETTINGS: Settings = {
  idleNudgeMinutes: 20,
  budgetPerTicketUsd: 20,
  contextWarnPct: 85,
  autoOpenNeedsInput: true,
  dockBadge: true,
  notifyNeedsYou: true,
  afterRestart: 'ask',
  reviewQuietMinutes: 20,
  monitorsBy: 'claude',
  watchPrs: true,
  remoteEnabled: false,
  instantTyping: true,
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
    notifyNeedsYou: typeof r.notifyNeedsYou === 'boolean' ? r.notifyNeedsYou : DEFAULT_SETTINGS.notifyNeedsYou,
    afterRestart: r.afterRestart === 'resume' || r.afterRestart === 'off' ? r.afterRestart : DEFAULT_SETTINGS.afterRestart,
    reviewQuietMinutes: clamp(r.reviewQuietMinutes, 1, 24 * 60, DEFAULT_SETTINGS.reviewQuietMinutes),
    monitorsBy: r.monitorsBy === 'masterdeck' ? 'masterdeck' : 'claude',
    watchPrs: typeof r.watchPrs === 'boolean' ? r.watchPrs : DEFAULT_SETTINGS.watchPrs,
    remoteEnabled: typeof r.remoteEnabled === 'boolean' ? r.remoteEnabled : DEFAULT_SETTINGS.remoteEnabled,
    instantTyping: typeof r.instantTyping === 'boolean' ? r.instantTyping : DEFAULT_SETTINGS.instantTyping,
  }
}

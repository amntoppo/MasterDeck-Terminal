export interface Settings {
  idleNudgeMinutes: number
  budgetPerTicketUsd: number
  contextWarnPct: number
  autoOpenNeedsInput: boolean
  dockBadge: boolean
  /** After the Mac restarts: offer to resume the background sessions it stopped, resume them, or neither. */
  afterRestart: 'ask' | 'resume' | 'off'
}

export const DEFAULT_SETTINGS: Settings = {
  idleNudgeMinutes: 20,
  budgetPerTicketUsd: 20,
  contextWarnPct: 85,
  autoOpenNeedsInput: true,
  dockBadge: true,
  afterRestart: 'ask',
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
    afterRestart: r.afterRestart === 'resume' || r.afterRestart === 'off' ? r.afterRestart : DEFAULT_SETTINGS.afterRestart,
  }
}

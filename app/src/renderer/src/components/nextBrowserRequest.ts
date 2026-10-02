import type { BrowserRequestView } from '@shared/types'

/** The unexpired request closest to expiring (so it is answered before it lapses), or null. */
export const nextRequest = (rs: BrowserRequestView[] | undefined, now: number) =>
  (rs ?? []).filter((r) => r.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt)[0] ?? null

/** Allow stays disabled this long after a request appears, so a double-click on Deny cannot approve the next one. */
export const ALLOW_DELAY_MS = 600
export const allowArmed = (shownAt: number, now: number) => now - shownAt >= ALLOW_DELAY_MS

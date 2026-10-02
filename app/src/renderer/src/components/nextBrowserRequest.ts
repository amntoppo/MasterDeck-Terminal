import type { BrowserRequestView } from '@shared/types'

/** The unexpired request closest to expiring (so it is answered before it lapses), or null. */
export const nextRequest = (rs: BrowserRequestView[] | undefined, now: number) =>
  (rs ?? []).filter((r) => r.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt)[0] ?? null

import type { LiveClient } from './remote'
import { cleanLabel } from './deviceInfo'
import type { AppState } from './types'

export interface Presence {
  id: string
  kind: 'browser' | 'phone' | 'api'
  name: string
  device: string | null
  /** When it connected (ms); 0 when unknown (an older web app that predates connectedAt). */
  since: number
}

type BrowserLike = NonNullable<AppState['browsers']>[number]

/** Connected approved browsers plus the backend's live clients, newest first. */
export function mergePresence(browsers: BrowserLike[] | undefined, clients: Pick<LiveClient, 'id' | 'kind' | 'name' | 'device' | 'since'>[] | undefined): Presence[] {
  const b: Presence[] = (browsers ?? []).filter((x) => x.connected).map((x) => ({ id: x.id, kind: 'browser', name: cleanLabel(x.name, 120) || 'Unnamed', device: x.device ?? null, since: x.connectedAt ?? 0 }))
  const c: Presence[] = (clients ?? []).map((x) => ({ id: x.id, kind: x.kind === 'api' ? 'api' : 'phone', name: cleanLabel(x.name, 120) || 'Unnamed', device: x.device, since: x.since }))
  return [...b, ...c].sort((x, y) => y.since - x.since)
}

export const showRemoteDot = (count: number, web: boolean) => !web && count > 0
export const describeDevice = (d: string | null | undefined) => d || 'Unknown device'

import { formatAgo } from './format'
import { PROTOCOL_VERSION, type DesktopStatus } from './remote'

/** How long a stage may last before the web app names a reason (#168: it used to wait for ever). */
export const WEB_LOAD_TIMEOUT_MS = 15_000

/** Where the web app is between approval and the first state. */
export type LoadPhase = 'socket' | 'handshake' | 'state'

export interface LoadInput {
  /** The socket to the hub is open. */
  up: boolean
  /** What the hub said about the Mac; null until it said anything. */
  desktop: DesktopStatus | null
  phase: LoadPhase
  /** When `phase` began. */
  since: number
  now: number
  /** The Mac said it could not send its state (`notice` tooLarge). */
  tooLarge?: { bytes: number } | null
}

export type LoadStage = 'connecting' | 'unreachable' | 'offline' | 'waitingMac' | 'macSilent' | 'loadingSessions' | 'tooLarge' | 'noState'

export interface LoadView {
  stage: LoadStage
  title: string
  text: string
  /** Offer Retry (a fresh connection). */
  retry: boolean
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`
const runs = (d: DesktopStatus | null) => (d?.appVersion ? ` (it runs MasterDeck ${d.appVersion})` : '')

/** What the loading screen says: a stage that waits, or after `WEB_LOAD_TIMEOUT_MS` the reason and Retry. */
export function loadView(i: LoadInput): LoadView {
  const late = i.now - i.since >= WEB_LOAD_TIMEOUT_MS
  const d = i.desktop
  if (!i.up)
    return late
      ? { stage: 'unreachable', title: "Can't reach MasterDeck", text: "This page can't reach MasterDeck's server. Check your connection, then try again.", retry: true }
      : { stage: 'connecting', title: 'MasterDeck', text: 'Connecting…', retry: false }
  if (d && !d.online)
    return {
      stage: 'offline',
      title: 'Your Mac is offline',
      text: `${d.lastSeen ? `Last seen ${formatAgo(i.now - d.lastSeen)} ago. ` : ''}Open MasterDeck on your Mac and check that Settings → Remote says connected.`,
      retry: true,
    }
  if (i.phase !== 'state' || !d)
    return late
      ? { stage: 'macSilent', title: "Your Mac doesn't answer", text: `Your Mac is online but did not answer this browser${runs(d)}. Update MasterDeck on your Mac, or quit and reopen it, then try again.`, retry: true }
      : { stage: 'waitingMac', title: 'MasterDeck', text: 'Waiting for your Mac…', retry: false }
  if (i.tooLarge)
    return {
      stage: 'tooLarge',
      title: 'Too much to send',
      text: `Your Mac's sessions and lists are too large to send to the web (${mb(i.tooLarge.bytes)}). Update MasterDeck on your Mac, then try again.`,
      retry: true,
    }
  return late
    ? { stage: 'noState', title: 'No sessions arrived', text: `Your Mac connected but sent no sessions${runs(d)}. Update MasterDeck on your Mac, then try again.`, retry: true }
    : { stage: 'loadingSessions', title: 'MasterDeck', text: 'Loading sessions…', retry: false }
}

/** The Mac's hello names another protocol than this page speaks: what to update. */
export function updateText(mac: { appVersion?: string; protocol: number }): string {
  const v = mac.appVersion ? `MasterDeck ${mac.appVersion}` : 'MasterDeck'
  return mac.protocol < PROTOCOL_VERSION
    ? `Your Mac runs ${v} (protocol ${mac.protocol}); this page needs protocol ${PROTOCOL_VERSION}. Update MasterDeck on your Mac to use the web app.`
    : `Your Mac runs ${v} (protocol ${mac.protocol}), newer than this page (protocol ${PROTOCOL_VERSION}). Reload this page to get the new web app.`
}

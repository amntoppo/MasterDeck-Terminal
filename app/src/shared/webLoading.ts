import { formatAgo } from './format'
import { PROTOCOL_VERSION, type DesktopStatus } from './remote'

/** How long a stage may last before the web app names a reason (#168: it used to wait for ever). */
export const WEB_LOAD_TIMEOUT_MS = 15_000

/** Where the web app is between approval and the first state. */
export type LoadPhase = 'socket' | 'handshake' | 'state'

const RANK: Record<LoadPhase, number> = { socket: 0, handshake: 1, state: 2 }

/** The wait's clock: the furthest phase this wait reached, and since when. */
export interface LoadClock {
  reached: LoadPhase
  since: number
}

export const startWait = (now: number): LoadClock => ({ reached: 'socket', since: now })

/**
 * Only progress moves the clock. A reconnect drops back to an earlier phase without restarting it: the
 * socket's own handshake timeout (15 s) closes and redials, and restarting there would wait for ever.
 */
export const advance = (c: LoadClock, p: LoadPhase, now: number): LoadClock => (RANK[p] > RANK[c.reached] ? { reached: p, since: now } : c)

export interface LoadInput {
  /** The socket to the hub is open. */
  up: boolean
  /** What the hub said about the Mac; null until it said anything. */
  desktop: DesktopStatus | null
  /** Where this connection is now. */
  phase: LoadPhase
  /** The furthest phase this wait reached (`advance`), and since when: what a timeout is about. */
  reached: LoadPhase
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

/** The reason for a wait that lasted: by the furthest phase it reached. */
function late(reached: LoadPhase, d: DesktopStatus | null): LoadView {
  if (reached === 'socket')
    return { stage: 'unreachable', title: "Can't reach MasterDeck", text: "This page can't reach MasterDeck's server. Check your connection, then try again.", retry: true }
  if (reached === 'handshake')
    return { stage: 'macSilent', title: "Your Mac doesn't answer", text: `Your Mac is online but did not answer this browser${runs(d)}. Update MasterDeck on your Mac, or quit and reopen it, then try again.`, retry: true }
  return { stage: 'noState', title: 'No sessions arrived', text: `Your Mac connected but sent no sessions${runs(d)}. Update MasterDeck on your Mac, then try again.`, retry: true }
}

/** What the loading screen says: the stage it is in, or after `WEB_LOAD_TIMEOUT_MS` the reason and Retry. */
export function loadView(i: LoadInput): LoadView {
  const over = i.now - i.since >= WEB_LOAD_TIMEOUT_MS
  const d = i.desktop
  if (!i.up) return over ? late(i.reached, d) : { stage: 'connecting', title: 'MasterDeck', text: 'Connecting…', retry: false }
  if (d && !d.online)
    return {
      stage: 'offline',
      title: 'Your Mac is offline',
      text: `${d.lastSeen ? `Last seen ${formatAgo(i.now - d.lastSeen)} ago. ` : ''}Open MasterDeck on your Mac and check that Settings → Remote says connected.`,
      retry: true,
    }
  if (i.tooLarge)
    return {
      stage: 'tooLarge',
      title: 'Too much to send',
      // Only a Mac that already fits its state sends this, so updating will not help: say what does.
      text: `Your Mac's sessions and lists are too large for the web, even shortened (${mb(i.tooLarge.bytes)}). Use MasterDeck on the Mac for now; once there is less on it (fewer sessions, PRs or Needs-you items), try again.`,
      retry: true,
    }
  if (over) return late(i.reached, d)
  return i.phase !== 'state' || !d
    ? { stage: 'waitingMac', title: 'MasterDeck', text: 'Waiting for your Mac…', retry: false }
    : { stage: 'loadingSessions', title: 'MasterDeck', text: 'Loading sessions…', retry: false }
}

/** The Mac's hello names another protocol than this page speaks: what to update. */
export function updateText(mac: { appVersion?: string; protocol: number }): string {
  const v = mac.appVersion ? `MasterDeck ${mac.appVersion}` : 'MasterDeck'
  return mac.protocol < PROTOCOL_VERSION
    ? `Your Mac runs ${v} (protocol ${mac.protocol}); this page needs protocol ${PROTOCOL_VERSION}. Update MasterDeck on your Mac to use the web app.`
    : `Your Mac runs ${v} (protocol ${mac.protocol}), newer than this page (protocol ${PROTOCOL_VERSION}). Reload this page to get the new web app.`
}

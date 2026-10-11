/**
 * Meetings: the mic follows the meeting app's mute (Plan M, issue #102). The rules md-mute reads
 * the meeting apps' own Mute / Unmute control by, and the app's side of its line protocol
 * (native/mute/main.swift is the other side):
 *
 *   stdin, once:  muteRulesLine(rules)  one line of JSON
 *   stdout:       {"t":<ms>,"trusted":bool,"apps":[{"id":"zoom","state":"muted"|"unmuted"|"unknown"}]}
 *                 every 400 ms; only apps with a running process are listed.
 *
 * ponytail: every rule below is a guess from the apps' published shortcuts and screen-reader
 * labels; none was checked on a real call (none of the apps is installed here). They are data, so a
 * fix is a change here, not a rebuild of the helper: check one by hand with OPERATIONS § Meetings:
 * md-mute.
 */

export type MuteState = 'muted' | 'unmuted' | 'unknown'

/** A menu bar menu whose item says what the control would do (Zoom's Meeting menu). */
export interface MenuRule {
  title: string
  /** Item titles (prefixes) that are there while you are muted. */
  muted: readonly string[]
  unmuted: readonly string[]
}

/** A control in the app's windows whose label starts with one of the prefixes. */
export interface ElementRule {
  role: 'AXButton'
  /** The label attributes read, in order, on controls of that role only. */
  attrs: readonly string[]
  muted: readonly string[]
  unmuted: readonly string[]
}

export interface MuteRule {
  id: string
  /** What the Record popout says: "Mic: muted in Zoom". */
  name: string
  bundles: readonly string[]
  /** Chromium browsers among `bundles`: md-mute sets AXManualAccessibility so web content shows. */
  chromium?: readonly string[]
  menu?: MenuRule
  element?: ElementRule
}

const LABELS = ['AXTitle', 'AXDescription', 'AXHelp'] as const

const CHROMIUM = [
  'com.google.Chrome',
  'company.thebrowser.Browser', // Arc
  'com.microsoft.edgemac',
  'com.brave.Browser',
] as const

export const MUTE_RULES: readonly MuteRule[] = [
  {
    id: 'zoom',
    name: 'Zoom',
    bundles: ['us.zoom.xos'],
    // The item says what it would do: "Mute audio" while you are heard, "Unmute audio" while muted.
    menu: { title: 'Meeting', muted: ['Unmute audio'], unmuted: ['Mute audio'] },
  },
  {
    id: 'teams',
    name: 'Teams',
    // New Teams, then classic.
    bundles: ['com.microsoft.teams2', 'com.microsoft.teams'],
    // ponytail: unverified; Teams' button reads "Mute (⌘+Shift+M)" / "Unmute (⌘+Shift+M)".
    element: { role: 'AXButton', attrs: LABELS, muted: ['Unmute'], unmuted: ['Mute'] },
  },
  {
    id: 'webex',
    name: 'Webex',
    bundles: ['Cisco-Systems.Spark'],
    // ponytail: unverified; Webex's button reads "Mute" / "Unmute" (sometimes with "my audio").
    element: { role: 'AXButton', attrs: LABELS, muted: ['Unmute'], unmuted: ['Mute'] },
  },
  {
    id: 'meet',
    name: 'Google Meet',
    bundles: [...CHROMIUM, 'com.apple.Safari'],
    chromium: CHROMIUM,
    // ponytail: unverified; Meet's button reads "Turn on microphone (⌘ + d)" while muted. Only
    // the tab on screen is in a browser's tree: a Meet in a background tab reads as unknown.
    element: { role: 'AXButton', attrs: LABELS, muted: ['Turn on microphone'], unmuted: ['Turn off microphone'] },
  },
]

/** The one line md-mute reads on stdin: only the fields it uses. */
export function muteRulesLine(rules: readonly MuteRule[] = MUTE_RULES): string {
  return (
    JSON.stringify({
      apps: rules.map((r) => ({
        id: r.id,
        bundles: r.bundles,
        ...(r.chromium ? { chromium: r.chromium } : {}),
        ...(r.menu ? { menu: r.menu } : {}),
        ...(r.element ? { element: r.element } : {}),
      })),
    }) + '\n'
  )
}

export interface MuteApp {
  id: string
  state: MuteState
}

export interface MuteReading {
  t: number
  trusted: boolean
  apps: MuteApp[]
}

const STATES: ReadonlySet<string> = new Set(['muted', 'unmuted', 'unknown'])
const ID = /^[a-z0-9-]{1,32}$/
/** More apps than any rule set has is not a line md-mute wrote. */
const MAX_APPS = 32

/**
 * One line of md-mute's output, or null for anything else (a partial line, junk, a wrong shape).
 * Strict: every field is checked, an app listed twice or an id outside `known` (when given) is
 * junk, so a confused helper can never switch the mic.
 */
export function parseMuteLine(line: string, known?: ReadonlySet<string>): MuteReading | null {
  if (line.length > 4096) return null
  let j: unknown
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  if (typeof o.t !== 'number' || !Number.isFinite(o.t) || o.t < 0) return null
  if (typeof o.trusted !== 'boolean') return null
  if (!Array.isArray(o.apps) || o.apps.length > MAX_APPS) return null
  const apps: MuteApp[] = []
  const seen = new Set<string>()
  for (const a of o.apps as unknown[]) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null
    const { id, state } = a as Record<string, unknown>
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) return null
    if (known && !known.has(id)) return null
    if (typeof state !== 'string' || !STATES.has(state)) return null
    // Not trusted, nothing can be read: a line that says otherwise is not believed.
    if (!o.trusted && state !== 'unknown') return null
    seen.add(id)
    apps.push({ id, state: state as MuteState })
  }
  return { t: o.t, trusted: o.trusted, apps }
}

/** A rule's id from an id or a name ("Zoom" from the offer, "zoom" from a rule). */
export function muteRuleId(nameOrId: string, rules: readonly MuteRule[] = MUTE_RULES): string | null {
  const k = nameOrId.trim().toLowerCase()
  return rules.find((r) => r.id === k || r.name.toLowerCase() === k)?.id ?? null
}

/**
 * Which app's mute the mic follows: the preferred one (the offered or detected call app, by name
 * or id) while md-mute lists it, else the first app it reads as muted or unmuted, else none.
 */
export function pickApp(
  apps: readonly MuteApp[],
  preferred: string | null | undefined,
  rules: readonly MuteRule[] = MUTE_RULES,
): string | null {
  const want = preferred ? muteRuleId(preferred, rules) : null
  if (want && apps.some((a) => a.id === want)) return want
  return apps.find((a) => a.state !== 'unknown')?.id ?? null
}

/**
 * Two equal readings in a row before the settled state changes: one stray reading (a menu being
 * rebuilt, a tree half built) never switches the mic. Starts unknown.
 */
export class MuteSettle {
  private settled: MuteState = 'unknown'
  private last: MuteState | null = null

  /** Feeds one reading; returns the settled state after it. */
  push(s: MuteState): MuteState {
    if (s === this.last) this.settled = s
    this.last = s
    return this.settled
  }

  get state(): MuteState {
    return this.settled
  }

  /** Another app, or the helper started again: nothing carries over. */
  reset(): void {
    this.settled = 'unknown'
    this.last = null
  }
}

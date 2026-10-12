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

/**
 * A control in the app's windows whose label starts with one of the prefixes. Keep every prefix
 * ASCII: md-mute compares Swift Characters, this file UTF-16 units, so "the longest prefix" would
 * differ between the two for other text (meetingMute.test.ts checks it).
 */
export interface ElementRule {
  role: 'AXButton'
  /** The label attributes read, in order, on controls of that role only. */
  attrs: readonly string[]
  muted: readonly string[]
  unmuted: readonly string[]
  /**
   * Labels that start with one of these are never the user's own control, though a muted or
   * unmuted prefix matches them too: "Mute all" in Teams' participants panel starts with "Mute".
   */
  exclude?: readonly string[]
  /**
   * Prefixes among `muted` / `unmuted` that match only the whole label or the label followed by
   * " (" (a shortcut: "Mute (⌘+Shift+M)"): a bare "Mute" must not read "Mute Alice" in a
   * participants list. The specific ones ("Mute microphone") stay prefixes.
   */
  whole?: readonly string[]
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

/**
 * Controls of Teams and Webex whose label starts with "Mute" / "Unmute" but act on others or on
 * something else than your microphone (participants panel, host controls, chat).
 */
const NOT_YOURS = [
  'Mute all',
  'Unmute all',
  'Mute everyone',
  'Unmute everyone',
  'Mute attendees',
  'Unmute attendees',
  'Mute participants',
  'Unmute participants',
  'Mute others',
  'Mute on entry',
  'Mute notifications',
  'Unmute notifications',
  'Mute chat',
  'Unmute chat',
  'Mute conversation',
  'Unmute conversation',
  'Mute meeting chat',
  'Mute sound',
  'Mute speaker',
  'Unmute speaker',
] as const

/** The bare words: the whole label only (or with a shortcut after it), never "Mute Alice". */
const BARE = ['Mute', 'Unmute'] as const

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
    element: {
      role: 'AXButton',
      attrs: LABELS,
      // The most specific first; the longest prefix that matches decides.
      muted: ['Unmute microphone', 'Unmute mic', 'Unmute'],
      unmuted: ['Mute microphone', 'Mute mic', 'Mute'],
      exclude: NOT_YOURS,
      whole: BARE,
    },
  },
  {
    id: 'webex',
    name: 'Webex',
    bundles: ['Cisco-Systems.Spark'],
    // ponytail: unverified; Webex's button reads "Mute" / "Unmute" (sometimes with "my audio").
    element: {
      role: 'AXButton',
      attrs: LABELS,
      muted: ['Unmute my audio', 'Unmute'],
      unmuted: ['Mute my audio', 'Mute'],
      exclude: NOT_YOURS,
      whole: BARE,
    },
  },
  {
    id: 'meet',
    name: 'Google Meet',
    bundles: [...CHROMIUM, 'com.apple.Safari'],
    chromium: CHROMIUM,
    // ponytail: unverified; Meet's button reads "Turn on microphone (⌘ + d)" while muted. Only
    // the tab on screen is in a browser's tree: a Meet in a background tab reads as unknown.
    element: {
      role: 'AXButton',
      attrs: LABELS,
      muted: ['Turn on microphone'],
      unmuted: ['Turn off microphone'],
      // A host's controls for the others.
      exclude: ['Turn on microphone for everyone', 'Turn off microphone for everyone', 'Turn off microphone for all'],
    },
  },
]

const norm = (s: string): string => s.trim().toLowerCase()

/**
 * What one label says, as md-mute's classify() reads it (native/mute/main.swift; keep the two the
 * same): null when it starts with an `exclude` prefix or with none of the rule's prefixes; else
 * the side whose matching prefix is the longest (the most specific: "Unmute microphone" over
 * "Mute"), muted on a tie. A prefix listed in `whole` matches only the whole label or the label
 * followed by " (". Case and outer spaces are ignored.
 */
export function classifyLabel(
  label: string,
  rule: Pick<ElementRule, 'muted' | 'unmuted' | 'exclude' | 'whole'>,
): 'muted' | 'unmuted' | null {
  const l = norm(label)
  if (!l) return null
  if ((rule.exclude ?? []).some((p) => norm(p) && l.startsWith(norm(p)))) return null
  const whole = new Set((rule.whole ?? []).map(norm))
  const matches = (p: string): boolean => (whole.has(p) ? l === p || l.startsWith(p + ' (') : l.startsWith(p))
  const best = (ps: readonly string[]): number => Math.max(0, ...ps.map(norm).filter((p) => p && matches(p)).map((p) => p.length))
  const m = best(rule.muted)
  const u = best(rule.unmuted)
  if (!m && !u) return null
  return m >= u ? 'muted' : 'unmuted'
}

/**
 * One control's labels (the rule's attributes, in order), as md-mute's classifyControl() reads
 * them: null when any label is excluded (a "Mute all" is never yours, whatever its other labels
 * say), else the first label that classifies.
 */
export function classifyControl(
  labels: readonly string[],
  rule: Pick<ElementRule, 'muted' | 'unmuted' | 'exclude' | 'whole'>,
): 'muted' | 'unmuted' | null {
  const ex = (rule.exclude ?? []).map(norm).filter(Boolean)
  if (labels.some((l) => ex.some((p) => norm(l).startsWith(p)))) return null
  for (const l of labels) {
    const s = classifyLabel(l, { muted: rule.muted, unmuted: rule.unmuted, whole: rule.whole })
    if (s) return s
  }
  return null
}

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
 * Readings of 'unknown' in a row that leave 'muted' (7 × 400 ms, about 3 s): a control being
 * rebuilt, a window redrawn or md-mute's next full search must not let the mic in while you are
 * still muted. Unknown for longer (the call ended, the app hid its controls) does.
 */
export const MUTE_UNKNOWN_HOLD = 7

/** md-mute's reading clock (one line every 400 ms); MuteWatch keeps it while md-mute is down. */
export const MUTE_TICK_MS = 400

/**
 * The settled mute, debounced only on the way back to the mic: the first 'muted' reading settles
 * at once (dropping the mic is the safe side), while leaving 'muted' takes two 'unmuted' readings
 * in a row, or MUTE_UNKNOWN_HOLD 'unknown' ones, so a stray reading or a short gap in what
 * md-mute can see never lets the mic in. Between 'unmuted' and 'unknown' (both keep the mic) a
 * reading counts at once. Starts unknown.
 */
export class MuteSettle {
  private settled: MuteState = 'unknown'
  private last: MuteState | null = null
  /** How many readings in a row were `last`. */
  private run = 0

  /** Feeds one reading; returns the settled state after it. */
  push(s: MuteState): MuteState {
    this.run = s === this.last ? this.run + 1 : 1
    this.last = s
    if (s === 'muted' || this.settled !== 'muted') this.settled = s
    else if (this.run >= (s === 'unmuted' ? 2 : MUTE_UNKNOWN_HOLD)) this.settled = s
    return this.settled
  }

  get state(): MuteState {
    return this.settled
  }

  /** The helper started again, or a new recording: nothing carries over. */
  reset(): void {
    this.settled = 'unknown'
    this.last = null
    this.run = 0
  }

  /**
   * The mic follows another app now: a settled 'muted' is kept until the new app's readings leave
   * it as above (one reading of another app never lets the mic in); anything else starts over.
   */
  switched(): void {
    if (this.settled !== 'muted') this.settled = 'unknown'
    this.last = null
    this.run = 0
  }
}

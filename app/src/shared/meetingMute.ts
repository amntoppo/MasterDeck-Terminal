/**
 * Meetings: the mic follows the meeting app's mute (Plan M, issue #102). The rules md-mute reads
 * the meeting apps' own Mute / Unmute control by, and the app's side of its line protocol
 * (native/mute/main.swift is the other side):
 *
 *   stdin, once:  muteRulesLine(rules)  one line of JSON
 *   stdout:       {"t":<ms>,"trusted":bool,"apps":[{"id":"zoom","state":"muted"|"unmuted"|"unknown", …}]}
 *                 every 400 ms; only apps with a running process are listed. Each app may also
 *                 carry diagnostics: why, label (the matched control's only), searched, ms, cached
 *                 (MuteApp; a helper from before them sends none).
 *
 * ponytail: every rule below is a guess from the apps' published shortcuts and screen-reader
 * labels; none was checked on a real call (none of the apps is installed here). They are data, so a
 * fix is a change here, not a rebuild of the helper: check one by hand with OPERATIONS § Meetings:
 * md-mute.
 */

import { MUTE_WHYS, type MuteWhy } from './meetings'

export type MuteState = 'muted' | 'unmuted' | 'unknown'

/**
 * The roles a mute control may have. A web page's toggle (Meet's mic button) shows as an AXButton
 * (sometimes with subrole AXToggle), an AXCheckBox or an AXToggleButton depending on the browser.
 */
export type ControlRole = 'AXButton' | 'AXCheckBox' | 'AXToggleButton'

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
  roles: readonly ControlRole[]
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
  /**
   * The control is in a web page (a browser): md-mute searches from the windows' AXWebArea
   * elements (not the browser's toolbars) with a larger budget (800 ms, 40000 elements).
   */
  web?: boolean
  /**
   * With `web`: only pages whose address is on one of these hosts (or below one) are searched;
   * md-mute reads each AXWebArea's AXURL for its host and nothing else of it.
   */
  hosts?: readonly string[]
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
      roles: ['AXButton'],
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
      roles: ['AXButton'],
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
    web: true,
    hosts: ['meet.google.com'],
    // ponytail: unverified on a real call; Settings → Meetings → Check mute reading shows what
    // md-mute sees. Meet's mic button has the aria-label "Turn off microphone" while you are heard
    // and "Turn on microphone" while muted, often with a shortcut after it (" (⌘ + d)", " (ctrl +
    // d)"), which the prefix covers. Chrome gives an aria-label as AXDescription, on an AXButton
    // (subrole AXToggle) or, for a toggle, an AXCheckBox / AXToggleButton. English labels only.
    // Only the tab on screen is in a browser's tree: a Meet in a background tab reads as unknown.
    element: {
      roles: ['AXButton', 'AXCheckBox', 'AXToggleButton'],
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
        ...(r.web ? { web: true } : {}),
        // An md-mute from before `hosts` ignores it and searches every page.
        ...(r.web && r.hosts?.length ? { hosts: r.hosts } : {}),
        ...(r.menu ? { menu: r.menu } : {}),
        // `role` too: an md-mute from before `roles` reads only that.
        ...(r.element ? { element: { ...r.element, role: r.element.roles[0] } } : {}),
      })),
    }) + '\n'
  )
}

export interface MuteApp {
  id: string
  state: MuteState
  /** Diagnostics (md-mute since they were added; none from an older one). */
  why?: MuteWhy
  /** The matched control's label (printable ASCII, at most 80): only with why 'found'. */
  label?: string
  /** Elements visited this tick (0: no search ran, the last one's why is said again). */
  searched?: number
  /** Time spent on this app this tick. */
  ms?: number
  /** Read from the control found before (no search). */
  cached?: boolean
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
/** What md-mute may say about a running app (never 'not-running': it lists running apps only). */
const LINE_WHYS: ReadonlySet<string> = new Set(MUTE_WHYS.filter((w) => w !== 'not-running'))
const LABEL = /^[\x20-\x7e]{1,80}$/
const count = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max

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
    const { id, state, why, label, searched, ms, cached } = a as Record<string, unknown>
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) return null
    if (known && !known.has(id)) return null
    if (typeof state !== 'string' || !STATES.has(state)) return null
    // Not trusted, nothing can be read: a line that says otherwise is not believed.
    if (!o.trusted && state !== 'unknown') return null
    // The diagnostics, each optional, each checked, and consistent with the state.
    if (why !== undefined) {
      if (typeof why !== 'string' || !LINE_WHYS.has(why)) return null
      if ((why === 'found') !== (state !== 'unknown')) return null
      if (!o.trusted && why !== 'not-trusted') return null
    }
    if (label !== undefined && (typeof label !== 'string' || !LABEL.test(label) || why !== 'found')) return null
    if (searched !== undefined && !count(searched, 10_000_000)) return null
    if (ms !== undefined && !count(ms, 600_000)) return null
    if (cached !== undefined && typeof cached !== 'boolean') return null
    seen.add(id)
    apps.push({
      id,
      state: state as MuteState,
      ...(why !== undefined ? { why: why as MuteWhy } : {}),
      ...(label !== undefined ? { label: label as string } : {}),
      ...(searched !== undefined ? { searched: searched as number } : {}),
      ...(ms !== undefined ? { ms: ms as number } : {}),
      ...(cached !== undefined ? { cached: cached as boolean } : {}),
    })
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

// ── Check mute reading (Settings → Meetings) ────────────────────────────────

/** One app in the check's answer: every rule's app, running or not. */
export interface MuteCheckApp {
  id: string
  name: string
  state: MuteState
  why: MuteWhy
  label?: string
  /** The last full search's elements and time (or the last reading's, when none ran). */
  searched: number
  ms: number
}

/**
 * meetings:muteCheck: md-mute run with every rule for MUTE_CHECK_MS. `found`: the helper is there;
 * `trusted`: what the helper says of Accessibility; `gateTrusted`: what macOS says of MasterDeck
 * (the two differ when the grant does not reach the helper). `message`: the helper sent nothing.
 */
export type MuteCheckAnswer =
  | { ok: true; found: boolean; trusted: boolean; gateTrusted: boolean; apps: MuteCheckApp[]; message?: string }
  | { ok: false; message: string }

/** How long the check reads (several ticks: a browser's first tree may come a tick late). */
export const MUTE_CHECK_MS = 3000

/**
 * The check's apps from what md-mute said: per rule, its last reading (with the last real search's
 * size and time), or 'not-running' when md-mute never listed it. A helper from before the
 * diagnostics gets a why from its state.
 */
export function muteCheckApps(readings: readonly MuteReading[], rules: readonly MuteRule[] = MUTE_RULES): MuteCheckApp[] {
  const last = readings.at(-1)
  return rules.map((r): MuteCheckApp => {
    const a = last?.apps.find((x) => x.id === r.id)
    if (!last || !a) return { id: r.id, name: r.name, state: 'unknown', why: 'not-running', searched: 0, ms: 0 }
    const search = [...readings]
      .reverse()
      .map((x) => x.apps.find((y) => y.id === r.id))
      .find((y) => !!y && (y.searched ?? 0) > 0 && !y.cached)
    const why: MuteWhy = a.why ?? (a.state !== 'unknown' ? 'found' : last.trusted ? 'no-control' : 'not-trusted')
    return {
      id: r.id,
      name: r.name,
      state: a.state,
      why,
      ...(a.label ? { label: a.label } : {}),
      searched: (search ?? a).searched ?? 0,
      ms: (search ?? a).ms ?? 0,
    }
  })
}

const READS: Record<MuteState, string> = { muted: 'Muted', unmuted: 'Unmuted', unknown: 'Unknown' }

/** One row's Why: a plain sentence. */
export function muteCheckWhy(a: MuteCheckApp, rule?: Pick<MuteRule, 'web'>): string {
  const size = a.searched > 0 ? ` (${a.searched} elements in ${a.ms} ms)` : ''
  switch (a.why) {
    case 'found':
      return a.label ? `${READS[a.state]} (button says '${a.label}')` : `${READS[a.state]} (button found)`
    case 'not-running':
      return 'Not running'
    case 'not-trusted':
      return "Accessibility not given to MasterDeck's helper"
    case 'no-control':
      return rule?.web
        ? `No mute button found — is the call in the front tab, or Meet is full screen / on another desktop — press Check from the same desktop as the call${size}`
        : `No mute button found — is a call open?${size}`
    case 'cut':
      return `Search cut short${size}`
    case 'error':
      return 'The app did not answer (busy or not responding)'
  }
}

/** macOS trusts MasterDeck, its helper says it is not trusted: the grant is for an older build. */
export const MUTE_CHECK_SPLIT_GRANT =
  'macOS gave Accessibility to MasterDeck but not to its helper. Remove MasterDeck from Accessibility in System Settings and allow it again (each new build needs this).'

/** The check's answer as Settings → Meetings shows it: notes above the table, then a row per app. */
export function muteCheckView(
  a: Extract<MuteCheckAnswer, { ok: true }>,
  rules: readonly MuteRule[] = MUTE_RULES,
): { notes: string[]; rows: { id: string; app: string; reads: string; why: string }[] } {
  const notes: string[] = []
  if (!a.found) notes.push('The mute reader is missing; reinstall MasterDeck.')
  else if (a.message) notes.push(a.message)
  // Only what the helper itself said (a line with trusted: false), never a helper that failed or sent nothing.
  if (a.found && !a.message && !a.trusted && a.gateTrusted) notes.push(MUTE_CHECK_SPLIT_GRANT)
  else if (a.found && !a.message && !a.trusted) notes.push("Accessibility not given to MasterDeck's helper: Allow it above.")
  const rows = a.apps.map((x) => ({
    id: x.id,
    app: x.name,
    reads: READS[x.state],
    why: muteCheckWhy(x, rules.find((r) => r.id === x.id)),
  }))
  return { notes, rows }
}

/**
 * The offer (spec §2): which meeting apps are in a call, read from the running processes
 * (`ps -axo comm`: one executable path per line on macOS). An app counts only by a process it runs
 * during a call, inside its own app bundle, never by the app merely being open.
 *
 * ponytail: the ceiling is a process list, and only apps with a call-only process are on it.
 * Zoom runs CptHost (and on newer versions aomhost) only while in a meeting; Webex runs its
 * "Meeting Center" only in a meeting. Microsoft Teams and Slack run calls and huddles inside their
 * usual processes, so they cannot be told apart from the app being open and are left out; Google
 * Meet in a browser too. The upgrade is Core Audio's "microphone in use by another process"
 * (kAudioDevicePropertyDeviceIsRunningSomewhere) through the Swift helper, which covers them all.
 */
export interface MeetingApp {
  /** What the offer says: "Zoom call: record it?" */
  name: string
  /** The executable's own name (the last part of the path) while in a call. */
  exe: readonly string[]
  /** The path must also match this: the process is the app's own, not one that shares a name. */
  within: RegExp
}

export const MEETING_APPS: readonly MeetingApp[] = [
  { name: 'Zoom', exe: ['CptHost', 'aomhost'], within: /\/zoom\.us\.app\//i },
  { name: 'Webex', exe: ['Meeting Center'], within: /webex/i },
]

/** How often the offer looks, and how long one `ps` may take. */
export const OFFER_POLL_MS = 10_000
export const PS_TIMEOUT_MS = 5_000

/** The apps in a call in `ps -axo comm` output, each once, in MEETING_APPS order. */
export function callApps(psOut: string, apps: readonly MeetingApp[] = MEETING_APPS): string[] {
  const found = new Set<string>()
  for (const raw of psOut.split('\n')) {
    const line = raw.trim()
    if (!line || line === 'COMM') continue
    const exe = line.slice(line.lastIndexOf('/') + 1)
    for (const a of apps) if (a.exe.includes(exe) && a.within.test(line)) found.add(a.name)
  }
  return apps.map((a) => a.name).filter((n) => found.has(n))
}

/** The notification's and the rail chip's words. */
export const offerText = (app: string): string => `${app} call: record it?`

// In-app updates (issue #122): the model the main process keeps and the window shows. Never part of
// AppState (it reaches the window through update:* only; a browser never sees or drives it).

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error'

export type UpdateErrorKind = 'offline' | 'check' | 'download' | 'verify' | 'install' | 'permission'

export type UpdateChannel = 'stable' | 'beta'

/** The server's answer to GET /v1/updates/check (200): the highest version offered to this install. */
export interface UpdateOffer {
  version: string
  channel: UpdateChannel
  /** Release notes, Markdown (draw with MarkdownView html={false}). */
  notes: string
  /** The file's name, as signed (MasterDeck-<v>-arm64-mac.zip, MasterDeck-Setup-<v>.exe). */
  name: string
  url: string
  /** Base64 SHA-512 of the file. */
  sha512: string
  size: number
  /** Base64 Ed25519 signature of signedMessage(...). */
  signature: string
  publishedAt: number
  mandatory: boolean
}

export interface UpdateState {
  /** This app's version. */
  current: string
  platform: string
  arch: string
  /** False in a development build, with MASTERDECK_UPDATES=0, or a Mac app run from a read-only place. */
  enabled: boolean
  /** Why updates are off, for Settings. */
  disabledReason?: string
  phase: UpdatePhase
  offer?: UpdateOffer
  /** 0-1 while downloading. */
  progress?: number
  lastChecked?: number
  /** What went wrong, one line (no paths). */
  error?: string
  errorKind?: UpdateErrorKind
  /** The server says this version is below the oldest supported one. */
  mandatory: boolean
  /** Remind me later: no prompt before this time (kept in memory: the next launch asks again). */
  remindAt?: number
  /** The last update did not start and the previous version was put back; that version is skipped until a newer one. */
  rolledBack?: { version: string; reason: string; at: number }
  /** This launch is the first of an update: "Updated from 0.9.0". */
  updatedFrom?: { from: string; at: number }
  /** The Mac's app folder is not writable: Restart asks for the administrator's password. */
  needsAdmin?: boolean
}

/** Remind me later: four hours. */
export const REMIND_MS = 4 * 3_600_000
/** Background checks: every six hours. */
export const CHECK_EVERY_MS = 6 * 3_600_000
/** The first check after launch. */
export const FIRST_CHECK_MS = 30_000
/** The new app says it is healthy this long after its window loaded. */
export const HEALTHY_AFTER_MS = 10_000

type Semver = { nums: [number, number, number]; pre: string[] }

function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** A version the updater accepts (semver, an optional prerelease and build). */
export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && parseSemver(v) !== null
}

/**
 * Semver order, prereleases below their release (`0.10.0-beta.1 < 0.10.0`), numeric identifiers
 * compared as numbers. Something that is no version sorts below every version.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** A tag with a `-` is the beta channel. */
export function channelOf(version: string): UpdateChannel {
  return version.includes('-') ? 'beta' : 'stable'
}

export interface SignedFields {
  version: string
  platform: string
  arch: string
  name: string
  sha512: string
}

/** The message a release file's signature covers (spec §1): UTF-8, `\n` between lines, none at the end. */
export function signedMessage(f: SignedFields): string {
  return ['masterdeck-update', 'v1', f.version, f.platform, f.arch, f.name, f.sha512].join('\n')
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The check's 200 answer, or null when it is not the expected shape (an unsafe file name included). */
export function parseOffer(raw: unknown): UpdateOffer | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const ok =
    isVersion(r.version) &&
    typeof r.name === 'string' &&
    /^[0-9A-Za-z._-]{1,200}$/.test(r.name) &&
    typeof r.url === 'string' &&
    /^https?:\/\/\S+$/.test(r.url) &&
    typeof r.sha512 === 'string' &&
    B64.test(r.sha512) &&
    typeof r.signature === 'string' &&
    B64.test(r.signature) &&
    typeof r.size === 'number' &&
    Number.isSafeInteger(r.size) &&
    r.size > 0
  if (!ok) return null
  return {
    version: r.version as string,
    channel: r.channel === 'beta' ? 'beta' : 'stable',
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 50_000) : '',
    name: r.name as string,
    url: r.url as string,
    sha512: r.sha512 as string,
    size: r.size as number,
    signature: r.signature as string,
    publishedAt: typeof r.publishedAt === 'number' ? r.publishedAt : 0,
    mandatory: r.mandatory === true,
  }
}

/** GET /v1/updates/check for this install. */
export function checkUrl(base: string, q: { version: string; platform: string; arch: string; channel: UpdateChannel; id: string }): string {
  const p = new URLSearchParams({ version: q.version, platform: q.platform, arch: q.arch, channel: q.channel, id: q.id })
  return `${base}/v1/updates/check?${p.toString()}`
}

/** What the macOS helper wrote after an install (`<userData>/updates/result.json`). */
export type UpdateResult =
  | { ok: true; from: string; version: string; at: number }
  | { ok: false; version: string; reason: string; at: number }

export function parseResult(text: string): UpdateResult | null {
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || !isVersion(v.version)) return null
    const at = typeof v.at === 'number' ? v.at : 0
    if (v.ok === true && isVersion(v.from)) return { ok: true, from: v.from, version: v.version, at }
    if (v.ok === false) return { ok: false, version: v.version, reason: typeof v.reason === 'string' ? v.reason.slice(0, 40) : 'unknown', at }
    return null
  } catch {
    return null
  }
}

/** One line for Settings → Updates. */
export function statusLine(s: UpdateState): string {
  if (!s.enabled) return s.disabledReason ?? 'Updates are off'
  const v = s.offer ? `v${s.offer.version}` : ''
  switch (s.phase) {
    case 'idle':
      return 'Not checked yet'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return 'Up to date'
    case 'available':
      return s.mandatory ? `Required update: ${v}` : `Update available: ${v}`
    case 'downloading':
      return `Downloading ${Math.round((s.progress ?? 0) * 100)}%`
    case 'verifying':
      return 'Verifying the update…'
    case 'ready':
      return 'Ready to install'
    case 'installing':
      return 'Installing…'
    case 'error':
      switch (s.errorKind) {
        case 'offline':
          return 'Offline: could not check for updates'
        case 'download':
          return 'The download failed'
        case 'verify':
          return 'The update could not be verified'
        case 'install':
          return 'The update could not be installed'
        case 'permission':
          return 'The update needs an administrator password'
        default:
          return 'Could not check for updates'
      }
  }
}

/** Ask "Restart now to update" now: an update is ready and Remind me later has run out. */
export function shouldPrompt(s: UpdateState, now: number): boolean {
  return s.enabled && s.phase === 'ready' && !!s.offer && (s.remindAt === undefined || now >= s.remindAt)
}

/** The mark on the rail's Settings icon: a required update, one ready, one available; else none. */
export function badge(s: UpdateState): 'required' | 'ready' | 'available' | null {
  if (!s.enabled || !s.offer) return null
  const pending = s.phase === 'available' || s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'ready'
  if (!pending) return null
  if (s.mandatory) return 'required'
  return s.phase === 'ready' ? 'ready' : 'available'
}

/** The prompt's text when an update is ready. */
export function readyLine(s: UpdateState): string {
  return s.offer ? `MasterDeck ${s.offer.version} is ready. Restart now to update.` : ''
}

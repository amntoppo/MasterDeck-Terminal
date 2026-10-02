import { commitment, publicRaw, randomNonce, words } from '@shared/e2e'
import type { KeyRec } from './keys'

export interface Res { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Api {
  get(path: string): Promise<Res>
  post(path: string, body: unknown): Promise<Res>
  del?(path: string): Promise<Res>
}
export type Outcome = 'approved' | 'denied' | 'expired' | 'notPaired' | 'tooMany'

interface Deps {
  api: Api
  rec: KeyRec
  name: string
  save(rec: KeyRec): Promise<void>
  onWords(w: string[]): void
  /** Sleep between polls; the Gate makes it throw to cancel. */
  wait(ms: number): Promise<void>
  /** A new key pair: every new request gets one, so a denied key's 1-hour block never stops the next try. */
  generate(): Promise<CryptoKeyPair>
}

/**
 * Approval by commit-reveal (spec §1): commit to our key, wait for the Mac's nonce, reveal, show the words, wait for
 * the Mac's decision. The Mac key used later for the handshake is the one the words were computed over.
 */
export async function approve({ api, name, save, onWords, wait, generate, rec: start }: Deps): Promise<Outcome> {
  let rec = start
  let asked = false
  let myPub = await publicRaw(rec.pair.publicKey)
  const ask = async (): Promise<Outcome | null> => {
    asked = true
    const pair = await generate()
    const pub = await publicRaw(pair.publicKey)
    const nB = randomNonce()
    const r = await api.post('/v1/browsers', { name, commit: await commitment(pub, nB) })
    if (r.status === 409) return 'notPaired'
    if (r.status === 429) return 'tooMany'
    if (r.status !== 201) throw new Error(r.body?.error ?? `HTTP ${r.status}`)
    // Saving replaces the old record: the old pair is gone.
    rec = { browserId: String(r.body.id), pair, nB }
    myPub = pub
    await save(rec)
    return null
  }
  if (!rec.browserId) {
    const o = await ask()
    if (o) return o
  }
  let shown = false
  for (;;) {
    const g = await api.get(`/v1/browsers/${encodeURIComponent(rec.browserId!)}`)
    if (g.status === 401 || g.status === 403) throw new Error(g.body?.error ?? 'signed out')
    const status: string = g.status === 404 ? 'expired' : g.status === 200 ? g.body.status : 'retry'
    // Only trust "approved" for a request whose words we showed: the Mac key must be the one checked by the user.
    if (status === 'approved' && rec.macPublicKey) return 'approved'
    if (status !== 'pending' && status !== 'retry') {
      if (asked) return status === 'denied' ? 'denied' : 'expired'
      // A stored request that is over (revoked, denied, expired, or approved without our words): ask afresh.
      const o = await ask()
      if (o) return o
      continue
    }
    if (status === 'pending' && !rec.macNonce && g.body.macNonce && g.body.macPublicKey) {
      const macNonce = String(g.body.macNonce)
      // Recorded before the POST: a reload that lost its answer finds it and does not take the 409 for an expiry.
      const sentBefore = rec.revealFor === macNonce
      if (!sentBefore) await save((rec = { ...rec, revealFor: macNonce }))
      const r = await api.post(`/v1/browsers/${encodeURIComponent(rec.browserId!)}/reveal`, { publicKey: myPub, nonce: rec.nB })
      if (r.status === 429) return 'tooMany'
      if (r.status !== 200 && !(r.status === 409 && sentBefore)) return 'expired'
      rec = { ...rec, macPublicKey: String(g.body.macPublicKey), macNonce: String(g.body.macNonce) }
      await save(rec)
    }
    if (rec.macNonce && !shown) {
      onWords(await words(rec.macPublicKey!, myPub, rec.macNonce, rec.nB!))
      shown = true
    }
    await wait(2000)
  }
}

export type AfterClose = 'retry' | 'signin' | 'revoked' | 'otherTab'

/**
 * The socket closed: what next. 4009 another tab; 4003 revoked/signed out; 4008 (closed by the Mac) or a close
 * before the Mac's hello (e.g. HTTP 403 seen as 1006) → ask the backend instead of retrying blind (e2e H/I).
 */
export async function afterClose(api: Api, browserId: string, code: number, reason: string, helloed: boolean): Promise<AfterClose> {
  if (code === 4009) return 'otherTab'
  if (code !== 4003 && code !== 4008 && helloed) return 'retry'
  const path = `/v1/browsers/${encodeURIComponent(browserId)}`
  // Best effort: a signed-out browser's row should not stay approved.
  if (code === 4003 && reason === 'signed out') await api.del?.(path).catch(() => null)
  try {
    const s = await api.get('/auth/get-session')
    if (s.status === 401 || (s.status === 200 && !s.body?.user?.id)) return 'signin'
    if (code === 4003) return 'revoked'
    const g = await api.get(path)
    if (g.status === 404 || (g.status === 200 && g.body?.status !== 'approved')) return 'revoked'
  } catch {
    // Backend unreachable: 4003 is still final; anything else backs off.
  }
  return code === 4003 ? 'revoked' : 'retry'
}

/** "Chrome on macOS" from the user agent, ≤ 80 chars. */
export function browserName(ua: string): string {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return (os ? `${b} on ${os}` : b).slice(0, 80)
}

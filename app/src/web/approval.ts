import { commitment, publicRaw, randomNonce, words } from '@shared/e2e'
import type { KeyRec } from './keys'

export interface Res { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Api {
  get(path: string): Promise<Res>
  post(path: string, body: unknown): Promise<Res>
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
}

/**
 * Approval by commit-reveal (spec §1): commit to our key, wait for the Mac's nonce, reveal, show the words, wait for
 * the Mac's decision. The Mac key used later for the handshake is the one the words were computed over.
 */
export async function approve({ api, name, save, onWords, wait, rec: start }: Deps): Promise<Outcome> {
  let rec = start
  let asked = false
  const myPub = await publicRaw(rec.pair.publicKey)
  const ask = async (): Promise<Outcome | null> => {
    asked = true
    const nB = randomNonce()
    const r = await api.post('/v1/browsers', { name, commit: await commitment(myPub, nB) })
    if (r.status === 409) return 'notPaired'
    if (r.status === 429) return 'tooMany'
    if (r.status !== 201) throw new Error(r.body?.error ?? `HTTP ${r.status}`)
    rec = { browserId: String(r.body.id), pair: rec.pair, nB }
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
      const r = await api.post(`/v1/browsers/${encodeURIComponent(rec.browserId!)}/reveal`, { publicKey: myPub, nonce: rec.nB })
      if (r.status === 429) return 'denied'
      if (r.status !== 200) return 'expired'
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

/** "Chrome on macOS" from the user agent, ≤ 80 chars. */
export function browserName(ua: string): string {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return (os ? `${b} on ${os}` : b).slice(0, 80)
}

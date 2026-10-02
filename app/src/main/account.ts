import type { AccountState, Provider } from '@shared/account'

export interface AccountDeps {
  baseUrl: string
  fetch: typeof fetch
  openBrowser(url: string): void
  deviceName: string
  saveToken(token: string | null): { ok: boolean; message: string }
  readIdentity(): { email: string; provider: Provider; deviceId: string } | null
  saveIdentity(id: { email: string; provider: Provider; deviceId: string } | null): void
  onChange(s: AccountState): void
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const CLIENT_ID = 'masterdeck-desktop'
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * MasterDeck's sign-in to its MasterDeck account. Google/GitHub/Apple go through the browser with the
 * OAuth device-code flow; email signs in here. Either way the short session is exchanged once for
 * this Mac's own device token (kept in the Keychain) and then signed out.
 */
export class Account {
  private st: AccountState
  private running = false
  private cancelled = false

  constructor(private d: AccountDeps) {
    const id = d.readIdentity()
    this.st = id ? { kind: 'signedIn', ...id } : { kind: 'signedOut', message: null }
  }

  state(): AccountState {
    return this.st
  }

  private set(s: AccountState): void {
    this.st = s
    this.d.onChange(s)
  }

  private now = () => (this.d.now ?? Date.now)()
  private sleep = (ms: number) => (this.d.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms)

  private ctl = new AbortController()

  private sig(): AbortSignal {
    return AbortSignal.any([this.ctl.signal, AbortSignal.timeout(this.d.timeoutMs ?? 10_000)])
  }

  /** Better Auth's CSRF check rejects Sec-Fetch-* requests with no Origin; Node's fetch sends the former only. */
  private originFor(path: string): Record<string, string> {
    return path.startsWith('/auth/') ? { origin: this.d.baseUrl } : {}
  }

  private post(path: string, body: unknown, bearer?: string, signal: AbortSignal = this.sig()): Promise<Response> {
    return this.d.fetch(`${this.d.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.originFor(path), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      signal,
    })
  }

  /** Sleep that ends early when the flow is cancelled. */
  private nap(ms: number): Promise<void> {
    const s = this.ctl.signal
    return Promise.race([this.sleep(ms), new Promise<void>((r) => (s.aborted ? r() : s.addEventListener('abort', () => r(), { once: true })))])
  }

  private verifyUrlFor(uri: unknown, provider: string): string | null {
    try {
      const u = new URL(String(uri))
      const base = new URL(this.d.baseUrl)
      const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      if (u.origin !== base.origin || (u.protocol !== 'https:' && !local)) return null
      u.search = ''
      u.hash = ''
      u.searchParams.set('provider', provider)
      return u.toString()
    } catch {
      return null
    }
  }

  async signInWith(provider: 'google' | 'github' | 'apple'): Promise<void> {
    if (this.running) return
    this.running = true
    this.cancelled = false
    this.ctl = new AbortController()
    try {
      const r = await this.post('/auth/device/code', { client_id: CLIENT_ID })
      if (this.cancelled) return this.set({ kind: 'signedOut', message: null })
      if (!r.ok) return this.set({ kind: 'signedOut', message: `Couldn't start sign-in (${r.status})` })
      const c = (await r.json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number }
      const verifyUrl = this.verifyUrlFor(c.verification_uri, provider)
      if (!verifyUrl) return this.set({ kind: 'signedOut', message: "Sign-in returned an address that isn't MasterDeck's" })
      if (this.cancelled) return this.set({ kind: 'signedOut', message: null })
      const expiresAt = this.now() + (c.expires_in ?? 600) * 1000
      this.set({ kind: 'pending', provider, userCode: c.user_code, verifyUrl, expiresAt })
      this.d.openBrowser(verifyUrl)
      let interval = Math.max(1000, (c.interval ?? 5) * 1000)
      while (!this.cancelled) {
        if (this.now() >= expiresAt) return this.set({ kind: 'signedOut', message: 'That sign-in expired; try again' })
        let res: Response
        try {
          res = await this.post('/auth/device/token', { grant_type: GRANT, device_code: c.device_code, client_id: CLIENT_ID })
        } catch {
          await this.nap(interval)
          continue
        }
        if (this.cancelled) break
        if (res.ok) {
          const { access_token } = (await res.json()) as { access_token: string }
          if (this.cancelled) break
          const who = await this.d.fetch(`${this.d.baseUrl}/auth/get-session`, { headers: { ...this.originFor('/auth/'), authorization: `Bearer ${access_token}` }, signal: this.sig() }).catch(() => null)
          const email = ((await who?.json().catch(() => null)) as { user?: { email?: string } } | null)?.user?.email ?? ''
          if (this.cancelled) {
            void this.dropSession(access_token)
            break
          }
          return void (await this.finish(access_token, email, provider))
        }
        const err = ((await res.json().catch(() => ({}))) as { error?: string }).error
        if (err === 'access_denied') return this.set({ kind: 'signedOut', message: 'Sign-in was denied' })
        if (err === 'expired_token') return this.set({ kind: 'signedOut', message: 'That sign-in expired; try again' })
        if (err === 'slow_down' || res.status === 429) interval += 5000
        else if (err !== 'authorization_pending' && res.status >= 400 && res.status < 500) return this.set({ kind: 'signedOut', message: `Sign-in failed (${err ?? res.status})`.slice(0, 200) })
        await this.nap(interval)
      }
      this.set({ kind: 'signedOut', message: null })
    } catch (e) {
      this.set(this.cancelled ? { kind: 'signedOut', message: null } : { kind: 'signedOut', message: `Sign-in failed: ${String(e)}`.slice(0, 200) })
    } finally {
      this.running = false
    }
  }

  cancel(): void {
    this.cancelled = true
    this.ctl.abort()
  }

  private dropSession(session: string): Promise<unknown> {
    return this.post('/auth/sign-out', {}, session, AbortSignal.timeout(this.d.timeoutMs ?? 10_000)).catch(() => undefined)
  }

  private async dropDevice(token: string): Promise<void> {
    await this.d
      .fetch(`${this.d.baseUrl}/v1/devices/self`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.d.timeoutMs ?? 10_000) })
      .catch(() => undefined)
  }

  /** Exchange a short session for this Mac's device token, then drop the session. */
  private async finish(session: string, email: string, provider: Provider): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await this.post('/v1/devices', { name: deviceName(this.d.deviceName) }, session)
      if (r.status === 409) {
        this.set({ kind: 'signedOut', message: 'This account already has 5 signed-in Macs; sign one out at dev.masterdeck.dev/account' })
        return { ok: false, message: 'too many Macs' }
      }
      const body = r.ok ? ((await r.json().catch(() => null)) as { id?: unknown; token?: unknown } | null) : null
      if (!r.ok || typeof body?.id !== 'string' || typeof body?.token !== 'string') {
        this.set({ kind: 'signedOut', message: `Couldn't register this Mac (${r.status})` })
        return { ok: false, message: `register failed (${r.status})` }
      }
      const { id, token } = body as { id: string; token: string }
      const saved = this.d.saveToken(token)
      if (!saved.ok) {
        await this.dropDevice(token)
        this.set({ kind: 'signedOut', message: saved.message })
        return { ok: false, message: saved.message }
      }
      const identity = { email, provider, deviceId: id }
      try {
        this.d.saveIdentity(identity)
      } catch (e) {
        this.d.saveToken(null)
        await this.dropDevice(token)
        this.set({ kind: 'signedOut', message: `Couldn't save sign-in: ${String(e)}`.slice(0, 200) })
        return { ok: false, message: 'identity save failed' }
      }
      this.set({ kind: 'signedIn', ...identity })
      return { ok: true, message: 'signed in' }
    } finally {
      await this.dropSession(session)
    }
  }

  async signInEmail(email: string, password: string, create: boolean, name?: string): Promise<{ ok: boolean; message: string }> {
    if (this.running) return { ok: false, message: 'A sign-in is already in progress' }
    this.running = true
    this.cancelled = false
    this.ctl = new AbortController()
    try {
      if (create) {
        const r = await this.post('/auth/sign-up/email', { email, password, name: name || email.split('@')[0] })
        if (!r.ok) return { ok: false, message: await errorText(r) }
        return { ok: true, message: 'Account created. Check your inbox to verify your email, then sign in' }
      }
      const r = await this.post('/auth/sign-in/email', { email, password })
      if (!r.ok) return { ok: false, message: await errorText(r) }
      const session = r.headers.get('set-auth-token')
      if (!session) return { ok: false, message: 'Sign-in did not return a session' }
      const user = ((await r.json()) as { user?: { email?: string } }).user
      return await this.finish(session, user?.email ?? email, 'email')
    } catch (e) {
      return { ok: false, message: `Couldn't reach MasterDeck: ${String(e)}`.slice(0, 200) }
    } finally {
      this.running = false
    }
  }

  async signOut(deviceToken: string | null): Promise<void> {
    this.cancel()
    if (deviceToken) await this.dropDevice(deviceToken)
    this.clear(null)
  }

  /** The server signed this Mac out (4003 / 401). */
  signedOutRemotely(message?: string): void {
    this.cancel()
    this.clear(message ?? 'This Mac was signed out')
  }

  private clear(message: string | null): void {
    this.d.saveToken(null)
    this.d.saveIdentity(null)
    this.set({ kind: 'signedOut', message })
  }
}

/** The backend rejects odd names with 400, so send a clean one. */
function deviceName(raw: string): string {
  const n = [...raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 80).join('').trim()
  return n || 'Mac'
}

async function errorText(r: Response): Promise<string> {
  const b = (await r.json().catch(() => ({}))) as { code?: string; message?: string }
  if (b.code === 'EMAIL_NOT_VERIFIED' || (r.status === 403 && /verif/i.test(b.message ?? ''))) return 'Check your inbox to verify your email, then sign in'
  if (r.status === 403) return 'Sign-in refused (403)'
  if (b.code === 'INVALID_EMAIL_OR_PASSWORD' || r.status === 401) return 'Wrong email or password'
  if (r.status === 429) return 'Too many attempts; wait a minute and try again'
  if (b.code === 'PASSWORD_COMPROMISED' || /breach/i.test(b.message ?? '')) return 'That password appears in a known data breach; choose another'
  if (b.code === 'PASSWORD_TOO_SHORT') return 'Use at least 10 characters'
  return b.message || `Sign-in failed (${r.status})`
}

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

  private post(path: string, body: unknown, bearer?: string): Promise<Response> {
    return this.d.fetch(`${this.d.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    })
  }

  async signInWith(provider: 'google' | 'github' | 'apple'): Promise<void> {
    if (this.running) return
    this.running = true
    this.cancelled = false
    try {
      const r = await this.post('/auth/device/code', { client_id: CLIENT_ID })
      if (!r.ok) return this.set({ kind: 'signedOut', message: `Couldn't start sign-in (${r.status})` })
      const c = (await r.json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number }
      const expiresAt = this.now() + (c.expires_in ?? 600) * 1000
      const verifyUrl = `${c.verification_uri}?provider=${provider}`
      this.set({ kind: 'pending', provider, userCode: c.user_code, verifyUrl, expiresAt })
      this.d.openBrowser(verifyUrl)
      let interval = (c.interval ?? 5) * 1000
      while (!this.cancelled) {
        if (this.now() >= expiresAt) return this.set({ kind: 'signedOut', message: 'That sign-in expired; try again' })
        let res: Response
        try {
          res = await this.post('/auth/device/token', { grant_type: GRANT, device_code: c.device_code, client_id: CLIENT_ID })
        } catch {
          await this.sleep(interval)
          continue
        }
        if (res.ok) {
          const { access_token } = (await res.json()) as { access_token: string }
          const who = await this.d.fetch(`${this.d.baseUrl}/auth/get-session`, { headers: { authorization: `Bearer ${access_token}` } })
          const email = ((await who.json().catch(() => null)) as { user?: { email?: string } } | null)?.user?.email ?? ''
          return void (await this.finish(access_token, email, provider))
        }
        const err = ((await res.json().catch(() => ({}))) as { error?: string }).error
        if (err === 'access_denied') return this.set({ kind: 'signedOut', message: 'Sign-in was denied' })
        if (err === 'expired_token') return this.set({ kind: 'signedOut', message: 'That sign-in expired; try again' })
        if (err === 'slow_down') interval += 5000
        await this.sleep(interval)
      }
      this.set({ kind: 'signedOut', message: null })
    } catch (e) {
      this.set({ kind: 'signedOut', message: `Sign-in failed: ${String(e)}`.slice(0, 200) })
    } finally {
      this.running = false
    }
  }

  cancel(): void {
    this.cancelled = true
  }

  /** Exchange a short session for this Mac's device token, then drop the session. */
  private async finish(session: string, email: string, provider: Provider): Promise<{ ok: boolean; message: string }> {
    const r = await this.post('/v1/devices', { name: deviceName(this.d.deviceName) }, session)
    if (r.status === 409) {
      this.set({ kind: 'signedOut', message: 'This account already has 5 signed-in Macs; sign one out at dev.masterdeck.dev/account' })
      return { ok: false, message: 'too many Macs' }
    }
    if (!r.ok) {
      this.set({ kind: 'signedOut', message: `Couldn't register this Mac (${r.status})` })
      return { ok: false, message: `register failed (${r.status})` }
    }
    const { id, token } = (await r.json()) as { id: string; token: string }
    const saved = this.d.saveToken(token)
    void this.post('/auth/sign-out', {}, session).catch(() => {})
    if (!saved.ok) {
      this.set({ kind: 'signedOut', message: saved.message })
      return { ok: false, message: saved.message }
    }
    const identity = { email, provider, deviceId: id }
    this.d.saveIdentity(identity)
    this.set({ kind: 'signedIn', ...identity })
    return { ok: true, message: 'signed in' }
  }

  async signInEmail(email: string, password: string, create: boolean, name?: string): Promise<{ ok: boolean; message: string }> {
    if (this.running) return { ok: false, message: 'A sign-in is already in progress' }
    this.running = true
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
    if (deviceToken)
      await this.d
        .fetch(`${this.d.baseUrl}/v1/devices/self`, { method: 'DELETE', headers: { authorization: `Bearer ${deviceToken}` } })
        .catch(() => undefined)
    this.clear(null)
  }

  /** The server signed this Mac out (4003 / 401). */
  signedOutRemotely(): void {
    this.clear('This Mac was signed out')
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
  if (b.code === 'EMAIL_NOT_VERIFIED' || r.status === 403) return 'Check your inbox to verify your email, then sign in'
  if (b.code === 'INVALID_EMAIL_OR_PASSWORD' || r.status === 401) return 'Wrong email or password'
  if (r.status === 429) return 'Too many attempts; wait a minute and try again'
  if (b.code === 'PASSWORD_COMPROMISED' || /breach/i.test(b.message ?? '')) return 'That password appears in a known data breach; choose another'
  if (b.code === 'PASSWORD_TOO_SHORT') return 'Use at least 10 characters'
  return b.message || `Sign-in failed (${r.status})`
}

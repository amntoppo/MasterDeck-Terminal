import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Account, type AccountDeps } from './account'

type Route = (init: RequestInit & { url: string }) => Response | Promise<Response>
function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`
    const r = routes[key]
    if (!r) return new Response('{}', { status: 404 })
    const h = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]) : r
    return h({ ...init, url })
  }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })

function deps(fetchImpl: typeof fetch, over: Partial<AccountDeps> = {}) {
  const states: any[] = []
  let token: string | null = null
  let identity: any = null
  const d: AccountDeps = {
    baseUrl: 'https://md.test', fetch: fetchImpl, openBrowser: vi.fn(), deviceName: 'Test Mac',
    saveToken: (t) => ((token = t), { ok: true, message: 'ok' }),
    readIdentity: () => identity, saveIdentity: (i) => (identity = i),
    onChange: (s) => states.push(s),
    now: () => 1_000_000, sleep: async () => {},
    ...over,
  }
  return { d, states, token: () => token, identity: () => identity }
}

const code = { device_code: 'DC', user_code: 'ABCD-EFGH', verification_uri: 'https://md.test/device', verification_uri_complete: 'https://md.test/device?user_code=ABCD-EFGH', interval: 5, expires_in: 600 }

describe('Account device flow', () => {
  it('opens the browser with the provider, polls, exchanges, signs the temp session out', async () => {
    const f = fakeFetch({
      'POST /auth/device/code': () => json(code),
      'POST /auth/device/token': [() => json({ error: 'authorization_pending' }, 400), () => json({ access_token: 'SESSION', token_type: 'Bearer', expires_in: 100 })],
      'GET /auth/get-session': () => json({ user: { email: 'me@x.test' } }),
      'POST /v1/devices': () => json({ id: 'dev1', token: 'DEVICE-TOKEN' }, 201),
      'POST /auth/sign-out': () => json({ success: true }),
    })
    const t = deps(f.fn)
    const a = new Account(t.d)
    await a.signInWithCode('github')
    expect(t.d.openBrowser).toHaveBeenCalledWith('https://md.test/device?provider=github')
    expect(t.token()).toBe('DEVICE-TOKEN')
    expect(a.state()).toEqual({ kind: 'signedIn', email: 'me@x.test', provider: 'github', deviceId: 'dev1' })
    expect(t.states.map((s) => s.kind)).toEqual(['pending', 'signedIn'])
    expect(t.states[0]).toMatchObject({ userCode: 'ABCD-EFGH', verifyUrl: 'https://md.test/device?provider=github' })
    const pair = f.calls.find((c) => c.url.endsWith('/v1/devices'))!
    expect((pair.init.headers as any).authorization).toBe('Bearer SESSION')
    expect(JSON.parse(pair.init.body as string)).toEqual({ name: 'Test Mac' })
    expect(f.calls.some((c) => c.url.endsWith('/auth/sign-out'))).toBe(true)
  })
  it('stops at expiry with a message and no token (Review Focus 1)', async () => {
    let now = 1_000_000
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': () => json({ error: 'authorization_pending' }, 400) })
    const t = deps(f.fn, { now: () => now, sleep: async (ms) => { now += ms } })
    const a = new Account(t.d)
    await a.signInWithCode('google')
    expect(a.state()).toEqual({ kind: 'signedOut', message: 'That sign-in expired; try again' })
    expect(t.token()).toBeNull()
  })
  it('denied → message', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': () => json({ error: 'access_denied' }, 400) })
    const t = deps(f.fn)
    const a = new Account(t.d)
    await a.signInWithCode('google')
    expect(a.state()).toEqual({ kind: 'signedOut', message: 'Sign-in was denied' })
  })
  it('slow_down adds 5 s to the interval; network errors keep polling (Review Focus 5)', async () => {
    const waits: number[] = []
    const f = fakeFetch({
      'POST /auth/device/code': () => json(code),
      'POST /auth/device/token': [() => json({ error: 'slow_down' }, 400), () => { throw new TypeError('fetch failed') }, () => json({ access_token: 'S', token_type: 'Bearer', expires_in: 1 })],
      'GET /auth/get-session': () => json({ user: { email: 'e@x.test' } }),
      'POST /v1/devices': () => json({ id: 'd', token: 'T' }, 201),
      'POST /auth/sign-out': () => json({}),
    })
    const t = deps(f.fn, { sleep: async (ms) => { waits.push(ms) } })
    await new Account(t.d).signInWithCode('google')
    expect(waits).toEqual([10000, 10000])
    expect(t.token()).toBe('T')
  })
  it('a second sign-in while one runs is ignored (Review Focus 4)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': async () => { await gate; return json({ error: 'access_denied' }, 400) } })
    const t = deps(f.fn)
    const a = new Account(t.d)
    const one = a.signInWithCode('google')
    await a.signInWithCode('github')
    release()
    await one
    expect(f.calls.filter((c) => c.url.endsWith('/device/code'))).toHaveLength(1)
  })
  it('cancel stops polling', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': () => json({ error: 'authorization_pending' }, 400) })
    let a!: Account
    const t = deps(f.fn, { sleep: async () => a.cancel() })
    a = new Account(t.d)
    await a.signInWithCode('google')
    expect(a.state()).toEqual({ kind: 'signedOut', message: null })
  })
})

describe('Account email', () => {
  it('sends Origin on /auth requests only (Better Auth CSRF), not on /v1', async () => {
    const f = fakeFetch({
      'POST /auth/sign-in/email': () => json({ user: { email: 'm@x.test' } }, 200, { 'set-auth-token': 'S2' }),
      'POST /auth/sign-up/email': () => json({ user: { email: 'm@x.test' } }),
      'POST /v1/devices': () => json({ id: 'd2', token: 'T2' }, 201),
      'POST /auth/sign-out': () => json({}),
    })
    const a = new Account(deps(f.fn).d)
    await a.signInEmail('n@x.test', 'pw pw pw pw pw', true)
    await a.signInEmail('m@x.test', 'pw pw pw pw pw', false)
    const origin = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).origin
    const auth = f.calls.filter((c) => new URL(c.url).pathname.startsWith('/auth/'))
    expect(auth.length).toBeGreaterThanOrEqual(3)
    for (const c of auth) expect(origin(c)).toBe('https://md.test')
    for (const c of f.calls.filter((c) => c.url.includes('/v1/'))) expect(origin(c)).toBeUndefined()
  })

  it('sign-in exchanges the session for a device token', async () => {
    const f = fakeFetch({
      'POST /auth/sign-in/email': () => json({ user: { email: 'm@x.test' } }, 200, { 'set-auth-token': 'S2' }),
      'POST /v1/devices': () => json({ id: 'd2', token: 'T2' }, 201),
      'POST /auth/sign-out': () => json({}),
    })
    const t = deps(f.fn)
    const a = new Account(t.d)
    expect(await a.signInEmail('m@x.test', 'pw pw pw pw pw', false)).toEqual({ ok: true, message: 'signed in' })
    expect(a.state()).toEqual({ kind: 'signedIn', email: 'm@x.test', provider: 'email', deviceId: 'd2' })
  })
  it('unverified → check your inbox, nothing stored (Review Focus 3)', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': () => json({ code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }, 403) })
    const t = deps(f.fn)
    expect(await new Account(t.d).signInEmail('u@x.test', 'pw pw pw pw pw', false)).toEqual({ ok: false, message: 'Check your inbox to verify your email, then sign in' })
    expect(t.token()).toBeNull()
  })
  it('create account → check your inbox', async () => {
    const f = fakeFetch({ 'POST /auth/sign-up/email': () => json({ token: null, user: { email: 'n@x.test' } }) })
    expect(await new Account(deps(f.fn).d).signInEmail('n@x.test', 'a long password here', true, 'N')).toEqual({ ok: true, message: 'Account created. Check your inbox to verify your email, then sign in' })
  })
  it('wrong password → plain message', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': () => json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, 401) })
    expect(await new Account(deps(f.fn).d).signInEmail('w@x.test', 'nope nope nope', false)).toEqual({ ok: false, message: 'Wrong email or password' })
  })
})

describe('Account device name', () => {
  it('sanitizes control/format chars, trims, caps at 80 code points, falls back to Mac', async () => {
    const names: string[] = []
    const run = async (deviceName: string) => {
      const f = fakeFetch({
        'POST /auth/sign-in/email': () => json({ user: { email: 'm@x.test' } }, 200, { 'set-auth-token': 'S' }),
        'POST /v1/devices': (i) => { names.push(JSON.parse(i.body as string).name); return json({ id: 'd', token: 'T' }, 201) },
        'POST /auth/sign-out': () => json({}),
      })
      await new Account(deps(f.fn, { deviceName }).d).signInEmail('m@x.test', 'pw pw pw pw pw', false)
    }
    await run('  Aman\u0007\u202E’s Mac\u200B ')
    await run('\u0000 \u200B')
    await run('😀'.repeat(100))
    expect(names).toEqual(['Aman’s Mac', 'Mac', '😀'.repeat(80)])
  })
})

describe('Account email errors', () => {
  it('maps 429 and breached-password', async () => {
    const f1 = fakeFetch({ 'POST /auth/sign-in/email': () => json({}, 429) })
    expect((await new Account(deps(f1.fn).d).signInEmail('a@x.test', 'x', false)).message).toBe('Too many attempts; wait a minute and try again')
    const f2 = fakeFetch({ 'POST /auth/sign-up/email': () => json({ message: 'Password found in a data breach' }, 400) })
    expect((await new Account(deps(f2.fn).d).signInEmail('a@x.test', 'x', true)).message).toBe('That password appears in a known data breach; choose another')
  })
})

describe('Account sign-out', () => {
  it('revokes on the server and clears locally even if the server is unreachable', async () => {
    const f = fakeFetch({ 'DELETE /v1/devices/self': () => { throw new TypeError('offline') } })
    const t = deps(f.fn)
    t.d.saveIdentity({ email: 'a@x.test', provider: 'google', deviceId: 'd' })
    const a = new Account(t.d)
    await a.signOut('TOKEN')
    expect(a.state()).toEqual({ kind: 'signedOut', message: null })
    expect(t.identity()).toBeNull()
  })
})

describe('Account fix round 1', () => {
  const okRoutes = {
    'POST /auth/device/code': () => json(code),
    'GET /auth/get-session': () => json({ user: { email: 'e@x.test' } }),
    'POST /auth/sign-out': () => json({}),
  }
  it('cancel while a token request is in flight that then succeeds: stays signed out, no /v1/devices', async () => {
    let a!: Account
    const f = fakeFetch({ ...okRoutes, 'POST /auth/device/token': () => { a.cancel(); return json({ access_token: 'S' }) }, 'POST /v1/devices': () => json({ id: 'd', token: 'T' }, 201) })
    const t = deps(f.fn)
    a = new Account(t.d)
    await a.signInWithCode('google')
    expect(a.state()).toEqual({ kind: 'signedOut', message: null })
    expect(f.calls.some((c) => c.url.endsWith('/v1/devices'))).toBe(false)
    expect(t.token()).toBeNull()
  })
  it('every request carries an abort signal; cancel aborts a hanging request promptly', async () => {
    let a!: Account
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': (i) => new Promise<Response>((_, rej) => i.signal!.addEventListener('abort', () => rej(new Error('aborted')))) })
    const t = deps(f.fn)
    a = new Account(t.d)
    const p = a.signInWithCode('google')
    await new Promise((r) => setTimeout(r, 10))
    a.cancel()
    await p
    expect(a.state()).toEqual({ kind: 'signedOut', message: null })
    expect(f.calls.every((c) => c.init.signal)).toBe(true)
  })
  it('signOut DELETE carries a timeout signal that aborts a hang; local state clears', async () => {
    const f = fakeFetch({ 'DELETE /v1/devices/self': (i) => new Promise<Response>((_, rej) => i.signal!.addEventListener('abort', () => rej(new Error('t')))) })
    const t = deps(f.fn)
    const p = new Account({ ...t.d, timeoutMs: 20 }).signOut('TOK')
    const sig = f.calls[0].init.signal as AbortSignal
    expect(sig.aborted).toBe(false)
    await p // resolves only when the timeout fires
    expect(sig.aborted).toBe(true)
    expect(t.identity()).toBeNull()
  })
  it('saveToken failing after registering deletes the orphan device', async () => {
    const f = fakeFetch({ ...okRoutes, 'POST /auth/sign-in/email': () => json({ user: { email: 'm@x.test' } }, 200, { 'set-auth-token': 'S' }), 'POST /v1/devices': () => json({ id: 'd', token: 'T' }, 201), 'DELETE /v1/devices/self': () => json({}) })
    const t = deps(f.fn, { saveToken: () => ({ ok: false, message: 'keychain locked' }) })
    expect((await new Account(t.d).signInEmail('m@x.test', 'pw pw pw pw pw', false)).ok).toBe(false)
    const del = f.calls.find((c) => c.init.method === 'DELETE')!
    expect((del.init.headers as any).authorization).toBe('Bearer T')
  })
  it('saveIdentity throwing removes the token again', async () => {
    const f = fakeFetch({ ...okRoutes, 'POST /auth/sign-in/email': () => json({ user: { email: 'm@x.test' } }, 200, { 'set-auth-token': 'S' }), 'POST /v1/devices': () => json({ id: 'd', token: 'T' }, 201), 'DELETE /v1/devices/self': () => json({}) })
    const t = deps(f.fn, { saveIdentity: () => { throw new Error('disk') } })
    const a = new Account(t.d)
    expect((await a.signInEmail('m@x.test', 'pw pw pw pw pw', false)).ok).toBe(false)
    expect(t.token()).toBeNull()
    expect(a.state().kind).toBe('signedOut')
  })
  it('signs the temp session out on failure paths too', async () => {
    const f = fakeFetch({ ...okRoutes, 'POST /auth/sign-in/email': () => json({ user: { email: 'm@x.test' } }, 200, { 'set-auth-token': 'S' }), 'POST /v1/devices': () => json({}, 409) })
    await new Account(deps(f.fn).d).signInEmail('m@x.test', 'pw pw pw pw pw', false)
    expect(f.calls.some((c) => c.url.endsWith('/auth/sign-out'))).toBe(true)
  })
  it('refuses a verification_uri on another origin; builds provider param safely', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json({ ...code, verification_uri: 'https://evil.test/device' }) })
    const t = deps(f.fn)
    const a = new Account(t.d)
    await a.signInWithCode('google')
    expect(t.d.openBrowser).not.toHaveBeenCalled()
    expect(a.state().kind).toBe('signedOut')
  })
  it('unknown 4xx code ends the flow; bad /v1/devices body is rejected', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': () => json({ error: 'invalid_grant' }, 400) })
    const a = new Account(deps(f.fn).d)
    await a.signInWithCode('google')
    expect(a.state()).toEqual({ kind: 'signedOut', message: 'Sign-in failed (invalid_grant)' })
    const g = fakeFetch({ 'POST /auth/sign-in/email': () => json({ user: {} }, 200, { 'set-auth-token': 'S' }), 'POST /v1/devices': () => json({ id: 1 }, 201), 'POST /auth/sign-out': () => json({}) })
    const t = deps(g.fn)
    expect((await new Account(t.d).signInEmail('a@x.test', 'pw pw pw pw pw', false)).ok).toBe(false)
    expect(t.token()).toBeNull()
  })
  it('interval is clamped to 1 s', async () => {
    const waits: number[] = []
    let n = 0
    const f = fakeFetch({ 'POST /auth/device/code': () => json({ ...code, interval: 0 }), 'POST /auth/device/token': () => (++n < 2 ? json({ error: 'authorization_pending' }, 400) : json({ error: 'access_denied' }, 400)) })
    await new Account(deps(f.fn, { sleep: async (ms) => { waits.push(ms) } }).d).signInWithCode('google')
    expect(waits).toEqual([1000])
  })
  it('403 not about verification is not the inbox message', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': () => json({ message: 'Forbidden' }, 403) })
    expect((await new Account(deps(f.fn).d).signInEmail('a@x.test', 'x', false)).message).toBe('Sign-in refused (403): Forbidden')
  })
})

describe('D3 carry-overs', () => {
  it('429 from the token endpoint is treated like slow_down', async () => {
    const f = fakeFetch({
      'POST /auth/device/code': () => json(code),
      'GET /auth/get-session': () => json({ user: { email: 'e@x.test' } }),
      'POST /v1/devices': () => json({ id: 'd', token: 'T' }, 201),
      'POST /auth/sign-out': () => json({}),
      'POST /auth/device/token': [() => json({}, 429), () => json({ access_token: 'S', token_type: 'Bearer', expires_in: 1 })],
    })
    const t = deps(f.fn)
    const sleeps: number[] = []
    await new Account({ ...t.d, sleep: async (ms: number) => void sleeps.push(ms) }).signInWithCode('google')
    expect(sleeps[0]).toBeGreaterThanOrEqual(10_000)
    expect(f.calls.filter((c) => c.url.endsWith('/auth/device/token'))).toHaveLength(2)
  })
  it('signedOutRemotely(message) shows that message', () => {
    const t = deps(fakeFetch({}).fn)
    const a = new Account(t.d)
    a.signedOutRemotely('This account was deleted')
    expect(a.state()).toEqual({ kind: 'signedOut', message: 'This account was deleted' })
  })
})

describe('final fixes', () => {
  it('signIn does nothing when already signed in', async () => {
    const f = fakeFetch({})
    const a = new Account(deps(f.fn, { readIdentity: () => ({ email: 'a@x.test', provider: 'email', deviceId: 'd' }) }).d)
    await a.signInWithCode('google')
    expect((await a.signInEmail('a@x.test', 'x', false)).ok).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  it('rejects a device-code response without user_code/device_code', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json({ ...code, user_code: '' }) })
    const t = deps(f.fn)
    await new Account(t.d).signInWithCode('google')
    expect(t.states.at(-1)).toEqual({ kind: 'signedOut', message: "Couldn't start sign-in" })
    expect(t.d.openBrowser).not.toHaveBeenCalled()
  })
  it('includes the server message on other 403s', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': () => json({ message: 'Account suspended' }, 403) })
    expect((await new Account(deps(f.fn).d).signInEmail('a@x.test', 'x', false)).message).toBe('Sign-in refused (403): Account suspended')
  })
  it('reopen opens the pending verifyUrl only', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': () => json({ error: 'authorization_pending' }, 400) })
    const open = vi.fn()
    const a = new Account(deps(f.fn, { openBrowser: open, sleep: () => new Promise((r) => setTimeout(r, 5)) }).d)
    a.reopen()
    expect(open).not.toHaveBeenCalled()
    const p = a.signInWithCode('github')
    await new Promise((r) => setTimeout(r, 20))
    a.reopen()
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls[1][0]).toBe('https://md.test/device?provider=github')
    a.cancel()
    await p
  })
})

describe('Account browser (loopback) flow', () => {
  const fixed = (n: number) => Buffer.alloc(n, 7)
  const verifier = fixed(32).toString('base64url')
  const state = fixed(24).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  function lbFake(result: { code: string; state: string } | null | 'wait') {
    let settle!: (v: any) => void
    const p = new Promise<any>((r) => (settle = r))
    const lb = { port: 4567, result: result === 'wait' ? p : Promise.resolve(result), close: vi.fn(() => settle(null)) }
    return { lb, start: vi.fn(async () => lb) }
  }
  const redeemOk = () => json({ id: 'dev9', token: 'TOK9', email: 'me@x.test' }, 201)
  const setup = (result: any, routes: Record<string, Route | Route[]> = {}, over: Partial<AccountDeps> = {}) => {
    const f = fakeFetch({ 'POST /desktop/redeem': redeemOk, ...routes })
    const l = lbFake(result)
    const t = deps(f.fn, { startLoopback: l.start, randomBytes: fixed, ...over })
    return { f, l, t, a: new Account(t.d) }
  }
  it('opens desktop-login, redeems the code, signs in', async () => {
    const { f, t, a } = setup({ code: 'CODE', state })
    await a.signInWith('google')
    expect(t.d.openBrowser).toHaveBeenCalledWith(`https://md.test/desktop-login?port=4567&state=${state}&challenge=${challenge}&provider=google`)
    expect(t.states[0]).toMatchObject({ kind: 'pending', mode: 'browser' })
    expect(JSON.parse(f.calls.find((c) => c.url.endsWith('/desktop/redeem'))!.init.body as string)).toEqual({ code: 'CODE', verifier, name: 'Test Mac' })
    expect(t.token()).toBe('TOK9')
    expect(a.state()).toEqual({ kind: 'signedIn', email: 'me@x.test', provider: 'google', deviceId: 'dev9' })
  })
  it('rejects a state mismatch without redeeming', async () => {
    const { f, a } = setup({ code: 'CODE', state: 'x'.repeat(32) })
    await a.signInWith('github')
    expect(a.state()).toEqual({ kind: 'signedOut', message: 'Sign-in failed (state mismatch)' })
    expect(f.calls.some((c) => c.url.endsWith('/desktop/redeem'))).toBe(false)
  })
  it('maps redeem 400 and 409', async () => {
    const r400 = setup({ code: 'C', state }, { 'POST /desktop/redeem': () => json({ error: 'invalid code' }, 400) })
    await r400.a.signInWith('google')
    expect(r400.a.state()).toEqual({ kind: 'signedOut', message: 'Sign-in failed; try again' })
    const r409 = setup({ code: 'C', state }, { 'POST /desktop/redeem': () => json({}, 409) })
    await r409.a.signInWith('google')
    expect((r409.a.state() as any).message).toContain('5 signed-in Macs')
  })
  it('drops the device when the token cannot be saved', async () => {
    const { f, a } = setup({ code: 'C', state }, { 'DELETE /v1/devices/self': () => json({}) }, { saveToken: () => ({ ok: false, message: 'keychain' }) })
    await a.signInWith('google')
    expect(f.calls.some((c) => c.init.method === 'DELETE' && c.url.endsWith('/v1/devices/self'))).toBe(true)
    expect(a.state()).toEqual({ kind: 'signedOut', message: 'keychain' })
  })
  it('cancel closes the listener, no redeem', async () => {
    const { f, l, a } = setup('wait')
    const p = a.signInWith('google')
    await vi.waitFor(() => expect(a.state().kind).toBe('pending'))
    a.cancel()
    await p
    expect(l.lb.close).toHaveBeenCalled()
    expect(a.state()).toEqual({ kind: 'signedOut', message: null })
    expect(f.calls.some((c) => c.url.endsWith('/desktop/redeem'))).toBe(false)
  })
  it('falls back to the code flow when the listener cannot start', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': () => json({ error: 'access_denied' }, 400) })
    const t = deps(f.fn, { startLoopback: async () => { throw new Error('EADDRINUSE') } })
    await new Account(t.d).signInWith('google')
    expect(f.calls.some((c) => c.url.endsWith('/auth/device/code'))).toBe(true)
    expect(t.states[0]).toMatchObject({ kind: 'pending', mode: 'code' })
  })
  it('useCode closes the listener and starts the code flow', async () => {
    const f = fakeFetch({ 'POST /auth/device/code': () => json(code), 'POST /auth/device/token': () => json({ error: 'authorization_pending' }, 400) })
    const l = lbFake('wait')
    const t = deps(f.fn, { startLoopback: l.start, randomBytes: fixed, sleep: () => new Promise((r) => setTimeout(r, 5)) })
    const a = new Account(t.d)
    const p = a.signInWith('google')
    await vi.waitFor(() => expect(a.state()).toMatchObject({ mode: 'browser' }))
    a.useCode()
    await vi.waitFor(() => expect(a.state()).toMatchObject({ mode: 'code', userCode: 'ABCD-EFGH' }))
    await p
    expect(l.lb.close).toHaveBeenCalled()
    expect(a.state()).toMatchObject({ mode: 'code' })
    a.cancel()
  })
  it('reports expiry when the listener times out', async () => {
    const { a } = setup(null)
    await a.signInWith('google')
    expect(a.state()).toEqual({ kind: 'signedOut', message: 'That sign-in expired; try again' })
  })
  it('reopen in browser mode reopens desktop-login', async () => {
    const { t, a } = setup('wait')
    void a.signInWith('google')
    await vi.waitFor(() => expect(a.state().kind).toBe('pending'))
    a.reopen()
    expect((t.d.openBrowser as any).mock.calls.length).toBe(2)
    a.cancel()
  })
})

describe('Account.providers', () => {
  it('filters to configured providers in display order', async () => {
    const f = fakeFetch({ 'GET /providers': () => json({ providers: ['github', 'apple', 'bogus'] }) })
    expect(await new Account(deps(f.fn).d).providers()).toEqual(['github', 'apple'])
  })
  it('falls back to Google and GitHub when the fetch fails or is malformed', async () => {
    const bad = fakeFetch({ 'GET /providers': () => json({}, 500) })
    expect(await new Account(deps(bad.fn).d).providers()).toEqual(['google', 'github'])
    const boom = deps((async () => { throw new Error('down') }) as any)
    expect(await new Account(boom.d).providers()).toEqual(['google', 'github'])
  })
})

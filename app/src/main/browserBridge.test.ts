/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { browserHandshake, commitment, generateStatic, publicRaw, randomNonce, words, type Channel } from '@shared/e2e'
import { CH } from '@shared/ipc'
import { DECK_ACCESS } from '@shared/remoteDeck'
import { MAX_FRAME, PROTOCOL_VERSION } from '@shared/remote'
import { accountChange, BrowserBridge, userChanged } from './browserBridge'
import { BrowserStore } from './browserStore'

const EMAIL = 'me@x.com'
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

async function world(impl?: (ch: string, a: unknown[]) => Promise<unknown>) {
  const mac = await generateStatic(true)
  const macPub = await publicRaw(mac.publicKey)
  const store = new BrowserStore(join(mkdtempSync(join(tmpdir(), 'bridge-')), 'browsers.json'))
  const w = {
    mac, macPub, store,
    sent: [] as any[],
    logs: [] as string[],
    changes: 0,
    sendOk: true,
    t: 1_000_000,
    acct: { userId: 'u1', email: EMAIL } as { userId: string; email: string } | null,
    state: { n: 0 } as unknown,
    call: vi.fn(async (ch: string, a: unknown[]): Promise<unknown> => (ch === CH.getState ? w.state : impl ? impl(ch, a) : 'ok')),
    bridge: null as unknown as BrowserBridge,
  }
  w.bridge = new BrowserBridge({
    store,
    key: () => ({ pair: mac, publicKey: macPub }),
    account: () => w.acct,
    send: (m) => (w.sent.push(m), w.sendOk),
    call: (ch, a) => w.call(ch, a),
    onChange: () => void w.changes++,
    hello: { appVersion: '9.9.9', platform: 'darwin', home: '/Users/me' },
    now: () => w.t,
    batchMs: 20,
    stateMs: 60,
    log: (l) => void w.logs.push(l),
  })
  return w
}
type W = Awaited<ReturnType<typeof world>>
const of = (w: W, t: string) => w.sent.filter((m) => m.t === t)

/** Request + Mac nonce; returns what the browser committed to. */
async function request(w: W, id = 'b1', email = EMAIL) {
  const browser = await generateStatic(false)
  const pub = await publicRaw(browser.publicKey), nB = randomNonce()
  await w.bridge.onServer({ t: 'browserRequest', id, name: 'Chrome', email, commit: await commitment(pub, nB), expiresAt: w.t + 300_000 })
  return { browser, pub, nB }
}
async function approve(w: W, id = 'b1') {
  const r = await request(w, id)
  await w.bridge.onServer({ t: 'browserReveal', id, publicKey: r.pub, nonce: r.nB })
  await w.bridge.decide(id, true)
  return r
}

/** Plays the browser: open, handshake, hello. */
async function connectBrowser(w: W, id: string, browser: CryptoKeyPair) {
  const pub = await publicRaw(browser.publicKey)
  await w.bridge.onServer({ t: 'open', b: id, name: 'Chrome', publicKey: pub })
  const from = w.sent.length
  const hs = await browserHandshake(browser, w.macPub)
  await w.bridge.onServer({ t: 'frame', b: id, d: JSON.stringify(hs.hs1) })
  const hs2 = JSON.parse(w.sent.slice(from).find((m) => m.t === 'frame' && m.b === id).d)
  const { hs3, channel } = await hs.finish(hs2)
  const cursor = { at: w.sent.length }
  await w.bridge.onServer({ t: 'frame', b: id, d: JSON.stringify(hs3) })
  const got: any[] = []
  const recv = async () => {
    for (; cursor.at < w.sent.length; cursor.at++) {
      const m = w.sent[cursor.at]
      if (m.t === 'frame' && m.b === id) got.push(await channel.open(m.d))
    }
    return got
  }
  const send = (msg: unknown) => channel.seal(msg).then((d) => w.bridge.onServer({ t: 'frame', b: id, d }))
  let n = 0
  return {
    channel: channel as Channel,
    recv,
    send,
    call: async (m: string, a: unknown[]) => {
      const callId = ++n
      await send({ k: 'call', id: callId, m, a })
      return (await recv()).find((x) => x.k === 'ret' && x.id === callId)
    },
    sub: (ev: string, arg?: string) => send({ k: 'sub', ev, arg }),
  }
}
async function connected(w: W) {
  const { browser } = await approve(w)
  return connectBrowser(w, 'b1', browser)
}

describe('BrowserBridge approval (commit-reveal)', () => {
  it('refuses a different email without a prompt or a nonce', async () => {
    const w = await world()
    await request(w, 'b1', 'other@x.com')
    expect(w.bridge.requests()).toEqual([])
    expect(of(w, 'browserNonce')).toEqual([])
    expect(of(w, 'browserDecision')).toEqual([{ t: 'browserDecision', id: 'b1', allow: false }])
  })

  it('request alone shows no prompt; after the reveal the words match words(macPub, browserPub, nM, nB)', async () => {
    const w = await world()
    const r = await request(w)
    const [nonceMsg] = of(w, 'browserNonce')
    expect(nonceMsg).toMatchObject({ t: 'browserNonce', id: 'b1', macPublicKey: w.macPub })
    expect(nonceMsg.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(w.bridge.requests()).toEqual([])
    const before = w.changes
    await w.bridge.onServer({ t: 'browserReveal', id: 'b1', publicKey: r.pub, nonce: r.nB })
    expect(w.bridge.requests()).toEqual([
      { id: 'b1', name: 'Chrome', email: EMAIL, words: await words(w.macPub, r.pub, nonceMsg.nonce, r.nB), expiresAt: w.t + 300_000 },
    ])
    expect(w.changes).toBeGreaterThan(before)
  })

  it('a reveal with the wrong commitment is denied without a prompt', async () => {
    const w = await world()
    const r = await request(w)
    const other = await publicRaw((await generateStatic(false)).publicKey)
    await w.bridge.onServer({ t: 'browserReveal', id: 'b1', publicKey: other, nonce: r.nB })
    expect(w.bridge.requests()).toEqual([])
    expect(of(w, 'browserDecision')).toEqual([{ t: 'browserDecision', id: 'b1', allow: false }])
    expect(w.logs.join('\n')).toContain('commitment mismatch')
  })

  it('a reveal for an id the Mac does not hold (e.g. after a restart) is denied', async () => {
    const w = await world()
    const pub = await publicRaw((await generateStatic(false)).publicKey)
    await w.bridge.onServer({ t: 'browserReveal', id: 'ghost', publicKey: pub, nonce: randomNonce() })
    expect(of(w, 'browserDecision')).toEqual([{ t: 'browserDecision', id: 'ghost', allow: false }])
    expect(w.bridge.requests()).toEqual([])
  })

  it('a second reveal for a shown request cannot swap the key', async () => {
    const w = await world()
    const r = await request(w)
    await w.bridge.onServer({ t: 'browserReveal', id: 'b1', publicKey: r.pub, nonce: r.nB })
    await w.bridge.onServer({ t: 'browserReveal', id: 'b1', publicKey: r.pub, nonce: r.nB })
    expect(w.bridge.requests()).toEqual([])
    expect(of(w, 'browserDecision')).toEqual([{ t: 'browserDecision', id: 'b1', allow: false }])
  })

  it('at most 3 outstanding unrevealed nonces', async () => {
    const w = await world()
    for (const id of ['a', 'b', 'c', 'd']) await request(w, id)
    expect(of(w, 'browserNonce').map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(of(w, 'browserDecision')).toEqual([{ t: 'browserDecision', id: 'd', allow: false }])
  })

  it('at most 10 nonces per rolling hour', async () => {
    const w = await world()
    for (let i = 0; i < 11; i++) {
      const r = await request(w, `r${i}`)
      await w.bridge.onServer({ t: 'browserReveal', id: `r${i}`, publicKey: r.pub, nonce: r.nB })
      await w.bridge.decide(`r${i}`, false)
    }
    expect(of(w, 'browserNonce')).toHaveLength(10)
    expect(of(w, 'browserDecision').find((m) => m.id === 'r10')).toEqual({ t: 'browserDecision', id: 'r10', allow: false })
    w.t += 3_600_001
    await request(w, 'later')
    expect(of(w, 'browserNonce').at(-1).id).toBe('later')
  })

  it('a request that expires without a reveal is logged', async () => {
    const w = await world()
    await request(w)
    w.t += 300_001
    expect(w.bridge.requests()).toEqual([])
    expect(w.logs.join('\n')).toMatch(/b1.*expired without a reveal/)
  })

  it('decide(allow) stores the browser and tells the server; deny does not store', async () => {
    const w = await world()
    const r = await approve(w, 'b1')
    expect(of(w, 'browserDecision')).toEqual([{ t: 'browserDecision', id: 'b1', allow: true }])
    expect(w.store.list('u1')).toEqual([{ id: 'b1', name: 'Chrome', publicKey: r.pub, approvedAt: w.t }])
    expect(w.bridge.browsers()).toEqual([{ id: 'b1', name: 'Chrome', publicKey: r.pub, approvedAt: w.t, connected: false }])
    expect(w.bridge.requests()).toEqual([])
    const r2 = await request(w, 'b2')
    await w.bridge.onServer({ t: 'browserReveal', id: 'b2', publicKey: r2.pub, nonce: r2.nB })
    await w.bridge.decide('b2', false)
    expect(of(w, 'browserDecision').at(-1)).toEqual({ t: 'browserDecision', id: 'b2', allow: false })
    expect(w.store.get('u1', 'b2')).toBeNull()
  })

  it('decide on an unrevealed request does nothing', async () => {
    const w = await world()
    await request(w)
    await w.bridge.decide('b1', true)
    expect(of(w, 'browserDecision')).toEqual([])
    expect(w.store.list('u1')).toEqual([])
  })

  it('request expires: requests() drops it after expiresAt and decide is a no-op', async () => {
    const w = await world()
    const r = await request(w)
    await w.bridge.onServer({ t: 'browserReveal', id: 'b1', publicKey: r.pub, nonce: r.nB })
    expect(w.bridge.requests()).toHaveLength(1)
    w.t += 300_000
    expect(w.bridge.requests()).toEqual([])
    await w.bridge.decide('b1', true)
    expect(w.store.list('u1')).toEqual([])
  })
})

describe('BrowserBridge channel', () => {
  it('refuses open for an unknown browser or a different public key → browserClose', async () => {
    const w = await world()
    await approve(w, 'b1')
    const other = await publicRaw((await generateStatic(false)).publicKey)
    await w.bridge.onServer({ t: 'open', b: 'nope', name: 'x', publicKey: other })
    await w.bridge.onServer({ t: 'open', b: 'b1', name: 'x', publicKey: other })
    expect(of(w, 'browserClose')).toEqual([{ t: 'browserClose', b: 'nope' }, { t: 'browserClose', b: 'b1' }])
  })

  it('handshake, hello, then call runs an allowlisted method via deps.call with the right channel', async () => {
    const w = await world()
    const c = await connected(w)
    expect((await c.recv())[0]).toEqual({ k: 'hello', protocol: PROTOCOL_VERSION, appVersion: '9.9.9', platform: 'darwin', home: '/Users/me' })
    expect(w.bridge.browsers()[0].connected).toBe(true)
    expect(await c.call('sendText', ['k', 'hi'])).toEqual({ k: 'ret', id: 1, ok: true, v: 'ok' })
    expect(w.call).toHaveBeenCalledWith(CH.sendText, ['k', 'hi'])
  })

  it('a handler error comes back as ret ok:false', async () => {
    const w = await world(async () => { throw new Error('boom') })
    const c = await connected(w)
    expect(await c.call('sendText', ['k', 'hi'])).toEqual({ k: 'ret', id: 1, ok: false, e: 'boom' })
  })

  it('blocked, unknown and local methods → "Not available on the web yet"; deps.call not invoked', async () => {
    const w = await world()
    const c = await connected(w)
    for (const m of ['openEditor', 'accountSignOut', 'toString', 'nope', 'copy', 'openExternal'])
      expect(await c.call(m, [])).toMatchObject({ k: 'ret', ok: false, e: 'Not available on the web yet' })
    expect(w.call).not.toHaveBeenCalled()
  })

  it('ptyOpen for the screen kinds; unknown kinds refused', async () => {
    const w = await world()
    const c = await connected(w)
    const specs = [{ kind: 'attach', bgId: 'x' }, { kind: 'shell', cwd: '/' }, { kind: 'ticket-builder', resume: false }, { kind: 'builder', resume: false }, { kind: 'installer', tools: [] }]
    for (const spec of specs) expect(await c.call('ptyOpen', ['p', spec, 80, 24])).toMatchObject({ ok: true })
    expect(await c.call('ptyOpen', ['p9', { kind: 'bogus' }, 80, 24])).toMatchObject({ ok: false, e: 'Not available on the web yet' })
    expect(w.call).toHaveBeenCalledTimes(specs.length)
  })

  it('send-mode methods run without a ret', async () => {
    const w = await world()
    const c = await connected(w)
    await c.send({ k: 'call', id: 7, m: 'ptyWrite', a: ['p1', 'ls\r'] })
    expect(w.call).toHaveBeenCalledWith(CH.ptyWrite, ['p1', 'ls\r'])
    expect((await c.recv()).filter((x) => x.k === 'ret')).toEqual([])
  })

  it('rate limit: 201st call within 1 s is refused', async () => {
    const w = await world()
    const c = await connected(w)
    for (let i = 0; i < 200; i++) await c.send({ k: 'call', id: 1000 + i, m: 'getState', a: [] })
    expect(await c.call('getState', [])).toMatchObject({ ok: false, e: 'too many calls' })
    w.t += 1001
    expect(await c.call('getState', [])).toMatchObject({ ok: true })
  })

  it('message over 1 MB plaintext → channel closed (browserClose)', async () => {
    const w = await world()
    const c = await connected(w)
    await c.send({ k: 'call', id: 1, m: 'sendText', a: ['k', 'x'.repeat(1_100_000)] })
    expect(of(w, 'browserClose')).toEqual([{ t: 'browserClose', b: 'b1' }])
    expect(w.call).not.toHaveBeenCalled()
    expect(w.bridge.browsers()[0].connected).toBe(false)
  })

  it('tampered frame → browserClose; three failures in an hour → tamper warning (onChange when it ages out)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = await world()
    const { browser } = await approve(w)
    for (let i = 0; i < 3; i++) {
      const c = await connectBrowser(w, 'b1', browser)
      const d = await c.channel.seal({ k: 'visible', on: true })
      await w.bridge.onServer({ t: 'frame', b: 'b1', d: (d[0] === 'A' ? 'B' : 'A') + d.slice(1) })
      expect(of(w, 'browserClose')).toHaveLength(i + 1)
      if (i < 2) expect(w.bridge.warning()).toBeNull()
    }
    expect(w.bridge.warning()).toBe('Possible tampering on the connection to Chrome')
    expect(w.logs.join('\n')).toContain('Possible tampering')
    const before = w.changes
    w.t += 3_600_002
    vi.advanceTimersByTime(3_600_002)
    vi.useRealTimers()
    expect(w.changes).toBeGreaterThan(before)
    expect(w.bridge.warning()).toBeNull()
  })

  it('a bad handshake counts as a failure and closes', async () => {
    const w = await world()
    const { browser } = await approve(w)
    await w.bridge.onServer({ t: 'open', b: 'b1', name: 'Chrome', publicKey: await publicRaw(browser.publicKey) })
    await w.bridge.onServer({ t: 'frame', b: 'b1', d: '{"k":"hs1","e":"x","n":"y"}' })
    expect(of(w, 'browserClose')).toEqual([{ t: 'browserClose', b: 'b1' }])
  })

  it('state events: full state on sub, then only when changed, at most every stateMs', async () => {
    const w = await world()
    const c = await connected(w)
    w.state = { n: 1 }
    await c.sub(CH.state)
    const evs = async () => (await c.recv()).filter((x) => x.k === 'ev')
    expect(await evs()).toEqual([{ k: 'ev', ev: CH.state, v: [{ n: 1 }] }])
    w.bridge.event(CH.state, [{ n: 1 }]) // unchanged
    w.bridge.event(CH.state, [{ n: 2 }])
    w.bridge.event(CH.state, [{ n: 3 }])
    await tick(20)
    expect(await evs()).toHaveLength(1)
    await tick(80)
    expect((await evs()).slice(1)).toEqual([{ k: 'ev', ev: CH.state, v: [{ n: 3 }] }])
  })

  it('events go only to browsers that subscribed', async () => {
    const w = await world()
    const c = await connected(w)
    w.bridge.event(CH.focusSession, ['k1'])
    await c.sub(CH.focusSession)
    await c.sub('nope:channel')
    w.bridge.event(CH.focusSession, ['k2'])
    await tick(5)
    expect((await c.recv()).filter((x) => x.k === 'ev')).toEqual([{ k: 'ev', ev: CH.focusSession, v: ['k2'] }])
  })

  it('pty data: batched per batchMs, only to browsers subscribed to that id (RF2)', async () => {
    const w = await world()
    const c = await connected(w)
    await c.sub(CH.ptyData, 'p1')
    await c.sub(CH.ptyExit, 'p1')
    for (let i = 1; i <= 100; i++) w.bridge.event('pty:data:p1', ['a', i])
    w.bridge.event('pty:data:p2', ['zzz', 1])
    await tick(40)
    w.bridge.event('pty:data:p1', ['b', 101])
    w.bridge.event('pty:exit:p1', [0])
    await tick(5)
    expect((await c.recv()).filter((x) => x.k === 'ev')).toEqual([
      { k: 'ev', ev: CH.ptyData, arg: 'p1', v: ['a'.repeat(100), 100] },
      { k: 'ev', ev: CH.ptyData, arg: 'p1', v: ['b', 101] }, // flushed before the exit
      { k: 'ev', ev: CH.ptyExit, arg: 'p1', v: [0] },
    ])
    await c.send({ k: 'unsub', ev: CH.ptyData, arg: 'p1' })
    w.bridge.event('pty:data:p1', ['c', 102])
    await tick(40)
    expect((await c.recv()).filter((x) => x.k === 'ev')).toHaveLength(3)
  })

  it('pty data: nothing while the browser said visible:false (RF2)', async () => {
    const w = await world()
    const c = await connected(w)
    await c.sub(CH.ptyData, 'p1')
    await c.send({ k: 'visible', on: false })
    for (let i = 1; i <= 10; i++) w.bridge.event('pty:data:p1', ['a', i])
    await tick(40)
    expect((await c.recv()).filter((x) => x.k === 'ev')).toEqual([])
    await c.send({ k: 'visible', on: true })
    w.bridge.event('pty:data:p1', ['b', 11])
    await tick(40)
    expect((await c.recv()).filter((x) => x.k === 'ev')).toEqual([{ k: 'ev', ev: CH.ptyData, arg: 'p1', v: ['b', 11] }])
  })

  it('revoked mid-call: result is not delivered and later calls are refused (RF3)', async () => {
    let release!: (v: unknown) => void
    const w = await world(() => new Promise((r) => (release = r)))
    const c = await connected(w)
    const d = await c.channel.seal({ k: 'call', id: 1, m: 'sendText', a: ['k', 'hi'] })
    const inFlight = w.bridge.onServer({ t: 'frame', b: 'b1', d })
    await tick(5)
    expect(w.call).toHaveBeenCalledTimes(1)
    const sentBefore = w.sent.length
    await w.bridge.onServer({ t: 'browserRevoked', id: 'b1' })
    release('done')
    await inFlight
    expect(w.sent.slice(sentBefore).filter((m) => m.t === 'frame')).toEqual([])
    expect(w.store.list('u1')).toEqual([])
    const d2 = await c.channel.seal({ k: 'call', id: 2, m: 'sendText', a: ['k', 'again'] })
    await w.bridge.onServer({ t: 'frame', b: 'b1', d: d2 })
    expect(w.call).toHaveBeenCalledTimes(1)
    expect(w.sent.slice(sentBefore).filter((m) => m.t === 'frame')).toEqual([])
  })

  it('revoke(id) from the Mac closes the channel and forgets the browser', async () => {
    const w = await world()
    await connected(w)
    w.bridge.revoke('b1')
    expect(of(w, 'browserClose')).toEqual([{ t: 'browserClose', b: 'b1' }])
    expect(w.bridge.browsers()).toEqual([])
  })

  it('account change wipes the store and closes channels (RF1)', async () => {
    const w = await world()
    const { browser } = await approve(w)
    await connectBrowser(w, 'b1', browser)
    w.acct = { userId: 'u2', email: 'b@x.com' }
    w.bridge.closeAll()
    expect(of(w, 'browserClose')).toEqual([{ t: 'browserClose', b: 'b1' }])
    // The stale browser reconnects: refused, and the lookup under u2 dropped u1's entries.
    await w.bridge.onServer({ t: 'open', b: 'b1', name: 'Chrome', publicKey: await publicRaw(browser.publicKey) })
    expect(of(w, 'browserClose')).toHaveLength(2)
    expect(w.store.list('u1')).toEqual([])
    // Signed out: nothing opens, no prompts.
    w.acct = null
    await w.bridge.onServer({ t: 'open', b: 'b1', name: 'Chrome', publicKey: await publicRaw(browser.publicKey) })
    expect(of(w, 'browserClose')).toHaveLength(3)
    await request(w, 'b9')
    expect(of(w, 'browserDecision').at(-1)).toEqual({ t: 'browserDecision', id: 'b9', allow: false })
  })

  it('closeAll clears pending requests', async () => {
    const w = await world()
    const r = await request(w)
    await w.bridge.onServer({ t: 'browserReveal', id: 'b1', publicKey: r.pub, nonce: r.nB })
    w.bridge.closeAll()
    expect(w.bridge.requests()).toEqual([])
  })

  it('reconnect: a new open runs a fresh handshake; old channel frames rejected (RF4)', async () => {
    const w = await world()
    const { browser } = await approve(w)
    const old = await connectBrowser(w, 'b1', browser)
    for (let i = 0; i < 150; i++) await old.send({ k: 'call', id: 1000 + i, m: 'getState', a: [] })
    const stale = await old.channel.seal({ k: 'call', id: 999, m: 'sendText', a: ['k', 'replayed'] })
    await w.bridge.onServer({ t: 'close', b: 'b1' })
    const fresh = await connectBrowser(w, 'b1', browser)
    expect((await fresh.recv())[0]).toMatchObject({ k: 'hello' })
    // Counters are per connection: 150 calls on the old one do not count here.
    for (let i = 0; i < 100; i++) await fresh.send({ k: 'call', id: 1000 + i, m: 'getState', a: [] })
    expect(await fresh.call('sendText', ['k', 'new'])).toMatchObject({ ok: true })
    await w.bridge.onServer({ t: 'frame', b: 'b1', d: stale })
    expect(of(w, 'browserClose')).toEqual([{ t: 'browserClose', b: 'b1' }])
    expect(w.call).not.toHaveBeenCalledWith(CH.sendText, ['k', 'replayed'])
  })
})

describe('BrowserBridge fix round 1', () => {
  it('~2 MB of pty data in one window: no frame over MAX_FRAME, all data in order, seq per piece', async () => {
    const w = await world()
    const c = await connected(w)
    await c.sub(CH.ptyData, 'p1')
    const piece = 'y\x1b'.repeat(32 * 1024) // escape-heavy: worst case for JSON size
    let seq = 0
    for (let i = 0; i < 32; i++) w.bridge.event('pty:data:p1', [piece, (seq += piece.length)])
    await tick(60)
    const frames = w.sent.filter((m) => m.t === 'frame' && m.b === 'b1')
    expect(Math.max(...frames.map((m) => m.d.length))).toBeLessThanOrEqual(MAX_FRAME)
    const evs = (await c.recv()).filter((x) => x.k === 'ev')
    expect(evs.length).toBeGreaterThan(1)
    expect(evs.map((e) => e.v[0]).join('')).toBe(piece.repeat(32))
    let n = 0
    for (const e of evs) expect(e.v[1]).toBe((n += e.v[0].length))
    expect(of(w, 'browserClose')).toEqual([])
  })

  it('an oversize state is skipped unsealed; the channel stays usable', async () => {
    const w = await world()
    const c = await connected(w)
    await c.sub(CH.state)
    w.bridge.event(CH.state, [{ big: 'x'.repeat(1_200_000) }])
    await tick(100)
    expect(w.logs.join('\n')).toContain('state too large for the web')
    w.bridge.event(CH.state, [{ n: 2 }])
    await tick(100)
    const evs = (await c.recv()).filter((x) => x.k === 'ev')
    expect(evs.at(-1)).toEqual({ k: 'ev', ev: CH.state, v: [{ n: 2 }] })
    expect(await c.call('sendText', ['k', 'hi'])).toMatchObject({ ok: true })
    expect(of(w, 'browserClose')).toEqual([])
  })

  it('send() = false closes the channel', async () => {
    const w = await world()
    const c = await connected(w)
    w.sendOk = false
    await c.send({ k: 'call', id: 1, m: 'sendText', a: ['k', 'hi'] })
    await tick(5)
    expect(of(w, 'browserClose')).toEqual([{ t: 'browserClose', b: 'b1' }])
    expect(w.bridge.browsers()[0].connected).toBe(false)
  })

  it('state A (sent) → B → A within one window sends nothing stale', async () => {
    const w = await world()
    const c = await connected(w)
    w.state = { n: 'A' }
    await c.sub(CH.state)
    w.bridge.event(CH.state, [{ n: 'B' }])
    w.bridge.event(CH.state, [{ n: 'A' }])
    await tick(100)
    expect((await c.recv()).filter((x) => x.k === 'ev')).toEqual([{ k: 'ev', ev: CH.state, v: [{ n: 'A' }] }])
  })

  it('sub/unsub count toward the rate limit', async () => {
    const w = await world()
    const c = await connected(w)
    for (let i = 0; i < 200; i++) await c.sub(CH.focusSession)
    expect(await c.call('getState', [])).toMatchObject({ ok: false, e: 'too many calls' })
  })

  it('the request name is cut to 80 code points without control or format characters', async () => {
    const w = await world()
    const browser = await generateStatic(false)
    const pub = await publicRaw(browser.publicKey), nB = randomNonce()
    const name = '\u202eEvil\u0007\u200b' + '😀'.repeat(100)
    await w.bridge.onServer({ t: 'browserRequest', id: 'b1', name, email: EMAIL, commit: await commitment(pub, nB), expiresAt: w.t + 300_000 })
    await w.bridge.onServer({ t: 'browserReveal', id: 'b1', publicKey: pub, nonce: nB })
    expect(w.bridge.requests()[0].name).toBe('Evil' + '😀'.repeat(76))
  })

  it('onChange fires when a request expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = await world()
      await request(w)
      const before = w.changes
      w.t += 300_001
      vi.advanceTimersByTime(300_001)
      expect(w.changes).toBeGreaterThan(before)
      expect(w.logs.join('\n')).toMatch(/expired without a reveal/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('account helpers (index.ts wiring, RF1)', () => {
  it('accountChange forgets on sign-out and on a different email; pending keeps the last email', () => {
    expect(accountChange('a@x', { kind: 'signedOut' })).toEqual({ forget: true, email: null })
    expect(accountChange('a@x', { kind: 'signedIn', email: 'b@x' })).toEqual({ forget: true, email: 'b@x' })
    expect(accountChange('a@x', { kind: 'signedIn', email: 'a@x' })).toEqual({ forget: false, email: 'a@x' })
    expect(accountChange(null, { kind: 'signedIn', email: 'a@x' })).toEqual({ forget: false, email: 'a@x' })
    expect(accountChange('a@x', { kind: 'pending' })).toEqual({ forget: false, email: 'a@x' })
  })
  it('userChanged only for two known, different ids', () => {
    expect(userChanged({ id: 'u1' }, { id: 'u2' })).toBe(true)
    expect(userChanged({ id: 'u1' }, { id: 'u1' })).toBe(false)
    expect(userChanged(null, { id: 'u2' })).toBe(false)
    expect(userChanged({ id: 'u1' }, null)).toBe(false)
  })
})

describe('allowlisted IPC handlers', () => {
  it('do not read the event argument (only isRemote(e) to skip a native dialog)', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const chKey = Object.fromEntries(Object.entries(CH).map(([k, v]) => [v, k]))
    const remote = Object.values(DECK_ACCESS).flatMap((a) => (a.kind === 'remote' ? [a.ch] : []))
    expect(remote.length).toBeGreaterThan(20)
    for (const ch of remote) {
      const key = chKey[ch]
      const at = src.search(new RegExp(`reg\\.(handle|on)\\(\\s*CH\\.${key}\\s*,`))
      expect(at, `handler for CH.${key}`).toBeGreaterThan(-1)
      const rest = src.slice(at + 5)
      const next = rest.search(/\n {2}reg\.(handle|on)\(/)
      const body = next === -1 ? rest : rest.slice(0, next)
      const param = /,\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)?/.exec(body)?.[1]
      if (!param || param.startsWith('_')) continue
      const uses = body.match(new RegExp(`\\b${param}\\b`, 'g'))!.length
      const remoteChecks = body.match(new RegExp(`isRemote\\(${param}\\)`, 'g'))?.length ?? 0
      expect(uses - 1, `CH.${key} reads its event beyond isRemote(${param})`).toBe(remoteChecks)
    }
  })
})

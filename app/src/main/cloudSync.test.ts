import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { PROTOCOL_VERSION, type RemoteSnapshot } from '@shared/remote'
import type { RemoteStatus } from '@shared/remoteSnapshot'
import { CloudSync } from './cloudSync'

const TOKEN = 't'.repeat(40)
let servers: WebSocketServer[] = []
let syncs: CloudSync[] = []
afterEach(() => {
  syncs.forEach((s) => s.stop())
  servers.forEach((s) => s.close())
  servers = []
  syncs = []
})

/** A fake backend: records messages per connection; `reject` answers the upgrade with 401. */
async function server(o: { reject?: boolean | number; welcome?: unknown[]; nopong?: boolean; onHello?: (ws: WsSocket) => void } = {}) {
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info, cb) => (o.reject || info.req.headers.authorization !== `Bearer ${TOKEN}` ? cb(false, typeof o.reject === 'number' ? o.reject : 401, 'unauthorized') : cb(true)),
  })
  servers.push(wss)
  await new Promise((r) => wss.once('listening', r))
  const got: any[] = []
  const conns: WsSocket[] = []
  wss.on('connection', (ws, req) => {
    expect(req.url).toBe('/v1/desktop')
    conns.push(ws)
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      got.push(m)
      if (m.t === 'hello') {
        if (o.onHello) o.onHello(ws)
        else ws.send(JSON.stringify({ t: 'welcome', pending: o.welcome ?? [] }))
      }
      if (m.t === 'ping' && !o.nopong) ws.send(JSON.stringify({ t: 'pong' }))
    })
  })
  const port = (wss.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, got, conns, wss }
}

function sync(url: string, over: Partial<ConstructorParameters<typeof CloudSync>[0]> = {}) {
  const statuses: RemoteStatus[] = []
  const s = new CloudSync({
    url, token: TOKEN, deviceId: 'mac-1', appVersion: '0.7.0',
    run: vi.fn(async (c) => ({ ok: true, message: `ran ${c.type}` })),
    onItems: vi.fn(),
    onStatus: (x) => statuses.push(x),
    debounceMs: 20, pingMs: 60_000, backoff: { min: 30, max: 120 },
    ...over,
  })
  syncs.push(s)
  return { s, statuses }
}

const until = async (f: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const snap = (tick: number) => ({ takenAt: tick, sessions: [] }) as unknown as RemoteSnapshot

const withCost = (cost: number, state = 'idle') =>
  ({ takenAt: cost, sessions: [{ key: 'a', state, costUsd: cost, contextPct: cost }] }) as unknown as RemoteSnapshot

describe('CloudSync', () => {
  it('sends cost-only changes at most every minVolatileMs (deferred, not dropped); real changes go at once', async () => {
    const srv = await server()
    const { s, statuses } = sync(srv.url, { minVolatileMs: 400 })
    s.start()
    await until(() => statuses.some((x) => x.conn === 'connected'))
    const sent = () => srv.got.filter((m) => m.t === 'snapshot')
    s.push(withCost(1))
    await until(() => sent().length === 1)
    s.push(withCost(2))
    await new Promise((r) => setTimeout(r, 150))
    expect(sent()).toHaveLength(1)
    await until(() => sent().length === 2)
    expect(sent()[1].data.sessions[0].costUsd).toBe(2)
    s.push(withCost(3))
    s.push(withCost(3, 'busy'))
    await until(() => sent().length === 3, 300)
    expect(sent()[2].data.sessions[0].state).toBe('busy')
  })

  it('says hello, then sends snapshots debounced and only when changed', async () => {
    const srv = await server()
    const { s, statuses } = sync(srv.url)
    s.start()
    await until(() => srv.got.some((m) => m.t === 'hello'))
    expect(srv.got[0]).toEqual({ t: 'hello', deviceId: 'mac-1', appVersion: '0.7.0', protocol: PROTOCOL_VERSION })
    await until(() => statuses.some((x) => x.conn === 'connected'))
    s.push(snap(1))
    s.push(snap(2))
    await until(() => srv.got.some((m) => m.t === 'snapshot'))
    await new Promise((r) => setTimeout(r, 60))
    expect(srv.got.filter((m) => m.t === 'snapshot').map((m) => m.data.takenAt)).toEqual([2])
    s.push(snap(2))
    await new Promise((r) => setTimeout(r, 60))
    expect(srv.got.filter((m) => m.t === 'snapshot')).toHaveLength(1)
  })

  it('runs welcome commands in order, then live ones, and returns results', async () => {
    const order: string[] = []
    const srv = await server({ welcome: [{ id: 'a', type: 'session.stop', args: { key: 'k' } }, { id: 'b', type: 'session.stop', args: { key: 'k' } }] })
    const { s } = sync(srv.url, { run: async (c) => (order.push(c.id), { ok: true, message: 'fine' }) })
    s.start()
    await until(() => srv.got.filter((m) => m.t === 'result').length === 2)
    srv.conns[0].send(JSON.stringify({ t: 'command', cmd: { id: 'c', type: 'session.stop', args: { key: 'k' } } }))
    await until(() => srv.got.filter((m) => m.t === 'result').length === 3)
    expect(order).toEqual(['a', 'b', 'c'])
    expect(srv.got.find((m) => m.t === 'result' && m.cmdId === 'c')).toEqual({ t: 'result', cmdId: 'c', ok: true, message: 'fine' })
  })

  it('a transient outcome is re-run, and only the final result is sent', async () => {
    const srv = await server({ welcome: [{ id: 't', type: 'session.stop', args: { key: 'k' } }] })
    let n = 0
    const run = vi.fn(async () => (++n <= 2 ? { ok: false, transient: true as const, message: 'loading' } : { ok: true, message: 'stopped' }))
    const { s } = sync(srv.url, { run, transientRetry: { everyMs: 20, forMs: 1000 } })
    s.start()
    await until(() => srv.got.some((m) => m.t === 'result'))
    await new Promise((r) => setTimeout(r, 60))
    expect(run).toHaveBeenCalledTimes(3)
    expect(srv.got.filter((m) => m.t === 'result')).toEqual([{ t: 'result', cmdId: 't', ok: true, message: 'stopped' }])
  })

  it('a transient outcome that never clears is sent as a plain failure after the limit', async () => {
    const srv = await server({ welcome: [{ id: 'u', type: 'session.stop', args: { key: 'k' } }] })
    const run = vi.fn(async () => ({ ok: false, transient: true as const, message: 'loading' }))
    const { s } = sync(srv.url, { run, transientRetry: { everyMs: 20, forMs: 100 } })
    s.start()
    await until(() => srv.got.some((m) => m.t === 'result'))
    expect(run.mock.calls.length).toBeGreaterThan(1)
    expect(srv.got.filter((m) => m.t === 'result')).toEqual([{ t: 'result', cmdId: 'u', ok: false, message: 'loading' }])
  })

  it('passes stale through', async () => {
    const srv = await server({ welcome: [{ id: 's', type: 'inbox.dismiss', itemId: 'x', args: {} }] })
    const { s } = sync(srv.url, { run: async () => ({ ok: false, status: 'stale', message: 'gone' }) })
    s.start()
    await until(() => srv.got.some((m) => m.t === 'result'))
    expect(srv.got.find((m) => m.t === 'result')).toEqual({ t: 'result', cmdId: 's', ok: false, status: 'stale', message: 'gone' })
  })

  it('hands items to the app and sends answers and dismissals', async () => {
    const srv = await server()
    const onItems = vi.fn()
    const { s } = sync(srv.url, { onItems })
    s.start()
    await until(() => srv.conns.length === 1 && srv.got.some((m) => m.t === 'hello'))
    srv.conns[0].send(JSON.stringify({ t: 'items', items: [{ id: 'ext-1' }] }))
    await until(() => onItems.mock.calls.length > 0)
    expect(onItems).toHaveBeenCalledWith([{ id: 'ext-1' }])
    expect(s.answerItem('ext-1', 'yes', 'desktop')).toBe(true)
    expect(s.dismissItem('ext-2')).toBe(true)
    await until(() => srv.got.some((m) => m.t === 'itemDismissed'))
    expect(srv.got).toContainEqual({ t: 'itemAnswered', itemId: 'ext-1', answer: 'yes', by: 'desktop' })
  })

  it('reconnects after a drop and sends the last snapshot again', async () => {
    const srv = await server()
    const { s } = sync(srv.url)
    s.start()
    await until(() => srv.conns.length === 1)
    s.push(snap(7))
    await until(() => srv.got.some((m) => m.t === 'snapshot'))
    srv.conns[0].close(1011, 'boom')
    await until(() => srv.conns.length === 2 && srv.got.filter((m) => m.t === 'snapshot').length === 2)
    expect(srv.got.filter((m) => m.t === 'hello')).toHaveLength(2)
  })

  it('a 403 on connect shows an error and keeps retrying (Review Focus 4)', async () => {
    const srv = await server({ reject: 403 })
    const { s, statuses } = sync(srv.url)
    s.start()
    await until(() => statuses.filter((x) => x.conn === 'error').length >= 2)
    expect(statuses.find((x) => x.conn === 'error')!.message).toBe('the backend rejected the token (403)')
    expect(s.answerItem('x', 'y', 'desktop')).toBe(false)
  })
  it('4003 signs out and stops reconnecting (Review Focus 2)', async () => {
    const srv = await server()
    const onSignedOut = vi.fn()
    const { s, statuses } = sync(srv.url, { onSignedOut })
    s.start()
    await until(() => srv.conns.length === 1)
    srv.conns[0].close(4003, 'signed out')
    await until(() => onSignedOut.mock.calls.length === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(srv.conns).toHaveLength(1)
    expect(statuses.at(-1)).toMatchObject({ conn: 'off', message: 'Signed out' })
    expect(onSignedOut).toHaveBeenCalledWith(undefined)
  })
  it('401 on connect signs out too', async () => {
    const srv = await server({ reject: true })
    const onSignedOut = vi.fn()
    const { s } = sync(srv.url, { onSignedOut })
    s.start()
    await until(() => onSignedOut.mock.calls.length === 1)
  })
  it('410 on connect signs out with "This account was deleted"', async () => {
    const srv = await server({ reject: 410 })
    const onSignedOut = vi.fn()
    const { s } = sync(srv.url, { onSignedOut })
    s.start()
    await until(() => onSignedOut.mock.calls.length === 1)
    expect(onSignedOut).toHaveBeenCalledWith('This account was deleted')
  })
  it('close reason "account deleted" signs out with that message', async () => {
    const srv = await server()
    const onSignedOut = vi.fn()
    const { s } = sync(srv.url, { onSignedOut })
    s.start()
    await until(() => srv.conns.length === 1)
    srv.conns[0].close(4003, 'account deleted')
    await until(() => onSignedOut.mock.calls.length === 1)
    expect(onSignedOut).toHaveBeenCalledWith('This account was deleted')
  })
  it('4005 shows "Another Mac is connected" and retries at the cap, not in a tight loop', async () => {
    const srv = await server({ onHello: (ws) => ws.close(4005, 'another Mac is connected for this account') })
    const onSignedOut = vi.fn()
    const { s, statuses } = sync(srv.url, { onSignedOut, backoff: { min: 30, max: 400 } })
    s.start()
    await until(() => srv.conns.length === 1)
    await until(() => statuses.some((x) => x.conn === 'error'))
    expect(s.status()).toMatchObject({ conn: 'error', message: 'Another Mac is connected to this account' })
    await new Promise((r) => setTimeout(r, 150))
    expect(srv.conns).toHaveLength(1)
    expect(onSignedOut).not.toHaveBeenCalled()
  })
  it('4006 reconnects normally', async () => {
    let n = 0
    const srv = await server({ onHello: (ws) => (++n === 1 ? ws.close(4006, 'session expired, reconnect') : ws.send(JSON.stringify({ t: 'welcome', pending: [] }))) })
    const { s } = sync(srv.url)
    s.start()
    await until(() => srv.conns.length === 2 && s.status().conn === 'connected')
  })

  it('a server that is down is amber, not a crash', async () => {
    const { s, statuses } = sync('http://127.0.0.1:1')
    s.start()
    await until(() => statuses.some((x) => x.conn === 'connecting' && !!x.message))
    await until(() => s.status().message !== null && s.status().message!.startsWith('cannot reach the backend'))
    await new Promise((r) => setTimeout(r, 100))
    expect(s.status().message).toMatch(/^cannot reach the backend/)
    s.stop()
    expect(s.status().conn).toBe('off')
  })

  it('does not send a snapshot that is still over the limit after trimming', async () => {
    const srv = await server()
    const log = vi.fn()
    const { s, statuses } = sync(srv.url, { log, limit: 5000 })
    s.start()
    await until(() => statuses.some((x) => x.conn === 'connected'))
    const big = { takenAt: 1, board: null, inbox: { open: [], snoozed: [], history: [] }, sessions: Array.from({ length: 2000 }, (_, i) => ({ key: `k${i}`, issue: null, name: 'x'.repeat(1024) })) } as unknown as RemoteSnapshot
    s.push(big)
    await until(() => statuses.some((x) => x.message === 'snapshot too large to send'))
    s.push(big)
    await new Promise((r) => setTimeout(r, 80))
    expect(srv.got.filter((m) => m.t === 'snapshot')).toHaveLength(0)
    expect(log.mock.calls.filter((c) => String(c[0]).includes('still over the limit'))).toHaveLength(1)
    expect(s.status().conn).toBe('connected')
  })

  it('a throwing run does not wedge the command chain', async () => {
    const srv = await server({ welcome: [{ id: 'a', type: 'session.stop', args: { key: 'k' } }, { id: 'b', type: 'session.stop', args: { key: 'k' } }] })
    const { s } = sync(srv.url, { run: async (c) => { if (c.id === 'a') throw new Error('boom'); return { ok: true, message: 'fine' } } })
    s.start()
    await until(() => srv.got.filter((m) => m.t === 'result').length === 2)
    expect(srv.got.find((m) => m.t === 'result' && m.cmdId === 'a')).toMatchObject({ ok: false, message: 'failed: Error: boom' })
    expect(srv.got.find((m) => m.t === 'result' && m.cmdId === 'b')).toMatchObject({ ok: true })
  })

  it('oversize drops the stale snapshot and the message clears once a snapshot is sent', async () => {
    const srv = await server()
    const { s, statuses } = sync(srv.url, { limit: 5000 })
    s.start()
    await until(() => statuses.some((x) => x.conn === 'connected'))
    const mk = (n: number) => ({ takenAt: 1, board: null, inbox: { open: [], snoozed: [], history: [] }, sessions: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, issue: null, name: 'x'.repeat(1024) })) }) as unknown as RemoteSnapshot
    s.push(mk(1))
    await until(() => srv.got.some((m) => m.t === 'snapshot'))
    s.push(mk(2000))
    await until(() => s.status().message === 'snapshot too large to send')
    srv.conns[0].close(1011, 'boom')
    await until(() => srv.conns.length === 2)
    await new Promise((r) => setTimeout(r, 100))
    expect(srv.got.filter((m) => m.t === 'snapshot')).toHaveLength(1)
    s.push(mk(1))
    await until(() => srv.got.filter((m) => m.t === 'snapshot').length === 2)
    expect(s.status().message).toBeNull()
  })

  it('does not resend when only takenAt changed', async () => {
    const srv = await server()
    const { s, statuses } = sync(srv.url)
    s.start()
    await until(() => statuses.some((x) => x.conn === 'connected'))
    s.push(snap(1))
    await until(() => srv.got.some((m) => m.t === 'snapshot'))
    s.push(snap(2))
    await new Promise((r) => setTimeout(r, 80))
    expect(srv.got.filter((m) => m.t === 'snapshot')).toHaveLength(1)
  })

  it('terminates a half-open socket when pings go unanswered', async () => {
    const srv = await server({ nopong: true })
    const { s } = sync(srv.url, { pingMs: 40 })
    s.start()
    await until(() => srv.conns.length === 2, 3000)
    expect(srv.got.filter((m) => m.t === 'hello').length).toBeGreaterThanOrEqual(2)
  })

  it('a backend address the socket library rejects is an error, not a crash, and is retried', async () => {
    const { s, statuses } = sync('https://host:87o7')
    expect(() => s.start()).not.toThrow()
    expect(s.status().conn).toBe('error')
    expect(s.status().message).toMatch(/^bad backend address or token: /)
    // retried at the backoff cap (120 ms here), failing the same way
    await until(() => statuses.filter((x) => x.conn === 'error').length >= 2)
  })

  it('a socket that opens but is never welcomed is dropped and redialled', async () => {
    const srv = await server({ onHello: () => {} })
    const { s } = sync(srv.url, { welcomeTimeoutMs: 50 })
    s.start()
    await until(() => srv.conns.length >= 2, 3000)
    expect(s.status().conn).not.toBe('connected')
  })

  it('ignores a welcome or items message whose list is not a list', async () => {
    const run = vi.fn(async () => ({ ok: true, message: 'ran' }))
    const onItems = vi.fn()
    const srv = await server({
      onHello: (ws) => {
        ws.send(JSON.stringify({ t: 'welcome', pending: 5 }))
        ws.send(JSON.stringify({ t: 'welcome', pending: 'abc' }))
        ws.send(JSON.stringify({ t: 'items', items: 'nope' }))
        ws.send(JSON.stringify({ t: 'items', items: { length: 1 } }))
        ws.send(JSON.stringify({ t: 'welcome', pending: [] }))
      },
    })
    const { s, statuses } = sync(srv.url, { run, onItems })
    s.start()
    await until(() => statuses.some((x) => x.conn === 'connected'))
    await new Promise((r) => setTimeout(r, 50))
    expect(run).not.toHaveBeenCalled()
    expect(onItems).not.toHaveBeenCalled()
    expect(srv.conns).toHaveLength(1)
  })
})

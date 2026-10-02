import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { RemoteSnapshot } from '@shared/remote'
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
async function server(o: { reject?: boolean; welcome?: unknown[] } = {}) {
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info, cb) => (o.reject || info.req.headers.authorization !== `Bearer ${TOKEN}` ? cb(false, 401, 'unauthorized') : cb(true)),
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
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'welcome', pending: o.welcome ?? [] }))
      if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
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

describe('CloudSync', () => {
  it('says hello, then sends snapshots debounced and only when changed', async () => {
    const srv = await server()
    const { s, statuses } = sync(srv.url)
    s.start()
    await until(() => srv.got.some((m) => m.t === 'hello'))
    expect(srv.got[0]).toEqual({ t: 'hello', deviceId: 'mac-1', appVersion: '0.7.0', protocol: 1 })
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

  it('a rejected token shows an error and keeps retrying (Review Focus 4)', async () => {
    const srv = await server({ reject: true })
    const { s, statuses } = sync(srv.url)
    s.start()
    await until(() => statuses.filter((x) => x.conn === 'error').length >= 2)
    expect(statuses.find((x) => x.conn === 'error')!.message).toBe('the backend rejected the token (401)')
    expect(s.answerItem('x', 'y', 'desktop')).toBe(false)
  })

  it('a server that is down is amber, not a crash', async () => {
    const { s, statuses } = sync('http://127.0.0.1:1')
    s.start()
    await until(() => statuses.some((x) => x.conn === 'connecting' && !!x.message))
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
})

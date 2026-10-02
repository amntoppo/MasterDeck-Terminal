/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserHandshake, generateStatic, macHandshake, publicRaw, type Channel } from '@shared/e2e'
import { CH } from '@shared/ipc'
import type { MacToWeb, WebToMac } from '@shared/bridgeWire'
import { createRemoteDeck, type Io } from './remoteDeck'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const HELLO = { k: 'hello', protocol: 3, appVersion: '9.9.9', platform: 'darwin', home: '/Users/me' } as const

/** A browser channel talking to a fake Mac: real handshake, stub dispatcher. */
async function world(reply: (m: Extract<WebToMac, { k: 'call' }>) => unknown = () => 'ok') {
  const mac = await generateStatic(false), me = await generateStatic(false)
  const hs = await browserHandshake(me, await publicRaw(mac.publicKey))
  const mh = await macHandshake(mac, await publicRaw(me.publicKey), hs.hs1)
  const { hs3, channel } = await hs.finish(mh.hs2)
  const macCh: Channel = await mh.confirm(hs3)
  let onFrame: (d: string) => void = () => {}
  let onClose: () => void = () => {}
  const w = {
    got: [] as WebToMac[],
    io: {
      send: (d: string) => {
        void macCh.open(d).then(async (m) => {
          const msg = m as WebToMac
          w.got.push(msg)
          if (msg.k === 'call' && !w.silent) await w.toWeb({ k: 'ret', id: msg.id, ok: true, v: reply(msg) })
        })
      },
      onFrame: (cb) => void (onFrame = cb),
      onClose: (cb) => void (onClose = cb),
    } as Io,
    silent: false,
    toWeb: async (m: MacToWeb) => onFrame(await macCh.seal(m)),
    close: () => onClose(),
  }
  return Object.assign(w, { deck: createRemoteDeck(w.io, channel, HELLO) })
}

describe('RemoteDeck', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('invoke methods round-trip; ARG_FIX applied', async () => {
    const w = await world((m) => ({ echo: m.a }))
    expect(await w.deck.getState()).toEqual({ echo: [] })
    await w.deck.inboxAct('i', 'reply' as any)
    expect(w.got.at(-1)).toMatchObject({ k: 'call', m: 'inboxAct', a: ['i', 'reply', {}] })
  })

  it('a failed ret rejects with the Mac error', async () => {
    const w = await world()
    w.silent = true
    const p = w.deck.getState()
    await tick(20)
    const id = (w.got[0] as any).id
    await w.toWeb({ k: 'ret', id, ok: false, e: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('blocked methods reject with "Not available on the web yet" without sending', async () => {
    const w = await world()
    await expect((w.deck.openEditor as any)('/x')).rejects.toThrow('Not available on the web yet')
    await expect((w.deck.pickFolder as any)()).rejects.toThrow('Not available on the web yet')
    await tick(20)
    expect(w.got).toEqual([])
  })

  it('blocked events (onAutoOpen) return a no-op unsubscribe without sending', async () => {
    const w = await world()
    const off = w.deck.onAutoOpen(() => {})
    expect(typeof off).toBe('function')
    off()
    await tick(20)
    expect(w.got).toEqual([])
  })

  it('local methods run locally (openExternal → window.open stub; copy → clipboard stub)', async () => {
    const open = vi.fn(), writeText = vi.fn(async () => {})
    vi.stubGlobal('window', { open })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const w = await world()
    w.deck.openExternal('https://x.test')
    w.deck.copy('hi')
    w.deck.setFocus('a' as any)
    w.deck.setVisible(true as any)
    w.deck.setBoardOpen(true as any)
    await tick(20)
    expect(open).toHaveBeenCalledWith('https://x.test', '_blank', 'noopener,noreferrer')
    expect(writeText).toHaveBeenCalledWith('hi')
    expect(w.got).toEqual([])
  })

  it('openExternal opens https only (javascript:, data:, http: are ignored)', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const w = await world()
    for (const u of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'http://x.test', ' JAVASCRIPT:alert(1)', 'file:///etc/passwd']) w.deck.openExternal(u)
    expect(open).not.toHaveBeenCalled()
  })

  it('a throwing listener does not stop the others; malformed events are ignored', async () => {
    const w = await world()
    const bad = vi.fn(() => { throw new Error('x') }), good = vi.fn()
    w.deck.onState(bad)
    w.deck.onState(good)
    await w.toWeb({ k: 'ev', ev: CH.state, v: 'nope' as any })
    await w.toWeb({ k: 'ev', ev: CH.state, v: [{ n: 2 }] })
    await tick(20)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledWith({ n: 2 })
  })

  it('send methods (ptyWrite) do not wait for a ret', async () => {
    const w = await world()
    w.silent = true
    expect(w.deck.ptyWrite('p1', 'ls\r')).toBeUndefined()
    await tick(20)
    expect(w.got).toEqual([expect.objectContaining({ k: 'call', m: 'ptyWrite', a: ['p1', 'ls\r'] })])
  })

  it('event subscription sends sub once per key, unsub when the last listener leaves', async () => {
    const w = await world()
    const a = vi.fn(), b = vi.fn(), c = vi.fn()
    const offA = w.deck.onPtyData('p1', a)
    const offB = w.deck.onPtyData('p1', b)
    const offC = w.deck.onState(c)
    await tick(20)
    expect(w.got).toEqual([
      { k: 'sub', ev: CH.ptyData, arg: 'p1' },
      { k: 'sub', ev: CH.state, patches: 1 },
    ])
    await w.toWeb({ k: 'ev', ev: CH.ptyData, arg: 'p1', v: ['out', 1] })
    await w.toWeb({ k: 'ev', ev: CH.state, v: [{ n: 1 }] })
    await tick(20)
    expect(a).toHaveBeenCalledWith('out', 1)
    expect(b).toHaveBeenCalledWith('out', 1)
    expect(c).toHaveBeenCalledWith({ n: 1 })
    offA()
    await tick(20)
    expect(w.got).toHaveLength(2)
    offB()
    offC()
    await tick(20)
    expect(w.got.slice(2)).toEqual([
      { k: 'unsub', ev: CH.ptyData, arg: 'p1' },
      { k: 'unsub', ev: CH.state },
    ])
  })

  it('in-flight calls reject with "Your Mac went offline — not sent" when the socket drops', async () => {
    const w = await world()
    w.silent = true
    const p = w.deck.getState()
    await tick(20)
    w.close()
    await expect(p).rejects.toThrow('Your Mac went offline — not sent')
  })

  it('calls after the socket dropped reject without sending', async () => {
    const w = await world()
    w.close()
    await expect(w.deck.getState()).rejects.toThrow('Your Mac went offline — not sent')
    await tick(20)
    expect(w.got).toEqual([])
  })

  it('platform is "web", home is from hello', async () => {
    const w = await world()
    expect(w.deck.platform).toBe('web')
    expect(w.deck.home).toBe('/Users/me')
  })
})

describe('RemoteDeck state patches', () => {
  const add = (path: string, value: unknown) => ({ op: 'add', path, value }) as const
  async function subbed() {
    const w = await world()
    const fn = vi.fn()
    w.deck.onState(fn)
    await w.toWeb({ k: 'ev', ev: CH.state, v: [{ a: 1, list: [1] }], n: 1 })
    return { w, fn, resyncs: () => w.got.filter((m) => m.k === 'resync') }
  }

  it('applies evp in order and calls onState with the patched state (base left untouched)', async () => {
    const { w, fn } = await subbed()
    await w.toWeb({ k: 'evp', ev: CH.state, n: 2, ops: [add('/b', 2)] })
    await w.toWeb({ k: 'evp', ev: CH.state, n: 3, ops: [add('/list/-', 2), { op: 'remove', path: '/a' }] })
    await tick(20)
    expect(fn.mock.calls.map((c) => c[0])).toEqual([{ a: 1, list: [1] }, { a: 1, b: 2, list: [1] }, { b: 2, list: [1, 2] }])
    expect(fn.mock.calls[0][0]).toEqual({ a: 1, list: [1] })
  })

  it('a gap sends one resync and ignores patches until the next full; the full resets n', async () => {
    const { w, fn, resyncs } = await subbed()
    await w.toWeb({ k: 'evp', ev: CH.state, n: 3, ops: [add('/b', 2)] })
    await w.toWeb({ k: 'evp', ev: CH.state, n: 4, ops: [add('/c', 3)] })
    await tick(20)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(resyncs()).toEqual([{ k: 'resync', ev: CH.state }])
    await w.toWeb({ k: 'ev', ev: CH.state, v: [{ z: 1 }], n: 5 })
    await w.toWeb({ k: 'evp', ev: CH.state, n: 6, ops: [add('/y', 2)] })
    await tick(20)
    expect(fn.mock.calls.slice(1).map((c) => c[0])).toEqual([{ z: 1 }, { z: 1, y: 2 }])
    expect(resyncs()).toHaveLength(1)
  })

  it('an op that fails to apply → resync, no onState', async () => {
    const { w, fn, resyncs } = await subbed()
    await w.toWeb({ k: 'evp', ev: CH.state, n: 2, ops: [{ op: 'remove', path: '/nope/x' }] })
    await tick(20)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(resyncs()).toHaveLength(1)
  })

  it('a prototype path → resync, Object.prototype untouched', async () => {
    for (const path of ['/__proto__/polluted', '/constructor/prototype/polluted']) {
      const { w, fn, resyncs } = await subbed()
      await w.toWeb({ k: 'evp', ev: CH.state, n: 2, ops: [add(path, 1)] })
      await tick(20)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(resyncs()).toHaveLength(1)
      expect(({} as any).polluted).toBeUndefined()
    }
  })

  it('evp without a full base (old Mac sent a full without n) → resync', async () => {
    const w = await world()
    const fn = vi.fn()
    w.deck.onState(fn)
    await w.toWeb({ k: 'ev', ev: CH.state, v: [{ a: 1 }] })
    await w.toWeb({ k: 'evp', ev: CH.state, n: 1, ops: [add('/b', 2)] })
    await tick(20)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(w.got.filter((m) => m.k === 'resync')).toHaveLength(1)
  })
})

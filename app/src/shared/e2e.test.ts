import { describe, it, expect } from 'vitest'
import { generateStatic, publicRaw, words, browserHandshake, macHandshake, E2EError, exportPrivate, importPrivate } from './e2e'
import { toB64u, fromB64u } from './b64'
import { WORDS } from './wordlist'

async function pair() {
  const mac = await generateStatic(true), browser = await generateStatic(false)
  const macPub = await publicRaw(mac.publicKey), browserPub = await publicRaw(browser.publicKey)
  const b = await browserHandshake(browser, macPub)
  const m = await macHandshake(mac, browserPub, b.hs1)
  const { hs3, channel: bc } = await b.finish(m.hs2)
  const mc = await m.confirm(hs3)
  return { mac, browser, macPub, browserPub, bc, mc }
}

describe('b64', () => {
  it('round-trips and rejects junk', () => {
    const v = new Uint8Array([0, 1, 250, 255, 62, 63])
    expect(fromB64u(toB64u(v))).toEqual(v)
    expect(() => fromB64u('a+b/')).toThrow()
  })
})
describe('word list', () => { it('has 2048 unique words', () => expect(new Set(WORDS).size).toBe(2048)) })
describe('words', () => {
  it('match on both sides and change with either key', async () => {
    const { macPub, browserPub } = await pair()
    const w = await words(macPub, browserPub)
    expect(w).toHaveLength(3); w.forEach((x) => expect(WORDS).toContain(x))
    expect(await words(macPub, browserPub)).toEqual(w)
    const other = await publicRaw((await generateStatic(false)).publicKey)
    expect(await words(macPub, other)).not.toEqual(w)
    expect(await words(other, browserPub)).not.toEqual(w)
  })
})
describe('handshake + channel', () => {
  it('round-trips both directions', async () => {
    const { bc, mc } = await pair()
    expect(await mc.open(await bc.seal({ k: 'call', id: 1 }))).toEqual({ k: 'call', id: 1 })
    expect(await bc.open(await mc.seal({ k: 'ret', id: 1 }))).toEqual({ k: 'ret', id: 1 })
  })
  it('rejects tampering, replay and reordering', async () => {
    const { bc, mc } = await pair()
    const f1 = await bc.seal('a'), f2 = await bc.seal('b')
    const raw = fromB64u(f1); raw[raw.length - 1] ^= 1
    const bad = toB64u(raw)
    await expect(mc.open(bad)).rejects.toThrow(E2EError)
    const { bc: bc2, mc: mc2 } = await pair()
    const g1 = await bc2.seal('a'), g2 = await bc2.seal('b')
    await expect(mc2.open(g2)).rejects.toThrow(E2EError)          // reordered
    const { bc: bc3, mc: mc3 } = await pair()
    const h1 = await bc3.seal('a')
    expect(await mc3.open(h1)).toBe('a')
    await expect(mc3.open(h1)).rejects.toThrow(E2EError)          // replay
    void f2; void g1
  })
  it('a frame from one direction cannot be opened as the other', async () => {
    const { bc } = await pair()
    await expect(bc.open(await bc.seal('x'))).rejects.toThrow(E2EError)
  })
  it('fails when the browser expected a different Mac key (MITM)', async () => {
    const mac = await generateStatic(true), evil = await generateStatic(true), browser = await generateStatic(false)
    const b = await browserHandshake(browser, await publicRaw(mac.publicKey))
    const m = await macHandshake(evil, await publicRaw(browser.publicKey), b.hs1)
    await expect(b.finish(m.hs2)).rejects.toThrow(E2EError)
  })
  it('fails when the Mac expected a different browser key', async () => {
    const mac = await generateStatic(true), browser = await generateStatic(false), other = await generateStatic(false)
    const b = await browserHandshake(browser, await publicRaw(mac.publicKey))
    const m = await macHandshake(mac, await publicRaw(other.publicKey), b.hs1)
    await expect(b.finish(m.hs2)).rejects.toThrow(E2EError)
  })
  it('each connection derives fresh keys (RF4)', async () => {
    const a = await pair()
    const f = await a.bc.seal('x')
    const b2 = await browserHandshake(a.browser, a.macPub)
    const m2 = await macHandshake(a.mac, a.browserPub, b2.hs1)
    const { hs3 } = await b2.finish(m2.hs2)
    const mc2 = await m2.confirm(hs3)
    await expect(mc2.open(f)).rejects.toThrow(E2EError)
  })
  it('Mac private key survives export/import', async () => {
    const mac = await generateStatic(true)
    const again = await importPrivate(await exportPrivate(mac.privateKey))
    expect(again.type).toBe('private')
  })
})

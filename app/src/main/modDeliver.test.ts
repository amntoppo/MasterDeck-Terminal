import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeldStore } from './held'
import { ModDelivery } from './modDeliver'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const FAST = { claimMs: 300, doneMs: 300, stepMs: 10 }
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

let deck: string
beforeEach(() => (deck = mkdtempSync(join(tmpdir(), 'md-deliver-'))))
afterEach(() => rmSync(deck, { recursive: true, force: true }))

/** The core mod's side (mods/masterdeck/hooks/deliver.ts), as files: claim, wait for go, done. */
function fakeMod(o: { claim?: boolean; done?: object | null; submitted: string[] }) {
  const dir = join(deck, 'deliver', SID)
  let stop = false
  void (async () => {
    while (!stop) {
      await tick(15)
      if (!existsSync(dir)) continue
      for (const n of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        const id = n.slice(0, -5)
        if (existsSync(join(dir, `${id}.claim`)) || o.claim === false) continue
        const text = JSON.parse(readFileSync(join(dir, n), 'utf8')).text
        writeFileSync(join(dir, `${id}.claim`), '')
        for (let i = 0; i < 30 && !existsSync(join(dir, `${id}.go`)); i++) await tick(10)
        if (!existsSync(join(dir, `${id}.go`))) continue
        o.submitted.push(text)
        if (o.done !== null) writeFileSync(join(dir, `${id}.done`), JSON.stringify(o.done ?? { ok: true }))
      }
    }
  })()
  return () => (stop = true)
}

describe('ModDelivery', () => {
  it('hands the message to the core mod and cleans up', async () => {
    const submitted: string[] = []
    const stop = fakeMod({ submitted })
    const r = await new ModDelivery(deck, FAST).deliver(SID, 'PR #3 has a review')
    stop()
    expect(r).toEqual({ kind: 'sent' })
    expect(submitted).toEqual(['PR #3 has a review'])
    expect(readdirSync(join(deck, 'deliver', SID))).toEqual([])
  })

  it('no claim in time: taken back, and a late claim never gets a go', async () => {
    const r = await new ModDelivery(deck, FAST).deliver(SID, 'hello')
    expect(r).toEqual({ kind: 'unclaimed' })
    expect(readdirSync(join(deck, 'deliver', SID))).toEqual([])
  })

  it('a submit Claude Code refused, and a go with no done yet (a busy session)', async () => {
    const failed: string[] = []
    let stop = fakeMod({ submitted: failed, done: { ok: false, error: 'no' } })
    expect(await new ModDelivery(deck, FAST).deliver(SID, 'a')).toEqual({ kind: 'failed', error: 'no' })
    stop()
    await tick(60)
    const handed: string[] = []
    stop = fakeMod({ submitted: handed, done: null })
    expect(await new ModDelivery(deck, FAST).deliver(SID, 'b')).toEqual({ kind: 'handed' })
    stop()
    expect(handed).toEqual(['b'])
  })

  it('refuses a session id that is not one, and prunes folders of ended sessions', async () => {
    const m = new ModDelivery(deck, FAST)
    expect(await m.deliver('../x', 'a')).toEqual({ kind: 'unclaimed' })
    await m.deliver(SID, 'a')
    writeFileSync(join(deck, 'deliver', SID, '1-0.claim'), '')
    m.prune(new Set([SID]), Date.now() + 601_000)
    expect(readdirSync(join(deck, 'deliver', SID))).toEqual([])
    m.prune(new Set())
    expect(readdirSync(join(deck, 'deliver'))).toEqual([])
  })
})

describe('HeldStore', () => {
  it('keeps messages in order across a restart, and removes the file when empty', () => {
    const f = join(deck, 'held.json')
    const a = new HeldStore(f)
    const m1 = a.add('k1', 'one', 'PR watch', 'draft', 1)
    a.add('k2', 'two', 'Monitor', 'typing', 2)
    const b = new HeldStore(f)
    expect(b.list().map((m) => m.text)).toEqual(['one', 'two'])
    b.setReason(m1.id, 'unknown')
    expect(new HeldStore(f).get(m1.id)?.reason).toBe('unknown')
    expect(b.drop((m) => m.key === 'k2').map((m) => m.text)).toEqual(['two'])
    b.remove(m1.id)
    expect(existsSync(f)).toBe(false)
  })
})

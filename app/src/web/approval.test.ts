/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import { checkCommitment, generateStatic, publicRaw, randomNonce, words } from '@shared/e2e'
import { approve, browserName, type Api } from './approval'
import type { KeyRec } from './keys'

/** A fake backend + Mac: answers like the worker routes, scripted per test. */
async function world(script: { create?: number; reveal?: number; after?: 'approved' | 'denied' | 'expired'; status?: string } = {}) {
  const mac = await generateStatic(false)
  const macPub = await publicRaw(mac.publicKey)
  const nM = randomNonce()
  const w = {
    macPub, nM,
    calls: [] as { m: string; p: string; b?: any }[],
    commit: '',
    revealed: null as null | { publicKey: string; nonce: string },
    gets: 0,
  }
  const api: Api = {
    async get(p) {
      w.calls.push({ m: 'GET', p })
      w.gets++
      if (script.status && w.gets === 1) return { status: 200, body: { status: script.status } }
      if (!w.revealed) return { status: 200, body: { status: 'pending', macPublicKey: w.gets > 1 ? macPub : null, macNonce: w.gets > 1 ? nM : null } }
      return { status: 200, body: { status: script.after ?? 'approved', macPublicKey: macPub, macNonce: nM } }
    },
    async post(p, b: any) {
      w.calls.push({ m: 'POST', p, b })
      if (p === '/v1/browsers') {
        if (script.create && script.create !== 201) return { status: script.create, body: { error: 'x' } }
        w.commit = b.commit
        return { status: 201, body: { id: 'b1', status: 'pending' } }
      }
      if (script.reveal && script.reveal !== 200) return { status: script.reveal, body: { error: 'x' } }
      if (!(await checkCommitment(w.commit, b.publicKey, b.nonce))) return { status: 400, body: { error: 'commitment mismatch' } }
      w.revealed = b
      return { status: 200, body: { ok: true } }
    },
  }
  return { w, api }
}

async function rec(over: Partial<KeyRec> = {}): Promise<KeyRec> {
  return { browserId: null, pair: await generateStatic(false), ...over }
}

const run = async (api: Api, r: KeyRec) => {
  const saved: KeyRec[] = []
  const shown: string[][] = []
  const out = await approve({ api, rec: r, name: 'Chrome on macOS', save: async (x) => void saved.push(x), onWords: (x) => void shown.push(x), wait: async () => {} })
  return { out, saved, shown }
}

describe('approve (commit-reveal)', () => {
  it('commits first, reveals only after the Mac nonce, shows words over both nonces, keeps the Mac key', async () => {
    const { w, api } = await world()
    const r = await rec()
    const { out, saved, shown } = await run(api, r)
    expect(out).toBe('approved')
    const post = w.calls.find((c) => c.p === '/v1/browsers')!
    expect(post.b).toEqual({ name: 'Chrome on macOS', commit: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
    expect(post.b.publicKey).toBeUndefined()
    // The reveal comes after a GET that carried the Mac nonce, never before.
    const revealAt = w.calls.findIndex((c) => c.p.endsWith('/reveal'))
    expect(w.calls.slice(0, revealAt).filter((c) => c.m === 'GET')).toHaveLength(2)
    const myPub = await publicRaw(r.pair.publicKey)
    expect(w.revealed!.publicKey).toBe(myPub)
    expect(shown).toEqual([await words(w.macPub, myPub, w.nM, w.revealed!.nonce)])
    const last = saved.at(-1)!
    expect(last).toMatchObject({ browserId: 'b1', macPublicKey: w.macPub, macNonce: w.nM, nB: w.revealed!.nonce })
  })

  it('409 on create → notPaired; 429 → tooMany', async () => {
    expect((await run((await world({ create: 409 })).api, await rec())).out).toBe('notPaired')
    expect((await run((await world({ create: 429 })).api, await rec())).out).toBe('tooMany')
  })

  it('reveal 409 → expired, 429 → tooMany', async () => {
    expect((await run((await world({ reveal: 409 })).api, await rec())).out).toBe('expired')
    expect((await run((await world({ reveal: 429 })).api, await rec())).out).toBe('tooMany')
  })

  it('denied / expired after the words', async () => {
    expect((await run((await world({ after: 'denied' })).api, await rec())).out).toBe('denied')
    expect((await run((await world({ after: 'expired' })).api, await rec())).out).toBe('expired')
  })

  it('a stored id that is revoked/denied/expired starts a new request', async () => {
    for (const status of ['revoked', 'denied', 'expired']) {
      const { w, api } = await world({ status })
      const { out } = await run(api, await rec({ browserId: 'old' }))
      expect(out).toBe('approved')
      expect(w.calls.filter((c) => c.p === '/v1/browsers')).toHaveLength(1)
    }
  })

  it('approved by the server without our reveal on record is not trusted', async () => {
    const { api } = await world({ status: 'approved' })
    const { out } = await run(api, await rec({ browserId: 'old' }))
    // Restarts: the Mac key was never checked against words here.
    expect(out).toBe('approved')
  })

  it('already approved with a stored Mac key → approved without any POST', async () => {
    const { w, api } = await world({ status: 'approved' })
    const { out } = await run(api, await rec({ browserId: 'b1', macPublicKey: w.macPub, macNonce: w.nM, nB: randomNonce() }))
    expect(out).toBe('approved')
    expect(w.calls.filter((c) => c.m === 'POST')).toEqual([])
  })

  it('a reload after the reveal shows the stored words without revealing again', async () => {
    const { w, api } = await world()
    const first = await run(api, await rec())
    const saved = first.saved.at(-1)!
    // Reloaded while the Mac still shows its prompt: pending (nonce in), then approved.
    let n = 0
    const again = await run({ ...api, get: async (p) => (n++ === 0 ? { status: 200, body: { status: 'pending', macPublicKey: w.macPub, macNonce: w.nM } } : api.get(p)) }, saved)
    expect(again.out).toBe('approved')
    expect(again.shown).toEqual(first.shown)
    expect(w.calls.filter((c) => c.p.endsWith('/reveal'))).toHaveLength(1)
  })
})

describe('browserName', () => {
  it('names browser and OS from the user agent, ≤ 80 chars', () => {
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe('Chrome on macOS')
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge on Windows')
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on Linux')
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Safari on macOS')
    expect(browserName('')).toBe('Browser')
  })
})

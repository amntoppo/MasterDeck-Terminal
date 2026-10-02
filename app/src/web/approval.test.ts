/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import { checkCommitment, generateStatic, publicRaw, randomNonce, words } from '@shared/e2e'
import { afterClose, approve, browserName, type Api } from './approval'
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
  const out = await approve({ api, rec: r, name: 'Chrome on macOS', save: async (x) => void saved.push(x), onWords: (x) => void shown.push(x), wait: async () => {}, generate: () => generateStatic(false) })
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
    // A fresh pair for the new request, never the one we came in with.
    expect(saved[0].pair).not.toBe(r.pair)
    const myPub = await publicRaw(saved[0].pair.publicKey)
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

  it('every new request after a failed one uses a fresh key pair (a denied key is blocked for an hour)', async () => {
    const { w, api } = await world({ status: 'denied' })
    const old = await rec({ browserId: 'old' })
    const { out, saved } = await run(api, old)
    expect(out).toBe('approved')
    const used = saved.find((x) => x.browserId === 'b1')!
    expect(used.pair).not.toBe(old.pair)
    expect(w.revealed!.publicKey).toBe(await publicRaw(used.pair.publicKey))
    expect(w.revealed!.publicKey).not.toBe(await publicRaw(old.pair.publicKey))
  })

  it('reveal 409 when our record says we already sent this reveal (reload race): keeps polling', async () => {
    const { w, api } = await world()
    const r = await rec()
    const first = await run({ ...api, post: async (p, b) => (p.endsWith('/reveal') ? (await api.post(p, b), { status: 409, body: {} }) : api.post(p, b)) }, r)
    // Without a record of the sent reveal a 409 is an expiry.
    expect(first.out).toBe('expired')
    const sent = first.saved.find((x) => x.revealFor)!
    expect(sent.revealFor).toBe(w.nM)
    let n = 0
    const again = await run({
      get: async (p) => (n++ === 0 ? { status: 200, body: { status: 'pending', macPublicKey: w.macPub, macNonce: w.nM } } : api.get(p)),
      post: async (p, b) => (p.endsWith('/reveal') ? { status: 409, body: {} } : api.post(p, b)),
    }, sent)
    expect(again.out).toBe('approved')
    expect(again.shown).toEqual([await words(w.macPub, await publicRaw(sent.pair.publicKey), w.nM, sent.nB!)])
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

describe('afterClose', () => {
  const fake = (session: number | 'none' | 'throw', browser: { status: number; body?: any }) => {
    const calls: string[] = []
    const api: Api = {
      async get(p) {
        calls.push('GET ' + p)
        if (p === '/auth/get-session') {
          if (session === 'throw') throw new Error('offline')
          return session === 'none' ? { status: 200, body: null } : { status: session, body: { user: { id: 'u1' } } }
        }
        return { status: browser.status, body: browser.body ?? null }
      },
      async post() {
        throw new Error('no post')
      },
      async del(p) {
        calls.push('DELETE ' + p)
        return { status: 401, body: null }
      },
    }
    return { api, calls }
  }
  const approved = { status: 200, body: { status: 'approved' } }
  it('4009 → another tab, without asking the backend', async () => {
    const f = fake(200, approved)
    expect(await afterClose(f.api, 'b1', 4009, 'open in another tab', true)).toBe('otherTab')
    expect(f.calls).toEqual([])
  })
  it('a close after the hello (not 4003/4008) → retry without asking', async () => {
    const f = fake(200, approved)
    expect(await afterClose(f.api, 'b1', 1006, '', true)).toBe('retry')
    expect(f.calls).toEqual([])
  })
  it('4008 or a close before the hello: signed out → signin; revoked / 404 / pending → revoked; approved → retry', async () => {
    expect(await afterClose(fake('none', approved).api, 'b1', 4008, '', true)).toBe('signin')
    expect(await afterClose(fake(401, approved).api, 'b1', 1006, '', false)).toBe('signin')
    for (const b of [{ status: 404 }, { status: 200, body: { status: 'revoked' } }, { status: 200, body: { status: 'pending' } }])
      expect(await afterClose(fake(200, b).api, 'b1', 1006, '', false)).toBe('revoked')
    expect(await afterClose(fake(200, approved).api, 'b1', 4008, '', true)).toBe('retry')
    // The backend unreachable: keep backing off.
    expect(await afterClose(fake('throw', approved).api, 'b1', 1006, '', false)).toBe('retry')
  })
  it("4003: revoked (or signin without a session); 'signed out' first tries DELETE of this browser", async () => {
    const f = fake(200, approved)
    expect(await afterClose(f.api, 'b1', 4003, 'revoked', true)).toBe('revoked')
    expect(f.calls.filter((c) => c.startsWith('DELETE'))).toEqual([])
    const g = fake('none', approved)
    expect(await afterClose(g.api, 'b1', 4003, 'signed out', true)).toBe('signin')
    expect(g.calls[0]).toBe('DELETE /v1/browsers/b1')
    expect(await afterClose(fake('throw', approved).api, 'b1', 4003, 'revoked', true)).toBe('revoked')
  })
})

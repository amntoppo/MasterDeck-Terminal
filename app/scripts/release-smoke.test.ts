import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signedMessage } from './release-publish.mjs'
import { bucket, idInside, offerProblems, parseArgs, signatureOk, smoke, targets } from './release-smoke.mjs'

const API = 'https://api.test'
const V = '0.9.2'

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { privateKey, raw: der.subarray(der.length - 32).toString('base64') }
}

/** A fake update service serving `version`'s three files, each `body`, signed with `privateKey`. */
function service(o: { privateKey: ReturnType<typeof keys>['privateKey']; version?: string; body?: Buffer; rollout?: number; tamper?: string }) {
  const version = o.version ?? V
  const body = o.body ?? Buffer.from('update bytes')
  const sha512 = createHash('sha512').update(body).digest('base64')
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    const u = new URL(url)
    if (u.pathname === '/v1/updates/check') {
      const id = u.searchParams.get('id') ?? ''
      if (bucket(id) >= (o.rollout ?? 100)) return new Response(null, { status: 204 })
      const t = targets(version).find((x) => x.platform === u.searchParams.get('platform') && x.arch === u.searchParams.get('arch'))!
      const signature = sign(null, Buffer.from(signedMessage({ version, platform: t.platform, arch: t.arch, name: t.name, sha512 })), o.privateKey).toString('base64')
      return Response.json({ version, name: t.name, url: `${API}/v1/updates/files/${version}/${t.name}`, sha512, size: body.length, signature })
    }
    if (u.pathname.startsWith('/v1/updates/feed/')) {
      const file = u.pathname.split('/').pop()
      const names = targets(version).filter((t) => t.feed === file).map((t) => `  - url: '${API}/v1/updates/files/${version}/${t.name}'`)
      return new Response(`version: '${version}'\nfiles:\n${names.join('\n')}\n`)
    }
    if (u.pathname.startsWith('/v1/updates/files/')) return new Response(o.tamper && url.endsWith(o.tamper) ? Buffer.from('other bytes!') : body)
    return new Response('not found', { status: 404 })
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const sleep = async () => {}

describe('rollout ids', () => {
  it('finds an id inside the rollout, none at 0', () => {
    for (const p of [1, 10, 50, 100]) expect(bucket(idInside(p)!)).toBeLessThan(p)
    expect(idInside(0)).toBeNull()
  })

  it("buckets as the backend does (SHA-256's first 4 bytes, big-endian, mod 100)", () => {
    const h = createHash('sha256').update('abc').digest()
    expect(bucket('abc')).toBe(h.readUInt32BE(0) % 100)
  })
})

describe('offers', () => {
  const { privateKey, raw } = keys()
  const t = targets(V)[0]
  const sha512 = createHash('sha512').update('x').digest('base64')
  const signature = sign(null, Buffer.from(signedMessage({ version: V, platform: t.platform, arch: t.arch, name: t.name, sha512 })), privateKey).toString('base64')
  const offer = { version: V, name: t.name, url: `${API}/f`, sha512, size: 1, signature }

  it('accepts a good offer', () => {
    expect(signatureOk(raw, { version: V, platform: t.platform, arch: t.arch, name: t.name, sha512 }, signature)).toBe(true)
    expect(offerProblems(offer, t, V, raw)).toEqual([])
  })

  it('names what is wrong', () => {
    expect(offerProblems(null, t, V, raw)).toEqual(['darwin/arm64: the check answered no offer'])
    expect(offerProblems({ ...offer, version: '0.9.1' }, t, V, raw).join()).toContain('offered 0.9.1, not 0.9.2')
    expect(offerProblems({ ...offer, url: 'http://api.test/f' }, t, V, raw).join()).toContain('not https')
    expect(offerProblems(offer, t, V, keys().raw).join()).toContain('signature does not verify')
    expect(offerProblems({ ...offer, signature: 'junk' }, t, V, raw).join()).toContain('signature does not verify')
  })
})

describe('smoke', () => {
  it('checks, reads the feed and verifies every download', async () => {
    const { privateKey, raw } = keys()
    const s = service({ privateKey })
    const res = await smoke({ api: API, version: V, publicKey: raw, fetch: s.fetch, sleep })
    expect(res.checked).toEqual(targets(V).map((t) => t.name))
    expect(s.calls.filter((c) => c.includes('/files/'))).toHaveLength(3)
    expect(s.calls.filter((c) => c.includes('/feed/'))).toHaveLength(3)
  })

  it('finds a staged release with an id inside its rollout', async () => {
    const { privateKey, raw } = keys()
    const res = await smoke({ api: API, version: V, rollout: 10, publicKey: raw, fetch: service({ privateKey, rollout: 10 }).fetch, sleep })
    expect(res.checked).toHaveLength(3)
  })

  it('skips a rollout of 0 without a call', async () => {
    const { privateKey, raw } = keys()
    const s = service({ privateKey })
    expect((await smoke({ api: API, version: V, rollout: 0, publicKey: raw, fetch: s.fetch, sleep })).skipped).toContain('0 %')
    expect(s.calls).toEqual([])
  })

  it('fails on an older version, a changed file or another key', async () => {
    const { privateKey, raw } = keys()
    await expect(smoke({ api: API, version: V, publicKey: raw, fetch: service({ privateKey, version: '0.9.1' }).fetch, sleep })).rejects.toThrow(/offered 0\.9\.1/)
    await expect(smoke({ api: API, version: V, publicKey: raw, fetch: service({ privateKey, tamper: '.exe' }).fetch, sleep })).rejects.toThrow(/win32\/x64: the download.s sha512 is not the offer.s/)
    await expect(smoke({ api: API, version: V, publicKey: keys().raw, fetch: service({ privateKey }).fetch, sleep })).rejects.toThrow(/signature/)
  })

  it('tries a failing call again before giving up', async () => {
    const { privateKey, raw } = keys()
    const s = service({ privateKey })
    let fails = 2
    const flaky = (async (url: string) => (url.includes('/check') && fails-- > 0 ? new Response('busy', { status: 503 }) : s.fetch(url))) as typeof fetch
    expect((await smoke({ api: API, version: V, publicKey: raw, fetch: flaky, sleep })).checked).toHaveLength(3)
    const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
    await expect(smoke({ api: API, version: V, publicKey: raw, fetch: down, sleep })).rejects.toThrow(/the check answered 503/)
  })
})

describe('parseArgs', () => {
  it('reads the version and rollout', () => {
    expect(parseArgs(['--version', V])).toEqual({ version: V, rollout: 100 })
    expect(parseArgs(['--version', V, '--rollout', ''])).toEqual({ version: V, rollout: 100 })
    expect(parseArgs(['--version', V, '--rollout', '25'])).toEqual({ version: V, rollout: 25 })
    expect(() => parseArgs(['--version', 'v1'])).toThrow(/--version/)
    expect(() => parseArgs(['--version', V, '--rollout', '101'])).toThrow(/0-100/)
  })
})

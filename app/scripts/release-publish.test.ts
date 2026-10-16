import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RELEASE_PUBLIC_KEY } from '../src/shared/releaseKey'
import {
  appReleaseKey,
  buildManifest,
  channelOf,
  checkSigningKey,
  findUpdateFiles,
  hashFile,
  parseAppKey,
  parseArgs,
  prepare,
  publicKeyOf,
  publish,
  signMessage,
  signedMessage,
  uploadFile,
} from './release-publish.mjs'

// The spec's shared test vector (2026-10-16-in-app-updates-design.md §1); test key only.
const VECTOR = {
  publicKey: 'AuokUivpXuPlZM7cfzzXh6veO1KFujjDji8HPyCHkUY=',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKrF71ca23w7Tr/HDObzqS2xGy5YQeoZ8HxSRt3CpmQT\n-----END PRIVATE KEY-----\n',
  fields: { version: '0.10.0', platform: 'darwin', arch: 'arm64', name: 'MasterDeck-0.10.0-arm64-mac.zip', sha512: 'q83vEjRWeJA=' },
  signature: 'H+NhmqxgXOseVXHDtkZnlAEIlAlUaWfjxy2J3Bve9zXTqk75fx0ra0h+JaIpjEKLy6LCuH3E5TPiHktYi7lHAQ==',
}

function verifyWithRaw(message: string, signature: string, rawPub: string): boolean {
  // SPKI prefix of an Ed25519 key, then the raw 32 bytes.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(rawPub, 'base64')])
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'))
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-release-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function artifacts(version: string, root = dir) {
  mkdirSync(join(root, 'masterdeck-macos-latest'), { recursive: true })
  mkdirSync(join(root, 'masterdeck-windows-latest'), { recursive: true })
  writeFileSync(join(root, 'masterdeck-macos-latest', `MasterDeck-${version}-arm64-mac.zip`), 'arm zip')
  writeFileSync(join(root, 'masterdeck-macos-latest', `MasterDeck-${version}-mac.zip`), 'intel zip')
  writeFileSync(join(root, 'masterdeck-macos-latest', `MasterDeck-${version}-arm64.dmg`), 'dmg')
  writeFileSync(join(root, 'masterdeck-windows-latest', `MasterDeck Setup ${version}.exe`), 'exe bytes')
  writeFileSync(join(root, 'masterdeck-windows-latest', `MasterDeck Setup ${version}.exe.blockmap`), 'blockmap')
}

describe('signing', () => {
  it('builds the signed message exactly', () => {
    expect(signedMessage(VECTOR.fields)).toBe(
      'masterdeck-update\nv1\n0.10.0\ndarwin\narm64\nMasterDeck-0.10.0-arm64-mac.zip\nq83vEjRWeJA=',
    )
  })

  it('matches the shared test vector', () => {
    expect(signMessage(signedMessage(VECTOR.fields), VECTOR.privateKey)).toBe(VECTOR.signature)
    expect(publicKeyOf(VECTOR.privateKey)).toBe(VECTOR.publicKey)
    expect(verifyWithRaw(signedMessage(VECTOR.fields), VECTOR.signature, VECTOR.publicKey)).toBe(true)
  })

  it('refuses a key that is not Ed25519', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    expect(() => signMessage('x', pem)).toThrow(/Ed25519/)
  })
})

describe("the app's release key", () => {
  it("reads the key built into the app from releaseKey.ts", async () => {
    expect(parseAppKey("export const RELEASE_PUBLIC_KEY = 'AuokUivpXuPlZM7cfzzXh6veO1KFujjDji8HPyCHkUY='\n")).toBe(VECTOR.publicKey)
    expect(() => parseAppKey('nothing here')).toThrow(/RELEASE_PUBLIC_KEY/)
    expect(await appReleaseKey()).toBe(RELEASE_PUBLIC_KEY)
  })

  it('refuses a signing key whose public key is not the expected one', () => {
    expect(() => checkSigningKey(VECTOR.privateKey, VECTOR.publicKey)).not.toThrow()
    expect(() => checkSigningKey(VECTOR.privateKey, RELEASE_PUBLIC_KEY)).toThrow(/does not match/)
  })

  it('--expect-key names another key (an E2E or test key)', () => {
    expect(parseArgs(['--dir', 'd', '--version', '1.0.0', '--expect-key', VECTOR.publicKey])).toMatchObject({ expectKey: VECTOR.publicKey })
    expect(() => parseArgs(['--dir', 'd', '--version', '1.0.0', '--expect-key', 'short'])).toThrow(/expect-key/)
  })
})

describe('channel and arguments', () => {
  it('takes the channel from the version', () => {
    expect(channelOf('0.10.0')).toBe('stable')
    expect(channelOf('0.10.0-beta.1')).toBe('beta')
  })

  it('parses and checks the arguments', () => {
    expect(parseArgs(['--dir', 'd', '--version', 'v0.10.0-beta.2'])).toMatchObject({ dir: 'd', version: '0.10.0-beta.2', channel: 'beta', dryRun: false })
    expect(parseArgs(['--dir', 'd', '--version', '1.0.0', '--rollout', '25', '--min-supported', '0.9.0', '--dry-run'])).toMatchObject({
      channel: 'stable',
      rollout: 25,
      minSupported: '0.9.0',
      dryRun: true,
    })
    expect(() => parseArgs(['--version', '1.0.0'])).toThrow(/--dir/)
    expect(() => parseArgs(['--dir', 'd', '--version', 'latest'])).toThrow(/version/)
    expect(() => parseArgs(['--dir', 'd', '--version', '1.0.0', '--rollout', '101'])).toThrow(/rollout/)
    expect(() => parseArgs(['--dir', 'd', '--version', '1.0.0', '--channel', 'nightly'])).toThrow(/channel/)
    expect(() => parseArgs(['--dir', 'd', '--version', '1.0.0', '--bogus'])).toThrow(/unknown/)
  })
})

describe('findUpdateFiles', () => {
  it('finds the zips and the renamed installer with its blockmap, in nested folders', async () => {
    artifacts('0.10.0')
    const files = await findUpdateFiles(dir, '0.10.0')
    expect(files.map((f) => [f.platform, f.arch, f.name])).toEqual([
      ['darwin', 'arm64', 'MasterDeck-0.10.0-arm64-mac.zip'],
      ['darwin', 'x64', 'MasterDeck-0.10.0-mac.zip'],
      ['win32', 'x64', 'MasterDeck-Setup-0.10.0.exe'],
    ])
    expect(files[2].path).toMatch(/MasterDeck Setup 0\.10\.0\.exe$/)
    expect(files[2].blockmap?.name).toBe('MasterDeck-Setup-0.10.0.exe.blockmap')
  })

  it('fails loudly on a missing file or a version mismatch', async () => {
    artifacts('0.10.0')
    rmSync(join(dir, 'masterdeck-windows-latest', 'MasterDeck Setup 0.10.0.exe.blockmap'))
    await expect(findUpdateFiles(dir, '0.10.0')).rejects.toThrow(/MasterDeck Setup 0\.10\.0\.exe\.blockmap/)
    await expect(findUpdateFiles(dir, '0.11.0')).rejects.toThrow(/missing.*MasterDeck-0\.11\.0-arm64-mac\.zip/)
  })
})

describe('manifest', () => {
  it('hashes, signs and builds the publish body', async () => {
    artifacts('0.10.0')
    const { manifest, uploads } = await prepare({
      dir,
      version: '0.10.0',
      channel: 'stable',
      notes: 'Notes',
      rolloutPercent: 10,
      minSupportedVersion: '0.9.0',
      privateKeyPem: VECTOR.privateKey,
    })
    expect(manifest).toMatchObject({ version: '0.10.0', channel: 'stable', notes: 'Notes', rolloutPercent: 10, minSupportedVersion: '0.9.0' })
    expect(manifest.files).toHaveLength(3)
    const arm = manifest.files[0]
    expect(arm).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      name: 'MasterDeck-0.10.0-arm64-mac.zip',
      key: '0.10.0/MasterDeck-0.10.0-arm64-mac.zip',
      sha512: createHash('sha512').update('arm zip').digest('base64'),
      size: 7,
      signature: expect.any(String),
    })
    for (const f of manifest.files) {
      expect(verifyWithRaw(signedMessage({ ...f, version: '0.10.0' }), f.signature, VECTOR.publicKey)).toBe(true)
    }
    expect(uploads.map((u) => u.key)).toEqual([
      '0.10.0/MasterDeck-0.10.0-arm64-mac.zip',
      '0.10.0/MasterDeck-0.10.0-mac.zip',
      '0.10.0/MasterDeck-Setup-0.10.0.exe',
      '0.10.0/MasterDeck-Setup-0.10.0.exe.blockmap',
    ])
  })

  it('leaves out the optional fields when not given', () => {
    const body = buildManifest({ version: '1.0.0', channel: 'stable', notes: 'n', files: [] })
    expect(body).toEqual({ version: '1.0.0', channel: 'stable', notes: 'n', files: [] })
  })

  it('hashes like electron-updater (base64 SHA-512)', async () => {
    const p = join(dir, 'f')
    writeFileSync(p, Buffer.alloc(300_000, 7))
    expect(await hashFile(p)).toEqual({ sha512: createHash('sha512').update(Buffer.alloc(300_000, 7)).digest('base64'), size: 300_000 })
  })
})

type Call = { method: string; url: string; body?: unknown; bytes?: number }

type Stored = { size: number; sha512?: string; published?: boolean }

function fakeServer(opts: { failPart?: { n: number; times: number }; stored?: Record<string, Stored>; createStatus?: number } = {}) {
  const calls: Call[] = []
  let failures = 0
  const fetchFn = async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    const body = init.body
    const call: Call = { method, url }
    if (typeof body === 'string') call.body = JSON.parse(body)
    else if (body) call.bytes = (body as Buffer).length
    calls.push(call)
    const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })
    const file = url.match(/\/v1\/updates\/files\/(.+)$/)
    if (method === 'HEAD' && file) {
      const f = opts.stored?.[file[1]]
      if (!f) return new Response(null, { status: 404 })
      const headers: Record<string, string> = { 'content-length': String(f.size), 'cache-control': f.published ? 'public, max-age=31536000, immutable' : 'no-store' }
      if (f.sha512) headers['x-md-sha512'] = f.sha512
      return new Response(null, { status: 200, headers })
    }
    if (method === 'POST' && url.endsWith('/v1/admin/uploads'))
      return opts.createStatus ? new Response(JSON.stringify({ error: 'is published' }), { status: opts.createStatus }) : ok({ uploadId: 'up1' })
    const part = url.match(/\/parts\/(\d+)\?/)
    if (method === 'PUT' && part) {
      const n = Number(part[1])
      if (opts.failPart && opts.failPart.n === n && failures < opts.failPart.times) {
        failures++
        return new Response('boom', { status: 500 })
      }
      return ok({ partNumber: n, etag: `e${n}` })
    }
    if (method === 'POST' && url.endsWith('/complete')) return ok({ key: (call.body as { key: string }).key, size: 0 })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (method === 'POST' && url.endsWith('/v1/admin/releases')) return ok({ ok: true })
    return new Response('no route', { status: 404 })
  }
  return { calls, fetch: fetchFn as unknown as typeof fetch }
}

describe('uploads', () => {
  const noSleep = async () => {}

  it('splits a file into parts and completes with their etags', async () => {
    const p = join(dir, 'big')
    writeFileSync(p, Buffer.alloc(25, 1))
    const s = fakeServer()
    await uploadFile({ api: 'https://api.test', token: 'tok', key: '1.0.0/big', path: p, size: 25, sha512: 'SUM', fetch: s.fetch, partSize: 10, sleep: noSleep })
    const puts = s.calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => c.bytes)).toEqual([10, 10, 5])
    expect(puts[0].url).toBe('https://api.test/v1/admin/uploads/up1/parts/1?key=1.0.0%2Fbig')
    const complete = s.calls.find((c) => c.url.endsWith('/complete'))
    expect(complete?.body).toEqual({
      key: '1.0.0/big',
      parts: [
        { partNumber: 1, etag: 'e1' },
        { partNumber: 2, etag: 'e2' },
        { partNumber: 3, etag: 'e3' },
      ],
    })
    expect(s.calls[0]).toEqual({ method: 'POST', url: 'https://api.test/v1/admin/uploads', body: { key: '1.0.0/big', sha512: 'SUM' } })
  })

  it('retries a failing part', async () => {
    const p = join(dir, 'big')
    writeFileSync(p, Buffer.alloc(25, 1))
    const s = fakeServer({ failPart: { n: 2, times: 2 } })
    await uploadFile({ api: 'https://api.test', token: 'tok', key: 'k/x', path: p, size: 25, sha512: 'SUM', fetch: s.fetch, partSize: 10, sleep: noSleep })
    expect(s.calls.filter((c) => c.method === 'PUT').length).toBe(5)
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('aborts the upload when a part keeps failing', async () => {
    const p = join(dir, 'big')
    writeFileSync(p, Buffer.alloc(25, 1))
    const s = fakeServer({ failPart: { n: 2, times: 99 } })
    await expect(
      uploadFile({ api: 'https://api.test', token: 'tok', key: 'k/x', path: p, size: 25, sha512: 'SUM', fetch: s.fetch, partSize: 10, sleep: noSleep }),
    ).rejects.toThrow(/500 boom/)
    expect(s.calls.at(-1)).toEqual({ method: 'DELETE', url: 'https://api.test/v1/admin/uploads/up1?key=k%2Fx' })
    expect(s.calls.some((c) => c.url.endsWith('/complete'))).toBe(false)
  })

  it('uploads every file, then publishes the manifest', async () => {
    artifacts('0.10.0')
    const { manifest, uploads } = await prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })
    const s = fakeServer()
    const res = await publish({ api: 'https://api.test', token: 'tok', manifest, uploads, fetch: s.fetch, sleep: noSleep })
    expect(res).toEqual({ ok: true })
    expect(s.calls.filter((c) => c.url.endsWith('/v1/admin/uploads')).map((c) => (c.body as { key: string }).key)).toEqual(uploads.map((u) => u.key))
    const last = s.calls.at(-1)
    expect(last?.url).toBe('https://api.test/v1/admin/releases')
    expect(last?.body).toEqual(manifest)
  })

  it('sends each upload its sha512, the blockmap too', async () => {
    artifacts('0.10.0')
    const { manifest, uploads } = await prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })
    const s = fakeServer()
    await publish({ api: 'https://api.test', token: 'tok', manifest, uploads, fetch: s.fetch, sleep: noSleep })
    const created = s.calls.filter((c) => c.url.endsWith('/v1/admin/uploads')).map((c) => c.body as { key: string; sha512: string })
    expect(created.map((c) => c.sha512)).toEqual(uploads.map((u) => u.sha512))
    for (const f of manifest.files) expect(created.find((c) => c.key === f.key)?.sha512).toBe(f.sha512)
    expect(created.every((c) => /^[A-Za-z0-9+/]{86}==$/.test(c.sha512))).toBe(true)
  })

  it('skips a file only when the service holds it with the same size and sha512 (a re-run reaches the idempotent publish)', async () => {
    artifacts('0.10.0')
    const { manifest, uploads } = await prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })
    expect(uploads.length).toBeGreaterThanOrEqual(4)
    const [same, otherSize, otherHash, noHash] = uploads
    const s = fakeServer({
      stored: {
        [same.key]: { size: same.size, sha512: same.sha512 },
        [otherSize.key]: { size: otherSize.size + 1, sha512: otherSize.sha512 },
        [otherHash.key]: { size: otherHash.size, sha512: same.sha512 === otherHash.sha512 ? 'x' : same.sha512 },
        [noHash.key]: { size: noHash.size },
      },
    })
    await publish({ api: 'https://api.test', token: 'tok', manifest, uploads, fetch: s.fetch, sleep: noSleep })
    expect(s.calls.filter((c) => c.method === 'HEAD').map((c) => c.url)).toEqual(uploads.map((u) => `https://api.test/v1/updates/files/${u.key}`))
    const created = s.calls.filter((c) => c.url.endsWith('/v1/admin/uploads')).map((c) => (c.body as { key: string }).key)
    // Same size and hash: skipped. Another size, a same-size rebuild, or no hash stored: uploaded again
    // (an unpublished key may be overwritten).
    expect(created).toEqual(uploads.slice(1).map((u) => u.key))
    expect(s.calls.at(-1)?.url).toBe('https://api.test/v1/admin/releases')
  })

  it('fails loudly, uploading and publishing nothing, when a published file has another hash', async () => {
    artifacts('0.10.0')
    const { manifest, uploads } = await prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })
    const u = uploads[1]
    const s = fakeServer({ stored: { [u.key]: { size: u.size, sha512: 'another', published: true } } })
    await expect(publish({ api: 'https://api.test', token: 'tok', manifest, uploads, fetch: s.fetch, sleep: noSleep })).rejects.toThrow(
      new RegExp(`${u.key.replace(/\./g, '\\.')} is published with another build.*yank 0\\.10\\.0 and ship a new version`, 'i'),
    )
    expect(s.calls.filter((c) => c.method !== 'HEAD')).toEqual([])
  })

  it('a create refused as published (409) fails with the same advice', async () => {
    artifacts('0.10.0')
    const { manifest, uploads } = await prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })
    const s = fakeServer({ createStatus: 409 })
    await expect(publish({ api: 'https://api.test', token: 'tok', manifest, uploads, fetch: s.fetch, sleep: noSleep })).rejects.toThrow(/yank 0\.10\.0 and ship a new version/i)
    expect(s.calls.some((c) => c.url.endsWith('/v1/admin/releases'))).toBe(false)
  })

  it('refuses an empty file', async () => {
    artifacts('0.10.0')
    writeFileSync(join(dir, 'masterdeck-macos-latest', 'MasterDeck-0.10.0-mac.zip'), '')
    await expect(prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })).rejects.toThrow(
      /MasterDeck-0\.10\.0-mac\.zip is empty/,
    )
    writeFileSync(join(dir, 'masterdeck-macos-latest', 'MasterDeck-0.10.0-mac.zip'), 'intel zip')
    writeFileSync(join(dir, 'masterdeck-windows-latest', 'MasterDeck Setup 0.10.0.exe.blockmap'), '')
    await expect(prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })).rejects.toThrow(/blockmap is empty/)
  })

  it('does not publish when an upload fails', async () => {
    artifacts('0.10.0')
    const { manifest, uploads } = await prepare({ dir, version: '0.10.0', channel: 'stable', notes: 'N', privateKeyPem: VECTOR.privateKey })
    const s = fakeServer({ failPart: { n: 1, times: 99 } })
    await expect(publish({ api: 'https://api.test', token: 'tok', manifest, uploads, fetch: s.fetch, sleep: noSleep })).rejects.toThrow()
    expect(s.calls.some((c) => c.url.endsWith('/v1/admin/releases'))).toBe(false)
  })
})

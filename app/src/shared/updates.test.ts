import { describe, expect, it } from 'vitest'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import {
  badge,
  channelOf,
  checkUrl,
  compareVersions,
  parseOffer,
  parseResult,
  REMIND_MS,
  shouldPrompt,
  signedMessage,
  statusLine,
  type UpdateOffer,
  type UpdateState,
} from './updates'
import { isRawKey, RELEASE_PUBLIC_KEY, releaseKey, updateBase } from './releaseKey'
import { DEFAULT_REMOTE_URL } from './account'

// The spec's shared test vector (spec §1): every implementation checks against it.
const VECTOR = {
  publicKey: 'AuokUivpXuPlZM7cfzzXh6veO1KFujjDji8HPyCHkUY=',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKrF71ca23w7Tr/HDObzqS2xGy5YQeoZ8HxSRt3CpmQT\n-----END PRIVATE KEY-----\n',
  fields: { version: '0.10.0', platform: 'darwin', arch: 'arm64', name: 'MasterDeck-0.10.0-arm64-mac.zip', sha512: 'q83vEjRWeJA=' },
  signature: 'H+NhmqxgXOseVXHDtkZnlAEIlAlUaWfjxy2J3Bve9zXTqk75fx0ra0h+JaIpjEKLy6LCuH3E5TPiHktYi7lHAQ==',
}
const spki = (raw: string) =>
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' })

describe('signedMessage and the shared test vector', () => {
  it('builds the seven lines without a trailing newline', () => {
    expect(signedMessage(VECTOR.fields)).toBe('masterdeck-update\nv1\n0.10.0\ndarwin\narm64\nMasterDeck-0.10.0-arm64-mac.zip\nq83vEjRWeJA=')
  })
  it('the vector signature verifies against the vector key', () => {
    const msg = Buffer.from(signedMessage(VECTOR.fields), 'utf8')
    expect(verify(null, msg, spki(VECTOR.publicKey), Buffer.from(VECTOR.signature, 'base64'))).toBe(true)
    // Signing again with the private key gives the same bytes (Ed25519 is deterministic).
    expect(sign(null, msg, createPrivateKey(VECTOR.privateKey)).toString('base64')).toBe(VECTOR.signature)
  })
  it('any changed field fails', () => {
    for (const k of Object.keys(VECTOR.fields) as (keyof typeof VECTOR.fields)[]) {
      const msg = Buffer.from(signedMessage({ ...VECTOR.fields, [k]: VECTOR.fields[k] + 'x' }), 'utf8')
      expect(verify(null, msg, spki(VECTOR.publicKey), Buffer.from(VECTOR.signature, 'base64')), k).toBe(false)
    }
  })
  it('the built-in release key is a valid raw key; the vector does not verify against it', () => {
    expect(isRawKey(RELEASE_PUBLIC_KEY)).toBe(true)
    expect(spki(RELEASE_PUBLIC_KEY).asymmetricKeyType).toBe('ed25519')
    const msg = Buffer.from(signedMessage(VECTOR.fields), 'utf8')
    expect(verify(null, msg, spki(RELEASE_PUBLIC_KEY), Buffer.from(VECTOR.signature, 'base64'))).toBe(false)
  })
})

describe('releaseKey', () => {
  const K = VECTOR.publicKey
  const iso = { MASTERDECK_UPDATE_PUBKEY: K, MASTERDECK_ISOLATED: '1' }
  it('honours a test key only in an update-test build launched isolated', () => {
    expect(releaseKey({ testBuild: true, env: {} })).toBe(RELEASE_PUBLIC_KEY)
    expect(releaseKey({ testBuild: true, env: { MASTERDECK_UPDATE_PUBKEY: K } })).toBe(RELEASE_PUBLIC_KEY)
    expect(releaseKey({ testBuild: true, env: iso })).toBe(K)
    expect(releaseKey({ testBuild: true, env: { MASTERDECK_UPDATE_PUBKEY: 'nope', MASTERDECK_ISOLATED: '1' } })).toBe(RELEASE_PUBLIC_KEY)
  })
  it('a release build never takes it, whatever the environment says (launchctl setenv reaches every app)', () => {
    expect(releaseKey({ testBuild: false, env: iso })).toBe(RELEASE_PUBLIC_KEY)
  })
})

describe('updateBase', () => {
  const env = { MASTERDECK_UPDATE_URL: 'http://localhost:8787/', MASTERDECK_REMOTE_URL: 'https://evil.example' }
  it('a packaged release build always asks the real service', () => {
    expect(updateBase({ testBuild: false, packaged: true, env })).toBe(DEFAULT_REMOTE_URL)
    expect(updateBase({ testBuild: false, packaged: true, env: {} })).toBe(DEFAULT_REMOTE_URL)
  })
  it('an update-test build or a development run takes MASTERDECK_UPDATE_URL', () => {
    expect(updateBase({ testBuild: true, packaged: true, env })).toBe('http://localhost:8787')
    expect(updateBase({ testBuild: false, packaged: false, env })).toBe('http://localhost:8787')
    // Not a backend address: the real service.
    expect(updateBase({ testBuild: true, packaged: true, env: { MASTERDECK_UPDATE_URL: 'file:///x' } })).toBe(DEFAULT_REMOTE_URL)
  })
})

describe('compareVersions', () => {
  it('orders semver with prereleases', () => {
    const sorted = ['0.9.0', '0.10.0-alpha', '0.10.0-alpha.1', '0.10.0-alpha.beta', '0.10.0-beta', '0.10.0-beta.2', '0.10.0-beta.11', '0.10.0-rc.1', '0.10.0', '0.10.1', '1.0.0']
    for (let i = 0; i < sorted.length; i++)
      for (let j = 0; j < sorted.length; j++) expect(Math.sign(compareVersions(sorted[i], sorted[j])), `${sorted[i]} vs ${sorted[j]}`).toBe(Math.sign(i - j))
  })
  it('ignores a leading v and build metadata', () => {
    expect(compareVersions('v0.10.0', '0.10.0')).toBe(0)
    expect(compareVersions('0.10.0+abc', '0.10.0')).toBe(0)
  })
  it('puts junk below every version', () => {
    expect(compareVersions('junk', '0.0.1')).toBe(-1)
    expect(compareVersions('0.0.1', 'junk')).toBe(1)
  })
  it('names the channel by the dash', () => {
    expect(channelOf('0.10.0-beta.1')).toBe('beta')
    expect(channelOf('0.10.0')).toBe('stable')
  })
})

const offer: UpdateOffer = {
  version: '0.10.0',
  channel: 'stable',
  notes: '## New',
  name: 'MasterDeck-0.10.0-arm64-mac.zip',
  url: 'https://dev.masterdeck.dev/v1/updates/files/0.10.0/MasterDeck-0.10.0-arm64-mac.zip',
  sha512: 'q83vEjRWeJA=',
  size: 10,
  signature: VECTOR.signature,
  publishedAt: 1,
  mandatory: false,
}

describe('parseOffer', () => {
  it('takes the server answer', () => {
    expect(parseOffer(offer)).toEqual(offer)
  })
  it('refuses a bad shape or an unsafe name', () => {
    expect(parseOffer(null)).toBeNull()
    expect(parseOffer({ ...offer, version: 'x' })).toBeNull()
    expect(parseOffer({ ...offer, name: '../evil.zip' })).toBeNull()
    expect(parseOffer({ ...offer, size: -1 })).toBeNull()
    expect(parseOffer({ ...offer, url: 'file:///etc/passwd' })).toBeNull()
  })
  it('wants an https download, plain http only to this machine', () => {
    expect(parseOffer({ ...offer, url: 'http://dev.masterdeck.dev/v1/updates/files/x.zip' })).toBeNull()
    expect(parseOffer({ ...offer, url: 'http://localhost.evil.com/x.zip' })).toBeNull()
    expect(parseOffer({ ...offer, url: 'http://127.0.0.1.nip.io/x.zip' })).toBeNull()
    expect(parseOffer({ ...offer, url: 'http://user@evil.com:80@localhost/x' })).toBeNull()
    expect(parseOffer({ ...offer, url: 'ftp://dev.masterdeck.dev/x.zip' })).toBeNull()
    expect(parseOffer({ ...offer, url: 'http://localhost:8787/v1/updates/files/x.zip' })?.url).toBe('http://localhost:8787/v1/updates/files/x.zip')
    expect(parseOffer({ ...offer, url: 'http://127.0.0.1:8787/x.zip' })).not.toBeNull()
  })
})

describe('checkUrl and parseResult', () => {
  it('builds the check query', () => {
    expect(checkUrl('https://x.dev', { version: '0.9.0', platform: 'darwin', arch: 'arm64', channel: 'beta', id: 'abc' })).toBe(
      'https://x.dev/v1/updates/check?version=0.9.0&platform=darwin&arch=arm64&channel=beta&id=abc',
    )
  })
  it('reads the helper result', () => {
    expect(parseResult('{"ok":true,"from":"0.9.0","version":"0.10.0","at":5}')).toEqual({ ok: true, from: '0.9.0', version: '0.10.0', at: 5 })
    expect(parseResult('{"ok":false,"version":"0.10.0","reason":"unhealthy","at":5}')).toEqual({ ok: false, version: '0.10.0', reason: 'unhealthy', at: 5 })
    expect(parseResult('nope')).toBeNull()
    expect(parseResult('{"ok":true,"version":"0.10.0"}')).toBeNull()
  })
})

const base: UpdateState = { current: '0.9.0', platform: 'darwin', arch: 'arm64', enabled: true, phase: 'idle', mandatory: false }

describe('statusLine, shouldPrompt, badge', () => {
  it('says where things are', () => {
    expect(statusLine({ ...base, phase: 'up-to-date' })).toBe('Up to date')
    expect(statusLine({ ...base, phase: 'available', offer })).toBe('Update available: v0.10.0')
    expect(statusLine({ ...base, phase: 'downloading', offer, progress: 0.42 })).toBe('Downloading 42%')
    expect(statusLine({ ...base, phase: 'ready', offer })).toBe('Ready to install')
    expect(statusLine({ ...base, phase: 'error', errorKind: 'offline' })).toBe('Offline: could not check for updates')
    expect(statusLine({ ...base, enabled: false, disabledReason: 'dev build' })).toBe('dev build')
  })
  it('prompts when ready and not snoozed', () => {
    expect(shouldPrompt({ ...base, phase: 'ready', offer }, 0)).toBe(true)
    expect(shouldPrompt({ ...base, phase: 'available', offer }, 0)).toBe(false)
    expect(shouldPrompt({ ...base, phase: 'ready', offer, remindAt: REMIND_MS }, REMIND_MS - 1)).toBe(false)
    expect(shouldPrompt({ ...base, phase: 'ready', offer, remindAt: REMIND_MS }, REMIND_MS)).toBe(true)
  })
  it('marks the rail', () => {
    expect(badge({ ...base, phase: 'up-to-date' })).toBeNull()
    expect(badge({ ...base, phase: 'available', offer })).toBe('available')
    expect(badge({ ...base, phase: 'downloading', offer })).toBe('available')
    expect(badge({ ...base, phase: 'ready', offer })).toBe('ready')
    expect(badge({ ...base, phase: 'ready', offer, mandatory: true })).toBe('required')
    expect(badge({ ...base, phase: 'error', offer, errorKind: 'verify' })).toBeNull()
  })
})

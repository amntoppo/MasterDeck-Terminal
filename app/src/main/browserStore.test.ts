import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserStore } from './browserStore'
import { loadMacKey } from './macKey'
import { publicRaw } from '@shared/e2e'

const file = () => join(mkdtempSync(join(tmpdir(), 'bstore-')), 'deep', 'browsers.json')
const b = (id: string) => ({ id, name: `B ${id}`, publicKey: 'B'.repeat(87), approvedAt: 1 })

describe('BrowserStore', () => {
  it('keeps entries per account and drops other accounts on load', () => {
    const f = file()
    const s = new BrowserStore(f)
    s.add('u1', b('b1'))
    s.add('u2', b('b2'))
    expect(new BrowserStore(f).list('u1')).toEqual([b('b1')])
    expect(readFileSync(f, 'utf8')).not.toContain('b2')
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
  it('wipe empties the file', () => {
    const f = file()
    const s = new BrowserStore(f)
    s.add('u1', b('b1'))
    s.wipe()
    expect(new BrowserStore(f).list('u1')).toEqual([])
    expect(readFileSync(f, 'utf8')).not.toContain('b1')
  })
  it('get refuses a wrong id (and another account); remove deletes', () => {
    const s = new BrowserStore(file())
    s.add('u1', b('b1'))
    expect(s.get('u1', 'b1')).toEqual(b('b1'))
    expect(s.get('u1', 'nope')).toBeNull()
    expect(s.get('u2', 'b1')).toBeNull()
    expect(s.list('u1')).toEqual([]) // the u2 lookup dropped u1's entries
    s.add('u1', b('b1'))
    s.remove('b1')
    expect(s.list('u1')).toEqual([])
  })
  it('a corrupt file is treated as empty', () => {
    const f = file()
    new BrowserStore(f).wipe()
    writeFileSync(f, '{nope')
    expect(new BrowserStore(f).list('u1')).toEqual([])
  })
})

describe('loadMacKey', () => {
  const safe = (on = true) => ({
    isEncryptionAvailable: () => on,
    encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
    decryptString: (x: Buffer) => String(x).split('').reverse().join(''),
  })
  it('creates the key once (encrypted, 0600) and loads the same key later', async () => {
    const f = file()
    const a = await loadMacKey(f, safe())
    expect(a!.publicKey).toHaveLength(87)
    expect(readFileSync(f, 'utf8')).not.toContain(a!.publicKey) // stored through safeStorage
    expect(statSync(f).mode & 0o777).toBe(0o600)
    const again = await loadMacKey(f, safe())
    expect(again!.publicKey).toBe(a!.publicKey)
    expect(await publicRaw(again!.pair.publicKey)).toBe(a!.publicKey)
    expect(again!.pair.privateKey.extractable).toBe(false)
  })
  it('is null when encryption is unavailable', async () => {
    expect(await loadMacKey(file(), safe(false))).toBeNull()
  })
})

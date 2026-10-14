import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real safeStorage opens the macOS Keychain; a test must never reach it.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => { throw new Error('real Keychain used') },
    encryptString: () => { throw new Error('real Keychain used') },
    decryptString: () => { throw new Error('real Keychain used') },
  },
}))

import { loadMacKey, NO_KEYCHAIN, type SafeStore } from './macKey'
import { readToken, writeToken } from './remoteToken'

/** A store that counts every Keychain call. */
function counting(): SafeStore & { calls: number } {
  const s = {
    calls: 0,
    isEncryptionAvailable: () => { s.calls++; return true },
    encryptString: (t: string) => { s.calls++; return Buffer.from(t) },
    decryptString: (b: Buffer) => { s.calls++; return b.toString() },
  }
  return s
}

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const tmp = () => (dir = mkdtempSync(join(tmpdir(), 'md-keychain-')))

describe('the Keychain at startup', () => {
  it('reads no token, and asks no Keychain, when there is no token file', () => {
    const safe = counting()
    expect(readToken(join(tmp(), 'remote-token'), safe)).toBeNull()
    expect(safe.calls).toBe(0)
  })

  it('reads a token through the store it is given', () => {
    const f = join(tmp(), 'remote-token')
    writeFileSync(f, 'tok')
    expect(readToken(f, counting())).toBe('tok')
  })

  it('NO_KEYCHAIN (the smoke test) gives no Mac key and writes no key file', async () => {
    const f = join(tmp(), 'browser-key')
    expect(await loadMacKey(f, NO_KEYCHAIN)).toBeNull()
    expect(existsSync(f)).toBe(false)
  })

  it('NO_KEYCHAIN reads no token even when the file is there, and saves none', () => {
    const f = join(tmp(), 'remote-token')
    writeFileSync(f, 'tok')
    expect(readToken(f, NO_KEYCHAIN)).toBeNull()
    expect(writeToken(join(dir, 'other'), 'x'.repeat(40), NO_KEYCHAIN)).toEqual({ ok: false, message: 'the Keychain is not available' })
  })
})

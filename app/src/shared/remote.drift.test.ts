import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// MASTERDECK_BACKEND (CI checks the backend out there) or the sibling checkout:
// ~/Documents/MasterDeck-Terminal/app/src/shared → ~/Documents/masterdeck-backend
const named = process.env.MASTERDECK_BACKEND || undefined
const backend = named ?? resolve(__dirname, '../../../../masterdeck-backend')
const theirs = resolve(backend, 'src/protocol.ts')

describe('remote protocol copy', () => {
  // Without a backend named, a missing sibling skips (a machine without it); a named one must be there,
  // so a broken checkout in CI cannot pass silently.
  it.skipIf(!named && !existsSync(theirs))('is the same as masterdeck-backend/src/protocol.ts', () => {
    expect(existsSync(theirs), `MASTERDECK_BACKEND has no src/protocol.ts: ${theirs}`).toBe(true)
    expect(readFileSync(resolve(__dirname, 'remote.ts'), 'utf8')).toBe(readFileSync(theirs, 'utf8'))
  })
})

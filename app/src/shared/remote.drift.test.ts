import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ~/Documents/MasterDeck-Terminal/app/src/shared → ~/Documents/masterdeck-backend
const backend = process.env.MASTERDECK_BACKEND ?? resolve(__dirname, '../../../../masterdeck-backend')
const theirs = resolve(backend, 'src/protocol.ts')

describe('remote protocol copy', () => {
  it.skipIf(!existsSync(theirs))('is the same as masterdeck-backend/src/protocol.ts', () => {
    expect(readFileSync(resolve(__dirname, 'remote.ts'), 'utf8')).toBe(readFileSync(theirs, 'utf8'))
  })
})

import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startDir } from './ptys'

describe('startDir', () => {
  it('expands ~, keeps a real folder, and falls back to home', () => {
    const d = mkdtempSync(join(tmpdir(), 'ws-'))
    expect(startDir(d)).toBe(d)
    expect(startDir('~')).toBe(homedir())
    expect(startDir(join(d, 'missing'))).toBe(homedir())
    expect(startDir(undefined)).toBe(homedir())
    expect(startDir('~nobody')).toBe(homedir()) // not "~/": left alone, and it doesn't exist
  })
})

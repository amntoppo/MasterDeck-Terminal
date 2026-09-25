import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hookStatus, installHooks } from './hooks'

describe.skipIf(process.platform === 'win32')('hooks', () => {
  it('adds, keeps other settings, is idempotent, and removes', () => {
    const d = mkdtempSync(join(tmpdir(), 'hooks-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({ model: 'x', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }))
    expect(hookStatus(p)).toEqual({ ticket: false, pr: false })
    expect(installHooks(p, d, { ticket: true, pr: true }).ok).toBe(true)
    installHooks(p, d, { ticket: true, pr: true })
    const s = JSON.parse(readFileSync(p, 'utf8'))
    expect(s.model).toBe('x')
    expect(hookStatus(p)).toEqual({ ticket: true, pr: true })
    const cmds = JSON.stringify(s.hooks)
    expect(cmds.split('babysit-ticket/scripts/tt.sh').length - 1).toBe(2)
    expect(cmds).toContain('other')
    installHooks(p, d, { ticket: false, pr: true })
    expect(hookStatus(p)).toEqual({ ticket: false, pr: true })
    expect(readFileSync(p, 'utf8')).toContain('other')
  })
})

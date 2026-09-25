import { describe, expect, it } from 'vitest'
import { isSafeBgId, paneCommand } from './paneCommand'

describe('paneCommand', () => {
  it('attach runs the resolved claude binary', () => {
    expect(paneCommand({ kind: 'attach', bgId: 'abcd1234' }, 'darwin', '/bin/zsh')).toEqual({ file: 'claude', args: ['attach', 'abcd1234'] })
    const c = 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd'
    expect(paneCommand({ kind: 'attach', bgId: 'abcd1234' }, 'win32', undefined, c).file).toBe(c)
  })
  it('shell uses the login shell, PowerShell on Windows', () => {
    expect(paneCommand({ kind: 'shell', cwd: '/w' }, 'darwin', '/bin/bash')).toEqual({ file: '/bin/bash', args: ['-l'], cwd: '/w' })
    expect(paneCommand({ kind: 'shell', cwd: 'C:\\w' }, 'win32', undefined)).toEqual({ file: 'powershell.exe', args: ['-NoLogo'], cwd: 'C:\\w' })
    expect(paneCommand({ kind: 'shell', cwd: '/w' }, 'linux', undefined).file).toBe('/bin/zsh')
  })
  it('isSafeBgId', () => {
    expect(isSafeBgId('ea39fd38')).toBe(true)
    expect(isSafeBgId('ea39fd38; rm -rf')).toBe(false)
  })
})

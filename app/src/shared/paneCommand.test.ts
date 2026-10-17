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
  it('installer runs claude with the install instructions for known tools only', () => {
    const c = paneCommand({ kind: 'installer', tools: ['jq', 'nope'] }, 'darwin', '/bin/zsh')
    expect(c.file).toBe('claude')
    expect(c.args).toHaveLength(1)
    expect(c.args[0]).toContain('brew install jq')
    expect(c.args[0]).not.toContain('nope')
  })
  it("Setup's Claude: its own name, project settings only, and a first message", () => {
    expect(paneCommand({ kind: 'setup-claude' }, 'darwin', '/bin/zsh', '/x/claude')).toEqual({
      file: '/x/claude',
      args: ['-n', 'md-setup', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits', 'Set up MasterDeck with me, following CLAUDE.md.'],
    })
  })
  it('isSafeBgId', () => {
    expect(isSafeBgId('ea39fd38')).toBe(true)
    expect(isSafeBgId('ea39fd38; rm -rf')).toBe(false)
  })
  it('ticket builder: one account exactly as before; a tab gets its own name and its account settings', () => {
    expect(paneCommand({ kind: 'ticket-builder', resume: true, prompt: 'hi' }, 'darwin', '/bin/zsh')).toEqual({
      file: 'claude',
      args: ['--continue', '-n', 'md-ticket-builder', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits', 'hi'],
    })
    expect(paneCommand({ kind: 'ticket-builder', resume: false, tab: 't1', account: 'bob-work' }, 'darwin', '/bin/zsh', 'claude', ['--settings', '/a/bob-work.settings.json'])).toEqual({
      file: 'claude',
      args: ['-n', 'md-ticket-builder-t1', '--settings', '/a/bob-work.settings.json', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits'],
    })
  })
  it('PR review: its tab\'s name, its account settings, project settings only; a first message', () => {
    expect(paneCommand({ kind: 'pr-review', resume: true, tab: 'prs-mine', prompt: 'Review the selected PR, acme/web#1.' }, 'darwin', '/bin/zsh')).toEqual({
      file: 'claude',
      args: ['--continue', '-n', 'md-pr-review-prs-mine', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits', 'Review the selected PR, acme/web#1.'],
    })
    expect(paneCommand({ kind: 'pr-review', resume: false, tab: 't1', account: 'bob-work', prompt: '--dangerously-skip-permissions' }, 'darwin', '/bin/zsh', 'claude', ['--settings', '/a/bob-work.settings.json'])).toEqual({
      file: 'claude',
      args: ['-n', 'md-pr-review-t1', '--settings', '/a/bob-work.settings.json', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits'],
    })
  })
  it("runs gh's own browser login", () => {
    expect(paneCommand({ kind: 'gh-login' }, 'darwin', '/bin/zsh')).toEqual({ file: 'gh', args: ['auth', 'login', '--hostname', 'github.com', '--web'] })
    expect(paneCommand({ kind: 'gh-login' }, 'win32', undefined).file).toBe('gh.exe')
  })
  it('opens plain claude in a folder, for the user to answer its trust prompt', () => {
    expect(paneCommand({ kind: 'claude-here', cwd: 'code/api' }, 'darwin', '/bin/zsh', '/opt/bin/claude')).toEqual({ file: '/opt/bin/claude', args: [], cwd: 'code/api' })
    expect(paneCommand({ kind: 'claude-here', cwd: 'code\\api' }, 'win32', undefined, 'claude.exe')).toEqual({ file: 'claude.exe', args: [], cwd: 'code\\api' })
  })
})

import { describe, expect, it } from 'vitest'
import { baseError, branchError, isPermissionMode, NO_PREFS, parsePrefs, prefsKey, ticketBranch, worktreeDir, worktreeNote } from './startOptions'

describe('ticketBranch', () => {
  it('is the number and a slug of the title', () => {
    expect(ticketBranch(66, 'Start Session popup: new design, worktree & other options')).toBe('66-start-session-popup-new-design-worktree')
    expect(ticketBranch(7, '  Fix: CI!! ')).toBe('7-fix-ci')
  })
  it('is the number alone for a title with nothing to slug', () => {
    expect(ticketBranch(9, '日本語')).toBe('9')
  })
  it('always passes its own check', () => {
    expect(branchError(ticketBranch(1, 'a'.repeat(200)))).toBeNull()
  })
})

describe('branchError', () => {
  it('takes ordinary names', () => {
    for (const ok of ['66-start', 'feat/start-dialog', 'fix_1.2', 'origin/main']) expect(branchError(ok)).toBeNull()
  })
  it('refuses what git or a command line would not take', () => {
    for (const bad of ['', '-x', '--upload-pack=x', 'a b', 'a..b', 'a//b', 'a/', 'a.', 'a.lock', 'a/.b', 'a;b', 'a~1', 'x'.repeat(101)])
      expect(branchError(bad)).not.toBeNull()
    expect(baseError('-b')).toMatch(/^Base branch/)
  })
})

describe('worktreeDir and worktreeNote', () => {
  it('flattens the branch to one folder name', () => {
    expect(worktreeDir('feat/start/dialog')).toBe('feat-start-dialog')
  })
  it('says where the session is and that the worktree step is done', () => {
    const n = worktreeNote({ cwd: '/w/acme/app/.claude/worktrees/66-x', branch: '66-x', base: 'main' })
    expect(n).toContain('/w/acme/app/.claude/worktrees/66-x')
    expect(n).toContain('branch 66-x')
    expect(n).toContain('made from main')
    expect(n).toContain('Do not create another worktree')
  })
})

describe('remembered choices', () => {
  it('are kept per repository, whatever its case', () => {
    expect(prefsKey('Acme/App')).toBe('startPrefs:acme/app')
    expect(prefsKey(null)).toBe('startPrefs:primary')
  })
  it('read back what was stored', () => {
    const p = { worktree: true, base: 'develop', model: 'opus[1m]', permissionMode: 'plan', workflow: 'review', assignMe: true }
    expect(parsePrefs(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })
  it('drop anything that is not one of ours', () => {
    expect(parsePrefs(null)).toBeNull()
    expect(parsePrefs('x')).toBeNull()
    expect(parsePrefs({ worktree: 'yes', base: '--x', model: 'a;b', permissionMode: 'bypassPermissions', workflow: 3, assignMe: 1 })).toEqual(NO_PREFS)
  })
  it('knows the permission modes it offers', () => {
    expect(isPermissionMode('plan')).toBe(true)
    expect(isPermissionMode('')).toBe(true)
    expect(isPermissionMode('bypassPermissions')).toBe(false)
  })
})

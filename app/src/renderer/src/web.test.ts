import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionOk, screenOk, shortcutOk } from './web'

describe('web allowlist (WEB_VIEWS)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('the web shows Tasks and Terminals only; palette and shortcuts follow it', () => {
    vi.stubGlobal('window', { deck: { platform: 'web' } })
    expect(['tasks', 'terminals'].every((v) => screenOk(v as never))).toBe(true)
    expect(['board', 'prs', 'costs', 'settings', 'history', 'broadcast'].some((v) => screenOk(v as never))).toBe(false)
    expect(shortcutOk('palette') && shortcutOk('new-shell')).toBe(true)
    expect(shortcutOk('settings') || shortcutOk('view-next') || shortcutOk('worktree')).toBe(false)
    expect(actionOk('view:tasks') && actionOk('new-shell') && actionOk('start-master')).toBe(true)
    expect(actionOk('view:board') || actionOk('view:history') || actionOk('settings') || actionOk('broadcast')).toBe(false)
  })
  it('the desktop allows everything', () => {
    vi.stubGlobal('window', { deck: { platform: 'darwin' } })
    expect(screenOk('board') && shortcutOk('settings') && actionOk('skills')).toBe(true)
  })
})

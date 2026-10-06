import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionOk, screenOk, shortcutOk } from './web'

const SCREENS = ['terminals', 'board', 'prs', 'tasks', 'settings', 'costs', 'janitor', 'history', 'workflow', 'broadcast', 'standup', 'sprint-summary', 'skills', 'notes']

describe('web allowlist (WEB_VIEWS)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('the web shows every screen; only controls needing a blocked method hide', () => {
    vi.stubGlobal('window', { deck: { platform: 'web' } })
    expect(SCREENS.filter((v) => !screenOk(v as never))).toEqual([])
    expect(shortcutOk('palette') && shortcutOk('new-shell') && shortcutOk('settings') && shortcutOk('view-next')).toBe(true)
    expect(shortcutOk('worktree')).toBe(false) // openEditor opens a Mac window
    expect(['view:tasks', 'view:board', 'view:history', 'settings', 'broadcast', 'skills', 'notes', 'start-master'].every((a) => actionOk(a as never))).toBe(true)
  })
  it('the desktop allows everything', () => {
    vi.stubGlobal('window', { deck: { platform: 'darwin' } })
    expect(screenOk('board') && shortcutOk('settings') && shortcutOk('worktree') && actionOk('skills')).toBe(true)
  })
})

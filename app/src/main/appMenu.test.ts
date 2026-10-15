import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { macMenuTemplate, updateMenuLabel } from './appMenu'

describe('macMenuTemplate', () => {
  it("keeps Electron's default roles and adds the update item to the app menu", () => {
    const clicks: string[] = []
    const t = macMenuTemplate('MasterDeck', { updateLabel: 'Check for Updates…', onUpdate: () => clicks.push('update'), openUrl: (u) => clicks.push(u) })
    expect(t.slice(1, 5).map((m) => m.role)).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'windowMenu'])
    const appItems = t[0].submenu as MenuItemConstructorOptions[]
    expect(appItems.map((i) => i.role ?? i.label ?? i.type)).toEqual([
      'about',
      'separator',
      'Check for Updates…',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ])
    ;(appItems[2].click as () => void)()
    expect(clicks).toEqual(['update'])
    expect(t[5].role).toBe('help')
  })
  it('says Restart to Update… when an update is ready', () => {
    expect(updateMenuLabel('ready')).toBe('Restart to Update…')
    expect(updateMenuLabel('available')).toBe('Check for Updates…')
  })
})

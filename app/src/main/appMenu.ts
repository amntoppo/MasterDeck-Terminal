import type { MenuItemConstructorOptions } from 'electron'

// The macOS app menu. Until in-app updates MasterDeck used Electron's default menu; this is the same
// menu (the same roles, so every shortcut stays: ⌘Q, ⌘H, ⌘W, ⌘C/⌘V, ⌘R, ⌘M, zoom …) with
// Check for Updates… / Restart to Update… in the app menu and MasterDeck's own Help links.

export interface MenuActions {
  /** "Check for Updates…" or "Restart to Update…" */
  updateLabel: string
  onUpdate: () => void
  openUrl: (url: string) => void
}

export function macMenuTemplate(appName: string, a: MenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: a.updateLabel, click: () => a.onUpdate() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'MasterDeck Website', click: () => a.openUrl('https://masterdeck.dev') },
        { label: 'Report an Issue', click: () => a.openUrl('https://github.com/amntoppo/MasterDeck-Terminal/issues') },
      ],
    },
  ]
}

/** The update item's label for an update phase. */
export function updateMenuLabel(phase: string): string {
  return phase === 'ready' ? 'Restart to Update…' : 'Check for Updates…'
}

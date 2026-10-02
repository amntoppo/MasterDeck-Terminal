import type { DeckApi } from '@shared/ipc'
import type { ShortcutId } from '@shared/shortcuts'
import { DECK_ACCESS } from '@shared/remoteDeck'
import type { PaletteAction } from './components/CommandPalette'
import type { View } from './components/Sidebar'
import { deck } from './deck'

type Method = keyof DeckApi

/** Running in the web app (app.masterdeck.dev), where window.deck is the RemoteDeck. */
export const isWeb = () => deck().platform === 'web'
/** Whether a control that calls `m` may show: on the web only remote/local methods work. */
export const can = (m: Method) => !isWeb() || DECK_ACCESS[m].kind !== 'blocked'
/** The platform for keyboard modifiers: on the web, the browser's own OS. */
export const keyPlatform = () => (isWeb() ? (navigator.platform.includes('Mac') ? 'darwin' : 'web') : deck().platform)

/** Screens: the views, plus the popups that act like one. */
export type Screen = View | 'history' | 'broadcast' | 'standup' | 'sprint-summary' | 'skills'

/**
 * THE web allowlist: the screens the web app shows (stage 1). Everything below derives from it, and each screen
 * also needs its methods to be reachable (`can`).
 */
export const WEB_VIEWS: ReadonlySet<Screen> = new Set<Screen>(['tasks', 'terminals'])

/** The method a screen cannot work without, if any. */
const SCREEN_NEEDS: Partial<Record<Screen, Method>> = {
  costs: 'tokensByDay',
  janitor: 'janitor',
  workflow: 'workflowGet',
  settings: 'getSettings',
  history: 'searchHistory',
  broadcast: 'sendText',
  standup: 'standupCommits',
  'sprint-summary': 'setSprint',
  skills: 'skillReinstall',
}
export const screenOk = (s: Screen) => !isWeb() || (WEB_VIEWS.has(s) && can(SCREEN_NEEDS[s] ?? 'getState'))

type Need = { screen?: Screen; method?: Method }
const ok = (n: Need | undefined) => !n || ((!n.screen || screenOk(n.screen)) && (!n.method || can(n.method)))

const SHORTCUT_NEEDS: Partial<Record<ShortcutId, Need>> = {
  // ⇧← / ⇧→ step through Terminals · Board · PRs · Tasks.
  'view-prev': { screen: 'board' },
  'view-next': { screen: 'board' },
  history: { screen: 'history' },
  worktree: { method: 'openEditor' },
  refresh: { method: 'refresh' },
  settings: { screen: 'settings' },
  shortcuts: { screen: 'settings' },
}
export const shortcutOk = (id: ShortcutId) => !isWeb() || ok(SHORTCUT_NEEDS[id])

const ACTION_NEEDS: Partial<Record<PaletteAction, Need>> = {
  refresh: { method: 'refresh' },
  'view:history': { screen: 'history' },
  broadcast: { screen: 'broadcast' },
  standup: { screen: 'standup' },
  'sprint-summary': { screen: 'sprint-summary' },
  settings: { screen: 'settings' },
  skills: { screen: 'skills' },
}
export const actionOk = (a: PaletteAction) =>
  !isWeb() || (a.startsWith('view:') && a !== 'view:history' ? screenOk(a.slice(5) as View) : ok(ACTION_NEEDS[a]))

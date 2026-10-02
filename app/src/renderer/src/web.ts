import { DECK_ACCESS } from '@shared/remoteDeck'
import { deck } from './deck'

/** Running in the web app (app.masterdeck.dev), where window.deck is the RemoteDeck. */
export const isWeb = () => deck().platform === 'web'
/** Whether a control that calls `m` may show: on the web only remote/local methods work. */
export const can = (m: keyof typeof DECK_ACCESS) => !isWeb() || DECK_ACCESS[m].kind !== 'blocked'
/** The platform for keyboard modifiers: on the web, the browser's own OS. */
export const keyPlatform = () => (isWeb() ? (navigator.platform.includes('Mac') ? 'darwin' : 'web') : deck().platform)

/**
 * Checks on what a remote client (phone/API, less trusted than the desktop) may get typed into a
 * session. Pure, so the main process wires them in and the tests exercise them directly.
 */
import { noEscape } from './remote'

/** An option's key ("B", "2"): never anything that could start a slash command or shell escape. */
export const OPTION_KEY = /^[A-Za-z0-9]{1,3}$/

/** `KEY: text` as a session's numbered/lettered question expects, or null for a key we refuse. */
export function optionMessage(key: unknown, text: string): string | null {
  return typeof key === 'string' && OPTION_KEY.test(key) ? `${key}: ${text}` : null
}

/** The wire contract's noEscape rule: no leading / or ! (after whitespace), no control characters. */
export function remoteTextAllowed(text: string): boolean {
  return noEscape.safeParse(text).success
}

/** Relay a send through master-agent? Never for remote callers: their text goes straight or not at all. */
export function sendMasterUp(remote: boolean, masterKind: string | undefined): boolean {
  return !remote && (masterKind === 'attached' || masterKind === 'elsewhere')
}

/** An external item's answer: free text only if the asker allowed it, else one of its options. */
export function externalAnswerAllowed(item: { options?: string[]; allowText: boolean }, answer: string): boolean {
  return item.allowText || (item.options ?? []).some((o) => o.trim() === answer.trim())
}

export const TOKEN_MSG = 'a token is 32-512 printable ASCII characters'

/** Null when the desktop token is acceptable, else why not. */
export function tokenProblem(token: string): string | null {
  return /^[\x21-\x7e]{32,512}$/.test(token) ? null : TOKEN_MSG
}

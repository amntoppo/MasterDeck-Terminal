export type Provider = 'google' | 'github' | 'apple' | 'email'
export const PROVIDERS: { id: Exclude<Provider, 'email'>; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
  { id: 'apple', label: 'Apple' },
]
export const DEFAULT_REMOTE_URL = 'https://dev.masterdeck.dev'

/** The backend address: the default, or a development override (https, or http on localhost). */
export function remoteUrl(env: Record<string, string | undefined>): string {
  return validBackendUrl(env.MASTERDECK_REMOTE_URL) ?? DEFAULT_REMOTE_URL
}

/** A backend address MasterDeck may talk to (https, or http on localhost), trailing slashes cut; else null. */
export function validBackendUrl(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().replace(/\/+$/, '')
  return /^https:\/\/[^\s/@?#]+$/.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v) ? v : null
}

export type Identity = { email: string; provider: Provider; deviceId: string }

/** The saved identity (account.json), or null when it is not the expected shape. */
export function parseIdentity(text: string): Identity | null {
  try {
    const v = JSON.parse(text)
    const ok = v && typeof v.email === 'string' && typeof v.deviceId === 'string' && ['google', 'github', 'apple', 'email'].includes(v.provider)
    return ok ? { email: v.email, provider: v.provider, deviceId: v.deviceId } : null
  } catch {
    return null
  }
}

export type AccountState =
  | { kind: 'signedOut'; message: string | null }
  | { kind: 'pending'; provider: Provider; mode: 'browser'; expiresAt: number }
  | { kind: 'pending'; provider: Provider; mode: 'code'; userCode: string; verifyUrl: string; expiresAt: number }
  | { kind: 'signedIn'; email: string; provider: Provider; deviceId: string }

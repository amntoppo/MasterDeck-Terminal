import { useEffect, useSyncExternalStore } from 'react'
import { DARK, isThemePref, resolveTheme, themeVars, type Theme, type ThemePref } from '@shared/themes'
import { load, save } from './deck'

/**
 * The theme on screen. The Mac's window follows Settings → Appearance (`settings.theme`, saved by main);
 * the web app keeps its own choice per browser, here in localStorage, so a phone and the Mac can differ.
 * In the window the same key mirrors the setting, for the first paint before the state arrives.
 */
const PREF_KEY = 'md.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

let current: Theme = DARK
const listeners = new Set<() => void>()

const osDark = () => typeof matchMedia !== 'function' || matchMedia(DARK_QUERY).matches

/** Write a theme's tokens on <html>, and tell the terminals. */
export function applyTheme(t: Theme): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(themeVars(t))) root.style.setProperty(k, v)
  root.style.colorScheme = t.scheme
  root.dataset.theme = t.id
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.tokens.bg)
  if (t === current) return
  current = t
  for (const l of listeners) l()
}

export const currentTheme = (): Theme => current

/** Called with every theme change; returns the unsubscribe. */
export function onTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The theme on screen, re-rendering on a change. */
export const useCurrentTheme = (): Theme => useSyncExternalStore(onTheme, currentTheme)

export const savedPref = (): ThemePref => {
  const v = load<unknown>(PREF_KEY, 'dark')
  return isThemePref(v) ? v : 'dark'
}

/** Before React renders: the last choice, so the first frame is already in the right colours. */
export function bootTheme(): void {
  applyTheme(resolveTheme(savedPref(), osDark()))
}

// The web app's choice: a store of its own, since it never reaches the Mac's settings.
const webListeners = new Set<() => void>()
export function setWebThemePref(p: ThemePref): void {
  save(PREF_KEY, p)
  for (const l of webListeners) l()
}
export const useWebThemePref = (): ThemePref =>
  useSyncExternalStore((cb) => {
    webListeners.add(cb)
    return () => webListeners.delete(cb)
  }, savedPref)

/**
 * Keep the screen on `pref`: applied at once, and on System again whenever the OS switches (in Electron the media
 * query follows nativeTheme.themeSource, which main sets from the same setting).
 */
export function useTheme(pref: ThemePref): void {
  useEffect(() => {
    save(PREF_KEY, pref)
    const apply = () => applyTheme(resolveTheme(pref, osDark()))
    apply()
    if (pref !== 'system' || typeof matchMedia !== 'function') return
    const mq = matchMedia(DARK_QUERY)
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref])
}

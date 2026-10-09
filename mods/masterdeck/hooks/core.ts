import type { SeenMod } from '../types'

/**
 * MasterDeck's own mods. They read their switch from the band themselves and go quiet at once, so
 * the core never refuses them (a refused mod comes back only at a reload, a running one never).
 */
export const FAMILY: readonly string[] = ['masterdeck', 'masterdeck-ticket', 'masterdeck-alerts', 'masterdeck-note']

/**
 * Whether to refuse a mod as it loads: one the person installed (tier `user`; never a managed or
 * built-in one, never MasterDeck's own) that is switched off for this session.
 */
export function refuses(mod: { name: string; tier: string }, offMods: readonly string[]): boolean {
  return mod.tier === 'user' && !FAMILY.includes(mod.name) && offMods.includes(mod.name)
}

/** The list of mods seen, with this one put in place of an older entry of the same name. */
export function seenWith(list: readonly SeenMod[], mod: SeenMod): SeenMod[] {
  return [...list.filter(m => m.name !== mod.name), mod].slice(-50)
}

/**
 * Mods refused here that are switched on again: they join only at a reload, so the core asks for
 * one. `asked` holds the names it already asked for (cleared when one is switched off again).
 */
export function toReload(seen: readonly SeenMod[], offMods: readonly string[], asked: ReadonlySet<string>): string[] {
  return seen.filter(m => !m.loaded && m.tier === 'user' && !offMods.includes(m.name) && !asked.has(m.name)).map(m => m.name)
}

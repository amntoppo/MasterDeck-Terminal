/**
 * What MasterDeck writes for a session: `deck/band/<sessionId>.json`.
 * The app's copy is `app/src/shared/modBand.ts` (`ModBand`); keep the two in step and bump `v`.
 */
export type Band = {
  v: 1
  name: string
  ticket: { label: string; ref: string; title: string | null; url: string } | null
  status: string | null
  pr: {
    number: number
    url: string
    state: string | null
    ci: 'success' | 'failure' | 'pending' | null
    threads: number
    draft: boolean
  } | null
  peers: { name: string; state: string }[]
  /**
   * Mods switched off for this session in MasterDeck's Session details, by plugin name.
   * `masterdeck` (this mod): it stays quiet. Any other: it is refused when it loads.
   */
  offMods?: string[]
}

/** Whether MasterDeck runs (its `deck/alive` is fresh) and, when not, when it last did (0 while it runs). */
export type Link = { isOffline: boolean; lastAliveAt: number }

/** A mod this one saw join (or refused) in this session, from `plugin.register`. */
export type SeenMod = {
  name: string
  /** `<name>@<marketplace>`, `<name>@inline` (`--plugin-dir`), `<name>@builtin`. */
  provenance: string
  version: string | null
  tier: string
  /** False: refused here (switched off in MasterDeck). */
  loaded: boolean
}

declare module 'claude-code' {
  interface PluginState {
    masterdeck: { band: Band | null; link: Link; isHidden: boolean; seen: SeenMod[] }
  }
}

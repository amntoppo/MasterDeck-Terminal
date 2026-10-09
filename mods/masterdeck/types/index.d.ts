/** A mod the core saw join (or refused) in this session, from `plugin.register`. */
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
    masterdeck: { seen: SeenMod[] }
  }
}

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
  /** Switched off in MasterDeck's Session details: draw nothing, toast nothing, commands say so. */
  off?: true
}

/** Whether MasterDeck runs (its `deck/alive` is fresh) and, when not, when it last did (0 while it runs). */
export type Link = { isOffline: boolean; lastAliveAt: number }

declare module 'claude-code' {
  interface PluginState {
    masterdeck: { band: Band | null; link: Link; isHidden: boolean }
  }
}

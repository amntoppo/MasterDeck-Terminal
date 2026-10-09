// SHARED: the one source of hooks/deck.ts in every MasterDeck mod. Edit it here, then run
// mods/sync-shared.sh; app/src/shared/modsShared.test.ts fails while a copy differs.
/**
 * What MasterDeck writes for a session: `<MASTERDECK_HOME>/deck/band/<sessionId>.json`.
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
  /** The board this session's account sees: `deck/boards/<boardKey>.json` (masterdeck-board). */
  boardKey?: string
  /** Mods switched off for this session in Session details → Mods, by plugin name. */
  offMods?: string[]
}

/** `deck/alive` older than this: MasterDeck is not running (the app touches it every 5 s). */
export const ALIVE_MS = 30_000

/** The band file's text, when it is one this version reads. */
export function parseBand(text: string): Band | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const b = o as Partial<Band>
  if (b.v !== 1 || typeof b.name !== 'string' || !Array.isArray(b.peers)) return null
  return b as Band
}

/** Switched off for this session: the mod does nothing at all (draws, toasts and answers nothing). */
export function isOff(band: Band | null, mod: string): boolean {
  return !!band?.offMods?.includes(mod)
}

export function ago(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  return `${Math.round(ms / 3_600_000)} h ago`
}

/** MasterDeck's deck folder from the environment: `$MASTERDECK_HOME/deck`, else `~/.claude/masterdeck/deck`. */
export function deckFolder(masterdeckHome: string | undefined, home: string | undefined): string {
  return `${masterdeckHome || `${home ?? ''}/.claude/masterdeck`}/deck`
}

/** What MasterDeck says about this session now. */
export type DeckRead = {
  band: Band | null
  /** MasterDeck is closed (or not installed): its `alive` is missing or older than ALIVE_MS. */
  isOffline: boolean
  /** When MasterDeck last ran, while it is closed (0 while it runs). */
  lastAliveAt: number
}

/**
 * From what a mod read: `deck/alive`'s mtime (null: none) and the session's band file (null: none).
 * The reading itself stays in each mod's register file: the engine follows `$` into functions of
 * that file only, never across an import.
 */
export function deckRead(aliveAt: number | null, now: number, bandText: string | null): DeckRead {
  const isOffline = aliveAt === null || now - aliveAt > ALIVE_MS
  return {
    band: aliveAt !== null && bandText !== null ? parseBand(bandText) : null,
    isOffline,
    lastAliveAt: isOffline ? aliveAt ?? 0 : 0,
  }
}

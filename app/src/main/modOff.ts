import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MASTERDECK_MODS, MOD_CORE, type ModEntry } from '@shared/modBand'

const KEY = /^[0-9a-f-]{8,36}$/i
const NAME = /^[A-Za-z0-9._-]{1,64}$/

function writeJson(file: string, value: unknown): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(value))
    renameSync(`${file}.tmp`, file)
    return true
  } catch (e) {
    console.error(`mods: could not write ${file}: ${String(e)}`)
    return false
  }
}

/**
 * `mod-off.json`: `{ <Session.key>: [mod names] }`, the mods switched off for a session in Session
 * details → Mods. Claude Code turns a plugin on or off per settings scope only, so the MasterDeck
 * mod does it per session: it stays quiet itself, and refuses the others when they load.
 * Older files: an array of keys (the one MasterDeck mod off there), and `masterdeck` in a list
 * (the same, before it became a core and feature mods): both read as every feature mod off.
 */
export class ModOff {
  private map: Map<string, string[]> | null = null

  constructor(private file: string) {}

  private load(): Map<string, string[]> {
    if (this.map) return this.map
    this.map = new Map()
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      const features = MASTERDECK_MODS.map((m) => m.name)
      if (Array.isArray(raw)) {
        for (const k of raw) if (typeof k === 'string' && KEY.test(k)) this.map.set(k, [...features].sort())
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          const listed = Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && NAME.test(n)) : []
          const names = listed.flatMap((n) => (n === MOD_CORE ? features : [n]))
          if (KEY.test(k) && names.length) this.map.set(k, [...new Set(names)].sort())
        }
      }
    } catch {
      // none yet, or unreadable: nothing is off
    }
    return this.map
  }

  /** The mods switched off for a session. */
  of(key: string): string[] {
    return this.load().get(key) ?? []
  }

  all(): Record<string, string[]> {
    return Object.fromEntries(this.load())
  }

  /** Switch a mod on (true) or off (false) for a session. */
  set(key: string, mod: string, on: boolean): boolean {
    // The core does the switching: it is never switched off.
    if (!KEY.test(key) || !NAME.test(mod) || mod === MOD_CORE) return false
    const map = this.load()
    const names = new Set(map.get(key) ?? [])
    if (on === !names.has(mod)) return true
    if (on) names.delete(mod)
    else names.add(mod)
    if (names.size) map.set(key, [...names].sort())
    else map.delete(key)
    return this.save()
  }

  /** Forget sessions that are no longer listed (call only with a real session list). */
  prune(listed: Set<string>): void {
    const map = this.load()
    const gone = [...map.keys()].filter((k) => !listed.has(k))
    if (!gone.length) return
    for (const k of gone) map.delete(k)
    this.save()
  }

  private save(): boolean {
    if (writeJson(this.file, this.all())) return true
    this.map = null
    return false
  }
}

/** `mod-catalog.json`: every mod MasterDeck's mod has reported in any session (shared/modBand.ts `mergeCatalog`). */
export class ModCatalog {
  private list: ModEntry[] | null = null

  constructor(private file: string) {}

  entries(): ModEntry[] {
    if (this.list) return this.list
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      this.list = Array.isArray(raw)
        ? raw.filter((e): e is ModEntry => !!e && typeof e === 'object' && typeof e.name === 'string' && NAME.test(e.name) && typeof e.provenance === 'string' && typeof e.tier === 'string')
        : []
    } catch {
      this.list = []
    }
    return this.list
  }

  /** Keep a new catalog (from mergeCatalog). */
  replace(next: ModEntry[]): void {
    this.list = next
    writeJson(this.file, next)
  }
}

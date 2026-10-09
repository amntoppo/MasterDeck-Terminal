import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const KEY = /^[0-9a-f-]{8,36}$/i

/**
 * `mod-off.json`: the sessions (Session.key) where the user switched the MasterDeck mod off in
 * Session details. Claude Code turns a plugin on or off for a whole settings scope only, so "off"
 * here means the mod stays quiet in that session (`off` in its band file).
 */
export class ModOff {
  private keys: Set<string> | null = null

  constructor(private file: string) {}

  private load(): Set<string> {
    if (this.keys) return this.keys
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      this.keys = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && KEY.test(x)) : [])
    } catch {
      this.keys = new Set()
    }
    return this.keys
  }

  has(key: string): boolean {
    return this.load().has(key)
  }

  list(): string[] {
    return [...this.load()].sort()
  }

  /** Switch the mod on (true) or off (false) for a session. */
  set(key: string, on: boolean): boolean {
    if (!KEY.test(key)) return false
    const keys = this.load()
    if (on === !keys.has(key)) return true
    if (on) keys.delete(key)
    else keys.add(key)
    return this.save()
  }

  /** Forget sessions that are no longer listed (call only with a real session list). */
  prune(listed: Set<string>): void {
    const keys = this.load()
    const gone = [...keys].filter((k) => !listed.has(k))
    if (!gone.length) return
    for (const k of gone) keys.delete(k)
    this.save()
  }

  private save(): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.list()))
      renameSync(`${this.file}.tmp`, this.file)
      return true
    } catch (e) {
      console.error(`mod off: ${String(e)}`)
      this.keys = null
      return false
    }
  }
}

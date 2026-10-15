import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HeldMessage, HeldReason } from '@shared/heldMessages'

/**
 * MasterDeck messages waiting for a session's prompt box to be empty (#123), in the order they
 * came, kept in `<home>/held-messages.json` so a restart loses none. Written atomically.
 */
export class HeldStore {
  private items: HeldMessage[] = []
  private n = 0

  constructor(
    private file: string,
    private onChange: () => void = () => {},
  ) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(v)) this.items = v.filter(isHeld)
    } catch {
      // none yet
    }
  }

  list(): HeldMessage[] {
    return [...this.items]
  }

  forKey(key: string): HeldMessage[] {
    return this.items.filter((m) => m.key === key)
  }

  get(id: string): HeldMessage | undefined {
    return this.items.find((m) => m.id === id)
  }

  add(key: string, text: string, from: string, reason: HeldReason, now = Date.now()): HeldMessage {
    const m: HeldMessage = { id: `${now}-${(this.n++).toString(36)}`, key, text, from, at: now, reason }
    this.items.push(m)
    this.save()
    return m
  }

  setReason(id: string, reason: HeldReason): void {
    const m = this.get(id)
    if (!m || m.reason === reason) return
    m.reason = reason
    this.save()
  }

  remove(id: string): HeldMessage | undefined {
    const m = this.get(id)
    if (!m) return undefined
    this.items = this.items.filter((x) => x !== m)
    this.save()
    return m
  }

  /** Drop every message `gone` says has no session to go to any more; what was dropped. */
  drop(gone: (m: HeldMessage) => boolean): HeldMessage[] {
    const out = this.items.filter(gone)
    if (!out.length) return out
    this.items = this.items.filter((m) => !out.includes(m))
    this.save()
    return out
  }

  private save(): void {
    try {
      if (!this.items.length) rmSync(this.file, { force: true })
      else {
        mkdirSync(dirname(this.file), { recursive: true })
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items))
        renameSync(`${this.file}.tmp`, this.file)
      }
    } catch {
      // kept in memory; the next change writes it again
    }
    this.onChange()
  }
}

function isHeld(v: unknown): v is HeldMessage {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return typeof m.id === 'string' && typeof m.key === 'string' && typeof m.text === 'string' && typeof m.from === 'string' && typeof m.at === 'number' && ['draft', 'typing', 'unknown', 'sending'].includes(m.reason as string)
}

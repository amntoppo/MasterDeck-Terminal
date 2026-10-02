import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ApprovedBrowser { id: string; name: string; publicKey: string; approvedAt: number }
type Entry = ApprovedBrowser & { userId: string }

/**
 * Browsers approved on this Mac, each tagged with the account it was approved under (spec "Same account").
 * Reading for an account deletes every other account's entries.
 */
export class BrowserStore {
  private all: Entry[]
  constructor(private file: string) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as { browsers?: unknown }
      this.all = Array.isArray(v.browsers) ? (v.browsers as Entry[]) : []
    } catch {
      this.all = [] // missing or corrupt
    }
  }
  list(userId: string): ApprovedBrowser[] {
    if (this.all.some((e) => e.userId !== userId)) {
      this.all = this.all.filter((e) => e.userId === userId)
      this.save()
    }
    return this.all.map(({ userId: _u, ...b }) => b)
  }
  get(userId: string, id: string): ApprovedBrowser | null {
    return this.list(userId).find((b) => b.id === id) ?? null
  }
  add(userId: string, b: ApprovedBrowser): void {
    this.all = [...this.all.filter((e) => e.id !== b.id), { ...b, userId }]
    this.save()
  }
  remove(id: string): void {
    this.all = this.all.filter((e) => e.id !== id)
    this.save()
  }
  wipe(): void {
    this.all = []
    this.save()
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ browsers: this.all }), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
}

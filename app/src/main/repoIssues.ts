import type { AppConfig } from '@shared/appConfig'
import { applyRead, cleanRepos, dumpEntries, liveRepos, loadEntries, needRead, parseRepoIssues, pruneEntries, repoKey, viewOf, withAssignee, type RepoEntries } from '@shared/repoView'
import type { Ticket } from '@shared/ticket'
import type { RepoView } from '@shared/types'

type ReadResult = { ok: true; data: unknown } | { ok: false; message: string }

export interface RepoIssuesDeps {
  /** `master repo-issues --repos …`; `force` skips what the shared gh cache holds. */
  read: (repos: string[], force: boolean) => Promise<ReadResult>
  config: () => AppConfig
  /** Are GitHub reads paused (a rate limit)? With `output`, a failed read's text: a rate limit in it starts the pause. */
  paused: (output?: string) => boolean
  /** The view changed; `read`: a read just ended (the cache is worth saving). */
  changed: (read: boolean) => void
  now?: () => number
}

/**
 * The issues behind the Board's repository view, per repository. Nothing is read until a tab
 * asks (`ask`); what was read stays (and is cached) until the repository is unticked in Setup.
 * A repository is read again by an ask once it is an hour old, and by every GitHub refresh while
 * a tab showing it asked within the last hour. One read at a time.
 */
export class RepoIssues {
  private entries: RepoEntries = {}
  private asked: Record<string, { repo: string; at: number }> = {}
  private loading = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()
  private out: RepoView | undefined
  private stale = true

  constructor(private deps: RepoIssuesDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private set(entries: RepoEntries): void {
    if (entries !== this.entries) this.stale = true
    this.entries = entries
  }

  /** A Board tab shows these repositories (from the renderer or the web: untrusted input). */
  ask(raw: unknown): void {
    const repos = cleanRepos(raw, this.deps.config())
    const now = this.now()
    for (const r of repos) this.asked[repoKey(r)] = { repo: r, at: now }
    const need = needRead(this.entries, repos, now).filter((r) => !this.loading.has(repoKey(r)))
    if (!need.length) return
    if (this.deps.paused()) {
      // Nothing to show for a repository never read: say why. Tried at 0, so the next ask after the pause reads it.
      const fresh = need.filter((r) => !this.entries[repoKey(r)])
      if (!fresh.length) return
      this.set(applyRead(this.entries, fresh, null, 'GitHub calls are paused', 0))
      this.deps.changed(false)
      return
    }
    void this.read(need, false)
  }

  /** The hourly refresh and the Refresh button: the repositories a tab asked for within the last hour. None: no call. */
  refresh(force = false): Promise<{ ok: boolean; message: string }> {
    const repos = cleanRepos(liveRepos(this.asked, this.now()), this.deps.config())
    if (!repos.length) return Promise.resolve({ ok: true, message: 'no repository view open' })
    if (this.deps.paused()) return Promise.resolve({ ok: false, message: 'GitHub calls paused' })
    return this.read(repos, force)
  }

  private read(repos: string[], force: boolean): Promise<{ ok: boolean; message: string }> {
    for (const r of repos) this.loading.set(repoKey(r), r)
    this.stale = true
    this.deps.changed(false)
    const run = async () => {
      let r: ReadResult
      try {
        r = await this.deps.read(repos, force)
      } catch (e) {
        r = { ok: false, message: String(e) }
      }
      const got = r.ok ? parseRepoIssues(r.data) : null
      const error = r.ok ? (got ? null : 'repo-issues printed an unexpected shape') : r.message
      for (const repo of repos) this.loading.delete(repoKey(repo))
      this.stale = true
      this.set(applyRead(this.entries, repos, got, error, this.now()))
      // A rate limit, in the whole read or in one repository's note, pauses GitHub reads as any other does.
      for (const text of [error, ...(got?.parts.filter((p) => !p.ok).map((p) => p.note) ?? [])]) if (text) this.deps.paused(text)
      this.deps.changed(true)
      return { ok: !error, message: error ?? 'refreshed' }
    }
    const p = this.chain.then(run, run)
    this.chain = p
    return p
  }

  /** For the state: the same object until something changes. Undefined while nothing was ever asked for. */
  view(): RepoView | undefined {
    if (this.stale) {
      this.out = viewOf(this.entries, this.loading)
      this.stale = false
    }
    return this.out
  }

  /** After an assign from a card: it says so at once. */
  noteAssigned(t: Ticket, login: string): void {
    this.set(withAssignee(this.entries, t, login))
  }

  /** The config changed: repositories no longer selected (or of an account that lost its board) are forgotten. */
  prune(): void {
    const c = this.deps.config()
    this.set(pruneEntries(this.entries, c))
    for (const k of Object.keys(this.asked)) if (!cleanRepos([this.asked[k].repo], c).length) delete this.asked[k]
  }

  /** From cache.json at launch. */
  load(raw: unknown): void {
    this.set(pruneEntries(loadEntries(raw), this.deps.config()))
  }

  /** For cache.json. */
  dump(): Record<string, unknown> | undefined {
    return dumpEntries(this.entries)
  }
}

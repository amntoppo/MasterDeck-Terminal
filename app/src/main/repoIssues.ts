import type { AppConfig } from '@shared/appConfig'
import { applyRead, cleanRepos, dumpEntries, liveRepos, loadEntries, needRead, parseRepoIssues, pruneEntries, repoKey, trimEntries, viewOf, withAssignee, REPO_VIEW_LIVE_MS, REPO_VIEW_MAX_ENTRIES, type RepoEntries } from '@shared/repoView'
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

type Outcome = { ok: boolean; message: string }

/**
 * The issues behind the Board's repository view, per repository. Nothing is read until a tab
 * asks (`ask`); what was read stays (and is cached) until the repository is unticked in Setup.
 * A repository is read again by an ask once it is an hour old, and by every GitHub refresh while
 * a tab showing it asked within the last hour. One read at a time.
 */
export class RepoIssues {
  private entries: RepoEntries = {}
  private asked: Record<string, { repo: string; at: number }> = {}
  /** Key → repository of the reads that run or wait; one read at most per repository (a second ask joins it). */
  private loading = new Map<string, string>()
  private inflight = new Map<string, Promise<Outcome>>()
  private chain: Promise<unknown> = Promise.resolve()
  private out: RepoView | undefined
  private sig = ''
  private stale = true

  constructor(private deps: RepoIssuesDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private set(entries: RepoEntries): void {
    if (entries !== this.entries) this.stale = true
    this.entries = entries
  }

  /** Without repositories no longer selected; but a config that is not (yet) readable prunes nothing: a half-written file must not wipe the cache. */
  private pruned(entries: RepoEntries): RepoEntries {
    const c = this.deps.config()
    return c.configured ? pruneEntries(entries, c) : entries
  }

  /** The keys on screen somewhere: asked for within REPO_VIEW_LIVE_MS. */
  private live(): Set<string> {
    const now = this.now()
    return new Set(Object.entries(this.asked).filter(([, a]) => now - a.at < REPO_VIEW_LIVE_MS).map(([k]) => k))
  }

  /** At most REPO_VIEW_MAX_ENTRIES repositories (entries and asks both): the one asked for longest ago goes, never one being read. */
  private cap(): void {
    const keep = new Set(this.loading.keys())
    this.set(trimEntries(this.entries, this.asked, keep))
    const keys = Object.keys(this.asked)
    if (keys.length > REPO_VIEW_MAX_ENTRIES) {
      keys
        .filter((k) => !keep.has(k))
        .sort((a, b) => this.asked[a].at - this.asked[b].at)
        .slice(0, keys.length - REPO_VIEW_MAX_ENTRIES)
        .forEach((k) => delete this.asked[k])
    }
  }

  /** A Board tab shows these repositories (from the renderer or the web: untrusted input). */
  ask(raw: unknown): void {
    const repos = cleanRepos(raw, this.deps.config())
    const now = this.now()
    for (const r of repos) this.asked[repoKey(r)] = { repo: r, at: now }
    this.cap()
    // Cut by the cap just now: not asked for any more.
    const need = needRead(this.entries, repos, now).filter((r) => !this.inflight.has(repoKey(r)) && this.asked[repoKey(r)])
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
  refresh(force = false): Promise<Outcome> {
    const repos = cleanRepos(liveRepos(this.asked, this.now()), this.deps.config())
    if (!repos.length) return Promise.resolve({ ok: true, message: 'no repository view open' })
    if (this.deps.paused()) return Promise.resolve({ ok: false, message: 'GitHub calls paused' })
    return this.read(repos, force)
  }

  /** Reads these repositories; one that is already being read (or waits for it) is joined, not read twice. */
  private read(repos: string[], force: boolean): Promise<Outcome> {
    const joined: Promise<Outcome>[] = []
    const fresh: string[] = []
    for (const r of repos) {
      const running = this.inflight.get(repoKey(r))
      if (!running) fresh.push(r)
      else if (!joined.includes(running)) joined.push(running)
    }
    const all = [...joined]
    if (fresh.length) {
      for (const r of fresh) this.loading.set(repoKey(r), r)
      this.stale = true
      this.deps.changed(false)
      const run = async (): Promise<Outcome> => {
        let r: ReadResult
        try {
          r = await this.deps.read(fresh, force)
        } catch (e) {
          r = { ok: false, message: String(e) }
        }
        const got = r.ok ? parseRepoIssues(r.data) : null
        const error = r.ok ? (got ? null : 'repo-issues printed an unexpected shape') : r.message
        for (const repo of fresh) {
          this.loading.delete(repoKey(repo))
          this.inflight.delete(repoKey(repo))
        }
        this.stale = true
        // A repository unticked while it was read does not come back.
        this.set(this.pruned(applyRead(this.entries, fresh, got, error, this.now())))
        this.cap()
        // A rate limit, in the whole read or in one repository's note, pauses GitHub reads as any other does.
        for (const text of [error, ...(got?.parts.filter((p) => !p.ok).map((p) => p.note) ?? [])]) if (text) this.deps.paused(text)
        this.deps.changed(true)
        return { ok: !error, message: error ?? 'refreshed' }
      }
      const own = this.chain.then(run, run)
      this.chain = own
      for (const r of fresh) this.inflight.set(repoKey(r), own)
      all.push(own)
    }
    return Promise.all(all).then((rs) => ({ ok: rs.every((x) => x.ok), message: rs.find((x) => !x.ok)?.message ?? 'refreshed' }))
  }

  /**
   * For the state: the same object until something changes. Only the repositories on screen (asked
   * for within the last hour, or being read): the rest stays in the cache, out of every state push.
   * Undefined while nothing is.
   */
  view(): RepoView | undefined {
    const live = this.live()
    const sig = [...live, '|', ...this.loading.keys()].join(',')
    if (this.stale || sig !== this.sig) {
      const shown = Object.fromEntries(Object.entries(this.entries).filter(([k]) => live.has(k) || this.loading.has(k)))
      this.out = viewOf(shown, this.loading)
      this.sig = sig
      this.stale = false
    }
    return this.out
  }

  /** After an assign from a card: it says so at once. */
  noteAssigned(t: Ticket, login: string): void {
    this.set(withAssignee(this.entries, t, login))
  }

  /** The config changed: repositories no longer selected (or of an account that lost its board) are forgotten. An unconfigured config forgets nothing. */
  prune(): void {
    const c = this.deps.config()
    if (!c.configured) return
    this.set(pruneEntries(this.entries, c))
    for (const k of Object.keys(this.asked)) if (!cleanRepos([this.asked[k].repo], c).length) delete this.asked[k]
  }

  /** From cache.json at launch. */
  load(raw: unknown): void {
    this.set(this.pruned(loadEntries(raw)))
  }

  /** For cache.json. */
  dump(): Record<string, unknown> | undefined {
    return dumpEntries(this.entries)
  }
}

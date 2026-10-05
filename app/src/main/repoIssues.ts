import type { AppConfig } from '@shared/appConfig'
import { admitRepo, applyRead, cleanRepos, dumpEntries, liveRepos, loadEntries, needRead, parseRepoIssues, pauseText, pruneEntries, repoKey, trimEntries, viewOf, withAssignee, REPO_VIEW_LIVE_MS, REPO_VIEW_MAX_ENTRIES, type RepoEntries } from '@shared/repoView'
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
 * a tab showing it asked within the last hour. One read at a time. It keeps at most
 * REPO_VIEW_MAX_ENTRIES repositories and never drops one that is on screen: a new one that finds
 * no room is refused, and the view says why.
 */
export class RepoIssues {
  private entries: RepoEntries = {}
  private asked: Record<string, { repo: string; at: number }> = {}
  /** Key → repository of the reads that run or wait; one read at most per repository (a second ask joins it). */
  private loading = new Map<string, string>()
  private inflight = new Map<string, Promise<Outcome>>()
  /** Key → a repository asked for and not taken in (no room, too many first reads waiting), with why and when. The latest asked last. */
  private refused = new Map<string, { repo: string; note: string; at: number }>()
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

  /** At most REPO_VIEW_MAX_ENTRIES repositories (entries and asks both): the one asked for longest ago goes, never one on screen or being read. */
  private cap(): void {
    const keep = new Set([...this.loading.keys(), ...this.live()])
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

  /** The keys MasterDeck holds something of: read, asked for, or being read. */
  private held(): Set<string> {
    return new Set([...Object.keys(this.entries), ...Object.keys(this.asked), ...this.loading.keys()])
  }

  /** Forgets a repository that is off screen, to make room for another. */
  private drop(key: string): void {
    if (this.entries[key]) {
      const { [key]: _gone, ...rest } = this.entries
      this.set(rest)
    }
    delete this.asked[key]
  }

  /** Notes that a repository was asked for and not taken in. True when the view changes by it. */
  private refuse(key: string, repo: string, note: string, at: number): boolean {
    const was = this.refused.get(key)
    this.refused.delete(key)
    this.refused.set(key, { repo, note, at })
    // The refusals are bounded too: the one asked for longest ago goes.
    while (this.refused.size > REPO_VIEW_MAX_ENTRIES) this.refused.delete(this.refused.keys().next().value!)
    return was?.note !== note
  }

  /** A Board tab shows these repositories (from the renderer or the web: untrusted input). */
  ask(raw: unknown): void {
    const repos = cleanRepos(raw, this.deps.config())
    const now = this.now()
    const taken: string[] = []
    // First reads that wait or run, with the ones this ask adds.
    let queued = [...this.loading.keys()].filter((k) => this.entries[k]?.takenAt == null).length
    let told = false
    for (const r of repos) {
      const k = repoKey(r)
      const held = this.held()
      if (!held.has(k)) {
        const live = this.live()
        const idle = [...held].filter((x) => !live.has(x) && !this.loading.has(x)).sort((a, b) => (this.asked[a]?.at ?? -1) - (this.asked[b]?.at ?? -1))
        const got = admitRepo(r, { held: held.size, idle, queued })
        if (!got.ok) {
          told = this.refuse(k, r, got.reason, now) || told
          continue
        }
        if (got.evict) this.drop(got.evict)
        queued++
      }
      if (this.refused.delete(k)) told = true
      this.asked[k] = { repo: r, at: now }
      taken.push(r)
    }
    if (told) {
      this.stale = true
      this.deps.changed(false)
    }
    const need = needRead(this.entries, taken, now).filter((r) => !this.inflight.has(repoKey(r)))
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
        // A rate limit, in the whole read or in what gh said of one repository, pauses GitHub reads as any other
        // does. Never a repository's name: "Not found: acme/rate-limiter" names no rate limit (`pauseText`).
        for (const text of [error, ...(got?.parts.filter((p) => !p.ok).map(pauseText) ?? [])]) if (text) this.deps.paused(text)
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
   * for within the last hour, or being read), and the ones asked for and refused: the rest stays in
   * the cache, out of every state push. Undefined while nothing is.
   */
  view(): RepoView | undefined {
    const live = this.live()
    const now = this.now()
    // A refusal shows for as long as a repository does after its last ask.
    const refused = new Map([...this.refused].filter(([, r]) => now - r.at < REPO_VIEW_LIVE_MS))
    const sig = [...live, '|', ...this.loading.keys(), '|', ...refused.keys()].join(',')
    if (this.stale || sig !== this.sig) {
      const shown = Object.fromEntries(Object.entries(this.entries).filter(([k]) => live.has(k) || this.loading.has(k)))
      this.out = viewOf(shown, this.loading, { refused })
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
    for (const [k, r] of this.refused) {
      if (cleanRepos([r.repo], c).length) continue
      this.refused.delete(k)
      this.stale = true
    }
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

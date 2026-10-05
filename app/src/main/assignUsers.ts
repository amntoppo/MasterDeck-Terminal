import type { AppConfig } from '@shared/appConfig'
import { primaryRepo } from '@shared/appConfig'
import { offBoardOk, repoKey, validRepoName } from '@shared/repoView'

/** How long a repository's assignable users are kept. */
export const ASSIGN_USERS_TTL_MS = 3_600_000
/** Most repositories remembered; past that, the one read longest ago goes. */
export const ASSIGN_USERS_MAX = 50

export type AssignUsersResult = { ok: true; users: string[] } | { ok: false; message: string }

export interface AssignUsersDeps {
  /** GitHub's assignable users of `repo` (owner/name), read as that repository's account; null when the read failed. */
  read: (repo: string) => Promise<string[] | null>
  config: () => AppConfig
  /** The repositories (owner/name) of the cards on the board main has loaded, as GitHub's board names them. */
  boardRepos?: () => string[]
  now?: () => number
}

/**
 * Who can be assigned an issue of a repository: what the Assign popup offers. Read when a popup
 * opens, as the account the repository belongs to, kept an hour per repository; two popups asking
 * at once share one read. Only a repository the config selects, or one a card of the loaded board
 * is in, is read (the web may ask too), and a failed read is not kept.
 */
export class AssignableUsers {
  private kept = new Map<string, { users: string[]; at: number }>()
  private inflight = new Map<string, Promise<AssignUsersResult>>()

  constructor(private deps: AssignUsersDeps) {}

  /** `raw`: the card's repository (untrusted); none means the primary issue repo. */
  get(raw: unknown): Promise<AssignUsersResult> {
    const c = this.deps.config()
    const asked = raw === null || raw === undefined || raw === '' ? primaryRepo(c) : raw
    if (typeof asked !== 'string' || !asked) return Promise.resolve({ ok: false, message: 'No repository to read.' })
    // Selected in Setup; or a card of the loaded board is in it (a board can hold issues of a repository
    // Setup does not tick): the name is then the board's, from GitHub, not the client's.
    const onBoard = (this.deps.boardRepos?.() ?? []).find((r) => validRepoName(r) && repoKey(r) === repoKey(asked))
    if (!offBoardOk(asked, c) && !onBoard) return Promise.resolve({ ok: false, message: `${asked.slice(0, 140)} is not selected in Setup.` })
    const repo = c.repos.find((r) => repoKey(r) === repoKey(asked)) ?? onBoard ?? asked
    const key = repoKey(repo)
    const now = (this.deps.now ?? Date.now)()
    const had = this.kept.get(key)
    if (had && now - had.at < ASSIGN_USERS_TTL_MS && now >= had.at) return Promise.resolve({ ok: true, users: had.users })
    const running = this.inflight.get(key)
    if (running) return running
    const run = (async (): Promise<AssignUsersResult> => {
      let users: string[] | null = null
      try {
        users = await this.deps.read(repo)
      } catch {
        users = null
      }
      this.inflight.delete(key)
      if (!users) return { ok: false, message: `Could not read who can be assigned in ${repo}.` }
      this.kept.delete(key)
      this.kept.set(key, { users, at: (this.deps.now ?? Date.now)() })
      while (this.kept.size > ASSIGN_USERS_MAX) this.kept.delete(this.kept.keys().next().value!)
      return { ok: true, users }
    })()
    this.inflight.set(key, run)
    return run
  }
}

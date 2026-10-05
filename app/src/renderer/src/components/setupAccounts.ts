import { projectKey, type AccountConfig, type ProjectConfig } from '@shared/appConfig'
import type { DetectAll } from '@shared/detect'

/** One account's choices on Setup's Repos & boards step. */
export interface AccountSel {
  repos: string[]
  allRepos: boolean
  /** Its main repository (the primary account's: where a plain #12 points). */
  primary: string
  boards: Record<string, ProjectConfig>
  allBoards: boolean
}

/** A connected account with the identity its sessions commit as. */
export interface Connected {
  login: string
  name: string
  email: string
}

const EMPTY: AccountSel = { repos: [], allRepos: false, primary: '', boards: {}, allBoards: false }

/** Setup's choices as the config's `accounts`: the primary first, each with its main repo first. */
export function accountsFromSetup(
  connected: Connected[],
  primary: string,
  sel: Record<string, AccountSel>,
  ownerType: (login: string, owner: string) => 'organization' | 'user',
): AccountConfig[] {
  return [...connected]
    .sort((a, b) => Number(b.login === primary) - Number(a.login === primary))
    .map((c) => {
      const s = sel[c.login] ?? EMPTY
      const main = s.repos.includes(s.primary) ? s.primary : (s.repos[0] ?? '')
      const [owner, issueRepo] = main ? main.split('/') : ['', '']
      return {
        login: c.login,
        ...(c.login === primary ? { primary: true as const } : {}),
        name: c.name.trim() || c.login,
        email: c.email.trim(),
        owner,
        ownerType: owner ? ownerType(c.login, owner) : 'organization',
        issueRepo,
        repos: main ? [main, ...s.repos.filter((r) => r !== main)] : [],
        allRepos: s.allRepos,
        projects: Object.values(s.boards),
        allProjects: s.allBoards,
      }
    })
}

/** Another connected account that has this repo ticked already (shown disabled: "in <login>"). */
export function takenBy(repo: string, login: string, sel: Record<string, AccountSel>): string | null {
  const r = repo.toLowerCase()
  return Object.entries(sel).find(([l, s]) => l !== login && s.repos.some((x) => x.toLowerCase() === r))?.[0] ?? null
}

/** Another connected account that has this board (owner/number) ticked already. */
export function boardTakenBy(key: string, login: string, sel: Record<string, AccountSel>): string | null {
  const k = key.toLowerCase()
  return Object.entries(sel).find(([l, s]) => l !== login && Object.keys(s.boards).some((x) => x.toLowerCase() === k))?.[0] ?? null
}

/** An account from the config as Setup's choices. */
export function selFromConfig(a: AccountConfig): AccountSel {
  return {
    repos: a.repos,
    allRepos: !!a.allRepos,
    primary: a.owner && a.issueRepo ? `${a.owner}/${a.issueRepo}` : '',
    boards: Object.fromEntries(a.projects.map((p) => [projectKey(p), p])),
    allBoards: !!a.allProjects,
  }
}

/**
 * Repos & boards moving from account `from` to `to`: the screen's choices are kept under `from`,
 * `to`'s own go on screen. `from` '' (no account shown yet: a config without `accounts`, e.g. its
 * migration failed): the screen's choices (the top-level config's) become `to`'s unless it has its
 * own. `drop`: an account just disconnected, its choices go.
 */
export function switchSel(
  sel: Record<string, AccountSel>,
  from: string,
  onScreen: AccountSel,
  to: string,
  drop?: string,
): { sel: Record<string, AccountSel>; shown: AccountSel } {
  const next = { ...sel }
  if (from && from !== drop) next[from] = onScreen
  if (drop) delete next[drop]
  return { sel: next, shown: sel[to] ?? (from ? EMPTY : onScreen) }
}

/**
 * GitHub's answer with the boards MasterDeck created marked as the saved config has them
 * (`sprintless`: detection cannot tell). Every board picked from the list then carries the mark,
 * also one unticked and ticked again. Nothing to mark: the answer itself.
 */
export function markMade(d: DetectAll, saved: ProjectConfig[]): DetectAll {
  const made = new Set(saved.filter((p) => p.sprintless).map((p) => projectKey(p).toLowerCase()))
  if (!d.owners.some((o) => o.projects.some((p) => made.has(projectKey(p).toLowerCase())))) return d
  return { ...d, owners: d.owners.map((o) => ({ ...o, projects: o.projects.map((p) => (made.has(projectKey(p).toLowerCase()) ? { ...p, sprintless: true as const } : p)) })) }
}

/**
 * One account's choices once GitHub answered for it: chosen boards take GitHub's current title,
 * ids and columns (keeping what their statuses mean); "Select all" takes everything there is now;
 * a first pick starts from the repo with the most open issues and its owner's only board. Repos
 * and boards under another account in `sel` are never picked for `login`.
 */
export function withFound(s: AccountSel, d: DetectAll, login: string, sel: Record<string, AccountSel>): AccountSel {
  const taken = (repo: string) => !!takenBy(repo, login, sel)
  const every = d.owners.flatMap((o) => o.repos.map((x) => x.repo)).filter((r) => !taken(r))
  const everyBoard = d.owners.flatMap((o) => o.projects).filter((p) => !boardTakenBy(projectKey(p), login, sel))
  const fresh = (p: ProjectConfig): ProjectConfig => {
    const had = s.boards[projectKey(p)]
    // GitHub's answer never says a board is one MasterDeck made (no sprint field): the choice does.
    return had ? { ...p, statuses: had.statuses, ...(had.sprintless ? { sprintless: true as const } : {}) } : p
  }
  const out: AccountSel = {
    ...s,
    boards: Object.fromEntries(
      Object.entries(s.boards).map(([k, b]) => {
        const now = everyBoard.find((p) => projectKey(p) === k)
        return [k, now ? fresh(now) : b]
      }),
    ),
  }
  if (s.allRepos) out.repos = every
  if (s.allBoards) out.boards = Object.fromEntries(everyBoard.map((p) => [projectKey(p), fresh(p)]))
  if (!s.repos.length && !s.allRepos) {
    const top = d.owners
      .flatMap((o) => o.repos)
      .filter((x) => !taken(x.repo))
      .sort((a, b) => b.openIssues - a.openIssues)[0]
    if (top) {
      out.repos = [top.repo]
      out.primary = top.repo
      const own = everyBoard.filter((p) => p.owner === top.repo.split('/')[0])
      if (own.length === 1 && !Object.keys(s.boards).length) out.boards = { [projectKey(own[0])]: own[0] }
    }
  }
  return out
}

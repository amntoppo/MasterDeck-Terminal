import { parseCodeRepos, projectKey, type AccountConfig, type CodeRepo, type ProjectConfig } from '@shared/appConfig'
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

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/**
 * The "code lives in" rows as Setup saves them: a row with no code repository is left out, and one
 * that names itself (nothing to say) too; a code repository that is not owner/name, or a second row
 * for the same issue repository, is an error (the message says which).
 */
export function codeReposToSave(rows: CodeRepo[]): { ok: true; list: CodeRepo[] } | { ok: false; message: string } {
  const kept = rows.map((r) => ({ issues: r.issues.trim(), code: r.code.trim() })).filter((r) => r.issues && r.code)
  const bad = kept.find((r) => !REPO.test(r.code))
  if (bad) return { ok: false, message: `Code lives in: ${bad.code} is not owner/name.` }
  const twice = kept.find((r, i) => kept.findIndex((x) => x.issues.toLowerCase() === r.issues.toLowerCase()) !== i)
  if (twice) return { ok: false, message: `Code lives in: ${twice.issues} has two rows; keep one.` }
  return { ok: true, list: parseCodeRepos(kept) }
}

/** The other accounts' own workspaces as Setup shows them (the primary's is the config's `workspace`). */
export function workspacesFromConfig(accounts: AccountConfig[]): Record<string, string> {
  return Object.fromEntries(accounts.filter((a) => !a.primary && a.workspace).map((a) => [a.login, a.workspace as string]))
}

/**
 * Another account becomes the primary. The Workspace field is always the primary's, so the two
 * swap: the new primary's own workspace goes into the field (it keeps the field's when it had
 * none), and the old primary keeps the folder it used as its own. `from` null: the old primary
 * was disconnected, nothing of it is kept.
 */
export function swapPrimaryWorkspace(
  workspace: string,
  workspaces: Record<string, string>,
  from: string | null,
  to: string,
): { workspace: string; workspaces: Record<string, string> } {
  if (from === to) return { workspace, workspaces }
  const own = workspaces[to]?.trim() ?? ''
  const next = Object.fromEntries(Object.entries(workspaces).filter(([l, w]) => l !== to && l !== from && w.trim()))
  const top = own || workspace
  if (from && workspace.trim() && workspace.trim() !== top) next[from] = workspace.trim()
  return { workspace: top, workspaces: next }
}

/**
 * Setup's choices as the config's `accounts`: the primary first, each with its main repo first.
 * `workspaces`: each other account's own workspace (blank: the config's); the primary never
 * carries one, the config's `workspace` is its.
 */
export function accountsFromSetup(
  connected: Connected[],
  primary: string,
  sel: Record<string, AccountSel>,
  ownerType: (login: string, owner: string) => 'organization' | 'user',
  workspaces: Record<string, string> = {},
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
        ...(c.login !== primary && workspaces[c.login]?.trim() ? { workspace: workspaces[c.login].trim() } : {}),
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
 * also one unticked and ticked again. A board GitHub now reports a sprint field on is not marked.
 * Nothing to mark: the answer itself.
 */
export function markMade(d: DetectAll, saved: ProjectConfig[]): DetectAll {
  const made = new Set(saved.filter((p) => p.sprintless).map((p) => projectKey(p).toLowerCase()))
  // Only while GitHub reports no sprint field on it: one added since gives the board its sprints back.
  const still = (p: ProjectConfig) => !p.sprintField && made.has(projectKey(p).toLowerCase())
  if (!d.owners.some((o) => o.projects.some(still))) return d
  return { ...d, owners: d.owners.map((o) => ({ ...o, projects: o.projects.map((p) => (still(p) ? { ...p, sprintless: true as const } : p)) })) }
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
    // A sprint field GitHub now reports on it ends that: the board has sprints again.
    return had ? { ...p, statuses: had.statuses, ...(had.sprintless && !p.sprintField ? { sprintless: true as const } : {}) } : p
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

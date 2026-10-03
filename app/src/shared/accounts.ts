import { primaryRepo, projectKey, type AccountConfig, type AppConfig } from './appConfig'
import { parsePrUrl } from './prSummary'

/**
 * Several GitHub accounts: which one a repo, a board, a new or a running session belongs to, and
 * what a session started as an account gets in its environment. Pure; main and the renderer use it.
 */

/** What AppState shows of a connected account: never its token. */
export interface GhAccountStatus {
  login: string
  primary: boolean
  /** False when gh has no token for it or GitHub refuses the token (Needs you asks to log in again). */
  healthy: boolean
  error?: string
  /** Something that may make sessions act as another account (a global git rule sending GitHub over SSH). */
  warning?: string
}

type WithAccounts = Pick<AppConfig, 'accounts'>
const low = (s: string) => s.toLowerCase()

/** Two or more connected accounts. With one, sessions and GitHub calls run exactly as before (no --settings, no GH_TOKEN). */
export function isMulti(c: WithAccounts): boolean {
  return c.accounts.length >= 2
}

/** The primary account's login; null before any account is connected. */
export function primaryLogin(c: WithAccounts): string | null {
  return (c.accounts.find((a) => a.primary) ?? c.accounts[0])?.login ?? null
}

/** The account that lists this repo (or, after its "Select all", owns its org); null if none. `repo` null: the primary issue repo. */
export function matchRepo(repo: string | null | undefined, c: AppConfig): string | null {
  const r = low(repo || primaryRepo(c))
  if (!r) return null
  const listed = c.accounts.find((a) => [a.owner && a.issueRepo ? `${a.owner}/${a.issueRepo}` : '', ...a.repos].some((x) => x && low(x) === r))
  if (listed) return listed.login
  const owner = r.split('/')[0]
  return c.accounts.find((a) => a.allRepos && low(a.owner) === owner)?.login ?? null
}

/** Repo-scoped calls (issues, PRs, the PR popup): the repo's account, else the primary. Null only with no accounts. */
export function accountForRepo(repo: string | null | undefined, c: AppConfig): string | null {
  return matchRepo(repo, c) ?? primaryLogin(c)
}

/** Board calls: the account whose boards include this one, else the primary. */
export function accountForProject(key: string | null | undefined, c: AppConfig): string | null {
  return (key && c.accounts.find((a) => a.projects.some((p) => projectKey(p) === key))?.login) || primaryLogin(c)
}

/** A new session's account: the issue's repo, then the folder's `origin` remote, then the primary. */
export function defaultAccount(o: { issue?: { repo?: string | null } | null; origin?: string | null }, c: AppConfig): string | null {
  return (o.issue ? matchRepo(o.issue.repo, c) : null) ?? (o.origin ? matchRepo(o.origin, c) : null) ?? primaryLogin(c)
}

/** A running session's account: as recorded at its start, else its spawn proposal's, else its folder's repo, else the primary. A login no longer connected is skipped. */
export function sessionAccount(o: { recorded?: string | null; spawned?: string | null; origin?: string | null }, c: AppConfig): string | null {
  const known = (l?: string | null) => (l && c.accounts.some((a) => a.login === l) ? l : null)
  return known(o.recorded) ?? known(o.spawned) ?? defaultAccount({ origin: o.origin }, c)
}

/** What a picker offers: every healthy account; nothing (so no picker) with fewer than two. */
export function accountChoices(c: WithAccounts, status: GhAccountStatus[] | undefined): string[] {
  if (!isMulti(c)) return []
  const bad = new Set((status ?? []).filter((s) => !s.healthy).map((s) => s.login))
  return c.accounts.map((a) => a.login).filter((l) => !bad.has(l))
}

/** The account a dialog should send: the picked one when it differs from the default (so it makes a new proposal); nothing otherwise or with one account. */
export function accountOverride(picked: string | null, def: string | null, c: WithAccounts): string | undefined {
  return isMulti(c) && picked && picked !== def ? picked : undefined
}

/** The account a resume sends: the user's pick, else the one the session was recorded with, else what the select shows; nothing with one account. */
export function resumeAccount(recorded: string | null | undefined, selected: string | null, picked: boolean, c: WithAccounts): string | undefined {
  if (!isMulti(c)) return undefined
  return (picked ? selected : (recorded ?? selected)) ?? undefined
}

/** owner/name of a GitHub remote: https://github.com/…, git@<host or alias>:…, ssh://git@<host or alias>/…; null otherwise. */
export function repoFromRemote(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/[^@/\s]+@[^/\s]+\/|[^@/\s]+@[^:/\s]+:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** owner/name of a PR URL; null for anything else. */
export function prRepo(url: string): string | null {
  const id = parsePrUrl(url)
  return id ? `${id.owner}/${id.repo}` : null
}

const REPO_ARG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

// A PR or issue URL, or a REST path `repos/<owner>/<repo>/…` (the whole argument).
const REPO_IN_ARG = /^(?:https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(?:pull|issues)\/\d+$|\/?repos\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:[/?]|$))/

/** The repo a gh call is about: its `-R`/`--repo` value, else a PR or issue URL or a `repos/<owner>/<repo>/` API path among its arguments. */
export function repoOfArgs(args: string[]): string | null {
  const i = args.findIndex((a) => a === '-R' || a === '--repo')
  if (i >= 0 && REPO_ARG.test(args[i + 1] ?? '')) return args[i + 1]
  const eq = args.find((a) => a.startsWith('--repo='))?.slice(7)
  if (eq && REPO_ARG.test(eq)) return eq
  for (const a of args) {
    const m = REPO_IN_ARG.exec(a)
    if (m) return m[1] ? `${m[1]}/${m[2]}` : `${m[3]}/${m[4]}`
  }
  return null
}

/** PR URLs by their repo's account ('' with no accounts): one batched call per account. */
export function groupByAccount(urls: string[], c: AppConfig): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const u of urls) {
    const k = accountForRepo(prRepo(u), c) ?? ''
    out.set(k, [...(out.get(k) ?? []), u])
  }
  return out
}

/**
 * ssh config Host aliases whose HostName is github.com (or ssh.github.com): `git@<alias>:org/repo`
 * remotes push with that alias's key, so a session rewrites them to HTTPS too. Host lists are split;
 * patterns with * ? ! and Match blocks are skipped; github.com itself is covered already.
 */
export function githubSshAliases(text: string): string[] {
  const out: string[] = []
  let hosts: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(\S+?)\s*(?:=\s*|\s+)(.+?)\s*$/.exec(raw.replace(/#.*$/, ''))
    if (!m) continue
    const key = low(m[1])
    const val = m[2].replace(/^"|"$/g, '')
    if (key === 'host') hosts = val.split(/\s+/).map((h) => h.replace(/^"|"$/g, ''))
    else if (key === 'match') hosts = []
    else if (key === 'hostname' && /^(ssh\.)?github\.com$/i.test(val))
      for (const h of hosts) if (!/[*?!]/.test(h) && low(h) !== 'github.com' && !out.some((x) => low(x) === low(h))) out.push(h)
  }
  return out
}

/**
 * The `env` of an account's Claude Code settings file: its token for gh, its identity for git, and
 * git rules (GIT_CONFIG_*, this session only) that send every github.com remote — HTTPS, SSH, or an
 * ssh alias — over HTTPS with gh's credential helper. The empty helper first drops helpers from the
 * user's own git config for github.com (a keychain entry for another account would answer first).
 */
export function accountEnvBlock(a: Pick<AccountConfig, 'name' | 'email'>, token: string, aliases: string[]): Record<string, string> {
  const rules: [string, string][] = [
    ['user.name', a.name],
    ['user.email', a.email],
    ['credential.https://github.com.helper', ''],
    ['credential.https://github.com.helper', '!gh auth git-credential'],
    ...['github.com', ...aliases].flatMap((h): [string, string][] => [
      ['url.https://github.com/.insteadOf', `git@${h}:`],
      ['url.https://github.com/.insteadOf', `ssh://git@${h}/`],
    ]),
  ]
  const env: Record<string, string> = {
    GH_TOKEN: token,
    GIT_AUTHOR_NAME: a.name,
    GIT_AUTHOR_EMAIL: a.email,
    GIT_COMMITTER_NAME: a.name,
    GIT_COMMITTER_EMAIL: a.email,
    GIT_CONFIG_COUNT: String(rules.length),
  }
  rules.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

/** GitHub's private commit email for an account. */
export function noreplyEmail(login: string, id: number | null): string {
  return id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`
}

/**
 * The one account an older config becomes at the first launch of this version: gh's active login,
 * today's repos and boards, and the git identity commits are made with today (GitHub fills gaps).
 */
export function migrationAccount(c: AppConfig, login: string, git: { name: string; email: string }, gh: { name: string | null; id: number | null }): AccountConfig {
  return {
    login,
    primary: true,
    name: git.name || gh.name || login,
    email: git.email || noreplyEmail(login, gh.id),
    owner: c.owner,
    ownerType: c.ownerType,
    issueRepo: c.issueRepo,
    repos: c.repos,
    allRepos: c.allRepos,
    projects: c.projects,
    allProjects: c.allProjects,
  }
}

/** `gh api user` JSON to {login, name, id}; null when it is not a GitHub user. The one parser Setup and the env code share. */
export function parseGhUser(json: string): { login: string; name: string | null; id: number | null } | null {
  try {
    const u = JSON.parse(json) as { login?: unknown; name?: unknown; id?: unknown }
    if (typeof u.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(u.login)) return null
    return { login: u.login, name: typeof u.name === 'string' && u.name ? u.name : null, id: typeof u.id === 'number' ? u.id : null }
  } catch {
    return null
  }
}

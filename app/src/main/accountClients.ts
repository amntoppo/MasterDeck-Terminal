import { accountForRepo, isMulti, primaryLogin, repoOfArgs, accountForCard } from '@shared/accounts'
import type { AppConfig } from '@shared/appConfig'
import type { Ticket } from '@shared/ticket'
import type { AccountRunEnv } from './accountEnv'
import { BoardOps } from './boardOps'
import type { GhRunner } from './ghc'
import { GitHub } from './github'
import type { RunOpts, RunResult, Runner } from './run'

/** MasterDeck's own gh runner, REST client and board writer, as one account. */
export interface Clients {
  gh: GhRunner
  github: GitHub
  ops: BoardOps
}

export interface AccountClientsDeps {
  config: () => AppConfig
  /** The one-account singletons: with one account (or none) every call uses these, exactly as before. */
  base: Clients
  run: Runner
  /** An account's env for MasterDeck's own gh calls (its token), or why it can't call. */
  runEnv: (login: string) => AccountRunEnv
  /** makeGhRunner with that account's env on every call. */
  ghFor: (account: () => AccountRunEnv) => GhRunner
  /** The key of the selected board whose loaded cards hold this issue (or, with no number, an issue of this repository); null when none does. */
  boardOf?: (repo: string | null | undefined, number?: number) => string | null
}

/**
 * Which account MasterDeck's GitHub calls go out as. Two or more accounts: a runner per account
 * (made once), picked by login, by repo, or from the call's own `-R`/PR URL. An account without a
 * usable token fails its calls with the reason; they never fall back to another account.
 */
export function accountClients(d: AccountClientsDeps) {
  const per = new Map<string, Clients>()
  // Routing says multi from the config; AccountEnv catches up on its next refresh and until then
  // answers {env: {}} (one account). Without a token that call would run as gh's active account.
  const envOf = (l: string): AccountRunEnv => {
    const a = d.runEnv(l)
    return 'error' in a || a.env.GH_TOKEN ? a : { error: `GitHub account ${l} is not ready yet` }
  }
  function forAccount(login: string | null | undefined): Clients {
    const cfg = d.config()
    if (!isMulti(cfg)) return d.base
    const l = login && cfg.accounts.some((a) => a.login === login) ? login : primaryLogin(cfg)!
    let r = per.get(l)
    if (!r) {
      const gh = d.ghFor(() => envOf(l))
      r = { gh, github: new GitHub(d.run, gh), ops: new BoardOps(gh) }
      per.set(l, r)
    }
    return r
  }
  /** Repo-scoped calls: the repo's account, else the primary. */
  const forRepo = (repo: string | null | undefined): Clients => forAccount(accountForRepo(repo, d.config()))
  /**
   * A card's calls: its repository's account; for a repository no account lists, the account whose
   * loaded board holds the card (`boardOf`), so a private repository on another account's board is
   * not asked for with the primary's token; else the primary.
   */
  const forCard = (repo: string | null | undefined, number?: number): Clients => {
    const cfg = d.config()
    if (!isMulti(cfg)) return d.base
    return forAccount(accountForCard(repo, d.boardOf?.(repo, number) ?? null, cfg))
  }
  /**
   * Picks the account from the call itself: `-R`/`--repo owner/name`, a whole PR or issue URL, or a
   * `repos/<owner>/<repo>/…` API path (`repoOfArgs`). Anything else (`api user`, search) names no
   * repo and goes as the primary.
   */
  const ghRouted: GhRunner = (args, opts) => forRepo(repoOfArgs(args)).gh(args, opts)
  /** gh straight (no cache) as a repo's account: calls with stdin, or that must not be cached. */
  function ghDirect(repo: string | null | undefined, args: string[], opts: RunOpts = {}): Promise<RunResult> {
    const cfg = d.config()
    if (!isMulti(cfg)) return d.run('gh', args, opts)
    const a = envOf(accountForRepo(repo, cfg)!)
    if ('error' in a) return Promise.resolve({ code: 1, stdout: '', stderr: a.error })
    return d.run('gh', args, { ...opts, env: { ...(opts.env ?? {}), ...a.env } })
  }
  /** BoardFlow's automatic moves and PR links, each as its ticket's repo's account. */
  const boardOps: Pick<BoardOps, 'move' | 'linkPr'> = {
    move: (t: Ticket, target: string, o?: { force?: boolean }) => forCard(t.repo, t.number).ops.move(t, target, o),
    linkPr: (t: Ticket, url: string) => forCard(t.repo, t.number).ops.linkPr(t, url),
  }
  return { forAccount, forRepo, forCard, ghRouted, ghDirect, boardOps }
}

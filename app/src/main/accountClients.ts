import { accountForRepo, isMulti, primaryLogin, repoOfArgs } from '@shared/accounts'
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
}

/**
 * Which account MasterDeck's GitHub calls go out as. Two or more accounts: a runner per account
 * (made once), picked by login, by repo, or from the call's own `-R`/PR URL. An account without a
 * usable token fails its calls with the reason; they never fall back to another account.
 */
export function accountClients(d: AccountClientsDeps) {
  const per = new Map<string, Clients>()
  function forAccount(login: string | null | undefined): Clients {
    const cfg = d.config()
    if (!isMulti(cfg)) return d.base
    const l = login && cfg.accounts.some((a) => a.login === login) ? login : primaryLogin(cfg)!
    let r = per.get(l)
    if (!r) {
      const gh = d.ghFor(() => d.runEnv(l))
      r = { gh, github: new GitHub(d.run, gh), ops: new BoardOps(gh) }
      per.set(l, r)
    }
    return r
  }
  /** Repo-scoped calls: the repo's account, else the primary. */
  const forRepo = (repo: string | null | undefined): Clients => forAccount(accountForRepo(repo, d.config()))
  /** Picks the account from the call itself (`-R owner/name` or a PR URL); else the primary. */
  const ghRouted: GhRunner = (args, opts) => forRepo(repoOfArgs(args)).gh(args, opts)
  /** gh straight (no cache) as a repo's account: calls with stdin, or that must not be cached. */
  function ghDirect(repo: string | null | undefined, args: string[], opts: RunOpts = {}): Promise<RunResult> {
    const cfg = d.config()
    if (!isMulti(cfg)) return d.run('gh', args, opts)
    const a = d.runEnv(accountForRepo(repo, cfg)!)
    if ('error' in a) return Promise.resolve({ code: 1, stdout: '', stderr: a.error })
    return d.run('gh', args, { ...opts, env: { ...(opts.env ?? {}), ...a.env } })
  }
  /** BoardFlow's automatic moves and PR links, each as its ticket's repo's account. */
  const boardOps: Pick<BoardOps, 'move' | 'linkPr'> = {
    move: (t: Ticket, target: string, o?: { force?: boolean }) => forRepo(t.repo).ops.move(t, target, o),
    linkPr: (t: Ticket, url: string) => forRepo(t.repo).ops.linkPr(t, url),
  }
  return { forAccount, forRepo, ghRouted, ghDirect, boardOps }
}

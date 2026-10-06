import type { AssignRequest } from '@shared/ipc'
import type { CliResult, Proposal } from '@shared/types'

export interface AssignCli {
  approve(ids: number[]): Promise<CliResult>
  reject(ids: number[]): Promise<CliResult>
  spawn(id: number): Promise<CliResult>
  addAssign(a: { issue: number; repo?: string | null; name: string; cwd: string; prompt: string; source: string; kind?: string; model?: string; account?: string }): Promise<
    { ok: true; id: number } | { ok: false; message: string }
  >
}

/** master's watch saw the approval and spawned it first; the session is on its way either way. */
const ALREADY_SENT = /is (sent|done|question|blocked), not approved/

/**
 * Start a session for an issue now: record the proposal (reusing master's own when unchanged),
 * approve it, and spawn it with `master spawn`. The ledger lock and the approved→sent check mean
 * the app and master can't both spawn it.
 */
export async function startAssign(cli: AssignCli, req: AssignRequest, now = Date.now(), fallbackAccount: string | null = null): Promise<CliResult & { proposalId?: number }> {
  let id: number
  if (req.retry && req.proposalId !== null) {
    // Try again: the failed start left this proposal held, with its name, folder, model and account.
    // Spawn that one (held → sent). Reading the request again would add a second proposal whenever
    // it names a model or an account.
    id = req.proposalId
  }
  // A chosen model or account means a new proposal: master's own has its spawn target already.
  else if (req.proposalId !== null && !req.edited && !req.model && !req.account) {
    id = req.proposalId
    if (!req.approved) {
      const a = await cli.approve([id])
      if (!a.ok) return a
    }
  } else {
    const kind = req.kind ?? 'ASSIGN'
    const t = req.repo ? `${req.repo}#${req.issue}` : String(req.issue)
    const source = kind === 'PRREVIEW' ? `app:review:${t}:${req.name}:${now}` : `app:issue:${t}:${now}`
    const added = await cli.addAssign({ issue: req.issue, repo: req.repo ?? null, name: req.name, cwd: req.cwd, prompt: req.prompt, source, kind, model: req.model || undefined, account: req.account || fallbackAccount || undefined })
    if (!added.ok) return { ok: false, message: added.message }
    const a = await cli.approve([added.id])
    if (!a.ok) {
      // Don't leave a stray proposal behind; a retry adds a fresh one.
      await cli.reject([added.id])
      return a
    }
    id = added.id
    if (req.proposalId !== null) await cli.reject([req.proposalId])
  }
  const s = await cli.spawn(id)
  if (s.ok || ALREADY_SENT.test(s.message)) return { ok: true, message: `started proposal ${id}`, proposalId: id }
  // The failed spawn left the proposal `held`; `master spawn <id>` can retry it.
  return { ok: false, message: s.message, proposalId: id }
}

/**
 * Try again from Needs you: spawn a held proposal itself (held → sent), under the ledger lock like
 * any spawn, so it starts once. `expect`: record the session's account once it shows up (two or
 * more accounts).
 */
export async function retryHeld(cli: Pick<AssignCli, 'spawn'>, p: Proposal, expect: (name: string, login: string) => void): Promise<CliResult> {
  const sp = p.target.spawn
  if (p.status !== 'held' || !sp) return { ok: false, message: `proposal ${p.id} is not a start that was held` }
  const s = await cli.spawn(p.id)
  if (!s.ok && !ALREADY_SENT.test(s.message)) return s
  if (sp.account) expect(sp.name, sp.account)
  return { ok: true, message: `started ${sp.name}` }
}

/**
 * A request that names a repository instead of a folder (a PR review): it starts where the CLI's
 * one resolver says, that repository's checkout, else its account's workspace. The given folder
 * stays when the CLI cannot say.
 */
export async function inRepoFolder(
  cli: { checkout(repo: string): Promise<{ ok: true; cwd: string } | { ok: false; message: string }> },
  req: AssignRequest,
): Promise<AssignRequest> {
  if (typeof req.cwdRepo !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(req.cwdRepo)) return req
  const r = await cli.checkout(req.cwdRepo)
  return r.ok ? { ...req, cwd: r.cwd } : req
}

type SettingsArgs = { ok: true; args: string[]; account: string | null } | { ok: false; message: string }

export interface AssignAccounts {
  /** `--settings` for the start (`sessionSettings`): account null with one account. */
  settings(account: string | null | undefined): Promise<SettingsArgs>
  /** `target.spawn.account` of an existing proposal; null when it names none. */
  proposalAccount(id: number): string | null
  /** Record the session's account once it shows up (`SessionAccounts.expect`). */
  expect(name: string, login: string): void
}

/**
 * `startAssign` as a GitHub account (two or more connected): the chosen one, else the issue's.
 * master's proposal is reused only when it already names that account; one without (it would
 * start as gh's active account) or with another becomes a new proposal carrying it. One account:
 * any account in the request is dropped and the start is as before.
 */
export async function assignNow(cli: AssignCli, req: AssignRequest, acc: AssignAccounts, now = Date.now()): Promise<CliResult & { proposalId?: number }> {
  const as = await acc.settings(req.account)
  if (!as.ok) return { ok: false, message: as.message }
  if (!as.account) return startAssign(cli, { ...req, account: undefined }, now)
  // A retry spawns the held proposal as it is: its account is in it (the state may not have it yet).
  const reuse = req.proposalId !== null && (req.retry === true || acc.proposalAccount(req.proposalId) === as.account)
  const r = await startAssign(cli, { ...req, account: reuse ? undefined : as.account }, now, as.account)
  if (r.ok) acc.expect(req.name, as.account)
  return r
}

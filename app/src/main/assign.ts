import type { AssignRequest } from '@shared/ipc'
import { heldForTrust } from '@shared/trust'
import type { CliResult, Proposal } from '@shared/types'

export interface AssignCli {
  approve(ids: number[]): Promise<CliResult>
  reject(ids: number[], note?: string): Promise<CliResult>
  spawn(id: number): Promise<CliResult>
  /** The guarded retry of a start held for an untrusted folder (`master spawn --held-for-trust`). */
  spawnHeld(id: number): Promise<CliResult>
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
export async function startAssign(
  cli: AssignCli,
  req: AssignRequest,
  now = Date.now(),
  fallbackAccount: string | null = null,
  /** The live session that already owns a proposal's ticket or name, if any (its name). */
  owner: (proposalId: number) => string | null = () => null,
): Promise<CliResult & { proposalId?: number }> {
  let id: number
  if (req.retry && req.proposalId !== null) {
    // Try again: the start Claude Code refused left this proposal held, with its name, folder,
    // model and account. Only the guarded spawn is asked (the CLI starts nothing held for another
    // reason, whoever sends `retry`), and never beside a session that owns the ticket already.
    const has = owner(req.proposalId)
    const r = await closeOrSpawnHeld(cli, req.proposalId, has)
    // Closed, not started: said as it is (the tab has no new session to wait for).
    if (has) return { ok: false, message: r.message, proposalId: req.proposalId }
    if (r.ok || ALREADY_SENT.test(r.message)) return { ok: true, message: `started proposal ${req.proposalId}`, proposalId: req.proposalId }
    return { ok: false, message: r.message, proposalId: req.proposalId }
  }
  // A chosen model or account means a new proposal: master's own has its spawn target already.
  if (req.proposalId !== null && !req.edited && !req.model && !req.account) {
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

/** A held start whose ticket has a session already is closed, not started: it would be a second session of it. */
async function closeOrSpawnHeld(cli: Pick<AssignCli, 'spawnHeld' | 'reject'>, id: number, owner: string | null): Promise<CliResult> {
  if (owner) {
    const note = `a session named ${owner} is already running; this held start was closed`
    const r = await cli.reject([id], note)
    return r.ok ? { ok: true, message: note } : r
  }
  const s = await cli.spawnHeld(id)
  return s.ok ? { ok: true, message: `started proposal ${id}` } : s
}

/**
 * Try again from Needs you: start a proposal held because Claude Code refused its folder, itself
 * (held → sent), through the CLI's guarded spawn (under the ledger lock, so it starts once).
 * `owner`: the live session that already has the ticket or the name; then the held start is
 * closed instead. `expect`: record the session's account once it shows up (two or more accounts).
 */
export async function retryHeld(
  cli: Pick<AssignCli, 'spawnHeld' | 'reject'>,
  p: Proposal,
  d: { expect: (name: string, login: string) => void; owner: () => string | null },
): Promise<CliResult> {
  const sp = p.target.spawn
  if (!heldForTrust(p) || !sp) return { ok: false, message: `proposal ${p.id} is not a start held because Claude Code refused its folder` }
  const owner = d.owner()
  const r = await closeOrSpawnHeld(cli, p.id, owner)
  if (owner) return r
  if (!r.ok && !ALREADY_SENT.test(r.message)) return r
  if (sp.account) d.expect(sp.name, sp.account)
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
  /** The live session that already owns a proposal's ticket or name (its name), for a retry. */
  owner?(proposalId: number): string | null
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
  const owner = (id: number) => acc.owner?.(id) ?? null
  if (!as.account) return startAssign(cli, { ...req, account: undefined }, now, null, owner)
  // A retry spawns the held proposal as it is: its account is in it (the state may not have it yet).
  const reuse = req.proposalId !== null && (req.retry === true || acc.proposalAccount(req.proposalId) === as.account)
  const r = await startAssign(cli, { ...req, account: reuse ? undefined : as.account }, now, as.account, owner)
  if (r.ok) acc.expect(req.name, as.account)
  return r
}

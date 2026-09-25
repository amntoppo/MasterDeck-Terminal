import type { AssignRequest } from '@shared/ipc'
import type { CliResult } from '@shared/types'

export interface AssignCli {
  approve(ids: number[]): Promise<CliResult>
  reject(ids: number[]): Promise<CliResult>
  spawn(id: number): Promise<CliResult>
  addAssign(a: { issue: number; name: string; cwd: string; prompt: string; source: string; kind?: string }): Promise<
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
export async function startAssign(cli: AssignCli, req: AssignRequest, now = Date.now()): Promise<CliResult & { proposalId?: number }> {
  let id: number
  if (req.proposalId !== null && !req.edited) {
    id = req.proposalId
    if (!req.approved) {
      const a = await cli.approve([id])
      if (!a.ok) return a
    }
  } else {
    const kind = req.kind ?? 'ASSIGN'
    const source = kind === 'PRREVIEW' ? `app:review:${req.issue}:${req.name}:${now}` : `app:issue:${req.issue}:${now}`
    const added = await cli.addAssign({ issue: req.issue, name: req.name, cwd: req.cwd, prompt: req.prompt, source, kind })
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

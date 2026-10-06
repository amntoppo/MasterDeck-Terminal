import type { AssignRequest } from './ipc'
import { sameTicket, type Ticket } from './ticket'
import type { Proposal } from './types'

/**
 * Claude Code works only in a folder whose trust prompt was accepted: `claude --bg` refuses to start
 * a session anywhere else ("Workspace not trusted. Run `claude` in <folder> once and accept the
 * trust prompt, then retry."). Whether a folder is trusted is read by the master CLI
 * (`master/trust.py`, from Claude Code's own `.claude.json`: `draft-assign`, `checkout`, `trust`);
 * this is what the app says and offers about it. MasterDeck never accepts the prompt itself: it
 * opens `claude` in the folder and the user answers Claude Code's own question.
 */

/** true, false, or not known (null from the CLI, undefined from an older one or before it answered). */
export type Trusted = boolean | null | undefined

// Loosely: the wording around it may change. (`trust.not_trusted` in the CLI is the same matcher.)
const NOT_TRUSTED = /workspace\s+(?:is\s+not|isn['’]?t|not)\s+trusted/i

/** Is this failed start Claude Code refusing a folder it was not allowed to work in? */
export function isNotTrusted(text: string | null | undefined): boolean {
  return !!text && NOT_TRUSTED.test(text)
}

export function trustLine(folder: string | null): string {
  return `Claude Code has not been allowed to work in ${folder || 'that folder'} yet.`
}

/**
 * Whether to say so. A folder known not to be trusted: yes, before any start. Not known: only
 * after a start failed with Claude Code's refusal. A trusted folder: never (nothing is added).
 */
export function needsTrust(trusted: Trusted, failure?: string | null): boolean {
  if (trusted === true) return false
  return trusted === false || isNotTrusted(failure)
}

export interface TrustView {
  /** `ask`: nothing done yet; `waiting`: Claude is open there, looking again by itself; `ready`: it may start. */
  step: 'ask' | 'waiting' | 'ready'
  line: string
  hint: string | null
  /** Show **Open Claude there…** (the desktop window only, and only with a folder). */
  open: boolean
}

/**
 * What the Start dialog, a start that failed and a held Needs-you item show. `opened`: the user
 * pressed Open Claude there… here; `desktop` false: the web app or a phone, where no tab can open.
 */
export function trustView(folder: string | null, o: { trusted: Trusted; opened: boolean; desktop: boolean }): TrustView {
  if (o.trusted === true)
    return { step: 'ready', line: `Claude Code can work in ${folder || 'that folder'} now.`, hint: o.opened ? 'You can close that tab.' : null, open: false }
  const line = trustLine(folder)
  if (!o.desktop) return { step: 'ask', line, hint: 'Do this on your Mac: open Claude in that folder once and accept its prompt.', open: false }
  if (!folder) return { step: 'ask', line, hint: 'Run claude in that folder once and accept its prompt.', open: false }
  return o.opened
    ? { step: 'waiting', line, hint: 'Accept the prompt in the tab that opened. This notices by itself.', open: true }
    : { step: 'ask', line, hint: 'Open Claude there once and accept its prompt.', open: true }
}

/**
 * The Start dialog's Start waits only for a folder known not to be trusted, and only where it can
 * be fixed (the desktop window). `anyway`: the user said to start regardless (what was read may be
 * wrong; Claude Code decides, and a refused start can be tried again).
 */
export function startBlocked(trusted: Trusted, o: { desktop: boolean; anyway: boolean }): boolean {
  return trusted === false && o.desktop && !o.anyway
}

/**
 * A start `master spawn` held because Claude Code refused its folder (`held_for: "trust"` in the
 * ledger, written by the CLI at that failure only; never judged by the note, which master-agent
 * can write): the folder to open Claude in, the proposal's own. Null: anything else. The CLI
 * checks the same again before it starts one (`master spawn --held-for-trust`).
 */
export function heldForTrust(p: Proposal): { folder: string | null } | null {
  if (p.status !== 'held' || p.heldFor !== 'trust' || !p.target.spawn) return null
  return { folder: p.target.spawn.cwd || null }
}

/** The refused start of a ticket, if one is still held (the newest): the Start dialog offers that one again instead of adding another. */
export function trustHeldAssign(proposals: Proposal[], t: Ticket): Proposal | null {
  const c = proposals.filter((p) => p.kind === 'ASSIGN' && sameTicket({ repo: p.repo ?? null, number: p.issue }, t) && heldForTrust(p))
  return c.sort((a, b) => b.id - a.id)[0] ?? null
}

/**
 * What Start sends about the proposal its draft came from. Unchanged from master's: approve it, or
 * only spawn one already approved (`approvedId`). Unchanged from the ticket's refused start
 * (`heldId`): that same proposal is tried again. Edited, or no proposal: a new one.
 */
export function startFlags(o: { proposalId: number | null; edited: boolean; approvedId: number | undefined; heldId: number | undefined }): { approved: boolean; retry?: true } {
  if (o.edited || o.proposalId === null) return { approved: false }
  if (o.proposalId === o.heldId) return { approved: true, retry: true }
  return { approved: o.proposalId === o.approvedId }
}

/**
 * What the "did not start" tab sends again. A start Claude Code refused for its folder: the held
 * proposal itself, as a retry (never a second proposal). Any other failure: what Retry always
 * sent. No proposal yet: the request as it was.
 */
export function retryRequest(req: AssignRequest, proposalId: number | undefined, error: string | undefined): AssignRequest {
  if (proposalId === undefined) return req
  return { ...req, proposalId, edited: false, approved: true, ...(isNotTrusted(error) ? { retry: true } : {}) }
}

/** For a start asked from a phone or the API: there is no tab to open there. */
export function remoteTrustMessage(folder: string | null): string {
  return `${trustLine(folder)} Do this on your Mac: in MasterDeck, Needs you has this start with Open Claude there… and Try again.`
}

export const TRUST_WAIT_MS = 10 * 60_000
const CHUNK_S = 15
const EVERY_MS = 2000

/**
 * Keep asking whether a folder is trusted while the user answers Claude Code's prompt. `ask(n)` is
 * `deck.trust(folder, n)`: the CLI looks every two seconds, for n seconds at most, and each call
 * reads the file afresh. True as soon as it is; false when `alive()` says nobody waits any more,
 * or after ten minutes (the tab was closed, or the prompt declined: the button is there again).
 */
export async function waitForTrust(
  ask: (waitSeconds: number) => Promise<boolean | null>,
  o: { alive: () => boolean; now?: () => number; pause?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const now = o.now ?? Date.now
  const pause = o.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const end = now() + TRUST_WAIT_MS
  while (o.alive() && now() < end) {
    const t = now()
    let got: boolean | null = null
    try {
      got = await ask(CHUNK_S)
    } catch {
      got = null
    }
    if (got === true) return true
    // An answer that came at once (the CLI could not run): look again as slowly as it would have.
    if (now() - t < EVERY_MS) await pause(EVERY_MS - (now() - t))
  }
  return false
}

// What the CLI (`spawn.py`) and `closeOrSpawnHeld` say when a held start was closed instead of started.
const CLOSED_FOR = /a session named (\S+) is already running; this held start was closed/

/**
 * What a "Starting…" tab shows. `running`: its retry was closed because the ticket has a session
 * already (that session is offered, and nothing can be retried: the proposal is over). `refused`:
 * Claude Code refused the folder. `error`: anything else, with Retry as always.
 */
export function pendingPane(error: string | undefined): { kind: 'starting' | 'refused' | 'error' } | { kind: 'running'; name: string } {
  if (!error) return { kind: 'starting' }
  const m = CLOSED_FOR.exec(error)
  if (m) return { kind: 'running', name: m[1] }
  return { kind: isNotTrusted(error) ? 'refused' : 'error' }
}

import type { AppState, Proposal } from './types'

/**
 * The web's copy of the state must fit one bridge frame: `MAX_FRAME` (1.4 MB) of base64 is about
 * 1.05 MB of JSON, and a state over it is never sent (#168: a Mac with a long ledger sent nothing, and
 * the web app stayed on "Loading sessions…"). 950 KB leaves room for the message around it.
 */
export const WEB_STATE_BUDGET = 950_000

/** What `fitWebState` left out, in the order it tries; the web app says so where it shows. */
export type WebCut = 'teamPrsClosed' | 'proposalsClosed' | 'inboxHistory' | 'pastSessions'

export interface WebFit {
  state: AppState
  json: string
  /** UTF-8 bytes of `json`. */
  bytes: number
  cut: WebCut[]
  /** Still over the budget after every cut: the bridge sends a notice instead. */
  tooLarge: boolean
}

const utf8 = new TextEncoder()
const size = (json: string) => utf8.encode(json).length
const CLOSED = new Set(['done', 'rejected'])

/** A finished proposal keeps what the web shows of it (summary, note), not the prompt master sent. */
function slim(p: Proposal): Proposal {
  if (!p || !CLOSED.has(p.status)) return p
  const spawn = p.target?.spawn
  return { ...p, message: '', target: spawn?.prompt ? { ...p.target, spawn: { ...spawn, prompt: undefined } } : p.target }
}

/**
 * The state for the web bridge: finished proposals always lose their prompts (nothing on the web reads
 * them, and on a long ledger they are most of the state); then, only while still over `budget`, the
 * closed PRs of the PRs view, the finished proposals, the Needs-you history and past sessions, in
 * that order. `cut` lists what went, so the state never claims to be whole when it is not.
 */
export function fitWebState(s: AppState, budget = WEB_STATE_BUDGET): WebFit {
  // Defensive about shape: the bridge passes whatever the state channel carries.
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : [])
  let state: AppState = Array.isArray(s.proposals) ? { ...s, proposals: s.proposals.map(slim) } : s
  const cut: WebCut[] = []
  let json = JSON.stringify(state)
  let bytes = size(json)
  const steps: [WebCut, (x: AppState) => AppState][] = [
    ['teamPrsClosed', (x) => ({ ...x, teamPrs: list(x.teamPrs).filter((p) => p.state === 'open') })],
    ['proposalsClosed', (x) => ({ ...x, proposals: list(x.proposals).filter((p) => !CLOSED.has(p.status)) })],
    ['inboxHistory', (x) => ({ ...x, inbox: x.inbox && { ...x.inbox, history: [] } })],
    ['pastSessions', (x) => ({ ...x, pastSessions: {} })],
  ]
  for (const [name, step] of steps) {
    if (bytes <= budget) break
    state = step(state)
    cut.push(name)
    json = JSON.stringify({ ...state, webCut: cut })
    bytes = size(json)
  }
  if (cut.length) state = { ...state, webCut: cut }
  return { state, json, bytes, cut, tooLarge: bytes > budget }
}

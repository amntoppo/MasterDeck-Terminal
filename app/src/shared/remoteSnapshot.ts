import type { InboxEntry } from './inbox'
import type { RemoteCard, RemoteInboxEntry, RemoteSession, RemoteSnapshot } from './remote'
import { jobName } from './schedules'
import { columnsWithDerived } from './derivedBoard'
import { fullRepo } from './ticket'
import type { AppState } from './types'

/**
 * What MasterDeck sends the remote backend: the Tasks view and Needs you, nothing else (no
 * terminal tails, cost book or history). Kept under the socket's 1 MB cap by `fitSnapshot`.
 */

export const SNAPSHOT_LIMIT = 900_000
const HISTORY_KEEP = 20

/** The line to the backend, as Settings → Remote shows it. */
export type RemoteConn = 'off' | 'connecting' | 'connected' | 'error'
export interface RemoteStatus {
  conn: RemoteConn
  message: string | null
  lastSyncAt: number | null
}

function inboxEntry(e: InboxEntry): RemoteInboxEntry {
  const t = e.item.ticket
  return {
    id: e.item.id,
    kind: e.item.kind,
    priority: e.item.priority,
    sessionKey: e.item.sessionKey,
    ticket: t ? `${fullRepo(t.repo)}#${t.number}` : null,
    title: e.item.title,
    body: e.item.body,
    actions: e.item.actions.map(({ type, label, primary }) => (primary ? { type, label, primary } : { type, label })),
    state: e.state,
    firstSeen: e.firstSeen,
    snoozedUntil: e.snoozedUntil ?? null,
    resolvedAt: e.resolvedAt ?? null,
    resolvedHow: e.resolvedHow ?? null,
  }
}

export function toRemoteSnapshot(s: AppState, appVersion: string, now = Date.now()): RemoteSnapshot {
  const live = s.sessions.filter((x) => x.state !== 'done')
  const sessions: RemoteSession[] = live.map((x) => {
    const st = s.allStats[x.sessionId]
    return {
      key: x.key,
      sessionId: x.sessionId,
      name: x.name,
      kind: x.kind,
      state: x.state,
      waitingOn: x.waitingOn ?? null,
      busyWith: x.busyWith ?? null,
      asking: x.asking ?? null,
      issue: x.issue,
      issueRepo: x.issueRepo ?? null,
      startedAt: x.startedAt,
      costUsd: st?.costUsd == null ? null : Math.round(st.costUsd * 100) / 100,
      contextPct: st?.contextPct == null ? null : Math.round(st.contextPct),
      prUrls: s.sessionPrs[x.sessionId] ?? [],
      schedules: (s.schedules[x.sessionId] ?? []).map((j) => ({ id: j.id, name: jobName(j.prompt), when: j.when, nextAt: j.nextAt })),
      monitors: s.watches
        .filter((w) => w.sessionId === x.sessionId)
        .map((w) => ({ id: w.id, description: w.description, events: w.events, lastEventAt: w.lastEventAt })),
    }
  })
  const linked = new Set(sessions.flatMap((x) => x.prUrls))
  const menuKeys = new Set(s.inbox.open.filter((e) => e.item.kind === 'menu' && e.item.sessionKey).map((e) => e.item.sessionKey!))
  const cards: RemoteCard[] = (s.board?.cards ?? []).map((c) => ({
    number: c.number,
    repo: c.repo ?? null,
    project: c.project ?? null,
    title: c.title,
    url: c.url,
    status: c.status,
    assignees: c.assignees,
    labels: c.labels,
    prUrls: c.prs.map((p) => p.url),
  }))
  return {
    takenAt: now,
    appVersion,
    me: s.me,
    master: s.master.kind,
    sessions,
    inbox: {
      open: s.inbox.open.map(inboxEntry),
      snoozed: s.inbox.snoozed.map(inboxEntry),
      history: s.inbox.history.slice(0, HISTORY_KEEP).map(inboxEntry),
    },
    menus: Object.fromEntries(Object.entries(s.menus ?? {}).filter(([k]) => menuKeys.has(k))),
    board: s.board ? { columns: columnsWithDerived(s.board), sprint: s.board.sprint, cards } : null,
    proposals: s.proposals
      .filter((p) => p.status === 'proposed' || p.status === 'approved')
      .map((p) => ({ id: p.id, kind: p.kind, issue: p.issue, repo: p.repo ?? null, status: p.status, summary: p.summary })),
    prLive: Object.fromEntries(
      Object.entries(s.prLive)
        .filter(([url]) => linked.has(url))
        .map(([url, p]) => [url, { number: p.number, title: p.title, state: p.state, ci: p.ci, reviewDecision: p.reviewDecision, isDraft: p.isDraft }]),
    ),
  }
}

/** The snapshot with what ticks without meaning zeroed (time, cost, context, monitor counters, next-run times): equal keys = nothing worth sending now. */
export function volatileKey(snap: RemoteSnapshot): string {
  return JSON.stringify({
    ...snap,
    takenAt: 0,
    sessions: snap.sessions.map((s) => ({
      ...s,
      costUsd: 0,
      contextPct: 0,
      schedules: s.schedules?.map((j) => ({ ...j, nextAt: 0 })),
      monitors: s.monitors?.map((m) => ({ ...m, events: 0, lastEventAt: 0 })),
    })),
  })
}

const BODY_KEEP = 2000
const enc = new TextEncoder()
const bytes = (json: string): number => enc.encode(json).length

function cutBody(e: RemoteInboxEntry): RemoteInboxEntry {
  return e.body.length > BODY_KEEP ? { ...e, body: `${e.body.slice(0, BODY_KEEP)}…` } : e
}

/**
 * Under `limit` bytes (the socket cap is bytes): drop the history, then cards not linked to a live
 * session, then the board, then truncate inbox bodies. Sessions and open entries are never dropped;
 * `oversize` is true when it still does not fit, and the sender should skip it.
 */
export function fitSnapshot(
  snap: RemoteSnapshot,
  limit = SNAPSHOT_LIMIT,
): { snap: RemoteSnapshot; json: string; trimmed: string[]; oversize: boolean } {
  const trimmed: string[] = []
  let cur = snap
  let json = JSON.stringify(cur)
  const steps: [string, (x: RemoteSnapshot) => RemoteSnapshot][] = [
    ['history', (x) => ({ ...x, inbox: { ...x.inbox, history: [] } })],
    [
      'cards',
      (x) => {
        const live = x.sessions.filter((s) => s.issue !== null)
        return x.board
          ? {
              ...x,
              board: {
                ...x.board,
                cards: x.board.cards.filter((c) => live.some((s) => s.issue === c.number && (s.issueRepo ?? null) === (c.repo ?? null))),
              },
            }
          : x
      },
    ],
    ['board', (x) => ({ ...x, board: null })],
    ['bodies', (x) => ({ ...x, inbox: { ...x.inbox, open: x.inbox.open.map(cutBody), snoozed: x.inbox.snoozed.map(cutBody) } })],
  ]
  for (const [name, step] of steps) {
    if (bytes(json) <= limit) break
    cur = step(cur)
    json = JSON.stringify(cur)
    trimmed.push(name)
  }
  return { snap: cur, json, trimmed, oversize: bytes(json) > limit }
}

/** The status shown while the line to the backend is not running. */
export function remoteStatusWhenOff(s: { remoteEnabled: boolean }, hasToken: boolean): RemoteStatus & { hasToken: boolean } {
  const message = !s.remoteEnabled ? null : !hasToken ? 'Sign in first (Settings → Account)' : null
  return { conn: 'off', message, lastSyncAt: null, hasToken }
}

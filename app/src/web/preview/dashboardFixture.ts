// DEV ONLY (?preview): the Dashboard's pulls, made up (fictional org `acme`), times relative to now.
import type { ActivityEvent, ActivityType } from '@shared/activityLog'
import type { JanitorRow } from '@shared/ipc'
import type { ProcsAll, SessionProc } from '@shared/sessionProcs'
import { SESSIONS } from './fixture'

const MIN = 60_000
const HOUR = 60 * MIN

/** Two days of the activity log, newest first, with every type at least once. */
export function fixtureActivity(): ActivityEvent[] {
  const now = Date.now()
  const s = (i: number) => SESSIONS[i]
  const ev = (ago: number, type: ActivityType, title: string, subject: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
    id: `${now - ago}-${type}`,
    at: now - ago,
    type,
    title,
    subject,
    ...extra,
  })
  const pr = (n: number) => `https://github.com/acme/web/pull/${n}`
  const out: ActivityEvent[] = [
    ev(3 * MIN, 'needs-you-answered', 'You answered login-redirect', `session:${s(0).key}`, { detail: 'Allowed npm run e2e', target: { session: s(0).key } }),
    ev(12 * MIN, 'pr-reviewed', 'sam asked for changes on web#136 Keep the session cookie across restarts', `pr:${pr(136)}`, { repo: 'acme/web', account: 'acme-dev', target: { pr: pr(136) } }),
    ev(25 * MIN, 'commit-pushed', '3 commits pushed to fix/112', 'branch:acme/web:fix/112', { detail: 'login-redirect', repo: 'acme/web', account: 'acme-dev', target: { session: s(0).key } }),
    ev(40 * MIN, 'session-started', 'Started billing-export on #118', `session:${s(1).key}`, { detail: 'acme/web', account: 'acme-dev', target: { session: s(1).key } }),
    ev(55 * MIN, 'ticket-moved', '#112 Login redirects to a blank page moved Todo → In Progress', 'ticket:acme/web#112', { detail: 'acme board', repo: 'acme/web', target: { ticket: { repo: 'acme/web', number: 112 } } }),
    ev(2 * HOUR, 'note-added', 'A note was added', 'note:n-1', { target: { note: `n-${'1'.repeat(32)}` } }),
    ev(3 * HOUR, 'meeting', 'Standup: notes added', 'meeting:m-a', { detail: 'Standup', target: { meeting: `m-${'a'.repeat(32)}` } }),
    ev(4 * HOUR, 'pr-opened', 'Opened web#138 Bump vite to 5.4', `pr:${pr(138)}`, { repo: 'acme/web', account: 'acme-dev', target: { pr: pr(138) } }),
    ev(5 * HOUR, 'schedule-run', 'Morning triage failed', 'run:r-manual', { detail: 'claude exited with code 1 before its first turn', target: { schedules: true } }),
    ev(7 * HOUR, 'session-finished', 'flaky-ci finished its turn', `session:${s(2).key}`, { account: 'acme-ops', target: { session: s(2).key } }),
    ev(20 * HOUR, 'release', 'MasterDeck 0.9.1 is out', 'release:0.9.1'),
    ev(24 * HOUR, 'schedule-run', 'Morning triage done ($0.62)', 'run:r-1', { target: { schedules: true } }),
    ev(26 * HOUR, 'pr-merged', 'Merged web#130 Onboarding checklist', `pr:${pr(130)}`, { repo: 'acme/web', account: 'acme-dev', target: { pr: pr(130) } }),
    ev(27 * HOUR, 'ticket-moved', '#104 Onboarding checklist moved In Review → Done', 'ticket:acme/web#104', { detail: 'acme board', repo: 'acme/web', target: { ticket: { repo: 'acme/web', number: 104 } } }),
    ev(30 * HOUR, 'pr-closed', 'Closed web#128 Try a new date picker', `pr:${pr(128)}`, { repo: 'acme/web', account: 'acme-dev', target: { pr: pr(128) } }),
    ev(33 * HOUR, 'session-ended', 'search-index ended', `session:${s(4).key}`, { account: 'acme-ops', target: { session: s(4).key } }),
    ev(36 * HOUR, 'commit-pushed', '1 commit pushed to ci/121', 'branch:acme/web:ci/121', { repo: 'acme/web', account: 'acme-ops' }),
    ev(40 * HOUR, 'session-started', 'Started search-index on #97', `session:${s(4).key}`, { account: 'acme-ops', target: { session: s(4).key } }),
    ev(45 * HOUR, 'needs-you-answered', 'You approved ASSIGN #118', 'proposal:5'),
  ]
  return out
}

/** Every session's processes: two sessions with ports, one test run that just failed, and a stray server. */
export function fixtureProcsAll(): ProcsAll {
  const t = Date.now()
  const proc = (pid: number, command: string, cwd: string, upMin: number, ports: number[], extra: Partial<SessionProc> = {}): SessionProc => ({
    pid, command, kind: 'background', cwd, startedAt: t - upMin * MIN, state: 'running', exitCode: null, endedAt: null,
    ports: ports.map((port) => ({ host: '127.0.0.1', port })), cpu: 0.4, memKb: 84_000, children: [], hasOutput: true, ...extra,
  })
  return {
    at: t,
    sessions: {
      [SESSIONS[1].key]: [
        proc(4312, 'npm run dev', SESSIONS[1].cwd, 42, [5173], { children: [{ pid: 4314, command: 'node node_modules/.bin/vite' }] }),
        proc(4501, 'npm test -- --run', SESSIONS[1].cwd, 1, [], { state: 'exited', exitCode: 1, endedAt: t - 20_000, cpu: 0, memKb: 0, hasOutput: false }),
      ],
      [SESSIONS[6].key]: [proc(4388, 'uv run main.py', SESSIONS[6].cwd, 18, [8000, 8001], { cpu: 2.1, memKb: 132_000 })],
    },
    strays: [{ pid: 3901, command: 'python3', cwd: '/Users/dev/acme/web-97', ports: [{ host: '127.0.0.1', port: 8080 }], startedAt: t - 26 * HOUR, folderOf: '/Users/dev/acme/web-97' }],
  }
}

/** Three worktrees: one safe to remove, one with changes, one not pushed. */
export function fixtureJanitor(): JanitorRow[] {
  const t = Date.now()
  return [
    { repo: 'acme/web', path: '/Users/dev/acme/web/.claude/worktrees/web-104', branch: 'feat/104', dirtyFiles: 0, merged: true, pushed: true, orphanCommits: 0, lastCommitAt: t - 3 * 86_400_000, cls: 'SAFE', reason: 'merged into main, nothing uncommitted' },
    { repo: 'acme/web', path: '/Users/dev/acme/web/.claude/worktrees/web-121', branch: 'ci/121', dirtyFiles: 4, merged: false, pushed: true, orphanCommits: 0, lastCommitAt: t - 5 * HOUR, cls: 'DIRTY', reason: '4 uncommitted files' },
    { repo: 'acme/api', path: '/Users/dev/acme/api/.claude/worktrees/api-31', branch: 'feat/31', dirtyFiles: 0, merged: false, pushed: false, orphanCommits: 0, lastCommitAt: t - 2 * 86_400_000, cls: 'UNPUSHED', reason: 'branch not on origin' },
  ]
}

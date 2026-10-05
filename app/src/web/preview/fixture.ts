// DEV ONLY (npm run dev:web, ?preview): a made-up AppState for looking at the web app without a Mac.
// Fictional org `acme`; nothing here comes from a real machine.
import { DEFAULT_CONFIG, parseConfig } from '@shared/appConfig'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { InboxEntry } from '@shared/inbox'
import type { AppState, Session } from '@shared/types'

const now = Date.now()
const min = 60_000

const session = (n: number, name: string, state: Session['state'], issue: number | null, extra: Partial<Session> = {}): Session => ({
  key: `bg-${n}`,
  sessionId: `00000000-0000-4000-8000-00000000000${n}`,
  name,
  kind: 'background',
  bgId: `bg-${n}`,
  pid: 4000 + n,
  cwd: `/Users/dev/acme/${issue ? `web-${issue}` : 'api'}`,
  state,
  rawState: state,
  startedAt: now - n * 37 * min,
  issue,
  ...extra,
})

export const SESSIONS: Session[] = [
  session(1, 'login-redirect', 'needs-input', 112),
  session(2, 'billing-export', 'working', 118, { busyWith: 'npm test' }),
  session(3, 'flaky-ci', 'idle', 121, { asking: 'Should I also bump the Node version in CI?' }),
  session(4, 'docs-refresh', 'working', null),
  session(5, 'search-index', 'suspended', 97),
  session(9, 'master-agent', 'idle', null, { cwd: '/Users/dev/acme' }),
]

const entry = (id: string, kind: InboxEntry['item']['kind'], s: Session, title: string, body: string, actions: InboxEntry['item']['actions']): InboxEntry => ({
  item: { id, kind, priority: 100, sessionKey: s.key, ticket: s.issue ? { repo: null, number: s.issue } : null, title, body, actions, detail: { type: 'session' } },
  state: 'open',
  firstSeen: now - 4 * min,
  lastSeen: now - min,
})

const card = (number: number, title: string, status: string, extra: Record<string, unknown> = {}) => ({
  number,
  repo: 'acme/web',
  project: 'acme/1',
  title,
  url: `https://github.com/acme/web/issues/${number}`,
  status,
  prs: [],
  assignees: ['dev'],
  labels: [],
  milestone: null,
  type: null,
  ...extra,
})

const teamPr = (number: number, title: string, author: string, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/acme/web/pull/${number}`,
  repo: 'acme/web',
  number,
  title,
  state: 'open' as const,
  draft: false,
  author,
  createdAt: new Date(now - number * 3 * 3600_000).toISOString(),
  updatedAt: new Date(now - number * 600_000).toISOString(),
  closedAt: null,
  mergedAt: null,
  headRef: `feat/${number}`,
  baseRef: 'main',
  additions: 120 + number,
  deletions: 14,
  files: 6,
  reviewDecision: null,
  labels: [],
  requested: [],
  reviews: [],
  unresolvedThreads: 0,
  ci: 'success' as const,
  issues: [],
  ...extra,
})

const stats = (cost: number, ctx: number) => ({
  costUsd: cost,
  contextPct: ctx,
  model: 'claude-opus',
  permissionMode: 'default',
  currentDir: null,
  linesAdded: 42,
  linesRemoved: 7,
  source: 'statusline' as const,
  updatedAt: now - min,
})

/** An issue of an account with no board, already in the column MasterDeck worked out. */
const loose = (number: number, title: string, status: string, extra: Record<string, unknown> = {}) =>
  card(number, title, status, { project: null, derived: true as const, state: status === 'Done' ? ('CLOSED' as const) : ('OPEN' as const), closedAt: status === 'Done' ? new Date(now - 2 * 86400_000).toISOString() : null, ...extra })

/** `noBoard` (?preview=noboard): the same account with repositories but no GitHub board. */
export function fixtureState(noBoard = false): AppState {
  const master = SESSIONS.find((s) => s.name === 'master-agent')!
  // The board of the account, as `master config show` would give it (project 1).
  const boards = parseConfig({ config: { owner: 'acme', issueRepo: 'web', project: 1 } }).projects
  const state: AppState = {
    sessions: SESSIONS,
    issues: [
      { number: 112, repo: null, project: 'acme/1', title: 'Login redirects to a blank page', url: 'https://github.com/acme/web/issues/112', status: 'In Progress', currentSprint: true, assignedToMe: true },
      { number: 118, repo: null, project: 'acme/1', title: 'Export invoices as CSV', url: 'https://github.com/acme/web/issues/118', status: 'In Progress', currentSprint: true, assignedToMe: true },
      { number: 125, repo: null, project: 'acme/1', title: 'Dark mode for settings', url: 'https://github.com/acme/web/issues/125', status: 'Todo', currentSprint: true, assignedToMe: true },
    ],
    prs: [
      { url: 'https://github.com/acme/web/pull/131', repo: 'web', number: 131, title: 'Fix login redirect loop', unresolvedThreads: 2, ci: 'success', headRef: 'fix/112', refsIssue: 112, authorIsMe: true },
      { url: 'https://github.com/acme/web/pull/133', repo: 'web', number: 133, title: 'Pin Node 22 in CI', unresolvedThreads: 0, ci: 'failure', headRef: 'ci/121', refsIssue: 121, reviewRequested: true },
    ],
    proposals: [],
    master: { kind: 'attached', session: master },
    inbox: {
      open: [
        entry('i1', 'input', SESSIONS[0], 'login-redirect is waiting on a permission', 'Allow Bash(npm run e2e -- --grep login)?', [
          { type: 'reply', label: 'Reply' },
          { type: 'open', label: 'Open', primary: true },
        ]),
        entry('i2', 'question', SESSIONS[2], 'flaky-ci asks', 'Should I also bump the Node version in CI?', [
          { type: 'reply', label: 'Reply', primary: true },
        ]),
      ],
      snoozed: [],
      history: [],
    },
    stats: { [SESSIONS[0].sessionId]: stats(3.42, 61), [SESSIONS[1].sessionId]: stats(1.08, 24) },
    tails: {},
    git: {},
    prLive: {},
    hookInfo: {},
    sessionWorktrees: {},
    sessionPrs: { [SESSIONS[0].sessionId]: ['https://github.com/acme/web/pull/131'] },
    watches: [],
    schedules: {},
    sources: { agents: 'ok', github: 'ok' },
    errors: [],
    lastSnapshotAt: new Date(now - 2 * min).toISOString(),
    statuslineInstalled: true,
    missingBinaries: [],
    masterWorkspace: '/Users/dev/acme',
    board: {
      takenAt: new Date(now - 3 * min).toISOString(),
      sprint: 'Sprint 14',
      columns: ['Todo', 'In Progress', 'In Review', 'Done'],
      cards: [
        card(125, 'Dark mode for settings', 'Todo'),
        card(127, 'Rate-limit the public API', 'Todo', { assignees: [] }),
        card(112, 'Login redirects to a blank page', 'In Progress', {
          prs: [{ url: 'https://github.com/acme/web/pull/131', repo: 'web', number: 131, state: 'OPEN', ci: 'success', unresolved: 2 }],
        }),
        card(118, 'Export invoices as CSV', 'In Progress'),
        card(121, 'CI is flaky on Node 20', 'In Review', {
          prs: [{ url: 'https://github.com/acme/web/pull/133', repo: 'web', number: 133, state: 'OPEN', ci: 'failure', unresolved: 0 }],
        }),
        card(104, 'Onboarding checklist', 'Done'),
      ],
    },
    boardError: null,
    boardLoading: false,
    githubRefreshedAt: now - 3 * min,
    githubRefreshing: false,
    sprints: [{ id: 's14', title: 'Sprint 14', startDate: new Date(now - 4 * 86400_000).toISOString().slice(0, 10), duration: 14, completed: false }],
    selectedSprint: 's14',
    users: ['dev', 'sam', 'riley'],
    me: 'dev',
    settings: DEFAULT_SETTINGS,
    allStats: {},
    costBook: {},
    lastActivity: {},
    boardHistory: {},
    ghCache: null,
    teamPrs: [
      teamPr(131, 'Fix login redirect loop', 'dev', { unresolvedThreads: 2, reviewDecision: 'REVIEW_REQUIRED', requested: ['sam'] }),
      teamPr(133, 'Pin Node 22 in CI', 'riley', { ci: 'failure', requested: ['dev'] }),
      teamPr(129, 'Invoice CSV: streaming writer', 'sam', { reviewDecision: 'APPROVED', reviews: [{ login: 'dev', state: 'APPROVED' }] }),
    ],
    teamPrsAt: now - 5 * min,
    teamPrsLoading: false,
    teamPrsError: null,
    config: {
      ...DEFAULT_CONFIG,
      configured: true,
      path: '/Users/dev/.claude/master/config.json',
      owner: 'acme',
      issueRepo: 'web',
      project: 1,
      workspace: '/Users/dev/acme',
      repos: ['acme/web', 'acme/api'],
      projects: boards,
    },
    skills: [],
    hooks: { queue: true, foreignQueue: false, reviewGate: true, masterGuard: true },
    stoppedByRestart: [],
    restoring: false,
    tokens: {},
    pastSessions: {},
    asks: {},
    menus: {},
    prStage: {},
    manualStatus: {},
  }
  if (!noBoard) return state
  return {
    ...state,
    issues: state.issues.map((i) => ({ ...i, project: null })),
    config: { ...state.config, project: 0, projects: [] },
    sprints: [],
    selectedSprint: '@current',
    board: {
      takenAt: new Date(now - 3 * min).toISOString(),
      sprint: null,
      columns: state.config.columns,
      projects: [],
      cards: [
        loose(125, 'Dark mode for settings', 'Todo'),
        loose(127, 'Rate-limit the public API', 'Todo', { assignees: [] }),
        loose(118, 'Export invoices as CSV', 'In Dev'),
        loose(112, 'Login redirects to a blank page', 'PR Raised', {
          prs: [{ url: 'https://github.com/acme/web/pull/131', repo: 'web', number: 131, state: 'OPEN', ci: 'success', unresolved: 2 }],
        }),
        loose(104, 'Onboarding checklist', 'Done'),
      ],
      derived: [{ account: null, repos: ['acme/web', 'acme/api', 'acme/old-site'], total: 412, shown: 300, skipped: [], missing: ['acme/api', 'acme/old-site'], notes: ['acme/api not read: RATE_LIMITED'] }],
    },
  }
}

/** What a Claude Code session's screen looks like, roughly (ANSI). */
export function fakeScreen(name: string): string {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const b = (s: string) => `\x1b[1m${s}\x1b[0m`
  return [
    `${b('✻ Welcome to Claude Code')}  ${dim(name)}`,
    '',
    `> fix the login redirect and add a test`,
    '',
    `● I'll look at the redirect handler first.`,
    `  ${dim('⎿  Read src/auth/redirect.ts (84 lines)')}`,
    `● The callback drops the ${b('next')} query param when the session cookie is new.`,
    `  ${dim('⎿  Edited src/auth/redirect.ts (+6 -2)')}`,
    '',
    `\x1b[33m Bash(npm run e2e -- --grep login)\x1b[0m`,
    `  Do you want to proceed?`,
    `  \x1b[36m❯ 1. Yes\x1b[0m`,
    `    2. Yes, and don't ask again for npm run e2e`,
    `    3. No, and tell Claude what to do differently ${dim('(esc)')}`,
    '',
  ].join('\r\n')
}

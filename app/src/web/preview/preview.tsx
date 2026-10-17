// DEV ONLY: `npm run dev:web`, then open /?preview (the app on a stub deck), /?preview=noboard (an account with no
// GitHub board) or /?preview=gate (the sign-in card).
// main.tsx imports this only under import.meta.env.DEV, so `npm run build:web` leaves it out.
import type { Root } from 'react-dom/client'
import { DECK_ACCESS } from '@shared/remoteDeck'
import type { DeckApi } from '@shared/ipc'
import type { AppState } from '@shared/types'
import { matches, noteMeta, sortNotes, ticketNoteId, type Note, type NoteChange, type NoteInput } from '@shared/notes'
import { applyBtwEvent, type BtwEntry, type BtwEvent } from '@shared/btw'
import { parseDiff } from '@shared/diff'
import { App } from '@renderer/App'
import { Card } from '../Gate'
import { layoutFlow, newLoop, type Flow } from '@shared/flow'
import { BUILTIN_WORKFLOWS } from '@shared/builtinWorkflows'
import { fakeScreen, fixtureCosts, fixtureState, SESSIONS } from './fixture'

type Fn = (...a: never[]) => unknown

/** The preview session's folder for its file and diff tabs. */
const PREVIEW_FILES: Record<string, string> = {
  'README.md': '# acme web\n\nThe **web** app of acme.\n\n- Sign in with a magic link\n- Keep the return path\n\n```ts\nredirect("/home?tab=2")\n```\n',
  'src/auth/redirect.ts': "export function returnPath(url: URL): string {\n  // Keep the query string: the page needs it after sign-in.\n  const path = url.searchParams.get('next') ?? '/'\n  return path.startsWith('/') ? path : '/'\n}\n",
  'src/auth/redirect.test.ts': "import { expect, it } from 'vitest'\nimport { returnPath } from './redirect'\n\nit('keeps the query string', () => {\n  expect(returnPath(new URL('https://x/?next=/a?b=1'))).toBe('/a?b=1')\n})\n",
  'src/index.ts': "export * from './auth/redirect'\n",
  'public/logo.png': '',
}
const PREVIEW_DIFFS: Record<string, string> = {
  'README.md': '@@ -1,5 +1,7 @@\n # acme web\n \n-The web app.\n+The **web** app of acme.\n+\n+- Sign in with a magic link\n+- Keep the return path\n',
  'src/auth/redirect.ts':
    "@@ -1,4 +1,6 @@\n export function returnPath(url: URL): string {\n-  const path = url.pathname\n-  return path\n+  // Keep the query string: the page needs it after sign-in.\n+  const path = url.searchParams.get('next') ?? '/'\n+  return path.startsWith('/') ? path : '/'\n+  // (a very long line to show how the split view wraps text that does not fit in its half of the pane at all)\n }\n",
  'src/auth/redirect.test.ts': `@@ -0,0 +1,6 @@\n${PREVIEW_FILES['src/auth/redirect.test.ts'].replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n')}\n`,
  'docs/old-auth.md': '@@ -1,2 +0,0 @@\n-# Old auth\n-Gone.\n',
}

/** A workflow with a Loop frame, as Build with Claude drafts it (no positions): the editor lays it out. */
const loopFlow = (): Flow =>
  layoutFlow({
    nodes: [
      { id: 't-push', x: 0, y: 0, kind: 'trigger', trigger: 'command-after', pattern: 'npm (run )?build' },
      {
        ...newLoop('n-tests1', 0, 0),
        name: 'Fix the tests',
        members: ['n-run', 'n-fix'],
        check: { command: 'npm test', output: '', outputMode: 'match', timeoutMin: 5 },
      } as Flow['nodes'][number],
      { id: 'n-run', x: 0, y: 0, kind: 'instruction', text: 'Run the tests and read what failed.' },
      { id: 'n-fix', x: 0, y: 0, kind: 'instruction', text: 'Fix the cause, not the test.' },
      { id: 'n-done', x: 0, y: 0, kind: 'instruction', text: 'Open the PR.' },
      { id: 'n-help', x: 0, y: 0, kind: 'instruction', text: 'Say on the PR what still fails.' },
    ],
    edges: [
      { id: 'e-1', from: 't-push', to: 'n-tests1', kind: 'then' },
      { id: 'e-2', from: 'n-run', to: 'n-fix', kind: 'then' },
      { id: 'e-3', from: 'n-tests1', to: 'n-done', kind: 'met' },
      { id: 'e-4', from: 'n-tests1', to: 'n-help', kind: 'limit' },
    ],
  })

/** `window.deck` with fixture answers: same blocked/local split as the real RemoteDeck, nothing leaves the page. */
function previewDeck(noBoard: boolean, twoAccounts = false): DeckApi {
  const state: AppState = fixtureState(noBoard)
  // `?preview=accounts`: two connected accounts, so the account pickers show.
  if (twoAccounts) {
    const acct = (login: string, primary: boolean) => ({ login, name: login, email: `${login}@example.com`, ...(primary ? { primary: true as const } : {}), owner: 'acme', ownerType: 'organization' as const, issueRepo: 'web', repos: ['acme/web'], projects: [] })
    state.config = { ...state.config, accounts: [acct('acme-dev', true), acct('acme-ops', false)] }
    state.ghAccounts = [
      { login: 'acme-dev', primary: true, healthy: true },
      { login: 'acme-ops', primary: false, healthy: true },
    ]
  }
  // The first session is in round 3 of its loop, so its workflow's frame shows where it is.
  state.loops = {
    [SESSIONS[0].sessionId]: [
      { id: 'n-tests1', name: 'Fix the tests', state: 'open', iteration: 3, max: 10, startedAt: Date.now() - 12 * 60_000, minutes: 0, reason: null, endedAt: null, lastCheck: { ran: true, passed: false, said: false, tail: '2 failed', at: Date.now() - 60_000 } },
    ],
    // The second one stopped at its limit ten minutes ago: the ↻ ! badge, the reason in Details.
    [SESSIONS[1].sessionId]: [
      { id: 'n-lint', name: 'Clean the lint', state: 'limit', iteration: 10, max: 10, startedAt: Date.now() - 50 * 60_000, minutes: 0, reason: 'stopped after 10 iterations; the last check failed', endedAt: Date.now() - 10 * 60_000, lastCheck: { ran: true, passed: false, said: true, tail: '1 problem', at: Date.now() - 10 * 60_000 } },
    ],
  }
  // History: three rounds of the open loop, with long output and PROGRESS lines, and the progress file the hook keeps.
  const said = ['the redirect drops the query string <b>tags stay text</b>', 'fixed the encoder; two cases left', 'the cookie path is wrong']
  const round = (n: number, passed: boolean, said_: boolean, tail: string) => ({ n, at: Date.now() - (4 - n) * 4 * 60_000, ms: 38_000 + n * 1500, passed, said: said_, exit: passed ? 0 : 1, tail, hash: `h${n}`, progress: said[n - 1] })
  const failing = (k: number) => Array.from({ length: k }, (_, i) => `FAIL src/auth/redirect.test.ts > keeps the return path on a very long line that wraps at phone width (case ${i + 1})`).join('\n')
  const loopHistory = {
    ok: true,
    name: 'Fix the tests',
    history: [round(1, false, false, failing(6)), round(2, false, true, failing(2)), round(3, false, false, `${failing(2)}\n\nTests  2 failed | 140 passed`)],
    progress: said.map((t, i) => `- round ${i + 1}: ${t}`).join('\n') + '\n',
  }
  const stateCbs = new Set<(s: AppState) => void>()
  const pty = new Map<string, Set<(d: string, seq: number) => void>>()
  let seq = 1
  const echo = (id: string, d: string) => {
    // Show what was sent: printable text as is, control bytes as ^X / ESC[..
    const shown = d.replace(/\x1b/g, '⎋').replace(/[\x00-\x1f]/g, (c) => (c === '\r' ? '\r\n' : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`))
    for (const cb of pty.get(id) ?? []) cb(shown, ++seq)
  }
  // Notes in memory: what the Mac's store does, in the shapes of DeckApi, so the panel can be looked at.
  const notes = new Map<string, Note>()
  const noteCbs = new Set<(c: NoteChange) => void>()
  // The first session's Details → Notes: its ticket's note, a note about the session, and one from a meeting (newer than
  // anything this browser has seen, so the tab has its dot); and one note of the user's own.
  {
    const s = SESSIONS[0]
    // On the hour: the same times after a reload, so the dot stays off once the tab was opened.
    const at = Math.floor(Date.now() / 3_600_000) * 3_600_000
    const seed = (n: Note) => notes.set(n.id, n)
    seed({ id: ticketNoteId('acme/web', s.issue ?? 112)!, title: '', body: 'Waiting on **alice** for the redirect rules.', ticket: { repo: 'acme/web', number: s.issue ?? 112 }, created: at - 3 * 86_400_000, updated: at - 2 * 3_600_000 })
    seed({ id: `n-${'1'.repeat(32)}`, title: 'Try the cookie fix', body: 'Before the PR:\n\n- [ ] clear the cache\n- [x] sign in twice', ticket: null, link: { session: { key: s.key, name: s.name } }, created: at - 86_400_000, updated: at - 5 * 3_600_000 })
    seed({
      id: `n-${'2'.repeat(32)}`,
      title: 'Standup: login redirect',
      body: '**From:** Standup · this morning\nThe redirect loses the return path on Safari.\n\n**Action items**\n- keep `?next=` on the way back\n\n> **Others** 10:04 — the redirect drops the query on Safari\n> **You** 10:05 — I will look at it today',
      ticket: null,
      link: { session: { key: s.key, name: s.name }, ticket: { repo: 'acme/web', number: s.issue ?? 112 } },
      meeting: { id: `m-${'a'.repeat(32)}`, title: 'Standup', at: at - 3 * 3_600_000 },
      created: at - 2 * 3_600_000 + 1,
      updated: at - 2 * 3_600_000 + 1,
    })
    seed({ id: `n-${'3'.repeat(32)}`, title: 'Tomorrow', body: 'Ask for a review of the billing export.', ticket: null, created: at - 4 * 86_400_000, updated: at - 4 * 86_400_000 })
  }
  const noteSave = (i: NoteInput) => {
    const id = i.id ?? (i.ticket ? ticketNoteId(i.ticket.repo ?? 'acme/web', i.ticket.number) : null) ?? `n-${Math.random().toString(16).slice(2).padEnd(32, '0')}`
    const old = notes.get(id)
    if (old && i.base !== old.updated && !i.force) return { ok: false as const, conflict: true as const, note: old }
    if (i.ticket && !i.title && !i.body.trim()) {
      notes.delete(id)
      for (const cb of noteCbs) cb({ id, deleted: true })
      return { ok: true as const, deleted: true as const, id }
    }
    const now = Date.now()
    const note: Note = { id, title: i.title, body: i.body, ticket: i.ticket ? { repo: i.ticket.repo ?? 'acme/web', number: i.ticket.number } : null, created: old?.created ?? now, updated: Math.max(now, (old?.updated ?? 0) + 1) }
    // As the store: a new note takes the editor's link (its ticket named in full), a stored one keeps its own, and
    // `meeting` is never the editor's.
    const link = old ? old.link : i.link ? { ...i.link, ticket: i.link.ticket ? { repo: i.link.ticket.repo ?? 'acme/web', number: i.link.ticket.number } : undefined } : null
    if (link) note.link = link
    if (old?.meeting) note.meeting = old.meeting
    notes.set(id, note)
    const meta = noteMeta(note)
    for (const cb of noteCbs) cb({ id, meta })
    return { ok: true as const, meta }
  }
  // Side questions in memory: a few earlier ones per session, and an answer that streams in.
  const btw = new Map<string, BtwEntry[]>()
  const btwCbs = new Set<(e: BtwEvent) => void>()
  const btwPut = (key: string, entry: BtwEntry) => {
    btw.set(key, applyBtwEvent(btwList(key), { key, entry }))
    for (const cb of btwCbs) cb({ key, entry })
  }
  const btwList = (key: string): BtwEntry[] => {
    if (!btw.has(key)) {
      const t = Date.now()
      btw.set(key, [
        { id: 'p1', question: 'Which files did you change for the sign-in fix so far?', answer: 'Three so far:\n\n- `src/auth/session.ts`: the cookie now keeps `SameSite=Lax`\n- `src/auth/session.test.ts`: two new tests for the restart case\n- `docs/auth.md`: the note on cookies\n\nNothing is committed yet.', at: t - 3 * 3600_000, doneAt: t - 3 * 3600_000 + 4000, source: 'panel', status: 'done', costUsd: 0.0412, model: 'claude-opus-5-5' },
        { id: 't-1', question: 'is the migration safe to run twice?', answer: 'Yes: `ALTER TABLE … ADD COLUMN IF NOT EXISTS` makes the second run a no-op.', at: t - 47 * 60_000, doneAt: t - 47 * 60_000 + 3000, source: 'terminal', status: 'done', captured: true, partial: true },
        { id: 't-2', question: 'what did the last test run say?', answer: '', at: t - 12 * 60_000, doneAt: t - 12 * 60_000, source: 'terminal', status: 'done', captured: false },
        { id: 'p2', question: 'Why did you pick a cookie over local storage?', answer: '', at: t - 5 * 60_000, doneAt: t - 5 * 60_000 + 9000, source: 'panel', status: 'error', error: 'No conversation found with session ID: 3f2a…' },
      ])
    }
    return btw.get(key) ?? []
  }
  const btwTimers = new Map<string, ReturnType<typeof setInterval>>()
  const btwAsk = (key: string, question: string) => {
    if (btwList(key).some((e) => e.status === 'asking')) return { ok: false, message: 'A side question is still being answered. Stop it or wait.' }
    const id = `p-${Date.now()}`
    const words = `Short answer: **yes**. The session is still on step 2 of 4 (the tests).\n\n\`\`\`ts\nexpect(cookie.sameSite).toBe('lax')\n\`\`\`\n\nYou asked: "${question.slice(0, 80)}".`.split(/(?<= )/)
    let e: BtwEntry = { id, question, answer: '', at: Date.now(), doneAt: null, source: 'panel', status: 'asking', model: 'claude-opus-5-5' }
    btwPut(key, e)
    let i = 0
    const timer = setInterval(() => {
      if (i < words.length) {
        e = { ...e, answer: e.answer + words[i++] }
        btwPut(key, e)
        return
      }
      clearInterval(timer)
      btwTimers.delete(id)
      btwPut(key, { ...e, status: 'done', doneAt: Date.now(), costUsd: 0.0187 })
    }, 1200 / words.length + 60)
    btwTimers.set(id, timer)
    return { ok: true, id }
  }
  const ok = { ok: true, message: 'preview: nothing was sent' }
  // The folders the Mac found: the workspace and its repositories (a long path to see the phone width).
  const repos = ['/Users/dev/acme', '/Users/dev/acme/web', '/Users/dev/acme/api', '/Users/dev/acme/clients/mobile-app-with-a-long-folder-name'].map((path) => ({ name: path.split('/').pop() ?? path, path }))
  const calls: Record<string, Fn> = {
    getState: () => state,
    // As the Mac answers a resume: the background id it runs under (here search-index's).
    resumeSession: (_id: never, name: never) => ({ ok: true, message: name, key: 'bg-5' }),
    getSettings: () => state.settings,
    setSettings: (s: never) => s,
    ptyOpen: (id: never) => ({ ok: true, replay: fakeScreen(String(id).replace(/^.*:/, '')), seq: 1, exited: false }),
    queueList: () => [],
    templates: () => [],
    ticketMemory: () => [],
    searchHistory: () => [],
    janitor: () => [],
    standupCommits: () => [],
    tokensByDay: () => fixtureCosts().tokens,
    // Details → Session → Processes (#115): a dev server and an API with ports, and a test run that just failed.
    procsList: () => {
      const t = Date.now()
      const proc = (pid: number, command: string, cwd: string, upMin: number, ports: number[], extra: object = {}) => ({
        pid, command, kind: 'background' as const, cwd, startedAt: t - upMin * 60_000, state: 'running' as const, exitCode: null, endedAt: null,
        ports: ports.map((port) => ({ host: '127.0.0.1', port })), cpu: 0.4, memKb: 84_000, children: [{ pid: pid + 2, command: 'node node_modules/.bin/vite' }], hasOutput: true, ...extra,
      })
      return {
        ok: true, supported: true, running: true,
        procs: [
          proc(4312, 'npm run dev', '/Users/dev/acme/web', 42, [5173]),
          proc(4388, 'uv run main.py', '/Users/dev/acme/api', 18, [8000], { children: [] }),
          proc(4501, 'npm test -- --run', '/Users/dev/acme/web', 1, [], { state: 'exited', exitCode: 1, endedAt: t - 20_000, cpu: 0, memKb: 0, children: [], hasOutput: false }),
        ],
      }
    },
    procsOutput: () => ({ ok: true, text: '  VITE v5.4.2  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n10:41:02 [vite] hmr update /src/App.tsx' }),
    workspaceRepos: () => repos,
    accountFor: () => (twoAccounts ? 'acme-dev' : null),
    // Any folder under the fixture's home exists; anything else (a remembered folder) is gone.
    folderExists: (p: string) => p.startsWith('/Users/dev/acme'),
    summaryGet: () => ({ summary: null, stale: false }),
    workflowStatus: () => null,
    workflowLoopHistory: () => loopHistory,
    // Stop loop: the loop ends here as the Mac would end it, so the line and the badge change.
    workflowLoopStop: (sid: string, id: string) => {
      const v = state.loops[sid]?.find((x) => x.id === id && x.state === 'open')
      if (!v) return { ok: false, message: 'the loop is not running' }
      Object.assign(v, { state: 'stopped', reason: 'stopped by you', endedAt: Date.now() })
      state.loops = { ...state.loops, [sid]: [...state.loops[sid]] }
      for (const cb of stateCbs) cb({ ...state })
      return { ok: true, message: 'loop stopped' }
    },
    sessionWorkflowGet: () => ({ flow: loopFlow(), from: 'Fix the tests', at: Date.now() }),
    workflowDraftGet: () => null,
    // One built-in (edited, with a newer version shipped) and one deleted, so the chip, the note,
    // Restore original and Restore built-ins (1) show.
    workflowGet: () => {
      const b = BUILTIN_WORKFLOWS[0]
      return {
        hooks: [],
        skills: [],
        flow: loopFlow(),
        templates: [
          { id: 'default', name: 'Default', flow: loopFlow() },
          { id: b.id, name: b.name, flow: b.flow, builtin: { id: b.id, edited: true, renamed: false, updated: true, description: b.description, whenToUse: b.whenToUse } },
        ],
        triggers: [],
        monitors: [],
        builtinsRemoved: [BUILTIN_WORKFLOWS[4].id],
      }
    },
    workflowBuiltinRestore: () => ({ ok: true, message: 'restored (preview: nothing written)' }),
    defaultModel: () => null,
    ticketRepoMeta: () => ({ labels: [], milestones: [], assignees: [] }),
    issueBody: () => ({ ok: true, body: '## Steps\n\n1. Sign in from a fresh browser.\n2. Open **Settings**.\n\nThe page is blank; expected the settings form.' }),
    // Two on the board (their columns show), one closed, one open off the board.
    issueSubIssues: () => ({
      ok: true,
      subIssues: [
        {
          repo: null, number: 118, title: 'Export invoices as CSV', url: 'https://github.com/acme/web/issues/118', state: 'open', bodyCut: false,
          body: '## What\n\nA **CSV** button on the invoices page.\n\n- [x] Columns agreed\n- [ ] Export the visible rows\n- [ ] Dates as `YYYY-MM-DD`\n\n```ts\nexportCsv(rows, { header: true })\n```\n\nSee [the spec](https://github.com/acme/web/issues/90).',
          assignees: ['alice'], labels: [{ name: 'feature', color: 'a2eeef' }, { name: 'billing', color: 'd4c5f9' }],
        },
        {
          repo: null, number: 125, title: 'Dark mode for settings', url: 'https://github.com/acme/web/issues/125', state: 'open', bodyCut: true,
          body: Array.from({ length: 30 }, (_, i) => `${i + 1}. Check the ${['toggle', 'form', 'banner'][i % 3]} in dark mode and note what still uses a fixed colour.`).join('\n'),
          assignees: ['alice', 'bob-work'], labels: [{ name: 'ui', color: '0e8a16' }],
        },
        { repo: null, number: 101, title: 'Keep the session cookie across restarts', url: 'https://github.com/acme/web/issues/101', state: 'closed', body: '', bodyCut: false, assignees: [], labels: [{ name: 'bug', color: 'd73a4a' }] },
        { repo: null, number: 102, title: 'Show the sign-in error under the form', url: 'https://github.com/acme/web/issues/102', state: 'open', body: 'The error shows in a toast today and is gone before it can be read.', bodyCut: false, assignees: ['bob-work'], labels: [] },
      ],
    }),
    assignableUsers: () => ({ ok: true, users: ['alice', 'bob-work'] }),
    // Session details → GitHub: a monitor's lines and the PR watch's finds, newest first.
    watchEvents: (id: string) =>
      id.startsWith('pr:')
        ? [
            { at: Date.now() - 20 * 60_000, kind: 'review', by: 'sam', text: 'The redirect should keep the hash too; see the comment on redirect.ts.' },
            { at: Date.now() - 45 * 60_000, kind: 'thread', by: 'sam', text: 'Why not use URL() here instead of splitting by hand?' },
            { at: Date.now() - 46 * 60_000, kind: 'thread', by: 'riley', text: 'This test needs a case for an empty next param.' },
            { at: Date.now() - 170 * 60_000, kind: 'note', text: '[MasterDeck PR watch] web#131: already has 0 unresolved review threads and 1 PR comment from before the watch started.' },
          ]
        : Array.from({ length: 7 }, (_, i) => ({ at: Date.now() - (3 + i * 12) * 60_000, text: i === 0 ? '{"status":"degraded","failing":["auth-callback"],"version":"2026.10.12-3"}' : '{"status":"ok","version":"2026.10.12-2"}' })),
    prDetail: () => ({
      ok: true,
      detail: {
        checks: [
          { name: 'e2e (login)', state: 'failure', url: 'https://github.com/acme/web/actions/runs/1' },
          { name: 'lint', state: 'pending', url: null },
          { name: 'build', state: 'success', url: 'https://github.com/acme/web/actions/runs/2' },
          { name: 'unit', state: 'success', url: 'https://github.com/acme/web/actions/runs/3' },
          { name: 'claude-review', state: 'success', url: 'https://github.com/acme/web/actions/runs/4' },
        ],
        reviews: [
          { author: 'sam', state: 'CHANGES_REQUESTED', at: Date.now() - 20 * 60_000, url: 'https://github.com/acme/web/pull/131#pullrequestreview-1' },
          { author: 'claude', state: 'COMMENTED', at: Date.now() - 2 * 3600_000, url: 'https://github.com/acme/web/pull/131#pullrequestreview-2' },
        ],
        threads: [
          { path: 'src/auth/redirect.ts', author: 'sam', text: 'Why not use URL() here instead of splitting by hand?', url: 'https://github.com/acme/web/pull/131#discussion_r1' },
          { path: 'src/auth/redirect.test.ts', author: 'riley', text: 'This test needs a case for an empty next param.', url: 'https://github.com/acme/web/pull/131#discussion_r2' },
        ],
        comments: [{ author: 'riley', at: Date.now() - 2.5 * 3600_000, text: 'Deployed to staging for a look.', url: 'https://github.com/acme/web/pull/131#issuecomment-1' }],
      },
    }),
    // Tools → Mods: switch in the fixture, as the Mac would after its next state.
    modSet: (key: string, mod: string, on: boolean) => {
      const off = new Set(state.modOff?.[key] ?? [])
      if (on) off.delete(mod)
      else off.add(mod)
      state.modOff = { ...state.modOff, [key]: [...off].sort() }
      for (const cb of stateCbs) cb({ ...state })
      return ok
    },
    // The Start dialog: a draft with no checkout found, so its folder line shows at phone width. A
    // chosen folder must be one of `repos`, as the Mac's guard (`chosenFolder`) answers a browser.
    draftAssign: (t: { number: number; repo: string | null }, title?: string, url?: string, cwd?: string) =>
      cwd && !repos.some((r) => r.path === cwd)
        ? { ok: false, message: `From the web app a session starts only in one of the workspace's repositories: ${cwd} is not one.` }
        : {
            ok: true,
            draft: { issue: t.number, repo: t.repo, name: `${t.number}-preview`, cwd: cwd ?? '/Users/dev/acme', prompt: `You own #${t.number} (${title ?? ''}). ${url ?? ''}`, summary: '', title: title ?? '', url: url ?? '', proposalId: null, workspace: '/Users/dev/acme', found: cwd ? cwd.endsWith('/web') : false, checkoutOf: t.repo ?? 'acme/web' },
          },
  }
  const local: Record<string, unknown> = {
    notesList: async () => sortNotes([...notes.values()].map(noteMeta)),
    notesGet: async (id: string) => notes.get(id) ?? null,
    notesSearch: async (q: string) => [...notes.values()].filter((n) => matches(n, q)).map((n) => n.id),
    notesSave: async (i: NoteInput) => noteSave(i),
    notesDelete: async (id: string) => {
      const had = notes.delete(id)
      if (had) for (const cb of noteCbs) cb({ id, deleted: true })
      return { ok: true }
    },
    onNotesChanged: (cb: (c: NoteChange) => void) => (noteCbs.add(cb), () => noteCbs.delete(cb)),
    btwList: async (key: string) => btwList(key),
    btwAsk: async (key: string, q: string) => btwAsk(key, q),
    btwStop: async (key: string, id: string) => {
      const t = btwTimers.get(id)
      const e = btwList(key).find((x) => x.id === id)
      if (!t || !e) return false
      clearInterval(t)
      btwTimers.delete(id)
      btwPut(key, { ...btwList(key).find((x) => x.id === id)!, status: 'stopped', doneAt: Date.now() })
      return true
    },
    btwRemove: async (key: string, id: string) => {
      btw.set(key, btwList(key).filter((e) => e.id !== id))
      for (const cb of btwCbs) cb({ key, removed: id })
      return true
    },
    onBtwEvent: (cb: (e: BtwEvent) => void) => (btwCbs.add(cb), () => btwCbs.delete(cb)),
    // A session's folder: a few files, two changed, one new (session tabs, Details → Diff / Files).
    filesList: async () => ({ ok: true, paths: Object.keys(PREVIEW_FILES).sort(), truncated: false }),
    filesRead: async (_key: string, path: string) => {
      const text = PREVIEW_FILES[path]
      if (text === undefined) return { ok: true, path, text: null, refused: 'missing', bytes: 0, mtimeMs: 0 }
      if (path.endsWith('.png')) return { ok: true, path, text: null, refused: 'binary', bytes: 2048, mtimeMs: Date.now() }
      return { ok: true, path, text, refused: null, bytes: text.length, mtimeMs: Date.now() }
    },
    diffList: async (_key: string, base: string) => ({
      ok: true,
      files: [
        { path: 'README.md', status: 'modified', add: 3, del: 1, binary: false },
        { path: 'src/auth/redirect.ts', status: 'modified', add: 4, del: 2, binary: false },
        { path: 'src/auth/redirect.test.ts', status: 'added', add: 9, del: 0, binary: false, untracked: true },
        ...(base === 'branch' ? [{ path: 'docs/old-auth.md', status: 'deleted', add: 0, del: 12, binary: false }] : []),
      ],
    }),
    diffFile: async (_key: string, path: string) => ({ ok: true, path, diff: parseDiff(PREVIEW_DIFFS[path] ?? '') }),
    platform: 'web',
    home: '/Users/dev',
    openExternal: () => {},
    openLink: () => {},
    copy: () => {},
    setFocus: () => {},
    setVisible: () => {},
    setBoardOpen: () => {},
    ptyWrite: (id: string, d: string) => echo(id, d),
    ptyResize: () => {},
    ptyClose: () => {},
    setSprint: () => {},
    onState: (cb: (s: AppState) => void) => (stateCbs.add(cb), () => stateCbs.delete(cb)),
    onPtyData: (id: string, cb: (d: string, seq: number) => void) => {
      const set = pty.get(id) ?? new Set()
      pty.set(id, set.add(cb))
      return () => set.delete(cb)
    },
  }
  return new Proxy({} as DeckApi, {
    get(_t, name) {
      if (typeof name !== 'string' || !Object.hasOwn(DECK_ACCESS, name)) return undefined
      if (name in local) return local[name]
      const a = DECK_ACCESS[name as keyof DeckApi]
      if (/^on[A-Z]/.test(name)) return () => () => {}
      if (a.kind === 'blocked') return () => Promise.reject(new Error('Not available on the web yet'))
      return async (...args: never[]) => (calls[name] ? calls[name](...args) : ok)
    },
  })
}

export function mountPreview(root: Root, which: string): void {
  if (which === 'gate') {
    root.render(
      <Card title="MasterDeck">
        <p>Control MasterDeck on your Mac from this browser.</p>
        <button className="btn primary">Sign in</button>
      </Card>,
    )
    return
  }
  window.deck = previewDeck(which === 'noboard', which === 'accounts')
  root.render(
    <>
      <App />
      <button className="web-signout">Sign out</button>
    </>,
  )
}

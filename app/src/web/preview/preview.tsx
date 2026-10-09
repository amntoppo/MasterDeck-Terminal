// DEV ONLY: `npm run dev:web`, then open /?preview (the app on a stub deck), /?preview=noboard (an account with no
// GitHub board) or /?preview=gate (the sign-in card).
// main.tsx imports this only under import.meta.env.DEV, so `npm run build:web` leaves it out.
import type { Root } from 'react-dom/client'
import { DECK_ACCESS } from '@shared/remoteDeck'
import type { DeckApi } from '@shared/ipc'
import type { AppState } from '@shared/types'
import { matches, noteMeta, sortNotes, ticketNoteId, type Note, type NoteChange, type NoteInput } from '@shared/notes'
import { App } from '@renderer/App'
import { Card } from '../Gate'
import { layoutFlow, newLoop, type Flow } from '@shared/flow'
import { fakeScreen, fixtureState, SESSIONS } from './fixture'

type Fn = (...a: never[]) => unknown

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
function previewDeck(noBoard: boolean): DeckApi {
  const state: AppState = fixtureState(noBoard)
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
    notes.set(id, note)
    const meta = noteMeta(note)
    for (const cb of noteCbs) cb({ id, meta })
    return { ok: true as const, meta }
  }
  const ok = { ok: true, message: 'preview: nothing was sent' }
  // The folders the Mac found: the workspace and its repositories (a long path to see the phone width).
  const repos = ['/Users/dev/acme', '/Users/dev/acme/web', '/Users/dev/acme/api', '/Users/dev/acme/clients/mobile-app-with-a-long-folder-name'].map((path) => ({ name: path.split('/').pop() ?? path, path }))
  const calls: Record<string, Fn> = {
    getState: () => state,
    getSettings: () => state.settings,
    setSettings: (s: never) => s,
    ptyOpen: (id: never) => ({ ok: true, replay: fakeScreen(String(id).replace(/^.*:/, '')), seq: 1, exited: false }),
    queueList: () => [],
    templates: () => [],
    ticketMemory: () => [],
    searchHistory: () => [],
    janitor: () => [],
    standupCommits: () => [],
    tokensByDay: () => ({}),
    workspaceRepos: () => repos,
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
    workflowGet: () => ({ hooks: [], skills: [], flow: loopFlow(), templates: [{ id: 'default', name: 'Default', flow: loopFlow() }], triggers: [], monitors: [] }),
    defaultModel: () => null,
    ticketRepoMeta: () => ({ labels: [], milestones: [], assignees: [] }),
    issueBody: () => ({ ok: true, body: '## Steps\n\n1. Sign in from a fresh browser.\n2. Open **Settings**.\n\nThe page is blank; expected the settings form.' }),
    // Two on the board (their columns show), one closed, one open off the board.
    issueSubIssues: () => ({
      ok: true,
      subIssues: [
        { repo: null, number: 118, title: 'Export invoices as CSV', url: 'https://github.com/acme/web/issues/118', state: 'open' },
        { repo: null, number: 125, title: 'Dark mode for settings', url: 'https://github.com/acme/web/issues/125', state: 'open' },
        { repo: null, number: 101, title: 'Keep the session cookie across restarts', url: 'https://github.com/acme/web/issues/101', state: 'closed' },
        { repo: null, number: 102, title: 'Show the sign-in error under the form', url: 'https://github.com/acme/web/issues/102', state: 'open' },
      ],
    }),
    assignableUsers: () => ({ ok: true, users: ['alice', 'bob-work'] }),
    // Session details → Mods: switch in the fixture, as the Mac would after its next state.
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
    platform: 'web',
    home: '/Users/dev',
    openExternal: () => {},
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
  window.deck = previewDeck(which === 'noboard')
  root.render(
    <>
      <App />
      <button className="web-signout">Sign out</button>
    </>,
  )
}

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
import { fakeScreen, fixtureState } from './fixture'

type Fn = (...a: never[]) => unknown

/** `window.deck` with fixture answers: same blocked/local split as the real RemoteDeck, nothing leaves the page. */
function previewDeck(noBoard: boolean): DeckApi {
  const state: AppState = fixtureState(noBoard)
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
    sessionWorkflowGet: () => null,
    workflowDraftGet: () => null,
    workflowGet: () => ({ hooks: [], skills: [], flow: null, templates: [], triggers: [], monitors: [] }),
    defaultModel: () => null,
    ticketRepoMeta: () => ({ labels: [], milestones: [], assignees: [] }),
    issueBody: () => ({ ok: true, body: 'Steps to reproduce: sign in from a fresh browser.' }),
    assignableUsers: () => ({ ok: true, users: ['alice', 'bob-work'] }),
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

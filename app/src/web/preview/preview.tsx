// DEV ONLY: `npm run dev:web`, then open /?preview (the app on a stub deck), /?preview=noboard (an account with no
// GitHub board) or /?preview=gate (the sign-in card).
// main.tsx imports this only under import.meta.env.DEV, so `npm run build:web` leaves it out.
import type { Root } from 'react-dom/client'
import { DECK_ACCESS } from '@shared/remoteDeck'
import type { DeckApi } from '@shared/ipc'
import type { AppState } from '@shared/types'
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
  const ok = { ok: true, message: 'preview: nothing was sent' }
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
    workspaceRepos: () => [{ name: 'web', path: '/Users/dev/acme/web' }],
    summaryGet: () => ({ summary: null, stale: false }),
    workflowStatus: () => null,
    sessionWorkflowGet: () => null,
    workflowDraftGet: () => null,
    workflowGet: () => ({ hooks: [], skills: [], flow: null, templates: [], triggers: [], monitors: [] }),
    defaultModel: () => null,
    ticketRepoMeta: () => ({ labels: [], milestones: [], assignees: [] }),
    issueBody: () => ({ ok: true, body: 'Steps to reproduce: sign in from a fresh browser.' }),
  }
  const local: Record<string, unknown> = {
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

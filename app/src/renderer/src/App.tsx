import { sameTicket, ticketLabel, ticketOf, ticketUrl, type Ticket } from '@shared/ticket'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sessionForIssue, sessionTicket } from '@shared/derive'
import type { AppState, Issue, Session, BoardCard } from '@shared/types'
import type { AssignRequest } from '@shared/ipc'
import { AssignDialog } from './components/AssignDialog'
import { AssignPopup } from './components/AssignPopup'
import { BroadcastDialog } from './components/BroadcastDialog'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { CostsView } from './components/CostsView'
import { JanitorView } from './components/HygieneViews'
import { PrsView } from './components/PrsView'
import { SetupDialog } from './components/SetupDialog'
import { SprintSummaryDialog, StandupDialog } from './components/SummaryDialogs'
import { BoardView } from './components/BoardView'
import { PrPopup } from './components/PrPopup'
import { StartHereDialog } from './components/StartHereDialog'
import { LinkDialog } from './components/LinkDialog'
import { MasterPane, masterPaneId } from './components/MasterPane'
import { ConnectGithub } from './components/ConnectGithub'
import { RestoreBanner } from './components/RestoreBanner'
import { SkillsDialog } from './components/SkillsDialog'
import { WorkflowView } from './components/WorkflowView'
import { Sidebar, type View } from './components/Sidebar'
import { TasksView } from './components/TasksView'
import { Rail } from './components/Rail'
import { Inspector, type InspectorTab } from './components/Inspector'
import { SettingsView, type SettingsSection } from './components/SettingsView'
import { WorktreesDialog } from './components/WorktreesDialog'
import { HistoryDialog } from './components/HistoryDialog'
import { FindBar, type FindTarget } from './components/FindBar'
import { cycle, matchShortcut } from '@shared/shortcuts'
import { TerminalView, typeInto } from './components/TerminalView'
import { deck, load, save, useAppState } from './deck'

type Tab =
  | { id: string; kind: 'session'; key: string }
  | { id: string; kind: 'shell'; cwd: string; title: string }
  /** A session being started from the Start dialog; becomes a session tab when it appears. */
  | {
      id: string
      kind: 'pending'
      name: string
      issue: number
      startedAt: number
      /** A new session from the Start dialog or a review. */
      req?: AssignRequest
      /** Or: a session from another terminal, resumed here. */
      here?: HereOpts
      error?: string
      proposalId?: number
    }

const MIN_MASTER = 300
const MIN_PANEL = 340
/** The views ⇧← / ⇧→ step through, in the order of the switch at the top of the sidebar. */
const MAIN_VIEWS: View[] = ['terminals', 'board', 'prs', 'tasks']
const SIDE_W = 272
const MIN_SIDE = 200
const MAX_SIDE = 560

type HereOpts = { sessionId: string; name: string; cwd: string; pid: number | null; stopOther: boolean; linkIssue: Ticket | null }

function paneIdFor(tab: Tab): string {
  return tab.kind === 'session' ? `s:${tab.key}` : tab.id
}

export function App() {
  const state = useAppState()
  const [tabs, setTabs] = useState<Tab[]>(() =>
    load<Tab[]>('tabs', []).filter((t) => (t.kind === 'session' ? typeof t.key === 'string' : t.kind === 'shell')),
  )
  const [active, setActive] = useState<string | null>(() => load<string | null>('active', null))
  const [split, setSplit] = useState<string | null>(null)
  // Tabs restored from the last run start their terminal only after a click: attaching resumes a
  // parked background session, which should never happen just because the app launched.
  const [armed, setArmed] = useState<Set<string>>(() => new Set())
  const arm = useCallback((id: string) => setArmed((cur) => (cur.has(id) ? cur : new Set(cur).add(id))), [])
  const activate = useCallback(
    (id: string) => {
      setActive(id)
      arm(id)
    },
    [arm],
  )
  const [assigning, setAssigning] = useState<Issue | null>(null)
  const [linking, setLinking] = useState<Issue | null>(null)
  const [prCard, setPrCard] = useState<BoardCard | null>(null)
  const [assignCard, setAssignCard] = useState<BoardCard | null>(null)
  const issueOf = useCallback(
    (card: BoardCard): Issue =>
      state?.issues.find((i) => sameTicket(i, card)) ?? {
        number: card.number,
        repo: card.repo ?? null,
        project: card.project ?? null,
        title: card.title,
        url: card.url,
        status: card.status,
        currentSprint: true,
        assignedToMe: true,
      },
    [state?.issues],
  )
  // Master's column width (% of the window), on every screen; the Terminals panel's width.
  const [masterPct, setMasterPct] = useState<number>(() => load('masterPct', 34))
  const [inspPct, setInspPct] = useState<number>(() => load('inspPct', 28))
  // The Master button (top right, every screen) shows or hides master; hidden, it stays attached.
  const [masterOpen, setMasterOpen] = useState(() => load<boolean>('masterOpen', true))
  const [view, setView] = useState<View>(() => {
    const v = load<string>('view', 'terminals')
    return (['terminals', 'board', 'prs', 'tasks', 'costs', 'janitor', 'workflow', 'settings'] as View[]).includes(v as View) ? (v as View) : 'terminals'
  })
  const [palette, setPalette] = useState(false)
  // History (⌘⇧F): a popup over any screen.
  const [historyOpen, setHistoryOpen] = useState(false)
  // ⌘F: find on the Terminals, Board or PRs screen; `at` reopens it (and refocuses) on each press.
  const [findAt, setFindAt] = useState<number | null>(null)
  useEffect(() => setFindAt(null), [view])
  const [worktreesFor, setWorktreesFor] = useState<Session | null>(null)
  const [settingsAt, setSettingsAt] = useState<{ section: SettingsSection; at: number } | null>(null)
  const [dialog, setDialog] = useState<'broadcast' | 'standup' | 'sprint-summary' | 'settings' | 'shortcuts' | 'setup' | 'skills' | 'skills-first' | null>(null)
  // First launch without a config: Setup opens once (Skip remembers it; Settings → Set up MasterDeck reopens it).
  const [showFirstRun, setShowFirstRun] = useState(() => !load<boolean>('setupSkipped', false))
  const [startWith, setStartWith] = useState<string | undefined>(undefined)
  // Which column edge is being dragged: the Terminals panel's, or master's.
  const [dragging, setDragging] = useState<false | 'panel' | 'master'>(false)
  // The left sidebar's width, dragged at its right edge (double-click resets it).
  const [sideW, setSideW] = useState<number>(() => load('sideW', SIDE_W))
  const [sideDragging, setSideDragging] = useState(false)
  // The Terminals screen's right panel: its tab (Details, Queue, Summary) and whether it shows.
  const [inspTab, setInspTab] = useState<InspectorTab>(() => load<InspectorTab>('inspTab', 'details'))
  const [inspOpen, setInspOpen] = useState(() => load<boolean>('inspOpen', true))
  const showPanel = useCallback((t: InspectorTab) => {
    setView('terminals')
    setInspTab(t)
    setInspOpen(true)
  }, [])
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const needsYouRef = useRef<HTMLDivElement>(null)
  // A clicked notification's Needs-you item, for the Sidebar to open.
  const [showItem, setShowItem] = useState<{ id: string; at: number } | null>(null)
  const appRef = useRef<HTMLDivElement>(null)

  useEffect(() => save('tabs', tabs), [tabs])
  useEffect(() => save('active', active), [active])
  useEffect(() => save('masterPct', masterPct), [masterPct])
  useEffect(() => save('sideW', sideW), [sideW])
  useEffect(() => save('inspTab', inspTab), [inspTab])
  useEffect(() => save('inspPct', inspPct), [inspPct])
  useEffect(() => save('masterOpen', masterOpen), [masterOpen])
  useEffect(() => save('inspOpen', inspOpen), [inspOpen])
  useEffect(() => {
    save('view', view)
    deck().setBoardOpen(view === 'board')
  }, [view])
  useEffect(() => {
    document.body.classList.toggle('win', deck().platform === 'win32')
  }, [])

  const flash = useCallback((text: string, bad = false) => {
    setToast({ text, bad })
    setTimeout(() => setToast(null), 2600)
  }, [])

  const openSession = useCallback((s: Session) => {
    setView('terminals')
    const id = `tab:${s.key}`
    setTabs((cur) => (cur.some((t) => t.id === id) ? cur : [...cur, { id, kind: 'session', key: s.key }]))
    activate(id)
  }, [activate])

  // A new shell starts in the workspace chosen in Setup (home until there is one).
  const workspace = state?.config.workspace || ''
  // In the workspace, + Shell first puts the checkout on its default branch (main or dev),
  // stashing what was on the old one, so a session started there starts from it.
  const openShell = useCallback(async (cwd?: string) => {
    const id = `sh:${Date.now()}`
    const dir = cwd ?? (workspace || deck().home)
    if (!cwd && workspace) {
      const r = await deck().shellPrepare(dir)
      if (r.message) flash(r.message, !r.ok)
    }
    setTabs((cur) => [...cur, { id, kind: 'shell', cwd: dir, title: dir.split(/[\\/]/).pop() || 'shell' }])
    activate(id)
  }, [activate, workspace, flash])

  const closeTab = useCallback(
    (id: string) => {
      setTabs((cur) => {
        const tab = cur.find((t) => t.id === id)
        if (tab) deck().ptyClose(paneIdFor(tab))
        const rest = cur.filter((t) => t.id !== id)
        if (active === id) setActive(rest.length ? rest[Math.max(0, cur.findIndex((t) => t.id === id) - 1)].id : null)
        return rest
      })
      if (split === id) setSplit(null)
    },
    [active, split],
  )

  const onIssue = useCallback(
    (issue: Issue) => {
      if (!state) return
      const owner = sessionForIssue(state.sessions, ticketOf(issue))
      if (owner) openSession(owner)
      else setAssigning(issue)
    },
    [state, openSession],
  )

  /** Start: switch to the terminal at once with a "Starting…" tab, and spawn in the background. */
  const startSession = useCallback(
    (req: AssignRequest) => {
      const id = `pending:${req.name}:${Date.now()}`
      setView('terminals')
      setTabs((cur) => [...cur, { id, kind: 'pending', name: req.name, issue: req.issue, startedAt: Date.now(), req }])
      activate(id)
      void deck()
        .assign(req)
        .then((r) => {
          if (!r.ok) setTabs((cur) => cur.map((t) => (t.id === id && t.kind === 'pending' ? { ...t, error: r.message, proposalId: r.proposalId } : t)))
        })
    },
    [activate],
  )

  /** Start here: turn the tab into a "Starting…" tab and resume the session as a background one. */
  const startHere = useCallback(
    (tabId: string, s: Session, stopOther: boolean) => {
      const id = `pending:${s.name}:${Date.now()}`
      const here: HereOpts = { sessionId: s.sessionId, name: s.name, cwd: s.cwd, pid: s.pid, stopOther, linkIssue: sessionTicket(s) }
      setView('terminals')
      setTabs((cur) => {
        const t: Tab = { id, kind: 'pending', name: s.name, issue: s.issue ?? 0, startedAt: Date.now(), here }
        return cur.some((x) => x.id === tabId) ? cur.map((x) => (x.id === tabId ? t : x)) : [...cur, t]
      })
      activate(id)
      void deck()
        .startHere(here)
        .then((r) => {
          if (!r.ok) setTabs((cur) => cur.map((x) => (x.id === id && x.kind === 'pending' ? { ...x, error: r.message } : x)))
        })
    },
    [activate],
  )

  const retryStart = useCallback((id: string) => {
    setTabs((cur) => cur.map((t) => (t.id === id && t.kind === 'pending' ? { ...t, error: undefined, startedAt: Date.now() } : t)))
    const t = tabs.find((x) => x.id === id)
    if (t?.kind !== 'pending') return
    if (t.here) {
      // The other copy was already stopped (or left running on purpose): don't stop anything again.
      void deck()
        .startHere({ ...t.here, stopOther: false })
        .then((r) => {
          if (!r.ok) setTabs((cur) => cur.map((x) => (x.id === id && x.kind === 'pending' ? { ...x, error: r.message } : x)))
        })
      return
    }
    if (!t.req) return
    // The failed spawn left its proposal held; spawn that one again. With no proposal yet, start over.
    const again: AssignRequest = t.proposalId !== undefined ? { ...t.req, proposalId: t.proposalId, edited: false, approved: true } : t.req
    void deck()
      .assign(again)
      .then((r) => {
        if (!r.ok) setTabs((cur) => cur.map((x) => (x.id === id && x.kind === 'pending' ? { ...x, error: r.message } : x)))
      })
  }, [tabs])

  // A "Starting…" tab becomes the real session tab as soon as `claude agents` lists it.
  useEffect(() => {
    if (!state) return
    const found = tabs.flatMap((t) => {
      if (t.kind !== 'pending') return []
      // A resumed session must resolve to the new background copy, not the terminal one of the same name.
      const s = state.sessions.find(
        (x) => x.name === t.name && x.state !== 'done' && x.startedAt >= t.startedAt - 10_000 && (!t.here || x.kind === 'background'),
      )
      return s ? [{ pendingId: t.id, s, linkIssue: t.here?.linkIssue ?? null }] : []
    })
    if (found.length === 0) return
    let next = tabs
    for (const { pendingId, s, linkIssue } of found) {
      // The resumed conversation has a new session id: keep its ticket link.
      if (linkIssue && !sameTicket(sessionTicket(s), linkIssue)) void deck().linkSession(linkIssue, s.sessionId, s.cwd)
      const tabId = `tab:${s.key}`
      next = next.some((t) => t.id === tabId)
        ? next.filter((t) => t.id !== pendingId)
        : next.map((t): Tab => (t.id === pendingId ? { id: tabId, kind: 'session', key: s.key } : t))
      arm(tabId)
      if (active === pendingId) setActive(tabId)
    }
    setTabs(next)
  }, [state, tabs, active, arm])

  useEffect(() => {
    // A session that just blocked on a prompt: add its tab (attached, so the prompt shows) without
    // taking focus from what the user is doing.
    const offAuto = deck().onAutoOpen((key) => {
      const s = state?.sessions.find((x) => x.key === key)
      if (!s || s.kind !== 'background') return
      const id = `tab:${key}`
      setTabs((cur) => (cur.some((t) => t.id === id) ? cur : [...cur, { id, kind: 'session', key }]))
      arm(id)
    })
    const offFocus = deck().onFocusSession((key) => {
      const s = state?.sessions.find((x) => x.key === key)
      if (s) openSession(s)
    })
    const offNeeds = deck().onShowNeedsYou(() => needsYouRef.current?.scrollIntoView({ behavior: 'smooth' }))
    const offItem = deck().onShowInboxItem((id) => setShowItem({ id, at: Date.now() }))
    return () => {
      offAuto()
      offFocus()
      offNeeds()
      offItem()
    }
  }, [state, openSession, arm])

  const activeTab = tabs.find((t) => t.id === active) ?? null
  const activeKey = activeTab?.kind === 'session' ? activeTab.key : null
  const activeSessionId = activeKey ? (state?.sessions.find((x) => x.key === activeKey)?.sessionId ?? null) : null

  useEffect(() => {
    deck().setFocus(activeSessionId)
  }, [activeSessionId])

  const visibleIds = useMemo(() => {
    const keys = new Set(tabs.flatMap((t) => (t.kind === 'session' ? [t.key] : [])))
    const ids = (state?.sessions ?? []).filter((x) => keys.has(x.key)).map((x) => x.sessionId)
    if (state?.master.kind === 'attached') ids.push(state.master.session.sessionId)
    return ids
  }, [tabs, state?.sessions, state?.master])
  const visibleKey = visibleIds.join(',')
  useEffect(() => {
    deck().setVisible(visibleIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey])

  // Keyboard: Cmd/Ctrl+1..9 switch tabs, Cmd/Ctrl+Shift+W closes the tab.
  const toggleSplit = () => {
    if (split) setSplit(null)
    else {
      const other = tabs.find((t) => t.id !== active)
      if (other) {
        setSplit(other.id)
        arm(other.id)
      }
    }
  }

  // Keyboard shortcuts (shared/shortcuts.ts; listed in Settings). Caught before a terminal sees
  // them, so Shift+arrows move around instead of reaching the shell.
  const onShortcut = useRef<(e: KeyboardEvent) => void>(() => {})
  onShortcut.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null
    const inTextField = !!el && !el.classList.contains('xterm-helper-textarea') && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
    const dialogOpen = !!document.querySelector('.backdrop')
    const hit = matchShortcut(e, { platform: deck().platform, inTextField, dialogOpen })
    if (!hit || !state) return
    const done = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    const goTab = (id: string | null) => {
      if (!id) return
      setView('terminals')
      activate(id)
    }
    switch (hit.id) {
      case 'view-prev':
      case 'view-next':
        setView((v) => cycle(MAIN_VIEWS, MAIN_VIEWS.includes(v) ? v : null, hit.id === 'view-next' ? 1 : -1) ?? v)
        return done()
      case 'tab-prev':
      case 'tab-next':
        goTab(cycle(tabs.map((t) => t.id), active, hit.id === 'tab-next' ? 1 : -1))
        return done()
      case 'tab-n':
        goTab(tabs[(hit.n ?? 1) - 1]?.id ?? null)
        return done()
      case 'close-tab':
        if (active) closeTab(active)
        return done()
      case 'new-shell':
        void openShell()
        return done()
      case 'palette':
        setPalette((p) => !p)
        return done()
      case 'needs-you': {
        const first = state.inbox.open[0]
        if (first) setShowItem({ id: first.item.id, at: Date.now() })
        else flash('Nothing needs you')
        return done()
      }
      case 'worktree': {
        const s = activeKey ? state.sessions.find((x) => x.key === activeKey) : null
        if (s) setWorktreesFor(s)
        else flash('Open a session tab first')
        return done()
      }
      case 'split':
        toggleSplit()
        return done()
      case 'master':
        if (state.config.masterEnabled) setMasterOpen((o) => !o)
        return done()
      case 'refresh':
        void deck().refresh()
        flash('Refreshing from GitHub…')
        return done()
      case 'settings':
        setSettingsAt({ section: 'general', at: Date.now() })
        setView('settings')
        return done()
      case 'history':
        setHistoryOpen((o) => !o)
        return done()
      case 'find':
        if (view === 'terminals' || view === 'board' || view === 'prs') {
          setFindAt(Date.now())
          return done()
        }
        return
      case 'shortcuts':
        setSettingsAt({ section: 'keys', at: Date.now() })
        setView('settings')
        return done()
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onShortcut.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Sidebar edge drag
  useEffect(() => {
    if (!sideDragging) return
    const move = (e: MouseEvent) => {
      const left = appRef.current?.getBoundingClientRect().left ?? 0
      const w = appRef.current?.clientWidth ?? window.innerWidth
      setSideW(Math.round(Math.min(Math.max(e.clientX - left, MIN_SIDE), MAX_SIDE, w * 0.45)))
    }
    const up = () => setSideDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.classList.add('resizing')
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.classList.remove('resizing')
    }
  }, [sideDragging])

  // Divider drag
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent) => {
      const w = appRef.current?.clientWidth ?? window.innerWidth
      if (dragging === 'master') {
        const px = Math.min(Math.max(w - e.clientX, MIN_MASTER), w * 0.6)
        setMasterPct((px / w) * 100)
      } else {
        // The panel's right edge is master's left edge when master shows.
        const right = masterOpen && state?.config.masterEnabled ? w - Math.max(MIN_MASTER, (masterPct / 100) * w) - 6 : w
        const px = Math.min(Math.max(right - e.clientX, MIN_PANEL), w * 0.45)
        setInspPct((px / w) * 100)
      }
    }
    const up = () => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
  }, [dragging, masterOpen, masterPct, state?.config.masterEnabled])

  if (!state) {
    return (
      <div className="welcome">
        <h2>MasterDeck</h2>
        <div>Loading sessions…</div>
      </div>
    )
  }

  const runAction = (a: PaletteAction | 'palette') => {
    if (a === 'palette') setPalette(true)
    else if (a === 'refresh') void deck().refresh()
    else if (a === 'view:history') setHistoryOpen(true)
    else if (a.startsWith('view:')) setView(a.slice(5) as View)
    else if (a === 'new-shell') openShell()
    else if (a === 'start-master') void deck().masterStart()
    else if (a === 'settings') setView('settings')
    else setDialog(a as 'broadcast' | 'standup' | 'sprint-summary' | 'skills')
  }
  /** The PR popup for any PR URL (palette, PRs view): a card built from what we know. */
  const openPr = (url: string, issue: Ticket | null, title: string) => {
    const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url)
    if (!m) return
    const known = issue ? state.board?.cards.find((c) => sameTicket(c, issue)) : undefined
    const snap = state.prs.find((p) => p.url === url)
    setPrCard({
      number: issue?.number ?? 0,
      repo: issue?.repo ?? null,
      project: known?.project ?? null,
      title: known?.title ?? (issue ? state.issues.find((i) => sameTicket(i, issue))?.title : undefined) ?? title,
      url: issue ? ticketUrl(issue.repo, issue.number) : url,
      status: known?.status ?? null,
      prs: [{ url, repo: m[1], number: Number(m[2]), state: 'OPEN', ci: snap?.ci === 'success' ? 'success' : snap?.ci === 'failure' ? 'failure' : null, unresolved: snap?.unresolvedThreads ?? 0 }],
      assignees: known?.assignees ?? [],
      labels: known?.labels ?? [],
      milestone: known?.milestone ?? null,
      type: known?.type ?? null,
    })
  }
  const startWithInstructions = (issue: Issue, instructions: string) => {
    setStartWith(instructions)
    setAssigning(issue)
  }

  // Terminal tabs count as shown only in the Terminals view: another view (Tasks) may show the same
  // session's terminal at its own size, and the tab takes its size back when it shows again.
  const shown = new Set(view === 'terminals' ? ([active, split].filter(Boolean) as string[]) : [])
  // Setup can turn master-agent off: then no master pane or button, only the Queue on the right.
  const useMaster = state.config.masterEnabled
  const panelShown = view === 'terminals' && inspOpen
  const masterShown = useMaster && masterOpen
  // What ⌘F searches: the open terminal, or the Board / PRs screen's text.
  const findKey = view === 'terminals' ? (activeTab ? paneIdFor(activeTab) : '') : view
  const findTarget: FindTarget | null =
    view === 'terminals'
      ? activeTab && activeTab.kind !== 'pending'
        ? { kind: 'terminal', paneId: paneIdFor(activeTab) }
        : null
      : view === 'board' || view === 'prs'
        ? { kind: 'dom', root: () => document.querySelector<HTMLElement>('.board-view') }
        : null
  // rail · sessions · terminal · [panel] · [master]: the other screens cover all but the rail and master.
  const columns = ['var(--rail-w)', `${sideW}px`, 'minmax(0, 1fr)', ...(panelShown ? ['6px', `max(${MIN_PANEL}px, ${inspPct}%)`] : []), ...(masterShown ? ['6px', `max(${MIN_MASTER}px, ${masterPct}%)`] : [])].join(' ')
  const masterAttached = useMaster && state.master.kind === 'attached'
  const askMaster = (s: Session) => {
    if (state.master.kind !== 'attached') return
    // Typed keystrokes would answer whatever prompt master is showing, so only ask an idle master.
    if (state.master.session.state !== 'idle') {
      flash(`master-agent is ${state.master.session.state}; ask again when it is idle`, true)
      return
    }
    typeInto(masterPaneId(state.master.session.bgId!), `what is ${s.name} doing right now?`)
  }

  return (
    <div
      className={`app view-${view} ${panelShown ? '' : 'no-panel'} ${masterShown ? '' : 'master-off'}`}
      ref={appRef}
      style={{ gridTemplateColumns: columns, ['--side-w' as string]: `${sideW}px`, ['--right-w' as string]: masterShown ? `calc(max(${MIN_MASTER}px, ${masterPct}%) + 6px)` : '0px' }}
    >
      <Rail
        view={view}
        onView={setView}
        onAction={(a) => (a === 'palette' ? setPalette(true) : setDialog(a))}
        needs={state.inbox.open.filter((e) => e.item.kind !== 'held').length}
        prAttention={state.inbox.open.filter((e) => e.item.detail.type === 'offer').length + state.prs.filter((p) => p.reviewRequested).length}
      />
      <Sidebar
        state={state}
        activeKey={activeKey}
        onOpenSession={openSession}
        onIssue={onIssue}
        onNewShell={() => openShell()}
        needsYouRef={needsYouRef}
        showItem={showItem}
        view={view}
        onView={setView}
        onTool={(a) => runAction(a)}
        onStartWith={startWithInstructions}
        onSessionAction={(sess, a) => {
          if (a === 'close-tab') closeTab(`tab:${sess.key}`)
          else {
            openSession(sess)
            showPanel('summary')
          }
        }}
        split={!!split}
        onToggleSplit={tabs.length > 1 ? toggleSplit : undefined}
        others={tabs
          .filter((t): t is Exclude<Tab, { kind: 'session' }> => t.kind !== 'session')
          .map((t) => ({
            id: t.id,
            kind: t.kind,
            label: t.kind === 'shell' ? t.title : t.name,
            sub: t.kind === 'shell' ? t.cwd : t.error ? `Did not start: ${t.error}` : 'Starting…',
            active: t.id === active,
            error: t.kind === 'pending' && !!t.error,
            onOpen: () => {
              setView('terminals')
              activate(t.id)
            },
            onClose: () => closeTab(t.id),
          }))}
      />
      <div
        className={`side-resizer ${sideDragging ? 'dragging' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault()
          setSideDragging(true)
        }}
        onDoubleClick={() => setSideW(SIDE_W)}
        title="Drag to resize the sidebar · double-click to reset"
      />
      {view === 'board' && !state.config.configured && <ConnectGithub title="Board View" what="The board, sprints and issues" onConnect={() => setDialog('setup')} />}
      {view === 'board' && state.config.configured && (
        <BoardView
          state={state}
          onOpenSession={openSession}
          onStart={(card) => setAssigning(issueOf(card))}
          onPr={setPrCard}
          onAssign={setAssignCard}
          onSummary={() => setDialog('sprint-summary')}
        />
      )}
      {view === 'prs' &&
        (state.config.configured ? (
          <PrsView state={state} onOpenSession={openSession} onPr={openPr} onStartWith={startWithInstructions} />
        ) : (
          <ConnectGithub title="PRs" what="Your organization's pull requests" onConnect={() => setDialog('setup')} />
        ))}
      {view === 'tasks' && (
        <TasksView
          state={state}
          onOpenSession={openSession}
          onPr={(url) => {
            const s = state.sessions.find((x) => (state.sessionPrs[x.sessionId] ?? []).includes(url))
            openPr(url, s ? sessionTicket(s) : null, state.prLive[url]?.title ?? '')
          }}
        />
      )}
      {view === 'costs' && <CostsView state={state} onOpenSession={openSession} />}
      {view === 'janitor' && <JanitorView state={state} />}
      {view === 'workflow' && <WorkflowView state={state} />}
      {view === 'settings' && <SettingsView settings={state.settings} state={state} onSetup={() => setDialog('setup')} onSkills={() => setDialog('skills')} initial={settingsAt} />}

      <main className="workspace">
        {state.missingBinaries.includes('claude') && <div className="banner">`claude` was not found on PATH.</div>}
        <RestoreBanner state={state} />
        <div className="panes">
          {tabs.length === 0 && (
            <div className="welcome">
              <h2>No session open</h2>
              <div>Pick a session or an issue on the left, or open a shell.</div>
              <button className="btn" onClick={() => openShell()}>
                + Shell
              </button>
            </div>
          )}
          {tabs.map((t) => (
            <div key={t.id} className={`pane ${shown.has(t.id) ? '' : 'hidden'}`} onMouseDown={() => t.id !== active && activate(t.id)}>
              {t.kind === 'pending' ? (
                <div className="welcome">
                  {t.error ? (
                    <>
                      <h2>{t.name} did not start</h2>
                      <div className="error" style={{ maxWidth: 560, userSelect: 'text' }}>{t.error}</div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn" onClick={() => closeTab(t.id)}>
                          Close
                        </button>
                        <button className="btn primary" onClick={() => retryStart(t.id)}>
                          Retry
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="spinner" />
                      <h2>Starting {t.name}…</h2>
                      <div>
                        {t.here
                          ? `Resuming the conversation from the other terminal${t.here.stopOther ? ' (stopping it first)' : ''}. The terminal attaches as soon as it is up.`
                          : `#${t.issue} · the terminal attaches as soon as Claude has started the session.`}
                      </div>
                    </>
                  )}
                </div>
              ) : t.kind === 'shell' ? (
                <ShellPane tab={t} visible={shown.has(t.id)} focus={t.id === active} armed={armed.has(t.id)} onArm={() => arm(t.id)} />
              ) : (
                <SessionPane
                  tab={t}
                  state={state}
                  visible={shown.has(t.id)}
                  focus={t.id === active}
                  onClose={() => closeTab(t.id)}
                  onAskMaster={askMaster}
                  masterAttached={masterAttached}
                  armed={armed.has(t.id)}
                  onArm={() => arm(t.id)}
                  onStartHere={(s, stop) => startHere(t.id, s, stop)}
                />
              )}
            </div>
          ))}
        </div>
      </main>

      {panelShown && (
        <div className={`divider ${dragging === 'panel' ? 'dragging' : ''}`} onMouseDown={() => setDragging('panel')} title="Drag to resize the panel · double-click to hide it" onDoubleClick={() => setInspOpen(false)}>
          ⋮
        </div>
      )}
      <div className="insp-slot" style={panelShown ? undefined : { display: 'none' }}>
        <Inspector
          state={state}
          session={activeKey ? (state.sessions.find((x) => x.key === activeKey) ?? null) : null}
          activeKey={activeKey}
          tab={inspTab}
          onTab={setInspTab}
          onHide={() => setInspOpen(false)}
          onDetach={() => active && closeTab(active)}
          onAskMaster={askMaster}
          masterAttached={masterAttached}
        />
      </div>
      {masterShown && (
        <div className={`divider ${dragging === 'master' ? 'dragging' : ''}`} onMouseDown={() => setDragging('master')} title="Drag to resize master">
          ⋮
        </div>
      )}
      {/* Always mounted: master stays attached while hidden. */}
      <div className="master-slot" style={masterShown ? undefined : { display: 'none' }}>
        {useMaster && <MasterPane state={state} shown={masterShown} />}
      </div>
      {view === 'terminals' && !inspOpen && (
        <button className="panel-show" onClick={() => setInspOpen(true)} title="Show the panel: Details, Master, Queue, Summary">
          ‹ Panel
        </button>
      )}

      {assigning && (
        <AssignDialog
          issue={assigning}
          state={state}
          onClose={() => {
            setAssigning(null)
            setStartWith(undefined)
          }}
          onStart={startSession}
          initialInstructions={startWith}
          onLink={() => {
            setLinking(assigning)
            setAssigning(null)
          }}
        />
      )}
      {prCard && <PrPopup card={prCard} state={state} onClose={() => setPrCard(null)} onStartReview={startSession} />}
      {palette && (
        <CommandPalette
          state={state}
          onClose={() => setPalette(false)}
          onAction={runAction}
          onOpenSession={openSession}
          onIssue={(i) => {
            const s = sessionForIssue(state.sessions, ticketOf(i))
            if (s) openSession(s)
            else setAssigning(i)
          }}
          onPr={openPr}
        />
      )}
      {dialog === 'broadcast' && (
        <BroadcastDialog
          state={state}
          onClose={() => setDialog(null)}
          livePanes={new Set(tabs.flatMap((t) => (t.kind === 'session' && armed.has(t.id) ? [t.key] : [])))}
        />
      )}
      {dialog === 'standup' && <StandupDialog state={state} onClose={() => setDialog(null)} />}
      {dialog === 'sprint-summary' && <SprintSummaryDialog state={state} onClose={() => setDialog(null)} />}
      {findAt !== null && findTarget && (
        <div className="find-slot" style={{ right: `calc(var(--right-w, 0px) + ${panelShown ? `max(${MIN_PANEL}px, ${inspPct}%) + 6px` : '0px'} + 14px)` }}>
          <FindBar key={`${view}:${findKey}:${findAt}`} target={findTarget} onClose={() => setFindAt(null)} />
        </div>
      )}
      {historyOpen && <HistoryDialog state={state} onOpenSession={openSession} onClose={() => setHistoryOpen(false)} />}
      {worktreesFor && (
        <WorktreesDialog
          session={worktreesFor}
          worktrees={state.sessionWorktrees[worktreesFor.key] ?? []}
          dir={state.stats[worktreesFor.sessionId]?.currentDir ?? state.tails[worktreesFor.sessionId]?.cwd ?? worktreesFor.cwd}
          onClose={() => setWorktreesFor(null)}
        />
      )}
      {(dialog === 'setup' || (showFirstRun && !state.config.configured)) && (
        <SetupDialog
          state={state}
          firstRun={dialog !== 'setup'}
          onClose={() => {
            // After the first-run setup (finished or skipped), the skills come next, once.
            const first = dialog !== 'setup' && !load<boolean>('skillsShown', false)
            setDialog(first ? 'skills-first' : null)
            setShowFirstRun(false)
            save('setupSkipped', true)
          }}
        />
      )}
      {(dialog === 'skills' || dialog === 'skills-first') && (
        <SkillsDialog
          state={state}
          firstRun={dialog === 'skills-first'}
          onClose={() => {
            setDialog(null)
            save('skillsShown', true)
          }}
        />
      )}
      {assignCard && (
        <AssignPopup
          card={assignCard}
          state={state}
          onClose={() => setAssignCard(null)}
          onAssigned={(card, login) => {
            if (login === state.me) setAssigning(issueOf({ ...card, assignees: [login] }))
            else flash(`${ticketLabel(card.repo, card.number)} assigned to ${login}`)
          }}
        />
      )}
      {linking && (
        <LinkDialog
          issue={linking}
          state={state}
          onClose={() => setLinking(null)}
          onLinked={(s) => {
            flash(s ? `${s.name} linked to ${ticketLabel(linking.repo, linking.number)}` : `Linked to ${ticketLabel(linking.repo, linking.number)}`)
            if (s) openSession(s)
          }}
        />
      )}
      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div>}
      {dragging && <div style={{ position: 'fixed', inset: 0, zIndex: 40, cursor: 'col-resize' }} />}
      {/* Last on purpose: Electron applies drag and no-drag regions in DOM order, so a button placed
          before the headers under it (drag regions for moving the window) could not be clicked. */}
      {useMaster && (
        <button className={`master-toggle ${masterOpen ? 'on' : ''}`} onClick={() => setMasterOpen((o) => !o)} title={`${masterOpen ? 'Hide master (it keeps running)' : 'Show master'}  ⌘⇧M`}>
          <span className="star">★</span> Master
        </button>
      )}
    </div>
  )
}

function ShellPane(p: { tab: Extract<Tab, { kind: 'shell' }>; visible: boolean; focus: boolean; armed: boolean; onArm: () => void }) {
  const { tab, visible, focus } = p
  const [exited, setExited] = useState(false)
  const [gen, setGen] = useState(0)
  if (!p.armed) return <NotStarted label={`Shell in ${tab.cwd}`} action="Open shell" onStart={p.onArm} />
  return (
    <>
      <TerminalView paneId={tab.id} spec={{ kind: 'shell', cwd: tab.cwd }} visible={visible} focusOnShow={focus} generation={gen} onExit={() => setExited(true)} />
      {exited && (
        <div className="overlay" style={{ position: 'relative', flex: 'none', padding: 10 }}>
          <span>Shell exited.</span>
          <button
            className="btn"
            onClick={() => {
              deck().ptyClose(tab.id)
              setExited(false)
              setGen(gen + 1)
            }}
          >
            Restart
          </button>
        </div>
      )}
    </>
  )
}

function SessionPane(p: {
  tab: Extract<Tab, { kind: 'session' }>
  state: AppState
  visible: boolean
  focus: boolean
  onClose: () => void
  onAskMaster: (s: Session) => void
  onStartHere: (s: Session, stopOther: boolean) => void
  masterAttached: boolean
  armed: boolean
  onArm: () => void
}) {
  const [asking, setAsking] = useState(false)
  const s = p.state.sessions.find((x) => x.key === p.tab.key)
  const [exited, setExited] = useState(false)
  const [gen, setGen] = useState(0)
  const paneId = `s:${p.tab.key}`

  if (!s) {
    return (
      <div className="welcome">
        <h2>Session no longer listed</h2>
        <div>`claude agents` does not list it anymore. It may have been removed.</div>
        <button className="btn" onClick={p.onClose}>
          Close tab
        </button>
      </div>
    )
  }

  const reattach = () => {
    deck().ptyClose(paneId)
    setExited(false)
    setGen(gen + 1)
  }

  return (
    <>
      {s.kind === 'background' && s.bgId && !p.armed ? (
        <NotStarted
          label={s.state === 'suspended' ? `${s.name} is parked. Attaching resumes it.` : `${s.name} from your last session`}
          action="Attach"
          onStart={p.onArm}
        />
      ) : s.kind === 'background' && s.bgId ? (
        <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
          <TerminalView
            paneId={paneId}
            spec={{ kind: 'attach', bgId: s.bgId }}
            visible={p.visible}
            focusOnShow={p.focus}
            generation={gen}
            onExit={() => setExited(true)}
          />
          {exited && (
            <div className="overlay">
              <h3>{s.state === 'done' ? 'Session ended' : 'Detached'}</h3>
              <div>The attach process exited. The background session keeps running unless it was stopped.</div>
              <button className="btn primary" onClick={reattach}>
                Reattach
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="welcome">
          <h2>{s.name} runs in another terminal</h2>
          <div>
            Interactive session, pid {s.pid}. It can't be attached here; the header above still tracks it.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => deck().copy(`claude --resume ${s.sessionId}`)}>
              Copy resume command
            </button>
            <button className="btn primary" onClick={() => setAsking(true)}>
              Start session here
            </button>
          </div>
          {asking && <StartHereDialog session={s} isMaster={false} onClose={() => setAsking(false)} onStart={(stop) => p.onStartHere(s, stop)} />}
        </div>
      )}
    </>
  )
}

function NotStarted({ label, action, onStart }: { label: string; action: string; onStart: () => void }) {
  return (
    <div className="welcome">
      <div>{label}</div>
      <button className="btn primary" onClick={onStart}>
        {action}
      </button>
    </div>
  )
}

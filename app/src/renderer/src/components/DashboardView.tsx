import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent } from '@shared/activityLog'
import { attentionItems, deliveryView, healthView, nowView, pruneDismissed, usageView, type AttentionItem, type Dismissal } from '@shared/dashboard'
import type { CardId } from '@shared/dashboardLayout'
import { formatRefreshed } from '@shared/format'
import type { JanitorRow } from '@shared/ipc'
import type { SchedList } from '@shared/sched'
import type { ProcsAll } from '@shared/sessionProcs'
import { parseSavedPrTabs } from '@shared/teamPrs'
import type { Ticket } from '@shared/ticket'
import { midnight } from '@shared/timeline'
import type { TokensByDay } from '@shared/tokens'
import type { AppState, Issue, Session } from '@shared/types'
import type { UpdateState } from '@shared/updates'
import { deck, load, save, useNow } from '../deck'
import { useStable } from '../useStable'
import { can, isWeb, usePhone } from '../web'
import { AttentionCard } from './dashboard/AttentionCard'
import { CustomiseCtx } from './dashboard/Card'
import { useCustomise } from './dashboard/customise'
import { DeliveryCard } from './dashboard/DeliveryCard'
import { HealthCard } from './dashboard/HealthCard'
import type { DashNav } from './dashboard/nav'
import { NowCard } from './dashboard/NowCard'
import { cleanTimeline, TimelineCard, type TimelineFilters } from './dashboard/TimelineCard'
import { UsageCard } from './dashboard/UsageCard'
import { liveDirs } from './HygieneViews'
import { InboxCard } from './InboxCard'

const MIN = 60_000
const DISMISSED_KEY = 'md.dashboard.dismissed'
const TIMELINE_KEY = 'md.dashboard.timeline'
const LAYOUT_KEY = 'md.dashboard.layout'
const SINCE_KEY = 'md.dashboard.since'

/**
 * The last on-demand answers, for the window's life: switching views and back within a minute
 * does not read again (#160). `procs:all` runs ps and lsof; the janitor reads every worktree.
 */
let procsCache: ProcsAll | null = null
let janitorCache: JanitorRow[] | null = null
/** When the last procs:all read started (this window's clock, not the Mac's `at`), and whether one is on its way. */
let procsTried = 0
let procsInFlight = false

function readDismissed(): Dismissal[] {
  const raw = load<unknown>(DISMISSED_KEY, [])
  return Array.isArray(raw) ? raw.filter((d): d is Dismissal => !!d && typeof d.id === 'string' && typeof d.fingerprint === 'string') : []
}

/**
 * When this device first showed the Dashboard. ponytail: the log starts when the version with it
 * first ran, which is about when the Dashboard is first opened; asking main for its first event is
 * the exact answer.
 */
function recordingSince(): number {
  const t = load<number | null>(SINCE_KEY, null)
  if (typeof t === 'number' && Number.isFinite(t)) return t
  const now = Date.now()
  save(SINCE_KEY, now)
  return now
}

const atWork = (s: Session) => s.state === 'working' || s.state === 'needs-input' || (s.state === 'idle' && (!!s.busyWith || !!s.waitingOn))

const CARD_TITLE: Record<CardId, string> = { now: 'Now', timeline: 'Timeline', delivery: 'Delivery', usage: 'Usage and cost', health: 'Health' }

const PR_TAB_NAME = { mine: 'Mine', review: 'Needs my review', merged: 'Recently merged' } as const

export interface DashboardProps {
  state: AppState
  /** In-app updates; null on the web. */
  update: UpdateState | null
  onOpenSession: (s: Session) => void
  onIssue: (i: Issue) => void
  onTicket: (t: Ticket) => void
  onStartWith: (issue: Issue, instructions: string) => void
  onOpenMeeting: (id: string) => void
  onPr: (url: string, title: string) => void
  onView: (v: string) => void
  onSettings: (section: string) => void
  onNeedsYou: () => void
  onNote: (id: string) => void
}

/** The Dashboard (#183): what needs me, what is happening, what happened, and how things are going. */
export function DashboardView(props: DashboardProps) {
  const { state, update } = props
  const phone = usePhone()
  // The view at 760 px or less (as the CSS container query measures it: a narrow window, panels open) is drawn as the phone
  // is: one column, Needs attention capped at 5, each card trimmed. A ResizeObserver, not a timer.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = bodyRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width <= 760))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const compact = phone || narrow
  // To the minute: the state ticks every few seconds; times and sums need not.
  const tick = useNow(MIN)
  const now = Math.floor(tick / MIN) * MIN

  // App's callbacks change on every render; the cards get one object that calls the latest.
  const latest = useRef({ props, sessions: state.sessions })
  latest.current = { props, sessions: state.sessions }
  const nav = useMemo<DashNav>(() => {
    const p = () => latest.current.props
    return {
      session: (key) => {
        const s = latest.current.sessions.find((x) => x.key === key)
        if (s) p().onOpenSession(s)
        else p().onView('terminals')
      },
      pr: (url, title) => p().onPr(url, title ?? ''),
      ticket: (t) => p().onTicket(t),
      view: (v) => p().onView(v),
      settings: (section) => p().onSettings(section),
      needsYou: () => p().onNeedsYou(),
      prsTab: (tab) => {
        const name = PR_TAB_NAME[tab]
        const tabs = parseSavedPrTabs(load<unknown>('prTabs', null))
        const t = tabs ? tabs.find((x) => x.name === name) : tab === 'mine' ? { id: 'prs-mine' } : undefined
        if (t) save('prTab', t.id)
        p().onView('prs')
      },
      note: (id) => p().onNote(id),
      meeting: (id) => p().onOpenMeeting(id),
    }
  }, [])

  // ---- Pulls: on mount, on a click, or on an existing event. No timer polls (#160).

  // Schedules: sched:list, and again on sched:changed.
  const [sched, setSched] = useState<SchedList | null>(null)
  useEffect(() => {
    if (!can('schedList')) return
    let alive = true
    const read = () =>
      void deck()
        .schedList()
        .then((l) => alive && setSched(l))
        .catch(() => {})
    read()
    const off = can('onSchedChanged') ? deck().onSchedChanged(read) : () => {}
    return () => {
      alive = false
      off()
    }
  }, [])

  // Processes and ports: on mount, on Refresh, and when the set of sessions at work changes, at
  // most once a minute (a change inside the minute reads once, when the minute is up).
  const windows = deck().platform === 'win32'
  const [procs, setProcs] = useState<ProcsAll | null>(procsCache)
  const [procsBusy, setProcsBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // The minute counts from each attempt, failed ones too, and a read on its way is never doubled.
  const readProcs = useCallback(() => {
    if (windows || !can('procsAll') || procsInFlight) return
    procsInFlight = true
    procsTried = Date.now()
    setProcsBusy(true)
    void deck()
      .procsAll()
      .then((p) => {
        procsCache = p
        if (alive.current) setProcs(p)
      })
      .catch(() => {})
      .finally(() => {
        procsInFlight = false
        if (alive.current) setProcsBusy(false)
      })
  }, [windows])
  const working = useMemo(() => state.sessions.filter(atWork).map((s) => s.key).sort().join(','), [state.sessions])
  useEffect(() => {
    const age = Date.now() - procsTried
    if (age >= MIN) {
      readProcs()
      return
    }
    // A one-off read when the minute is up, dropped if the set changes again or the view closes.
    const t = setTimeout(readProcs, MIN - age)
    return () => clearTimeout(t)
  }, [working, readProcs])

  // Worktrees: only on Check worktrees.
  const [janitor, setJanitor] = useState<JanitorRow[] | null>(janitorCache)
  const [janitorBusy, setJanitorBusy] = useState(false)
  const latestState = useRef(state)
  latestState.current = state
  const checkWorktrees = useCallback(() => {
    if (!can('janitor')) return
    setJanitorBusy(true)
    void deck()
      .janitor(liveDirs(latestState.current), false)
      .then((rows) => {
        janitorCache = rows
        setJanitor(rows)
      })
      .catch(() => {})
      .finally(() => setJanitorBusy(false))
  }, [])

  // Tokens per session, when the set of sessions in the cost book changes (as Costs does).
  const bookIds = useMemo(() => Object.keys(state.costBook).sort().join(','), [state.costBook])
  const [tokens, setTokens] = useState<Record<string, TokensByDay> | null>(null)
  useEffect(() => {
    if (!can('tokensByDay')) return
    let alive = true
    void deck()
      .tokensByDay(bookIds ? bookIds.split(',') : [])
      .then((t) => alive && setTokens(t))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [bookIds])

  // The Timeline: its range on mount and when the range changes, and again on activity:changed.
  const [filters, setFiltersState] = useState<TimelineFilters>(() => cleanTimeline(load<unknown>(TIMELINE_KEY, null)))
  const setFilters = useCallback((f: TimelineFilters) => {
    setFiltersState(f)
    save(TIMELINE_KEY, f)
  }, [])
  const [since] = useState(recordingSince)
  const today = midnight(now)
  const from = filters.range === 'yesterday' ? midnight(now, -1) : filters.range === '7d' ? midnight(now, -6) : today
  // To the end of today, so an event recorded within the current minute is in.
  const until = filters.range === 'yesterday' ? today : midnight(now, 1)
  const [events, setEvents] = useState<{ key: string; list: ActivityEvent[] } | null>(null)
  const [changed, setChanged] = useState(0)
  // Only a range that is still open can gain events: Yesterday is not read again.
  const untilRef = useRef(until)
  untilRef.current = until
  useEffect(() => {
    if (!can('onActivityChanged')) return
    return deck().onActivityChanged(() => {
      if (untilRef.current > Date.now()) setChanged((n) => n + 1)
    })
  }, [])
  const rangeKey = `${from}-${until}`
  useEffect(() => {
    if (!can('activityList')) return setEvents({ key: rangeKey, list: [] })
    let alive = true
    void deck()
      .activityList(from, until)
      .then((list) => alive && setEvents({ key: rangeKey, list }))
      .catch(() => alive && setEvents({ key: rangeKey, list: [] }))
    return () => {
      alive = false
    }
  }, [rangeKey, changed]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new range shows the skeleton until its answer; a refresh of the same range keeps the rows.
  const shownEvents = events && events.key === rangeKey ? events.list : null

  // ---- Needs attention

  const [dismissed, setDismissed] = useState<Dismissal[]>(readDismissed)
  const logins = useMemo(() => (state.ghAccounts ?? []).map((a) => a.login), [state.ghAccounts])
  const prWatches = state.prWatches
  const attention = useStable(useMemo(
    () =>
      attentionItems(
        {
          inbox: state.inbox,
          sessions: state.sessions,
          prs: state.prs,
          teamPrs: state.teamPrs,
          sessionPrs: state.sessionPrs,
          me: state.me,
          logins,
          watches: state.watches,
          prWatches: prWatches ?? [],
          sched,
          update,
          dismissed,
          max: compact ? 5 : 8,
        },
        now,
      ),
    [state.inbox, state.sessions, state.prs, state.teamPrs, state.sessionPrs, state.me, logins, state.watches, prWatches, sched, update, dismissed, compact, now],
  ))
  const subjects = attention.subjects
  const subjectsRef = useRef(subjects)
  subjectsRef.current = subjects
  const dismissedHere = useMemo(() => {
    const here = new Set(subjects)
    return dismissed.filter((d) => here.has(d.id)).length
  }, [dismissed, subjects])
  const dismiss = useCallback(
    (item: AttentionItem) => {
      setDismissed((cur) => {
        // Pruned of subjects no longer present, when written (a list still loading is not "gone").
        const next = pruneDismissed([...cur.filter((d) => d.id !== item.id), { id: item.id, fingerprint: item.fingerprint }], subjectsRef.current)
        save(DISMISSED_KEY, next)
        return next
      })
    },
    [],
  )
  const undismiss = useCallback(() => {
    setDismissed([])
    save(DISMISSED_KEY, [])
  }, [])

  // Reply…: the real Needs-you card under its row. It needs the whole state, so it is drawn here.
  const [replyId, setReplyId] = useState<string | null>(null)
  const replyEntry = useStable(replyId ? state.inbox.open.find((e) => e.item.id === replyId) : undefined)
  useEffect(() => {
    if (replyId && !replyEntry) setReplyId(null)
  }, [replyId, replyEntry])
  // Drawn again when its item or what the Needs-you cards read (sessions, issues, board, menus)
  // changes, not on every push. ponytail: a card reading another slice sees it as of that draw;
  // passing the whole state each time is the upgrade, at the cost of AttentionCard's memo.
  const replySessions = useStable(replyEntry ? state.sessions : null)
  const replyIssues = useStable(replyEntry ? state.issues : null)
  const replyBoard = useStable(replyEntry ? state.board : null)
  const replyMenus = useStable(replyEntry ? [state.menus, state.asks, state.proposals] : null)
  const reply = useMemo(
    () =>
      replyEntry ? (
        <InboxCard
          entry={replyEntry}
          state={latestState.current}
          onOpenSession={(s) => latest.current.props.onOpenSession(s)}
          onIssue={(i) => latest.current.props.onIssue(i)}
          onStartWith={(i, t) => latest.current.props.onStartWith(i, t)}
          onOpenMeeting={(id) => latest.current.props.onOpenMeeting(id)}
          full={false}
        />
      ) : null,
    [replyEntry, replySessions, replyIssues, replyBoard, replyMenus], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ---- The other cards' slices

  const multi = logins.length >= 2
  const nowV = useStable(useMemo(
    () =>
      nowView(
        {
          sessions: state.sessions,
          tails: state.tails,
          issues: state.issues,
          board: state.board,
          multi,
          procs,
          watches: state.watches,
          prWatches: prWatches ?? [],
          autoReview: state.autoReview ?? null,
          sched,
        },
        now,
      ),
    [state.sessions, state.tails, state.issues, state.board, multi, procs, state.watches, prWatches, state.autoReview, sched, now],
  ))
  const delivery = useStable(useMemo(
    () => deliveryView({ board: state.board, boardHistory: state.boardHistory, sprints: state.sprints, teamPrs: state.teamPrs, prs: state.prs, me: state.me, logins }, now),
    [state.board, state.boardHistory, state.sprints, state.teamPrs, state.prs, state.me, logins, now],
  ))
  const budget = state.settings.budgetPerTicketUsd
  const usage = useStable(useMemo(
    () => usageView({ costBook: state.costBook, sessions: state.sessions, hookInfo: state.hookInfo, ghCache: state.ghCache, budgetPerTicketUsd: budget, logins, tokensByDay: tokens }, now),
    [state.costBook, state.sessions, state.hookInfo, state.ghCache, budget, logins, tokens, now],
  ))
  const remoteEnabled = state.settings.remoteEnabled
  const health = useStable(useMemo(
    () =>
      healthView({
        now,
        remoteEnabled,
        remote: state.remote,
        browsers: state.browsers ?? [],
        ghAccounts: state.ghAccounts,
        ghCache: state.ghCache,
        boardError: state.boardError,
        teamPrsError: state.teamPrsError,
        sources: state.sources,
        errors: state.errors,
        missingBinaries: state.missingBinaries,
        hooks: state.hooks,
        statuslineInstalled: state.statuslineInstalled,
        procs,
        janitor,
        windows,
        update: isWeb() ? null : update,
      }),
    [now, remoteEnabled, state.remote, state.browsers, state.ghAccounts, state.ghCache, state.boardError, state.teamPrsError, state.sources, state.errors, state.missingBinaries, state.hooks, state.statuslineInstalled, procs, janitor, windows, update],
  ))

  const agentsLoading = state.sources.agents === 'pending' || state.sources.agents === undefined
  const portLinks = can('openPort')
  const cust = useCustomise(LAYOUT_KEY)

  const card = (id: CardId) => {
    switch (id) {
      case 'now':
        return <NowCard key={id} view={nowV} now={now} loading={agentsLoading} nav={nav} procsBusy={procsBusy} onRefresh={readProcs} portLinks={portLinks} windows={windows} compact={compact} />
      case 'timeline':
        return <TimelineCard key={id} events={shownEvents} filters={filters} onFilters={setFilters} now={now} nav={nav} from={from} recordingSince={since} compact={compact} />
      case 'delivery':
        return <DeliveryCard key={id} view={delivery} loading={!state.board && state.boardLoading} prsRead={state.teamPrsAt !== null || !!state.teamPrsError} nav={nav} compact={compact} />
      case 'usage':
        return <UsageCard key={id} view={usage} nav={nav} compact={compact} />
      case 'health':
        return <HealthCard key={id} view={health} nav={nav} worktreesBusy={janitorBusy} onCheckWorktrees={checkWorktrees} portLinks={portLinks} compact={compact} />
    }
  }

  const snap = state.lastSnapshotAt ? Date.parse(state.lastSnapshotAt) : NaN
  const date = new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <section className="board-view panel dash-view">
      <header className="board-head">
        <h2>Dashboard</h2>
        <span className="muted" title={Number.isFinite(snap) ? `The state was last read at ${new Date(snap).toLocaleTimeString()}` : undefined}>
          {date}
          {Number.isFinite(snap) ? ` · updated ${formatRefreshed(now - snap)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {cust.on ? (
          <>
            <span className="muted dash-hint">{phone ? 'Move a card with ← and →. The eye hides it.' : 'Drag a card by its handle, or press ⌥ and an arrow. The eye hides it.'}</span>
            <button className="btn" disabled={!cust.canReset} title={cust.canReset ? 'Back to the default order, every card shown' : 'The layout is the default'} onClick={cust.reset}>
              Reset
            </button>
            <button className="btn primary" onClick={() => cust.setOn(false)}>
              Done
            </button>
          </>
        ) : (
          <button className="btn dash-custbtn" onClick={() => cust.setOn(true)} title="Move and hide cards">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
              <circle cx="16" cy="6" r="2" />
              <circle cx="10" cy="12" r="2" />
              <circle cx="18" cy="18" r="2" />
            </svg>
            Customise
          </button>
        )}
      </header>
      <div className={`panel-body dash-body${compact ? ' dash-compact' : ''}`} ref={bodyRef}>
        <div className="dash-wrap">
          <AttentionCard
            list={attention}
            now={now}
            loading={agentsLoading}
            nav={nav}
            replyId={replyId}
            reply={reply}
            onReply={setReplyId}
            onDismiss={dismiss}
            dismissedCount={dismissedHere}
            onUndismiss={undismiss}
          />
          <CustomiseCtx.Provider value={cust.ctx}>
            <div className={`dash-grid${cust.on ? ' dash-customising' : ''}`} ref={cust.gridRef} onKeyDown={cust.onKeyDown}>
              {cust.shown.map(card)}
              {cust.on &&
                cust.hidden.map((id) => (
                  <div key={`hidden:${id}`} className="dash-hidden-ph">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.1 6.1C3.6 7.8 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1" />
                    </svg>
                    <span>{CARD_TITLE[id]} is hidden</span>
                    <span className="dash-grow" />
                    <button className="btn" onClick={() => cust.show(id)}>
                      Show
                    </button>
                  </div>
                ))}
              <div className="dash-marker" ref={cust.markerRef} aria-hidden="true" />
            </div>
          </CustomiseCtx.Provider>
        </div>
      </div>
    </section>
  )
}

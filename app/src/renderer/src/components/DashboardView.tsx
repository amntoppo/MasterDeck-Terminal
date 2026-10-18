import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent } from '@shared/activityLog'
import { attentionItems, deliveryView, healthView, nowView, pruneDismissed, usageView, type AttentionItem, type Dismissal } from '@shared/dashboard'
import { cleanLayout, layoutOrder, type CardId } from '@shared/dashboardLayout'
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
import { can, isWeb, usePhone } from '../web'
import { AttentionCard } from './dashboard/AttentionCard'
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
  const procsSeq = useRef(0)
  const readProcs = useCallback(() => {
    if (windows || !can('procsAll')) return
    const seq = ++procsSeq.current
    setProcsBusy(true)
    void deck()
      .procsAll()
      .then((p) => {
        procsCache = p
        if (seq === procsSeq.current) setProcs(p)
      })
      .catch(() => {})
      .finally(() => seq === procsSeq.current && setProcsBusy(false))
  }, [windows])
  const working = useMemo(() => state.sessions.filter(atWork).map((s) => s.key).sort().join(','), [state.sessions])
  useEffect(() => {
    const age = procsCache ? Date.now() - procsCache.at : Infinity
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
  useEffect(() => {
    if (!can('onActivityChanged')) return
    return deck().onActivityChanged(() => setChanged((n) => n + 1))
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
  const attention = useMemo(
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
          max: phone ? 5 : 8,
        },
        now,
      ),
    [state.inbox, state.sessions, state.prs, state.teamPrs, state.sessionPrs, state.me, logins, state.watches, prWatches, sched, update, dismissed, phone, now],
  )
  const subjects = attention.subjects
  const dismissedHere = useMemo(() => {
    const here = new Set(subjects)
    return dismissed.filter((d) => here.has(d.id)).length
  }, [dismissed, subjects])
  const dismiss = useCallback(
    (item: AttentionItem) => {
      setDismissed((cur) => {
        // Pruned of subjects no longer present, when written (a list still loading is not "gone").
        const next = pruneDismissed([...cur.filter((d) => d.id !== item.id), { id: item.id, fingerprint: item.fingerprint }], subjects)
        save(DISMISSED_KEY, next)
        return next
      })
    },
    [subjects],
  )
  const undismiss = useCallback(() => {
    setDismissed([])
    save(DISMISSED_KEY, [])
  }, [])

  // Reply…: the real Needs-you card under its row. It needs the whole state, so it is drawn here.
  const [replyId, setReplyId] = useState<string | null>(null)
  const replyEntry = replyId ? state.inbox.open.find((e) => e.item.id === replyId) : undefined
  useEffect(() => {
    if (replyId && !replyEntry) setReplyId(null)
  }, [replyId, replyEntry])
  const reply = replyEntry ? (
    <InboxCard
      entry={replyEntry}
      state={state}
      onOpenSession={props.onOpenSession}
      onIssue={props.onIssue}
      onStartWith={props.onStartWith}
      onOpenMeeting={props.onOpenMeeting}
      full={false}
    />
  ) : null

  // ---- The other cards' slices

  const multi = logins.length >= 2
  const nowV = useMemo(
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
  )
  const delivery = useMemo(
    () => deliveryView({ board: state.board, boardHistory: state.boardHistory, sprints: state.sprints, teamPrs: state.teamPrs, prs: state.prs, me: state.me, logins }, now),
    [state.board, state.boardHistory, state.sprints, state.teamPrs, state.prs, state.me, logins, now],
  )
  const budget = state.settings.budgetPerTicketUsd
  const usage = useMemo(
    () => usageView({ costBook: state.costBook, sessions: state.sessions, hookInfo: state.hookInfo, ghCache: state.ghCache, budgetPerTicketUsd: budget, logins, tokensByDay: tokens }, now),
    [state.costBook, state.sessions, state.hookInfo, state.ghCache, budget, logins, tokens, now],
  )
  const remoteEnabled = state.settings.remoteEnabled
  const health = useMemo(
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
  )

  const agentsLoading = state.sources.agents === 'pending' || state.sources.agents === undefined
  const portLinks = can('openPort')
  // Customise is Task 11: for now the saved order, hidden cards left out.
  const [layout] = useState(() => cleanLayout(load<unknown>(LAYOUT_KEY, null)))
  const order = useMemo(() => layoutOrder(layout).filter((id) => !layout.hidden.includes(id)), [layout])

  const card = (id: CardId) => {
    switch (id) {
      case 'now':
        return <NowCard key={id} view={nowV} now={now} loading={agentsLoading} nav={nav} procsBusy={procsBusy} onRefresh={readProcs} portLinks={portLinks} windows={windows} compact={phone} />
      case 'timeline':
        return <TimelineCard key={id} events={shownEvents} filters={filters} onFilters={setFilters} now={now} nav={nav} from={from} recordingSince={since} />
      case 'delivery':
        return <DeliveryCard key={id} view={delivery} loading={!state.board && state.boardLoading} prsRead={state.teamPrsAt !== null || !!state.teamPrsError} nav={nav} compact={phone} />
      case 'usage':
        return <UsageCard key={id} view={usage} nav={nav} compact={phone} />
      case 'health':
        return <HealthCard key={id} view={health} nav={nav} worktreesBusy={janitorBusy} onCheckWorktrees={checkWorktrees} portLinks={portLinks} compact={phone} />
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
      </header>
      <div className="panel-body dash-body">
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
          <div className="dash-grid">{order.map(card)}</div>
        </div>
      </div>
    </section>
  )
}

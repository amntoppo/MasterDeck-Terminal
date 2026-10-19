import { sameTicket, ticketLabel, ticketUrl, type Ticket } from '@shared/ticket'
import { nextTabName, ViewTabs } from './ViewTabs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ciMessage, ownerOf, reviewMessage, type PrOffer } from '@shared/offers'
import { isMulti, primaryLogin } from '@shared/accounts'
import { tabAccount, withAccountTabs } from '@shared/boardFilter'
import { formatRefreshed } from '@shared/format'
import { activeFilterCount, ageText, DEFAULT_PR_FILTERS, filterPrs, parseSavedPrTabs, prFilterOptions, prsForAccount, reviewLabel, type PrFilters, type TeamPr } from '@shared/teamPrs'
import type { AppState, Issue, Pr, Session } from '@shared/types'
import { deck, load, save, useNow } from '../deck'
import { defaultPrTabs, PR_PRESETS, presetFilters, presetOf } from '../prPresets'
import { PrIcon } from './BoardView'
import { PhoneFilters } from './PhoneFilters'
import { usePhone } from '../web'
import { prLabel, reviewPrompt } from '@shared/prReview'
import { ClaudeMark } from './NewTicket'
import { SessionAccount } from './AccountBits'
import { TerminalView } from './TerminalView'
import { AutoReviewWidget } from './AutoReviewWidget'
import { WatchEye, type WatchTabRef } from './WatchEye'
import type { PrWatchRow } from '@shared/watchPr'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
  /** Open the PR popup (summary + Review PR); `review`: its Review with Claude, here in the panel. */
  /** `watch`: the tab the PR popup's eye watches it for (#182). */
  onPr: (url: string, issue: Ticket | null, title: string, review?: () => void, watch?: WatchTabRef) => void
  /** No owning session: start one for the issue, instruction pre-filled. */
  onStartWith: (issue: Issue, instructions: string) => void
}


const TABS = 'prTabs'
const TAB = 'prTab'

/** A tab of the PRs view: its own name and filters over the one fetched list. */
interface PrTab {
  id: string
  name: string
  filters: PrFilters
  /** The GitHub account it shows; absent: the primary. */
  account?: string
  /** The PR picked in the list (its URL): what the tab's Review with Claude session talks about. */
  selected?: string
}

/** A PR tab's Review with Claude session. */
type ReviewSession = {
  gen: number
  resume: boolean
  prompt?: string
  /** The tab's account it runs as (two or more accounts). */
  account?: string
  /** Hidden (›): the session goes on, the panel is folded away. */
  hidden?: boolean
  /** A pane MasterDeck started for Automate Review (#157), adopted by the panel. */
  paneId?: string
}
/** The review sessions by PR tab id, kept while another view shows (their terminals keep running). */
let keptReviews: Record<string, ReviewSession> = {}
const reviewPaneId = (tab: string, gen: number) => `pr-review:${tab}:${gen}`
const paneOf = (tab: string, r: ReviewSession) => r.paneId ?? reviewPaneId(tab, r.gen)

/** The saved tabs; before any are saved, Mine (my open PRs, selected) and Everyone. */
function loadTabs(): PrTab[] {
  return parseSavedPrTabs(load<unknown>(TABS, null)) ?? defaultPrTabs()
}

function asPr(p: TeamPr, snapshot: Pr[]): Pr {
  const known = snapshot.find((x) => x.url === p.url)
  return {
    url: p.url,
    repo: p.repo,
    number: p.number,
    title: p.title,
    unresolvedThreads: p.unresolvedThreads,
    ci: p.ci,
    headRef: p.headRef,
    refsIssue: known?.refsIssue ?? p.issueRefs?.[0]?.number ?? p.issues[0] ?? null,
    refsRepo: known ? (known.refsRepo ?? null) : (p.issueRefs?.[0]?.repo ?? null),
  }
}

export function PrsView({ state, onOpenSession, onPr, onStartWith }: Props) {
  const now = useNow(30_000)
  // Tabs: each its own name and filters over the one list of PRs fetched from GitHub.
  const [tabs, setTabs] = useState<PrTab[]>(loadTabs)
  const [tabId, setTabId] = useState<string>(() => load<string>(TAB, ''))
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0]
  // Two or more GitHub accounts: each tab shows one account's PRs; "me" is that account's login.
  const cfg = state.config
  const multi = isMulti(cfg)
  const logins = cfg.accounts.map((a) => a.login)
  const primary = primaryLogin(cfg)
  const acct = multi ? (tabAccount(tab, logins) ?? primary) : null
  // Connecting another account adds a Mine tab for it, once.
  useEffect(() => {
    const added = load<string[]>('prTabAccounts', [])
    const make = (l: string): PrTab => ({ id: `prs-mine-${l}`, name: 'Mine', account: l, filters: presetFilters('Mine') })
    const r = withAccountTabs(tabs, logins, primary, added, make)
    if (r.added === added) return
    save('prTabAccounts', r.added)
    setTabs((ts) => withAccountTabs(ts, logins, primary, added, make).tabs)
  }, [logins.join(), primary]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => save(TABS, tabs), [tabs])
  useEffect(() => save(TAB, tab.id), [tab.id])
  const f = tab.filters
  const setF = (fn: (cur: PrFilters) => PrFilters) => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, filters: fn(t.filters) } : t)))
  const set = (patch: Partial<PrFilters>) => setF((cur) => ({ ...cur, ...patch }))
  const addTab = () => {
    const id = `prs-${Date.now().toString(36)}`
    const ta = tabAccount(tab, logins)
    setTabs([...tabs, { id, name: nextTabName(tabs, 'PRs'), filters: { ...DEFAULT_PR_FILTERS }, ...(ta ? { account: ta } : {}) }])
    setTabId(id)
    return id
  }
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id)
    if (!rest.length) return
    // Its review session goes with it; the folder stays. Its automation stops.
    closeReviewOf(id)
    void deck().autoReviewSet(id, { review: false, merge: false, name: '', filters: tab.filters, forget: true })
    setTabs(rest)
    if (id === tab.id) setTabId(rest[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)].id)
  }
  const renameTab = (id: string, name: string) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, name } : t)))
  const me = acct ?? state.me
  const isMe = (login: string) => !!me && login.toLowerCase() === me.toLowerCase()

  // Review with Claude: one session per tab, in its own folder, as the tab's account (two or more).
  const [reviews, setReviewsRaw] = useState<Record<string, ReviewSession>>(() => keptReviews)
  const setReviewOf = (key: string, r: ReviewSession | null) => {
    const next = { ...keptReviews }
    if (r) next[key] = r
    else delete next[key]
    keptReviews = next
    setReviewsRaw(next)
  }
  const closeReviewOf = (key: string) => {
    const r = keptReviews[key]
    if (r) deck().ptyClose(paneOf(key, r))
    setReviewOf(key, null)
  }
  const review = reviews[tab.id] ?? null
  const shownReview = review && !review.hidden ? review : null
  const [panelW, setPanelW] = useState<number>(() => load<number>('prReviewPanelW', 520))
  useEffect(() => save('prReviewPanelW', panelW), [panelW])
  const [reviewMsg, setReviewMsg] = useState<string | null>(null)
  // A tab whose account changed (picked, or disconnected): its session ran as the old one.
  useEffect(() => {
    if (multi && review && review.account !== acct) closeReviewOf(tab.id)
  }, [multi, tab.id, acct]) // eslint-disable-line react-hooks/exhaustive-deps
  // Automate Review (#157): main runs it per tab. The tab's account changing switches it off; its
  // name and filters (the repo it watches) follow while it is on.
  const auto = state.autoReview?.tabs[tab.id]
  const autoAcct = useRef<Record<string, string | null>>({})
  useEffect(() => {
    if (!auto?.review) return
    const was = autoAcct.current[tab.id]
    autoAcct.current[tab.id] = acct
    if (was !== undefined && was !== acct) {
      void deck().autoReviewSet(tab.id, { review: false, merge: false, name: tab.name, filters: tab.filters })
      return
    }
    // `follow`: main keeps the switches as they are by then (a switch flipped meanwhile is not undone).
    const t = setTimeout(() => void deck().autoReviewSet(tab.id, { review: true, merge: false, follow: true, name: tab.name, ...(acct ? { account: acct } : {}), filters: tab.filters }), 600)
    return () => clearTimeout(t)
  }, [tab.id, acct, tab.name, JSON.stringify(tab.filters), !!auto?.review]) // eslint-disable-line react-hooks/exhaustive-deps
  // A review session MasterDeck started for a request: the panel shows it (folded, until opened).
  const autoPane = auto?.pane ?? null
  useEffect(() => {
    if (!autoPane) return
    const cur = keptReviews[tab.id]
    if (cur && paneOf(tab.id, cur) === autoPane) return
    setReviewOf(tab.id, { gen: (cur?.gen ?? 0) + 1, resume: false, paneId: autoPane, ...(acct ? { account: acct } : {}), hidden: cur ? cur.hidden : true })
  }, [autoPane, tab.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // The automation widget: shown or hidden (remembered), lined up with the chat's input box.
  const [widgetOn, setWidgetOn] = useState<boolean>(() => load<boolean>('prReviewWidget', true))
  useEffect(() => save('prReviewWidget', widgetOn), [widgetOn])
  const [inputBox, setInputBox] = useState<{ top: number; bottom: number } | null>(null)
  const termWrap = useRef<HTMLDivElement>(null)
  // A second account connected or the last one removed: the sessions ran as the other mode's.
  const wasMulti = useRef(multi)
  useEffect(() => {
    if (wasMulti.current !== multi) for (const k of Object.keys(keptReviews)) closeReviewOf(k)
    wasMulti.current = multi
  }, [multi]) // eslint-disable-line react-hooks/exhaustive-deps
  const select = (url: string) => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, selected: url } : t)))
  // The eye (#182): which PRs MasterDeck watches, for this tab and its account.
  const watchRows = new Map((state.prWatches ?? []).map((r) => [r.url, r]))
  const watchTab: WatchTabRef = { tabId: tab.id, tabName: tab.name, ...(acct ? { account: acct } : {}), ...(tab.filters.repo ? { repo: tab.filters.repo } : {}) }
  const prepare = (url: string | undefined, contextOnly: boolean) =>
    deck().prReviewPrepare({ tabId: tab.id, tab: tab.name, ...(acct ? { account: acct } : {}), filters: tab.filters, ...(url ? { url } : {}), ...(contextOnly ? { context: true } : {}) })
  /**
   * Open the tab's panel; `url`: pick that PR first; `ask`: and ask Claude to review it (typed into
   * a running session, or the first message of a new one).
   */
  const openReview = async (url?: string, ask = false, restart = false) => {
    if (url) select(url)
    const pick = url ?? tab.selected
    const r = await prepare(pick, false)
    if (!r.ok) {
      setReviewMsg(r.message)
      setTimeout(() => setReviewMsg((m) => (m === r.message ? null : m)), 6000)
      return
    }
    const prompt = ask && pick ? reviewPrompt(pick) : undefined
    const cur = keptReviews[tab.id]
    if (cur && !restart) {
      setReviewOf(tab.id, { ...cur, hidden: false })
      if (prompt) {
        const id = paneOf(tab.id, cur)
        deck().ptyWrite(id, prompt)
        setTimeout(() => deck().ptyWrite(id, '\r'), 150)
      }
      return
    }
    if (cur) deck().ptyClose(paneOf(tab.id, cur))
    setReviewOf(tab.id, { gen: (cur?.gen ?? 0) + 1, resume: !restart && r.canContinue, prompt, ...(acct ? { account: acct } : {}) })
  }
  // The session's context follows the list: another PR picked, or the filters changed.
  const filtersKey = JSON.stringify(tab.filters)
  useEffect(() => {
    if (!review) return
    const t = setTimeout(() => void prepare(tab.selected, true), 400)
    return () => clearTimeout(t)
  }, [review?.gen, tab.id, tab.selected, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const dragPanel = (e: React.MouseEvent) => {
    e.preventDefault()
    const right = (e.currentTarget.parentElement?.getBoundingClientRect().right ?? window.innerWidth) as number
    const move = (ev: MouseEvent) => setPanelW(Math.round(Math.min(Math.max(right - ev.clientX, 340), window.innerWidth * 0.6)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Fetch on open when the list is older than 10 minutes (the shared cache absorbs repeats).
  useEffect(() => {
    void deck().refreshTeamPrs(600_000)
  }, [])

  const all = useMemo(() => prsForAccount(state.teamPrs, acct, primary), [state.teamPrs, acct, primary])
  const shown = useMemo(() => filterPrs(all, f, me, now), [all, f, me, now])
  const options = useMemo(() => prFilterOptions(all, me), [all, me])
  const repoCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const p of filterPrs(all, { ...f, repo: '' }, me, now)) c[p.repo] = (c[p.repo] ?? 0) + 1
    return c
  }, [all, f, me, now])
  const authorCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const p of filterPrs(all, { ...f, author: '' }, me, now)) c[p.author.toLowerCase()] = (c[p.author.toLowerCase()] ?? 0) + 1
    return c
  }, [all, f, me, now])
  // The PR offers are Needs-you items: dismissing one here dismisses it there too.
  const offers = useMemo(() => state.inbox.open.flatMap((e) => (e.item.detail.type === 'offer' ? [{ ...e.item.detail.offer, itemId: e.item.id }] : [])), [state.inbox.open])
  const active = activeFilterCount(f)
  const phone = usePhone()
  const preset = presetOf(f)
  const loading = state.teamPrsLoading

  // The filter row: inline on a wide screen; on a phone, behind a "Filters (n)" button.
  const filterControls = (
    <>
      {multi && (
        <select
          className="fsel"
          value={acct ?? ''}
          title="The GitHub account this tab shows"
          onChange={(e) => {
            const l = e.target.value
            setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, account: l === primary ? undefined : l, filters: { ...t.filters, repo: '', author: t.filters.author === '@me' ? '@me' : '', label: '' } } : t)))
          }}
        >
          {logins.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      )}
      <select className={`fsel ${f.state !== 'open' ? 'active' : ''}`} value={f.state} onChange={(e) => set({ state: e.target.value as PrFilters['state'] })} title="State">
        <option value="open">Open</option>
        <option value="merged">Merged</option>
        <option value="unmerged">Closed (not merged)</option>
        <option value="closed">Closed or merged</option>
        <option value="all">Any state</option>
      </select>
      <select className={`fsel ${f.author ? 'active' : ''}`} value={f.author} onChange={(e) => set({ author: e.target.value })} title="Created by">
        <option value="">Created by: anyone</option>
        {me && <option value="@me">Me ({me}){authorCounts[me.toLowerCase()] ? ` · ${authorCounts[me.toLowerCase()]}` : ''}</option>}
        {options.authors.map((a) => (
          <option key={a} value={a}>
            {a}
            {authorCounts[a.toLowerCase()] ? ` · ${authorCounts[a.toLowerCase()]}` : ''}
          </option>
        ))}
      </select>
      <select className={`fsel ${f.repo ? 'active' : ''}`} value={f.repo} onChange={(e) => set({ repo: e.target.value })} title="Repository">
        <option value="">All repositories</option>
        {options.repos.map((r) => (
          <option key={r} value={r}>
            {r}
            {repoCounts[r] ? ` · ${repoCounts[r]}` : ''}
          </option>
        ))}
      </select>
      <select className={`fsel ${f.review !== 'any' ? 'active' : ''}`} value={f.review} onChange={(e) => set({ review: e.target.value as PrFilters['review'] })} title="Review">
        <option value="any">Review: any</option>
        <option value="needs-me">Needs my review</option>
        <option value="waiting">Waiting for review</option>
        <option value="approved">Approved</option>
        <option value="changes">Changes requested</option>
        <option value="reviewed-by-me">Reviewed by me</option>
      </select>
      <select className={`fsel ${f.ci !== 'any' ? 'active' : ''}`} value={f.ci} onChange={(e) => set({ ci: e.target.value as PrFilters['ci'] })} title="CI checks">
        <option value="any">CI: any</option>
        <option value="failing">CI failing</option>
        <option value="pending">CI running</option>
        <option value="passing">CI passing</option>
      </select>
      <select className={`fsel ${f.drafts !== 'include' ? 'active' : ''}`} value={f.drafts} onChange={(e) => set({ drafts: e.target.value as PrFilters['drafts'] })} title="Drafts">
        <option value="include">Drafts: shown</option>
        <option value="exclude">Hide drafts</option>
        <option value="only">Drafts only</option>
      </select>
      <select className={`fsel ${f.updated ? 'active' : ''}`} value={f.updated} onChange={(e) => set({ updated: Number(e.target.value) })} title="Last updated">
        <option value={0}>Updated: any time</option>
        <option value={1}>Updated in 24 h</option>
        <option value={7}>Updated in 7 days</option>
        <option value={30}>Updated in 30 days</option>
        <option value={-3}>Stale: no update 3+ days</option>
        <option value={-7}>Stale: no update 7+ days</option>
      </select>
      <select className={`fsel ${f.threads !== 'any' ? 'active' : ''}`} value={f.threads} onChange={(e) => set({ threads: e.target.value as PrFilters['threads'] })} title="Review threads">
        <option value="any">Threads: any</option>
        <option value="unresolved">Has unresolved threads</option>
      </select>
      {options.labels.length > 0 && (
        <select className={`fsel ${f.label ? 'active' : ''}`} value={f.label} onChange={(e) => set({ label: e.target.value })} title="Label">
          <option value="">Any label</option>
          {options.labels.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      )}
      <select className="fsel" value={f.sort} onChange={(e) => set({ sort: e.target.value as PrFilters['sort'] })} title="Sort">
        <option value="updated">Sort: recently updated</option>
        <option value="created">Sort: newest</option>
        <option value="oldest">Sort: oldest</option>
        <option value="size">Sort: largest diff</option>
      </select>
    </>
  )
  const filterSearch = <input className="filter search" placeholder="Search title, #number, branch, ticket" value={f.search} onChange={(e) => set({ search: e.target.value })} />
  return (
    <>
    <section className="board-view panel" style={shownReview && !phone ? { right: `calc(var(--right-w, 0px) + ${panelW + 6}px)` } : undefined}>
      <header className="board-head">
        <h2>Pull requests</h2>
        <div className="seg">
          {PR_PRESETS.map((p) => (
            <button key={p.label} className={preset === p ? 'on' : ''} title={p.title} onClick={() => setF((cur) => ({ ...DEFAULT_PR_FILTERS, sort: cur.sort, ...p.f }))}>
              {p.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {state.webCut?.includes('teamPrsClosed') && (
          <span className="muted" title="Your Mac's lists were too large to send whole; open MasterDeck on the Mac for them">
            Open PRs only on the web
          </span>
        )}
        <span className="muted" title={state.teamPrsError ?? ''}>
          {loading ? 'refreshing from GitHub…' : state.teamPrsError ? <span className="bad">⚠ {state.teamPrsError.slice(0, 60)}</span> : state.teamPrsAt ? `refreshed ${formatRefreshed(now - state.teamPrsAt)}` : 'not loaded yet'}
        </span>
        <button className="btn" onClick={() => void deck().refreshTeamPrs()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {!shownReview && (
          <button className="btn claude-btn" onClick={() => void openReview()} title={tab.selected ? `Talk about ${prLabel(tab.selected)} with Claude` : 'A Claude session for this tab: pick a PR, then ask'}>
            <ClaudeMark /> Review with Claude{auto?.review ? <span className="auto-badge">auto</span> : null}
          </button>
        )}
      </header>
      <ViewTabs tabs={multi ? tabs.map((t) => ({ ...t, badge: tabAccount(t, logins) ?? primary ?? undefined })) : tabs} activeId={tab.id} onSelect={setTabId} onAdd={addTab} onClose={closeTab} onRename={renameTab} addTitle="Another PR tab, with its own filters" />

      {phone ? (
        <PhoneFilters count={activeFilterCount({ ...f, search: '' })} search={filterSearch} onReset={() => set({ ...DEFAULT_PR_FILTERS, sort: f.sort, search: f.search })}>
          {filterControls}
        </PhoneFilters>
      ) : (
        <div className="filter-bar">
          {filterControls}
          {filterSearch}
          {active > 0 && (
            <button className="link-btn" onClick={() => set({ ...DEFAULT_PR_FILTERS, sort: f.sort })}>
              Reset filters ({active})
            </button>
          )}
        </div>
      )}

      <div className="panel-body">
        {f.author === '@me' && offers.length > 0 && (
          <>
            <h3 className="sec">Needs its session ({offers.length})</h3>
            <div className="offers">
              {offers.map((o) => (
                <OfferRow key={o.id} o={o} itemId={o.itemId} state={state} onDismiss={() => void deck().inboxAct(o.itemId, 'dismiss')} onStartWith={onStartWith} onOpenSession={onOpenSession} />
              ))}
            </div>
          </>
        )}
        <h3 className="sec">
          {shown.length} of {all.length} PRs
          <span className="muted"> · all open PRs, and the latest closed or merged in the last 30 days</span>
        </h3>
        <table className="tbl prs-tbl">
          <thead>
            <tr>
              <th>PR</th>
              <th>Author</th>
              <th>State</th>
              <th>CI</th>
              <th className="r">Threads</th>
              <th>Reviews</th>
              <th className="r">Size</th>
              <th className="r">Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  {loading && !all.length ? 'Loading PRs…' : all.length ? 'No PRs match these filters.' : 'No PRs loaded yet. Press Refresh.'}
                </td>
              </tr>
            )}
            {shown.map((p) => (
              <PrRow
                key={p.url}
                p={p}
                pr={asPr(p, state.prs)}
                mine={isMe(p.author)}
                now={now}
                state={state}
                selected={p.url === tab.selected}
                onSelect={() => select(p.url)}
                onReview={() => void openReview(p.url, true)}
                onPr={(url, issue, title) => {
                  select(url)
                  onPr(url, issue, title, () => void openReview(url, true), watchTab)
                }}
                onOpenSession={onOpenSession}
                onStartWith={onStartWith}
                watchRow={watchRows.get(p.url)}
                watchTab={watchTab}
                onAuthor={(a) => set({ author: isMe(a) ? '@me' : a })}
                onRepo={(r) => set({ repo: r })}
              />
            ))}
          </tbody>
        </table>
      </div>
      {reviewMsg && <div className="ticket-toast bad-toast">{reviewMsg}</div>}
    </section>
    {shownReview && (
      <>
        {!phone && <div className="ticket-split" style={{ right: `calc(var(--right-w, 0px) + ${panelW}px)` }} onMouseDown={dragPanel} onDoubleClick={() => setPanelW(520)} title="Drag to resize · double-click to reset" />}
        <aside className="ticket-panel review-panel" style={phone ? undefined : { width: panelW }} aria-label="Review with Claude">
          <div className="wf-builder-head">
            <b>
              <ClaudeMark /> Review with Claude
            </b>
            <SessionAccount login={multi ? (shownReview.account ?? null) : null} />
            <span className="muted small review-on" title={tab.selected ?? ''}>
              {tab.selected ? `Reviewing ${prLabel(tab.selected)}` : 'No PR selected'}
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => void openReview(undefined, false, true)} title="Start a new conversation">
              New chat
            </button>
            <button className="insp-hide" onClick={() => setReviewOf(tab.id, { ...shownReview, hidden: true })} aria-label="Hide" title="Hide (the session goes on)">
              ›
            </button>
            <button className="insp-hide" onClick={() => closeReviewOf(tab.id)} aria-label="Close" title="Close (ends the session)">
              ×
            </button>
          </div>
          <div className="wf-builder-term" ref={termWrap}>
            <TerminalView
              key={paneOf(tab.id, shownReview)}
              paneId={paneOf(tab.id, shownReview)}
              onInputBox={setInputBox}
              spec={{ kind: 'pr-review', resume: shownReview.resume, tab: tab.id, ...(shownReview.prompt ? { prompt: shownReview.prompt } : {}), ...(multi && shownReview.account ? { account: shownReview.account } : {}) }}
              visible
              focusOnShow
            />
            {widgetOn && !phone && (
              <AutoReviewWidget
                state={state}
                tabId={tab.id}
                tab={tab}
                {...(acct ? { account: acct } : {})}
                style={widgetPlace(inputBox, termWrap.current)}
              />
            )}
          </div>
          {widgetOn && phone && <AutoReviewWidget state={state} tabId={tab.id} tab={tab} {...(acct ? { account: acct } : {})} inline />}
          <div className="wf-builder-tip muted review-tip">
            <button className={`link-btn auto-toggle${auto?.review ? ' on' : ''}`} onClick={() => setWidgetOn(!widgetOn)} aria-pressed={widgetOn} title={widgetOn ? 'Hide Automate Review' : 'Show Automate Review'}>
              {widgetOn ? '◂' : '▸'} Auto
            </button>
            Click a PR in the list to pick it, then ask: “review this PR”, “summarise what changed”, “is it safe to merge?”, “what does the CI failure mean?”. Nothing is posted to GitHub until you say yes to it.
          </div>
        </aside>
      </>
    )}
    </>
  )
}

function issueFor(state: AppState, t: Ticket): Issue {
  return (
    state.issues.find((i) => sameTicket(i, t)) ?? {
      number: t.number,
      repo: t.repo,
      title: state.board?.cards.find((c) => sameTicket(c, t))?.title ?? ticketLabel(t.repo, t.number),
      url: ticketUrl(t.repo, t.number),
      status: null,
      currentSprint: false,
      assignedToMe: true,
    }
  )
}

const STATE_TEXT: Record<TeamPr['state'], string> = { open: 'open', merged: 'merged', closed: 'closed' }

function PrRow({
  p,
  pr,
  mine,
  now,
  state,
  onPr,
  onOpenSession,
  onStartWith,
  onAuthor,
  onRepo,
  selected,
  onSelect,
  onReview,
  watchRow,
  watchTab,
}: {
  /** Its watch, if MasterDeck watches it (#182). */
  watchRow: PrWatchRow | undefined
  watchTab: WatchTabRef
  p: TeamPr
  pr: Pr
  mine: boolean
  now: number
  state: AppState
  onAuthor: (a: string) => void
  onRepo: (r: string) => void
  /** Picked for Review with Claude. */
  selected: boolean
  onSelect: () => void
  /** Pick it, open the panel and ask Claude to review it. */
  onReview: () => void
  onPr: (url: string, issue: Ticket | null, title: string) => void
} & Pick<Props, 'onOpenSession' | 'onStartWith'>) {
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const owner = mine ? ownerOf(pr, state.sessions, state.sessionPrs) : null
  const route = async (text: string) => {
    if (busy) return
    setBusy(true)
    if (owner) {
      const r = await deck().sendText(owner.key, text)
      setMsg(r.ok ? `Sent to ${owner.name}` : r.message)
    } else if (pr.refsIssue) onStartWith(issueFor(state, { repo: pr.refsRepo ?? null, number: pr.refsIssue }), text)
    else setMsg('No session or ticket to route it to')
    setBusy(false)
  }
  const open = p.state === 'open'
  const review = reviewLabel(p)
  const when = p.state === 'merged' ? p.mergedAt : p.state === 'closed' ? p.closedAt : p.createdAt
  return (
    <tr className={selected ? 'sel' : ''} onClick={onSelect} aria-selected={selected}>
      <td className="pr-cell">
        <button className="link-btn" onClick={() => onPr(p.url, pr.refsIssue ? { repo: pr.refsRepo ?? null, number: pr.refsIssue } : null, p.title)} title="Summary and Review PR">
          <PrIcon /> #{p.number}
        </button>{' '}
        <button className="link-btn muted-link" onClick={() => onRepo(p.repo)} title={`Only ${p.repo}`}>
          {p.repo}
        </button>{' '}
        {pr.refsIssue ? <span className="chip muted" title="Ticket">{ticketLabel(pr.refsRepo, pr.refsIssue)}</span> : null} {p.draft && <span className="chip muted">draft</span>} <span className="pr-title" title={`${p.title}\n${p.headRef} → ${p.baseRef}`}>{p.title}</span>
        {p.labels.map((l) => (
          <span key={l.name} className="chip label-chip" style={{ borderColor: `#${l.color}` }}>
            {l.name}
          </span>
        ))}
      </td>
      <td>
        <button className={`link-btn author ${mine ? '' : 'muted-link'}`} onClick={() => onAuthor(p.author)} title={`Only PRs by ${p.author}`}>
          {mine ? 'me' : p.author}
        </button>
      </td>
      <td className={`nowrap st-${p.state}`} title={when ? new Date(when).toLocaleString() : ''}>
        {STATE_TEXT[p.state]} <span className="muted">{ageText(when, now)}</span>
      </td>
      <td>{p.ci === 'failure' ? <span className="bad">✗ failing</span> : p.ci === 'success' ? <span className="ok">✓</span> : p.ci === 'pending' ? <span className="wait">● running</span> : '—'}</td>
      <td className="r">{!open ? '—' : p.unresolvedThreads > 0 ? <span className="wait">💬 {p.unresolvedThreads}</span> : '0'}</td>
      <td className={`review ${review.tone}`} title={p.reviews.map((r) => `${r.login}: ${r.state.toLowerCase().replace('_', ' ')}`).join('\n')}>
        {review.text}
      </td>
      <td className="r nowrap" title={`${p.files} file${p.files === 1 ? '' : 's'}`}>
        <span className="ok">+{p.additions}</span> <span className="bad">−{p.deletions}</span>
      </td>
      <td className="r muted nowrap" title={new Date(p.updatedAt).toLocaleString()}>
        {ageText(p.updatedAt, now)}
      </td>
      <td className="r nowrap">
        {msg && <span className="muted">{msg} </span>}
        {mine && owner && (
          <button className="link-btn author" onClick={() => onOpenSession(owner)} title={`Open its session ${owner.name}`}>
            {owner.name}
          </button>
        )}{' '}
        {mine && open && p.ci === 'failure' && (
          <button className="btn" disabled={busy} onClick={() => route(ciMessage(pr))}>
            Fix CI
          </button>
        )}{' '}
        {mine && open && p.unresolvedThreads > 0 && (
          <button className="btn" disabled={busy} onClick={() => route(reviewMessage(pr))}>
            Address comments
          </button>
        )}
        {!mine && open && !p.draft && (
          <button className={`btn ${p.requested.some((r) => !!state.me && r.toLowerCase() === state.me.toLowerCase()) ? 'primary' : ''}`} onClick={() => onPr(p.url, pr.refsIssue ? { repo: pr.refsRepo ?? null, number: pr.refsIssue } : null, p.title)} title="Summary and Review PR">
            Review
          </button>
        )}{' '}
        {(open || watchRow) && <WatchEye url={p.url} row={watchRow} tab={watchTab} onError={setMsg} />}{' '}
        <button className="link-btn review-claude" onClick={onReview} title="Review with Claude" aria-label={`Review #${p.number} with Claude`}>
          <ClaudeMark />
        </button>{' '}
        <button className="link-btn" onClick={() => deck().openExternal(p.url)} title="Open on GitHub">
          ↗
        </button>
      </td>
    </tr>
  )
}

/** A PR offer (a Needs-you item, `itemId`): send it through the inbox, or start a session when none owns the PR. */
export function OfferRow({ o, itemId, state, onDismiss, onStartWith, onOpenSession }: { o: PrOffer; itemId?: string; state: AppState; onDismiss: () => void } & Pick<Props, 'onStartWith' | 'onOpenSession'>) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const send = async () => {
    if (busy) return
    setBusy(true)
    if (itemId && (o.proposal || o.owner)) {
      const r = await deck().inboxAct(itemId, 'send')
      setMsg(r.message)
    } else if (o.proposal) {
      // master's own proposal: approving it lets master send it (and track it).
      const r = await deck().approve(o.proposal.id)
      setMsg(r.ok ? 'Approved; master sends it' : r.message)
    } else if (o.owner) {
      const r = await deck().sendText(o.owner.key, o.message)
      setMsg(r.ok ? `Sent to ${o.owner.name}` : r.message)
    } else if (o.pr.refsIssue) onStartWith(issueFor(state, { repo: o.pr.refsRepo ?? null, number: o.pr.refsIssue }), o.message)
    setBusy(false)
  }
  return (
    <div className={`offer ${o.kind}`}>
      <span className="kind">{o.kind === 'ci' ? 'CI FAILING' : `💬 ${o.pr.unresolvedThreads} THREADS`}</span>
      <span className="label">
        {o.pr.repo}#{o.pr.number} <span className="muted">{o.pr.title}</span>
      </span>
      <span className="muted nowrap">
        → {o.owner ? <button className="link-btn" onClick={() => onOpenSession(o.owner!)}>{o.owner.name}</button> : 'no session'}
        {o.proposal ? ` · master proposal ${o.proposal.id}` : ''}
      </span>
      {msg && <span className="muted">{msg}</span>}
      <button className="btn" onClick={onDismiss} disabled={busy}>
        Dismiss
      </button>
      <button className="btn primary" onClick={send} disabled={busy || !!msg}>
        {o.proposal ? 'Approve & send' : o.owner ? 'Send to session' : 'Start session'}
      </button>
    </div>
  )
}

/**
 * The widget's place: on the left of the panel, its top and bottom on the input box's (viewport
 * pixels from TerminalView, made relative to the terminal's box); the terminal's bottom rows when no box is found.
 */
function widgetPlace(box: { top: number; bottom: number } | null, wrap: HTMLElement | null): React.CSSProperties {
  const r = wrap?.getBoundingClientRect()
  if (!box || !r || box.bottom <= box.top) return { bottom: 0, minHeight: 52 }
  return { top: Math.max(0, box.top - r.top), height: box.bottom - box.top }
}

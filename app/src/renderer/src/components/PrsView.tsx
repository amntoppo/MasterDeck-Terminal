import { issueUrl } from '@shared/appConfig'
import { useEffect, useMemo, useState } from 'react'
import { ciMessage, ownerOf, prOffers, reviewMessage, type PrOffer } from '@shared/offers'
import { formatRefreshed } from '@shared/format'
import { activeFilterCount, ageText, DEFAULT_PR_FILTERS, filterPrs, normalizePrFilters, prFilterOptions, reviewLabel, type PrFilters, type TeamPr } from '@shared/teamPrs'
import type { AppState, Issue, Pr, Session } from '@shared/types'
import { deck, load, save, useNow } from '../deck'
import { PrIcon } from './BoardView'

interface Props {
  state: AppState
  onOpenSession: (s: Session) => void
  /** Open the PR popup (summary + Review PR). */
  onPr: (url: string, issue: number | null, title: string) => void
  /** No owning session: start one for the issue, instruction pre-filled. */
  onStartWith: (issue: Issue, instructions: string) => void
}

const DISMISSED = 'dismissedOffers'

export function useDismissed(): [Set<string>, (id: string) => void] {
  const [d, setD] = useState<Set<string>>(() => new Set(load<string[]>(DISMISSED, [])))
  const add = (id: string) =>
    setD((cur) => {
      const n = new Set(cur).add(id)
      save(DISMISSED, [...n].slice(-200))
      return n
    })
  return [d, add]
}

const FILTERS = 'prFilters'
const PRESETS: { label: string; title: string; f: Partial<PrFilters> }[] = [
  { label: 'Everyone', title: 'All open PRs in the org', f: { state: 'open', author: '', review: 'any', ci: 'any' } },
  { label: 'Mine', title: 'Open PRs I created', f: { state: 'open', author: '@me', review: 'any', ci: 'any' } },
  { label: 'Needs my review', title: 'Open PRs where my review is requested', f: { state: 'open', author: '', review: 'needs-me', ci: 'any' } },
  { label: 'Failing CI', title: 'Open PRs with failing checks', f: { state: 'open', author: '', review: 'any', ci: 'failing' } },
  { label: 'Recently merged', title: 'Merged in the last 7 days', f: { state: 'merged', author: '', review: 'any', ci: 'any', updated: 7 } },
]

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
    refsIssue: known?.refsIssue ?? p.issues[0] ?? null,
  }
}

export function PrsView({ state, onOpenSession, onPr, onStartWith }: Props) {
  const now = useNow(30_000)
  const [f, setF] = useState<PrFilters>(() => normalizePrFilters(load<unknown>(FILTERS, DEFAULT_PR_FILTERS)))
  const set = (patch: Partial<PrFilters>) =>
    setF((cur) => {
      const next = { ...cur, ...patch }
      save(FILTERS, next)
      return next
    })
  const [dismissed, dismiss] = useDismissed()
  const me = state.me
  const isMe = (login: string) => !!me && login.toLowerCase() === me.toLowerCase()

  // Fetch on open when the list is older than 10 minutes (the shared cache absorbs repeats).
  useEffect(() => {
    void deck().refreshTeamPrs(600_000)
  }, [])

  const all = state.teamPrs
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
  const mine = state.prs.filter((p) => p.authorIsMe)
  const offers = useMemo(() => prOffers(mine, state.sessions, state.sessionPrs, state.proposals, dismissed), [mine, state.sessions, state.sessionPrs, state.proposals, dismissed])
  const active = activeFilterCount(f)
  const preset = PRESETS.find((p) => (Object.keys(DEFAULT_PR_FILTERS) as (keyof PrFilters)[]).every((k) => k === 'sort' || f[k] === { ...DEFAULT_PR_FILTERS, ...p.f }[k]))
  const loading = state.teamPrsLoading

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Pull requests</h2>
        <div className="seg">
          {PRESETS.map((p) => (
            <button key={p.label} className={preset === p ? 'on' : ''} title={p.title} onClick={() => setF(() => {
              const next = { ...DEFAULT_PR_FILTERS, sort: f.sort, ...p.f }
              save(FILTERS, next)
              return next
            })}>
              {p.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span className="muted" title={state.teamPrsError ?? ''}>
          {loading ? 'refreshing from GitHub…' : state.teamPrsError ? <span className="bad">⚠ {state.teamPrsError.slice(0, 60)}</span> : state.teamPrsAt ? `refreshed ${formatRefreshed(now - state.teamPrsAt)}` : 'not loaded yet'}
        </span>
        <button className="btn" onClick={() => void deck().refreshTeamPrs()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="filter-bar">
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
        <input className="filter search" placeholder="Search title, #number, branch, ticket" value={f.search} onChange={(e) => set({ search: e.target.value })} />
        {active > 0 && (
          <button className="link-btn" onClick={() => set({ ...DEFAULT_PR_FILTERS, sort: f.sort })}>
            Reset filters ({active})
          </button>
        )}
      </div>

      <div className="panel-body">
        {f.author === '@me' && offers.length > 0 && (
          <>
            <h3 className="sec">Needs its session ({offers.length})</h3>
            <div className="offers">
              {offers.map((o) => (
                <OfferRow key={o.id} o={o} state={state} onDismiss={() => dismiss(o.id)} onStartWith={onStartWith} onOpenSession={onOpenSession} />
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
              <PrRow key={p.url} p={p} pr={asPr(p, state.prs)} mine={isMe(p.author)} now={now} state={state} onPr={onPr} onOpenSession={onOpenSession} onStartWith={onStartWith} onAuthor={(a) => set({ author: isMe(a) ? '@me' : a })} onRepo={(r) => set({ repo: r })} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function issueFor(state: AppState, n: number): Issue {
  return (
    state.issues.find((i) => i.number === n) ?? {
      number: n,
      title: state.board?.cards.find((c) => c.number === n)?.title ?? `#${n}`,
      url: issueUrl(n),
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
}: { p: TeamPr; pr: Pr; mine: boolean; now: number; state: AppState; onAuthor: (a: string) => void; onRepo: (r: string) => void } & Pick<Props, 'onPr' | 'onOpenSession' | 'onStartWith'>) {
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const owner = mine ? ownerOf(pr, state.sessions, state.sessionPrs) : null
  const route = async (text: string) => {
    if (busy) return
    setBusy(true)
    if (owner) {
      const r = await deck().sendText(owner.key, text)
      setMsg(r.ok ? `Sent to ${owner.name}` : r.message)
    } else if (pr.refsIssue) onStartWith(issueFor(state, pr.refsIssue), text)
    else setMsg('No session or ticket to route it to')
    setBusy(false)
  }
  const open = p.state === 'open'
  const review = reviewLabel(p)
  const when = p.state === 'merged' ? p.mergedAt : p.state === 'closed' ? p.closedAt : p.createdAt
  return (
    <tr>
      <td className="pr-cell">
        <button className="link-btn" onClick={() => onPr(p.url, pr.refsIssue, p.title)} title="Summary and Review PR">
          <PrIcon /> #{p.number}
        </button>{' '}
        <button className="link-btn muted-link" onClick={() => onRepo(p.repo)} title={`Only ${p.repo}`}>
          {p.repo}
        </button>{' '}
        {pr.refsIssue ? <span className="chip muted" title="Ticket">#{pr.refsIssue}</span> : null} {p.draft && <span className="chip muted">draft</span>} <span className="pr-title" title={`${p.title}\n${p.headRef} → ${p.baseRef}`}>{p.title}</span>
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
          <button className={`btn ${p.requested.some((r) => !!state.me && r.toLowerCase() === state.me.toLowerCase()) ? 'primary' : ''}`} onClick={() => onPr(p.url, pr.refsIssue, p.title)} title="Summary and Review PR">
            Review
          </button>
        )}{' '}
        <button className="link-btn" onClick={() => deck().openExternal(p.url)} title="Open on GitHub">
          ↗
        </button>
      </td>
    </tr>
  )
}

export function OfferRow({ o, state, onDismiss, onStartWith, onOpenSession }: { o: PrOffer; state: AppState; onDismiss: () => void } & Pick<Props, 'onStartWith' | 'onOpenSession'>) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const send = async () => {
    if (busy) return
    setBusy(true)
    if (o.proposal) {
      // master's own proposal: approving it lets master send it (and track it).
      const r = await deck().approve(o.proposal.id)
      setMsg(r.ok ? 'Approved; master sends it' : r.message)
    } else if (o.owner) {
      const r = await deck().sendText(o.owner.key, o.message)
      setMsg(r.ok ? `Sent to ${o.owner.name}` : r.message)
    } else if (o.pr.refsIssue) onStartWith(issueFor(state, o.pr.refsIssue), o.message)
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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Meeting, Segment } from '@shared/meetings'
import type { NoteMeta } from '@shared/notes'
import type { NoteTarget } from '@shared/noteEditor'
import {
  PRESET_LABELS,
  RANGE_PRESETS,
  RATES,
  customRange,
  dayKey,
  gridRange,
  highlightParts,
  lastDayKey,
  lineAt,
  lineClock,
  lineMatches,
  markedDays,
  meetingAudioUrl,
  meetingLengthMs,
  meetingTitle,
  micLogLine,
  monthGrid,
  presetRange,
  searchLines,
  stateView,
  stepHit,
  type MeetingRow,
  type Range,
  type RangePreset,
} from '@shared/meetingsPage'
import { MEETING_TITLE_MAX } from '@shared/meetings'
import { deck, useNow } from '../deck'
import { MarkdownView } from './MarkdownView'

/** Where to open the page: a meeting, and a time in seconds (a note's link); `at` makes a repeat a new open. */
export interface MeetingTarget {
  id: string
  t: number | null
  at: number
}

interface Props {
  /** The consent on Settings → Meetings holds (Match again and Try again need it). */
  agreed: boolean
  target: MeetingTarget | null
  /** Open Settings → Meetings. */
  onSetup: () => void
  /** Open a note in the Notes panel. */
  onNote: (t: NoteTarget) => void
  notes: NoteMeta[] | null
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const SKIP_S = 15
const when = (ms: number) =>
  `${new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
/** The page's list answers at most this many (MeetingsIpc's LIST_MAX): a union that full is read range by range. */
const LIST_MAX = 500
/** meetings:changed comes for every transcribed chunk: the page reads again once per this long. */
const CHANGED_MS = 250

/** What changed since the page last read: these meetings, or (all) the list itself. */
interface Changed {
  ids: string[]
  all: boolean
  n: number
}

/**
 * The Meetings page (spec §6; the Mac's window only): dates and meetings on the left, the meeting
 * on the right with its audio over the whole transcript. Meetings never reach a browser.
 */
export function MeetingsView({ agreed, target, onSetup, onNote, notes }: Props) {
  const now = useNow(30_000)
  const [preset, setPreset] = useState<RangePreset>('30d')
  const [custom, setCustom] = useState<Range | null>(null)
  const range = useMemo(() => (preset === 'custom' && custom ? custom : presetRange(preset === 'custom' ? '30d' : preset, now)), [preset, custom, now])
  const rangeNow = useRef(range)
  rangeNow.current = range
  const [month, setMonth] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }))
  const [rows, setRows] = useState<MeetingRow[] | null>(null)
  const [marks, setMarks] = useState<Map<string, number>>(new Map())
  const [any, setAny] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(target?.id ?? null)
  const [tick, setTick] = useState(0)

  // The lists: the range, the month's marks, and whether any meeting is stored at all (the empty
  // page). One call over both spans (main reads every meeting file per call); each is cut from it.
  // Only a union at the list's limit (older ones may be cut) is read span by span, and the whole
  // history only when the union is empty.
  useEffect(() => {
    let alive = true
    const g = gridRange(month.y, month.m)
    const from = Math.min(range.from, g.from)
    const to = Math.max(range.to, g.to)
    const within = (list: MeetingRow[], a: number, b: number) => list.filter((x) => x.started >= a && x.started < b)
    void (async () => {
      const u = await deck().meetingsList(from, to)
      if (!alive) return
      if (!u.ok) return setError(u.message)
      let inRange = within(u.meetings, range.from, range.to)
      let inGrid = within(u.meetings, g.from, g.to)
      if (u.meetings.length >= LIST_MAX) {
        const [a, b] = await Promise.all([deck().meetingsList(range.from, range.to), deck().meetingsList(g.from, g.to)])
        if (!alive) return
        if (a.ok) inRange = a.meetings
        if (b.ok) inGrid = b.meetings
      }
      let anyAt = u.meetings.length > 0
      if (!anyAt) {
        const all = await deck().meetingsList(0, Number.MAX_SAFE_INTEGER)
        if (!alive) return
        anyAt = all.ok && all.meetings.length > 0
      }
      setError(null)
      setRows(inRange)
      setMarks(markedDays(inGrid))
      setAny(anyAt)
    })()
    return () => {
      alive = false
    }
  }, [range.from, range.to, month.y, month.m, tick])

  // Changes come in bursts (a chunk, its progress, matching): read again once per CHANGED_MS.
  const [changed, setChanged] = useState<Changed>({ ids: [], all: false, n: 0 })
  useEffect(() => {
    let ids = new Set<string>()
    let all = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = deck().onMeetingsChanged((c) => {
      if (c.id === null) all = true
      else ids.add(c.id)
      timer ??= setTimeout(() => {
        const next = { ids: [...ids], all }
        ids = new Set()
        all = false
        timer = null
        setTick((t) => t + 1)
        setChanged((x) => ({ ...next, n: x.n + 1 }))
      }, CHANGED_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // A link or Needs you: that meeting, its month, and a range that holds it.
  useEffect(() => {
    if (!target) return
    setSelected(target.id)
    void deck()
      .meetingsGet(target.id)
      .then((r) => {
        if (!r.ok) return
        const s = r.meeting.started
        setMonth({ y: new Date(s).getFullYear(), m: new Date(s).getMonth() })
        const cur = rangeNow.current
        if (s >= cur.from && s < cur.to) return
        setCustom(customRange(dayKey(s), dayKey(s)))
        setPreset('custom')
      })
    // A new target only (its `at`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.at])

  const pickDay = (key: string) => {
    setCustom(customRange(key, key))
    setPreset('custom')
  }
  const setFromTo = (from: string, to: string) => {
    const r = customRange(from, to)
    if (!r) return
    setCustom(r)
    setPreset('custom')
  }
  const shiftMonth = (d: number) => setMonth(({ y, m }) => ({ y: new Date(y, m + d, 1).getFullYear(), m: new Date(y, m + d, 1).getMonth() }))

  if (any === false && !agreed)
    return (
      <section className="board-view panel">
        <Head />
        <div className="mt-empty">
          <p>Record a meeting on this Mac, read the whole transcript and hear it again. What was said about a session goes to its notes.</p>
          <button className="btn primary" onClick={onSetup}>
            Set up meetings
          </button>
        </div>
      </section>
    )

  const today = dayKey(now)
  const fromKey = dayKey(range.from)
  const toKey = lastDayKey(range)
  return (
    <section className="board-view panel">
      <Head />
      <div className="mt-body">
        <aside className="mt-side">
          <div className="mt-cal">
            <div className="mt-cal-head">
              <button className="btn" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
                ‹
              </button>
              <span>{new Date(month.y, month.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
              <button className="btn" aria-label="Next month" onClick={() => shiftMonth(1)}>
                ›
              </button>
            </div>
            <div className="mt-grid" role="grid" aria-label="Days with meetings">
              {WEEKDAYS.map((d) => (
                <span key={d} className="mt-wd">
                  {d}
                </span>
              ))}
              {monthGrid(month.y, month.m).map((d) => {
                const n = marks.get(d.key) ?? 0
                const inRange = d.start >= range.from && d.start < range.to
                return (
                  <button
                    key={d.key}
                    className={`mt-day ${d.inMonth ? '' : 'out'} ${inRange ? 'in' : ''} ${d.key === today ? 'today' : ''} ${n ? 'has' : ''}`}
                    title={n ? plural(n, 'meeting') : undefined}
                    aria-label={`${d.key}${n ? `, ${plural(n, 'meeting')}` : ''}`}
                    onClick={() => pickDay(d.key)}
                  >
                    {d.day}
                    {n > 0 && <i />}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="seg mt-presets">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p}
                className={preset === p ? 'on' : ''}
                onClick={() => {
                  if (p === 'custom') setCustom(range)
                  setPreset(p)
                }}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>
          <div className="mt-fromto">
            <label>
              From <input type="date" value={fromKey} max={toKey} onChange={(e) => setFromTo(e.target.value, toKey)} />
            </label>
            <label>
              To <input type="date" value={toKey} min={fromKey} onChange={(e) => setFromTo(fromKey, e.target.value)} />
            </label>
          </div>
          <div className="mt-list" role="list">
            {error && <div className="error">{error}</div>}
            {rows === null && !error && <div className="muted">Loading…</div>}
            {rows?.length === 0 && <div className="muted mt-none">{any ? 'No meetings in these days.' : 'No meetings yet. Record one with the microphone in the rail.'}</div>}
            {rows?.map((r) => (
              <ListRow key={r.id} row={r} now={now} on={r.id === selected} agreed={agreed} onOpen={() => setSelected(r.id)} />
            ))}
          </div>
        </aside>
        {selected ? (
          <MeetingDetail
            key={selected}
            id={selected}
            seek={target && target.id === selected ? target : null}
            changed={changed}
            agreed={agreed}
            notes={notes}
            onNote={onNote}
            onGone={() => setSelected(null)}
          />
        ) : (
          <div className="mt-detail mt-pick muted">Pick a meeting.</div>
        )}
      </div>
    </section>
  )
}

function Head() {
  return (
    <header className="board-head">
      <h2>Meetings</h2>
      <span className="muted">recorded and transcribed on this Mac · never sent anywhere but the one matching call</span>
    </header>
  )
}

function StateChip({ row, agreed }: { row: Pick<MeetingRow, 'id' | 'state' | 'progress' | 'error'>; agreed: boolean }) {
  const s = stateView(row)
  const [msg, setMsg] = useState<string | null>(null)
  const act = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const r = s.action === 'rematch' ? await deck().meetingsRematch(row.id) : await deck().meetingsRetry(row.id)
    setMsg(r.ok ? null : (r.message ?? 'Could not.'))
  }
  return (
    <span className="mt-state-wrap">
      <span className={`mt-state ${s.tone}`} title={row.error ?? undefined}>
        {s.label}
      </span>
      {s.action && agreed && (
        <button className="link-btn" onClick={(e) => void act(e)}>
          {s.action === 'rematch' ? 'Match again' : 'Try again'}
        </button>
      )}
      {msg && <span className="error">{msg}</span>}
    </span>
  )
}

function ListRow({ row, now, on, agreed, onOpen }: { row: MeetingRow; now: number; on: boolean; agreed: boolean; onOpen: () => void }) {
  return (
    <div role="listitem" className={`mt-row ${on ? 'on' : ''}`} onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="mt-row-title">{meetingTitle(row)}</div>
      <div className="mt-row-sub">
        <span>{when(row.started)}</span>
        <span>{lineClock(meetingLengthMs(row, now))}</span>
        {row.notes > 0 && <span>{plural(row.notes, 'note')}</span>}
      </div>
      <StateChip row={row} agreed={agreed} />
    </div>
  )
}

interface DetailProps {
  id: string
  seek: MeetingTarget | null
  changed: Changed
  agreed: boolean
  notes: NoteMeta[] | null
  onNote: (t: NoteTarget) => void
  onGone: () => void
}

function MeetingDetail({ id, seek, changed, agreed, notes, onNote, onGone }: DetailProps) {
  const [m, setM] = useState<Meeting | null>(null)
  const [audioOk, setAudioOk] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const audio = useRef<HTMLAudioElement>(null)
  const lines = useRef<HTMLDivElement>(null)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState<number>(1)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(-1)
  /** A time (ms) to go to once the audio can seek: a link's ?t=. */
  const pending = useRef<number | null>(null)

  const load = useCallback(async () => {
    const r = await deck().meetingsGet(id)
    if (!r.ok) {
      setErr(r.message)
      setM(null)
      return
    }
    setErr(null)
    setM(r.meeting)
    setAudioOk(r.audio)
    setTitle((t) => (document.activeElement?.classList.contains('mt-title') ? t : r.meeting.title))
  }, [id])
  useEffect(() => void load(), [load])
  useEffect(() => {
    if (changed.n && (changed.all || changed.ids.includes(id))) void load()
  }, [changed, id, load])

  // A link's time: shown and scrolled to at once, played from there once the audio can seek.
  useEffect(() => {
    if (!seek || seek.t === null) return
    pending.current = seek.t * 1000
    setCur(seek.t * 1000)
    const a = audio.current
    if (a && a.readyState >= 1) goTo(seek.t * 1000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek?.at])

  const segments = m?.segments ?? []
  const playingLine = lineAt(segments, cur)
  const hits = useMemo(() => searchLines(segments, query), [segments, query])
  const chips = useMemo(() => (m ? lineMatches(m) : new Map()), [m])
  const length = m ? meetingLengthMs(m, Date.now()) : 0
  const total = dur ?? length

  // The playing line stays in view (only while playing or after a jump: never fights a scroll by
  // hand). A scroll the page made itself is told apart from the user's (wheel, keys, scrollbar,
  // touch) by `auto`: a scroll event soon after one of ours is ours.
  const follow = useRef(true)
  const auto = useRef(0)
  const scrollTo = (i: number, block: ScrollLogicalPosition) => {
    const el = lines.current?.querySelector(`[data-i="${i}"]`)
    if (!el) return
    auto.current = performance.now()
    el.scrollIntoView({ block })
  }
  useEffect(() => {
    if (playingLine < 0 || !follow.current) return
    scrollTo(playingLine, 'nearest')
  }, [playingLine])
  useEffect(() => {
    if (hit < 0 || hits[hit] === undefined) return
    follow.current = false
    scrollTo(hits[hit]!, 'center')
  }, [hit, hits])
  const onScroll = () => {
    if (performance.now() - auto.current > 200) follow.current = false
  }
  useEffect(() => setHit(hits.length ? 0 : -1), [query]) // eslint-disable-line react-hooks/exhaustive-deps

  function goTo(ms: number) {
    const a = audio.current
    const t = Math.max(0, Math.min(ms, total || ms))
    setCur(t)
    follow.current = true
    if (a) a.currentTime = t / 1000
  }
  const playFrom = (ms: number) => {
    goTo(ms)
    void audio.current?.play().catch(() => {})
  }
  const toggle = () => {
    const a = audio.current
    if (!a) return
    follow.current = true
    if (a.paused) void a.play().catch(() => {})
    else a.pause()
  }
  // Stable for the memo'd lines: they call the latest playFrom / onNote / toggle.
  const latest = useRef({ playFrom, onNote, toggle })
  latest.current = { playFrom, onNote, toggle }
  const onLinePlay = useCallback((ms: number) => latest.current.playFrom(ms), [])
  const onLineNote = useCallback((nid: string) => latest.current.onNote({ id: nid }), [])

  // Space plays and pauses, unless focus is where Space types or presses (a field, a button).
  useEffect(() => {
    if (!audioOk) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return
      e.preventDefault()
      latest.current.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [audioOk])
  const hitSet = useMemo(() => new Set(hits), [hits])
  const active = playingLine >= 0 && (playing || cur > 0) ? playingLine : -1

  const rename = async () => {
    if (!m || title.trim() === m.title) return
    const r = await deck().meetingsRename(m.id, title)
    if (!r.ok) setMsg(r.message ?? 'Could not rename it.')
    else void load()
  }
  const act = async (what: 'rematch' | 'retry' | 'md' | 'audio' | 'deleteAudio' | 'delete') => {
    if (!m) return
    setMsg(null)
    const call = () =>
      what === 'rematch'
        ? deck().meetingsRematch(m.id)
        : what === 'retry'
          ? deck().meetingsRetry(m.id)
          : what === 'md' || what === 'audio'
            ? deck().meetingsExport(m.id, what)
            : what === 'deleteAudio'
              ? deck().meetingsDeleteAudio(m.id)
              : deck().meetingsDelete(m.id)
    const r = await call().catch(() => ({ ok: false, message: 'Something went wrong.' }))
    if (!r.ok) return r.message !== 'cancelled' && setMsg(r.message ?? 'Could not.')
    if (what === 'delete') return onGone()
    if (what === 'md' || what === 'audio') setMsg('Saved.')
    if (what === 'deleteAudio') audio.current?.pause()
    void load()
  }

  if (err) return <div className="mt-detail mt-pick muted">{err}</div>
  if (!m) return <div className="mt-detail mt-pick muted">Loading…</div>

  const noteChips = [...new Map(m.matches.filter((x) => x.noteId).map((x) => [x.noteId!, x.label])).entries()]
  const noteTitle = (nid: string) => notes?.find((n) => n.id === nid)?.title
  const state = stateView(m)
  const busy = m.state === 'recording' || m.state === 'transcribing' || m.state === 'matching'
  return (
    <div className="mt-detail">
      <div className="mt-top">
        <input
          className="mt-title"
          value={title}
          placeholder={meetingTitle({ title: '', started: m.started })}
          maxLength={MEETING_TITLE_MAX}
          aria-label="Title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setTitle(m.title)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <div className="mt-meta">
          <span>{when(m.started)}</span>
          <span>{lineClock(length)}</span>
          {m.apps.length > 0 && <span>{m.apps.join(', ')}</span>}
          <StateChip row={m} agreed={agreed} />
        </div>
        <div className="mt-actions">
          {msg && <span className={msg === 'Saved.' ? 'muted' : 'error'}>{msg}</span>}
          <button className="btn" disabled={!agreed || busy} title={agreed ? 'Match what was said to sessions, tickets and PRs again' : 'Turn meetings on in Settings → Meetings'} onClick={() => void act('rematch')}>
            Match again
          </button>
          <button className="btn" onClick={() => void act('md')}>
            Export transcript
          </button>
          <button className="btn" disabled={!audioOk} onClick={() => void act('audio')}>
            Export audio
          </button>
          <button className="btn danger" disabled={!audioOk || m.state === 'recording'} onClick={() => void act('deleteAudio')}>
            Delete audio
          </button>
          <button className="btn danger" disabled={m.state === 'recording'} onClick={() => void act('delete')}>
            Delete meeting
          </button>
        </div>
        {m.error && state.tone !== 'failed' && <div className="muted mt-err">{m.error}</div>}
        {m.error && state.tone === 'failed' && <div className="error mt-err">{m.error}</div>}
        {m.summary && <MarkdownView text={m.summary} html={false} className="mt-summary" />}
        {noteChips.length > 0 && (
          <div className="mt-notes">
            <span className="muted">Notes added:</span>
            {noteChips.map(([nid, label]) => (
              <button key={nid} className="chip btnlike" title="Open the note" onClick={() => onNote({ id: nid })}>
                {noteTitle(nid) || label}
              </button>
            ))}
          </div>
        )}
        {!!m.micLog?.length && (
          <details className="mt-miclog">
            <summary className="muted">Mic log ({m.micLog.length})</summary>
            <ol>
              {m.micLog.map((e, i) => (
                <li key={i}>{micLogLine(e)}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
      <div className="mt-player">
        {audioOk ? (
          <>
            <audio
              ref={audio}
              src={meetingAudioUrl(m.id)}
              preload="metadata"
              onLoadedMetadata={(e) => {
                const a = e.currentTarget
                a.playbackRate = rate
                if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration * 1000)
                if (pending.current !== null) {
                  goTo(pending.current)
                  pending.current = null
                }
              }}
              onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0 && setDur(e.currentTarget.duration * 1000)}
              onTimeUpdate={(e) => setCur(e.currentTarget.currentTime * 1000)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
            <button className="btn" aria-label={`Back ${SKIP_S} seconds`} onClick={() => goTo(cur - SKIP_S * 1000)}>
              −{SKIP_S}s
            </button>
            <button className="btn primary mt-play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button className="btn" aria-label={`Forward ${SKIP_S} seconds`} onClick={() => goTo(cur + SKIP_S * 1000)}>
              +{SKIP_S}s
            </button>
            <span className="mono mt-clock">{lineClock(cur)}</span>
            <input
              className="mt-seek"
              type="range"
              min={0}
              max={Math.max(1, Math.round(total))}
              step={100}
              value={Math.min(Math.round(cur), Math.max(1, Math.round(total)))}
              aria-label="Position"
              onChange={(e) => goTo(Number(e.target.value))}
            />
            <span className="mono mt-clock">{lineClock(total)}</span>
            <div className="seg mt-rate" role="group" aria-label="Speed">
              {RATES.map((r) => (
                <button
                  key={r}
                  className={rate === r ? 'on' : ''}
                  onClick={() => {
                    setRate(r)
                    if (audio.current) audio.current.playbackRate = r
                  }}
                >
                  {r}x
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="muted">{m.state === 'recording' ? 'The audio plays once the recording stops.' : 'No audio: it was deleted, or nothing was recorded.'}</span>
        )}
      </div>
      <div className="mt-search">
        <input
          className="filter"
          placeholder="Search the transcript"
          value={query}
          aria-label="Search the transcript"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setHit((h) => stepHit(hits.length, h, e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1))
            }
            if (e.key === 'Escape') setQuery('')
          }}
        />
        {query.trim() && <span className="muted mono">{hits.length ? `${hit + 1}/${hits.length}` : '0/0'}</span>}
        <button className="btn" aria-label="Previous match" disabled={!hits.length} onClick={() => setHit((h) => stepHit(hits.length, h, -1))}>
          ↑
        </button>
        <button className="btn" aria-label="Next match" disabled={!hits.length} onClick={() => setHit((h) => stepHit(hits.length, h, 1))}>
          ↓
        </button>
      </div>
      <div className="mt-lines" ref={lines} onScroll={onScroll} onWheel={() => (follow.current = false)}>
        {segments.length === 0 && <div className="muted mt-none">{busy ? 'The transcript appears here as it is written.' : 'Nothing was transcribed.'}</div>}
        <Lines
          segments={segments}
          active={active}
          hitLine={hit >= 0 ? (hits[hit] ?? -1) : -1}
          hitSet={hitSet}
          query={query}
          chips={chips}
          audioOk={audioOk}
          onPlay={onLinePlay}
          onNote={onLineNote}
        />
      </div>
    </div>
  )
}

type Chip = { label: string; noteId: string | null }
const NO_CHIPS: Chip[] = []

interface LinesProps {
  segments: Segment[]
  /** The playing line, or -1. */
  active: number
  /** The search hit picked now, or -1. */
  hitLine: number
  hitSet: Set<number>
  query: string
  chips: Map<number, Chip[]>
  audioOk: boolean
  onPlay: (ms: number) => void
  onNote: (noteId: string) => void
}

/**
 * The transcript (up to 20,000 lines). Memo'd: a time update that keeps the playing line renders
 * nothing here, and one that moves it re-renders only the old and the new line.
 */
const Lines = memo(function Lines({ segments, active, hitLine, hitSet, query, chips, audioOk, onPlay, onNote }: LinesProps) {
  return (
    <>
      {segments.map((s, i) => (
        <Line
          key={i}
          i={i}
          s={s}
          playing={i === active}
          hit={i === hitLine}
          query={hitSet.has(i) ? query : ''}
          chips={chips.get(i) ?? NO_CHIPS}
          audioOk={audioOk}
          onPlay={onPlay}
          onNote={onNote}
        />
      ))}
    </>
  )
})

interface LineProps {
  i: number
  s: Segment
  playing: boolean
  hit: boolean
  /** The search, only when this line matches it (so typing re-renders only the lines it marks). */
  query: string
  chips: Chip[]
  audioOk: boolean
  onPlay: (ms: number) => void
  onNote: (noteId: string) => void
}

/** One transcript line: a click or Enter plays from it. */
const Line = memo(function Line({ i, s, playing, hit, query, chips, audioOk, onPlay, onNote }: LineProps) {
  return (
    <div
      data-i={i}
      className={`mt-line ${playing ? 'playing' : ''} ${hit ? 'hit' : ''}`}
      onClick={() => audioOk && onPlay(s.start)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && audioOk && e.target === e.currentTarget) {
          e.preventDefault()
          onPlay(s.start)
        }
      }}
      tabIndex={audioOk ? 0 : undefined}
      role={audioOk ? 'button' : undefined}
      aria-current={playing ? 'true' : undefined}
      title={audioOk ? 'Play from here' : undefined}
    >
      <span className={`mt-spk ${s.speaker}`}>{s.speaker === 'you' ? 'You' : 'Others'}</span>
      <span className="mono mt-at">{lineClock(s.start)}</span>
      <span className="mt-text">
        {highlightParts(s.text, query).map((p, j) => (p.hit ? <mark key={j}>{p.text}</mark> : <span key={j}>{p.text}</span>))}
        {chips.map((c, j) => (
          <button
            key={`c${j}`}
            className="chip btnlike mt-chip"
            disabled={!c.noteId}
            title={c.noteId ? 'Open the note' : c.label}
            onClick={(e) => {
              e.stopPropagation()
              if (c.noteId) onNote(c.noteId)
            }}
          >
            {c.label}
          </button>
        ))}
      </span>
    </div>
  )
})

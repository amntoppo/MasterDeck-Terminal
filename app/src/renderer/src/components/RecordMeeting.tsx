import { useEffect, useRef, useState } from 'react'
import { MEETING_TITLE_MAX, recordClock as clock, recordedMs, type MeetingLive, type RecordAnswer } from '@shared/meetings'
import { deck } from '../deck'
import { can } from '../web'

/** Record is the Mac's window's only (macOS; the web never records the Mac). */
export const canRecord = () => deck().platform === 'darwin' && can('meetingsStart')

interface Props {
  live: MeetingLive | null | undefined
  /** The consent on Settings → Meetings holds; without it the button opens that screen. */
  agreed: boolean
  open: boolean
  setOpen: (open: boolean) => void
  /** Open Settings → Meetings. */
  onSetup: () => void
}

/**
 * The rail's Record item (spec §2): a title (optional) and Record; while recording, red with the
 * time, and Pause / Stop. Under it, every time: "Tell the others you are recording."
 */
export function RecordMeeting({ live, agreed, open, setOpen, onSetup }: Props) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const box = useRef<HTMLDivElement>(null)
  const recording = !!live?.recording

  useEffect(() => {
    if (!recording) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [recording])
  // Outside a click or Escape closes it (no backdrop: one would sit under the headers' drag regions).
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open, setOpen])
  useEffect(() => {
    if (!open) setMessage(null)
  }, [open])

  if (!canRecord()) return null

  const act = async (f: () => Promise<RecordAnswer>, closeAfter = false) => {
    setBusy(true)
    try {
      const r = await f()
      setMessage(r.message ?? null)
      if (r.ok && closeAfter && !r.message) setOpen(false)
      if (r.ok) setTitle('')
    } catch (e) {
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }

  const time = live && recording ? clock(recordedMs(live, now)) : ''
  const label = recording ? `${live?.paused ? 'Paused' : 'Recording'} ${time}` : 'Record meeting'
  return (
    <div className="rec" ref={box}>
      <button
        className={`rb ${recording ? 'rec-on' : ''} ${open ? 'on' : ''}`}
        data-tip={open ? undefined : label}
        aria-label={label}
        aria-expanded={agreed ? open : undefined}
        onClick={() => (agreed || recording ? setOpen(!open) : onSetup())}
      >
        {recording ? (
          <>
            <span className={`rec-dot ${live?.paused ? 'paused' : ''}`} />
            <span className="rec-time">{time}</span>
          </>
        ) : (
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3.5" fill="currentColor" />
          </svg>
        )}
      </button>
      {open && (
        <div className="rec-pop" role="dialog" aria-label={recording ? 'Recording' : 'Record a meeting'}>
          {recording ? (
            <>
              <div className="rec-head">
                {live?.paused ? 'Paused' : 'Recording'} · {time}
              </div>
              <div className="f-row">
                <button className="btn" disabled={busy} onClick={() => void act(() => deck().meetingsPause(!live?.paused))}>
                  {live?.paused ? 'Resume' : 'Pause'}
                </button>
                <button className="btn primary" disabled={busy} onClick={() => void act(() => deck().meetingsStop(), true)}>
                  Stop
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void act(() => deck().meetingsStart(title.trim() || undefined), true)
              }}
            >
              <div className="rec-head">Record a meeting</div>
              <input
                className="input"
                autoFocus
                value={title}
                maxLength={MEETING_TITLE_MAX}
                placeholder="Title (optional)"
                aria-label="Meeting title"
                onChange={(e) => setTitle(e.target.value.replace(/[\r\n]/g, ' '))}
              />
              <div className="f-row">
                <button className="btn primary" type="submit" disabled={busy}>
                  Record
                </button>
              </div>
            </form>
          )}
          <p className="rec-tell">Tell the others you are recording.</p>
          {message && (
            <p className="rec-msg" role="status">
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

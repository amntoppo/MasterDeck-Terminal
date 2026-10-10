import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import type { MeetingsAnswer, MeetingsSettings, MeetingsSetupInfo, SoundStatus } from '@shared/meetings'
import { deck } from '../deck'
import { Field } from './AccountPanel'

const STATUS: Record<SoundStatus, string> = {
  granted: 'Allowed',
  denied: 'Refused',
  'not-determined': 'Not asked yet',
  restricted: "Blocked by this Mac's policy",
  unknown: 'Unknown',
  'not-checked': 'Not checked yet',
  silent: 'No sound came through',
  unsupported: 'Not on this macOS',
}

const DELETE_AFTER: [number | null, string][] = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [365, 'A year'],
  [null, 'Never'],
]

/**
 * Settings → Meetings (macOS, the window only). The consent card comes first: nothing here asks
 * macOS for anything until the user agrees and then presses Allow.
 */
export function MeetingsSetup({ settings, save }: { settings: Settings; save: (next: Settings) => Promise<void> }) {
  const [info, setInfo] = useState<MeetingsSetupInfo | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const take = (r: MeetingsAnswer) => {
    if (r.ok) setInfo(r)
    setMessage(r.message ?? null)
  }
  const act = async (f: () => Promise<MeetingsAnswer>) => {
    setBusy(true)
    try {
      take(await f())
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void deck().meetingsSetup().then(take)
  }, [])

  const m = settings.meetings
  const setM = (patch: Partial<MeetingsSettings>) => void save({ ...settings, meetings: { ...m, ...patch } })

  if (!info)
    return message ? (
      <p className="set-hint error" role="alert">
        {message}
      </p>
    ) : (
      <p className="set-hint">Loading…</p>
    )

  const note = message && (
    <p className="set-hint" role="status" style={{ padding: '12px 0 0' }}>
      {message}
    </p>
  )

  if (!info.agreed)
    return (
      <>
        <div className="set-field" style={{ display: 'block' }}>
          <div className="set-label">Before you record a meeting</div>
          <ul className="set-hint" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
            <li>
              <b>What is recorded:</b> your microphone and the sound the Mac plays (the other people in the call), from when you press Record until
              Stop.
            </li>
            <li>
              <b>Where it stays:</b> the audio and the transcript are kept on this Mac only, in MasterDeck's folder. The transcript is made on this Mac.
            </li>
            <li>
              <b>What leaves the Mac:</b> once per meeting, the transcript's text and the list of your sessions, tickets and PRs go to Anthropic
              (Claude), to find what relates to which session.
            </li>
            <li>
              <b>No one in the meeting is told.</b> Recording people without telling them is illegal in many places. Telling them is your job.
            </li>
          </ul>
          <div className="f-row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={() => void act(() => deck().meetingsConsent(true))}>
              I agree
            </button>
            <span className="muted">macOS asks for the microphone and the Mac's sound only after this, when you press Allow.</span>
          </div>
        </div>
        {note}
      </>
    )

  const soundButton =
    info.screen === 'granted' || info.screen === 'unsupported' ? null : (
      <button className="btn" disabled={busy} onClick={() => void act(() => deck().meetingsPermission('screen'))}>
        {info.screen === 'denied' || info.screen === 'restricted' ? 'Open System Settings' : 'Allow'}
      </button>
    )
  return (
    <>
      {note}
      <Field label="Microphone" hint="Your side of the meeting.">
        <span className={info.mic === 'granted' ? 'ok' : 'muted'}>{STATUS[info.mic]}</span>
        <span style={{ flex: 1 }} />
        {info.mic !== 'granted' && (
          <button className="btn" disabled={busy} onClick={() => void act(() => deck().meetingsPermission('mic'))}>
            {info.mic === 'denied' || info.mic === 'restricted' ? 'Open System Settings' : 'Allow microphone'}
          </button>
        )}
      </Field>
      <Field
        label="Sound from the Mac"
        hint={
          info.systemAudio === 'tap'
            ? "The other people in the call. macOS: System Audio Recording Only. macOS may want MasterDeck restarted after you allow it."
            : info.systemAudio === 'screen'
              ? 'The other people in the call. macOS: Screen & System Audio Recording. macOS may want MasterDeck restarted after you allow it.'
              : 'This macOS cannot record the sound the Mac plays: meetings record your microphone only.'
        }
      >
        <span className={info.screen === 'granted' ? 'ok' : 'muted'}>{STATUS[info.screen]}</span>
        <span style={{ flex: 1 }} />
        {soundButton}
      </Field>
      <Field label="Speech model" hint="Turns the audio into text on this Mac.">
        <span className="muted">Set up in a later step</span>
      </Field>
      <Field label="Offer to record" hint="When a meeting app is in a call, offer to record it.">
        <button className={`switch ${m.offer ? 'on' : ''}`} role="switch" aria-checked={m.offer} aria-label="Offer to record" onClick={() => setM({ offer: !m.offer })} />
      </Field>
      <Field label="Delete audio after" hint="The transcript and the notes stay; only the recording is removed.">
        <select
          className="input"
          value={m.deleteAudioAfterDays === null ? 'never' : String(m.deleteAudioAfterDays)}
          onChange={(e) => setM({ deleteAudioAfterDays: e.target.value === 'never' ? null : Number(e.target.value) })}
        >
          {(DELETE_AFTER.some(([d]) => d === m.deleteAudioAfterDays) ? DELETE_AFTER : [...DELETE_AFTER, [m.deleteAudioAfterDays, `${m.deleteAudioAfterDays} days`] as [number, string]]).map(([d, label]) => (
            <option key={label} value={d === null ? 'never' : String(d)}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Turn off meetings"
        hint="Takes back your agreement (asked again next time) and stops the offers. Recorded meetings stay. macOS keeps its permissions until you remove them in System Settings."
      >
        <button className="btn" disabled={busy} onClick={() => void act(() => deck().meetingsConsent(false))}>
          Turn off meetings
        </button>
      </Field>
    </>
  )
}

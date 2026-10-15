import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import { MEETING_LANGUAGES, type MeetingsAnswer, type MeetingsSettings, type MeetingsSetupInfo, type SoundStatus } from '@shared/meetings'
import { muteCheckView, type MuteCheckAnswer } from '@shared/meetingMute'
import { modelSize, type ModelOp, type ModelProgress, type ModelsAnswer, type ModelsInfo } from '@shared/meetingModels'
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

const percent = (p: ModelProgress) => (p.total > 0 ? Math.floor((p.received / p.total) * 100) : 0)

/**
 * The speech model: Best or Fast, downloaded once from whisper.cpp's model repository and checked
 * against its SHA-256. The pick is stored by meetings:model (settings.meetings.model).
 */
function ModelRow() {
  const [info, setInfo] = useState<ModelsInfo | null>(null)
  const [progress, setProgress] = useState<ModelProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const take = (r: ModelsAnswer) => {
    if (r.ok) {
      setInfo(r)
      setProgress(r.downloading)
    }
    setMessage(r.message ?? null)
  }
  const call = (op: ModelOp, id?: string) => void deck().meetingsModel(op, id).then(take)
  useEffect(() => {
    call('status')
    return deck().onMeetingsModelProgress((p) => {
      setProgress(p.state === 'downloading' ? p : null)
      if (p.state === 'failed') setMessage(p.message ?? 'The download failed.')
      if (p.state !== 'downloading') void deck().meetingsModel('status').then((r) => r.ok && setInfo(r))
    })
  }, [])

  if (!info)
    return (
      <Field label="Speech model" hint="Turns the audio into text on this Mac.">
        <span className="muted">{message ?? 'Loading…'}</span>
      </Field>
    )
  const id = info.picked ?? info.suggested
  const model = info.models.find((m) => m.id === id) ?? info.models[0]
  const running = progress?.state === 'downloading' ? progress : null
  return (
    <Field
      label="Speech model"
      hint={`Turns the audio into text on this Mac. ${model.hint} Downloaded once from whisper.cpp's model page on Hugging Face; nothing is sent there.`}
    >
      {!info.engine && <span className="bad">Speech engine missing: reinstall MasterDeck.</span>}
      <select className="input" aria-label="Speech model" value={model.id} disabled={!!running} onChange={(e) => call('pick', e.target.value)}>
        {info.models.map((m) => (
          <option key={m.id} value={m.id}>
            {`${m.label} · ${modelSize(m.bytes)}${m.ready ? ' · downloaded' : ''}`}
          </option>
        ))}
      </select>
      {running ? (
        <>
          <progress max={100} value={percent(running)} style={{ width: 120 }} aria-label="Download progress" />
          <span className="muted">
            {percent(running)}% of {modelSize(running.total)}
            {running.id !== model.id ? ` (${info.models.find((m) => m.id === running.id)?.label ?? running.id})` : ''}
          </span>
          <button className="btn" onClick={() => call('cancel')}>
            Cancel
          </button>
        </>
      ) : model.ready ? (
        <>
          <span className="ok">Ready</span>
          <button className="btn" onClick={() => call('remove', model.id)}>
            Remove
          </button>
        </>
      ) : (
        <button className="btn primary" onClick={() => call('download', model.id)}>
          Download {modelSize(model.bytes)}
        </button>
      )}
      {message && (
        <span className="muted" role="status">
          {message}
        </span>
      )}
    </Field>
  )
}

/**
 * Check mute reading: md-mute reads every meeting app for about 3 s (meetings:muteCheck) and the
 * table says what it sees and why. Asks macOS nothing; the window only.
 */
function MuteCheck() {
  const [answer, setAnswer] = useState<MuteCheckAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      setAnswer(await deck().meetingsMuteCheck())
    } catch {
      setAnswer({ ok: false, message: 'Could not run the check.' })
    } finally {
      setBusy(false)
    }
  }
  const view = answer?.ok ? muteCheckView(answer) : null
  return (
    <div className="set-field" style={{ display: 'block' }}>
      <div className="f-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="set-label">Check mute reading</div>
          <div className="set-hint">Join a call, then press Check while muted and again while unmuted.</div>
        </div>
        <button className="btn" disabled={busy} onClick={() => void run()}>
          {busy ? 'Checking…' : 'Check'}
        </button>
      </div>
      {answer && !answer.ok && (
        <p className="set-hint error" role="alert">
          {answer.message}
        </p>
      )}
      {view && (
        <div role="status">
          {view.notes.map((n) => (
            <p key={n} className="set-hint error">
              {n}
            </p>
          ))}
          {view.rows.length > 0 && (
            <table className="mute-check">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Reads</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.app}</td>
                    <td>{r.reads}</td>
                    <td>{r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

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
            ? "The other people in the call. macOS: System Audio Recording Only. Play something (a video, music) when you press Allow: the check listens for one second. macOS may want MasterDeck restarted after you allow it."
            : info.systemAudio === 'screen'
              ? 'The other people in the call. macOS: Screen & System Audio Recording. macOS may want MasterDeck restarted after you allow it.'
              : 'This macOS cannot record the sound the Mac plays: meetings record your microphone only.'
        }
      >
        <span className={info.screen === 'granted' ? 'ok' : 'muted'}>{STATUS[info.screen]}</span>
        <span style={{ flex: 1 }} />
        {soundButton}
        {(info.screen === 'silent' || info.screen === 'denied') && (
          <button className="btn" disabled={busy} onClick={() => void deck().meetingsRestart().then((r) => !r.ok && r.message !== 'cancelled' && setMessage(r.message ?? null))}>
            Restart MasterDeck
          </button>
        )}
      </Field>
      <Field
        label="Your microphone"
        hint={
          m.mic === 'follow'
            ? "Muted in the meeting app, your mic stays out of the recording. If MasterDeck can't see the mute, it records your mic."
            : 'Your mic is recorded the whole time, muted in the meeting app or not.'
        }
      >
        <select className="input" aria-label="Your microphone" value={m.mic} onChange={(e) => setM({ mic: e.target.value === 'always' ? 'always' : 'follow' })}>
          <option value="follow">Follow the meeting app's mute</option>
          <option value="always">Always record</option>
        </select>
      </Field>
      {m.mic === 'follow' && (
        <Field label="Accessibility" hint="Reads only the meeting app's mute button. Nothing else on screen.">
          <span className={info.accessibility === 'granted' ? 'ok' : 'muted'}>{STATUS[info.accessibility]}</span>
          <span style={{ flex: 1 }} />
          {info.accessibility !== 'granted' && (
            <button className="btn" disabled={busy} onClick={() => void act(() => deck().meetingsPermission('accessibility'))}>
              {info.accessibility === 'denied' || info.accessibility === 'restricted' ? 'Open System Settings' : 'Allow'}
            </button>
          )}
        </Field>
      )}
      {m.mic === 'follow' && <MuteCheck />}
      <ModelRow />
      <Field label="Language" hint="What the meetings are spoken in. Automatic detection works for most; pick one when a meeting is in one language.">
        <select className="input" aria-label="Meeting language" value={m.language} onChange={(e) => setM({ language: e.target.value })}>
          {(MEETING_LANGUAGES.some(([c]) => c === m.language) ? MEETING_LANGUAGES : [...MEETING_LANGUAGES, [m.language, m.language] as [string, string]]).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
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

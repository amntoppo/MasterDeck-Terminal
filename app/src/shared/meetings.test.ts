import { describe, expect, it } from 'vitest'
import {
  webState,
  micLine,
  type MicLive,
  DEFAULT_MEETINGS,
  keepMeetings,
  mediaAllowed,
  MEETINGS_CONSENT_VERSION,
  meetingsAgreed,
  normalizeMeetings,
  privacyPane,
  soundStatus,
  systemAudioPath,
} from './meetings'

const agreed = { ...DEFAULT_MEETINGS, consentAt: 5, consentVersion: MEETINGS_CONSENT_VERSION }

describe('normalizeMeetings', () => {
  it('defaults for nothing, junk and settings files from before meetings', () => {
    for (const raw of [undefined, null, 'x', [], {}]) expect(normalizeMeetings(raw)).toEqual(DEFAULT_MEETINGS)
    expect(DEFAULT_MEETINGS).toEqual({ consentAt: null, consentVersion: 0, model: null, language: 'auto', offer: true, deleteAudioAfterDays: 30, systemAudio: null, mic: 'follow' })
  })
  it('keeps good values and drops bad ones', () => {
    expect(
      normalizeMeetings({ consentAt: 5, consentVersion: 1, model: 'ggml-base.en', language: 'de', offer: false, deleteAudioAfterDays: null, systemAudio: { at: 7, ok: true }, mic: 'always' }),
    ).toEqual({ consentAt: 5, consentVersion: 1, model: 'ggml-base.en', language: 'de', offer: false, deleteAudioAfterDays: null, systemAudio: { at: 7, ok: true }, mic: 'always' })
    // Settings from before Plan M, or junk: follow the meeting app's mute.
    expect(normalizeMeetings({ mic: 'never' }).mic).toBe('follow')
    expect(normalizeMeetings({ offer: false }).mic).toBe('follow')
    expect(normalizeMeetings({ model: '../x', language: 'English', offer: 'yes', deleteAudioAfterDays: 0.5, systemAudio: { at: 'now', ok: true } })).toEqual(DEFAULT_MEETINGS)
    expect(normalizeMeetings({ deleteAudioAfterDays: 99_999 }).deleteAudioAfterDays).toBe(30)
  })
  it('a consent is a time and a version together, or neither', () => {
    expect(normalizeMeetings({ consentAt: 5 })).toMatchObject({ consentAt: null, consentVersion: 0 })
    expect(normalizeMeetings({ consentVersion: 1 })).toMatchObject({ consentAt: null, consentVersion: 0 })
  })
})

describe('meetingsAgreed', () => {
  it('only the current version counts', () => {
    expect(meetingsAgreed({ meetings: DEFAULT_MEETINGS })).toBe(false)
    expect(meetingsAgreed({ meetings: agreed })).toBe(true)
    expect(meetingsAgreed({ meetings: { ...agreed, consentVersion: MEETINGS_CONSENT_VERSION - 1 || 99 } })).toBe(false)
    expect(meetingsAgreed({ meetings: { ...agreed, consentAt: null } })).toBe(false)
  })
})

describe('keepMeetings', () => {
  it('the window changes the offer and the audio timer but never the consent or the sound check', () => {
    const r = keepMeetings({ dockBadge: false, meetings: { ...agreed, consentAt: 9, offer: false, deleteAudioAfterDays: 7, systemAudio: { at: 1, ok: true } } }, DEFAULT_MEETINGS, false)
    expect(r.dockBadge).toBe(false)
    expect(r.meetings).toEqual({ ...DEFAULT_MEETINGS, offer: false, deleteAudioAfterDays: 7 })
    // A stale window (no meetings, or an old copy) never takes a consent back either.
    expect(keepMeetings({ meetings: DEFAULT_MEETINGS }, agreed, false).meetings).toEqual(agreed)
    expect(keepMeetings({}, agreed, false).meetings).toEqual(agreed)
  })
  it('a browser changes no meetings setting', () => {
    expect(keepMeetings({ meetings: { ...agreed, offer: false } }, DEFAULT_MEETINGS, true).meetings).toEqual(DEFAULT_MEETINGS)
    expect(keepMeetings('junk', agreed, true)).toEqual({ meetings: agreed })
  })
})

describe('mediaAllowed', () => {
  it('the microphone and the screen only in the capture partition while agreed', () => {
    for (const p of ['media', 'display-capture']) {
      expect(mediaAllowed(p, false, true)).toBe(false)
      expect(mediaAllowed(p, true, false)).toBe(false)
      expect(mediaAllowed(p, true, true)).toBe(true)
    }
    expect(mediaAllowed('notifications', false, false)).toBe(true)
    expect(mediaAllowed('clipboard-sanitized-write', false, false)).toBe(true)
  })

  it('never a clipboard read, in any partition, agreed or not', () => {
    for (const p of ['clipboard-read', 'deprecated-sync-clipboard-read'])
      for (const [inCapture, ok] of [[false, false], [true, true], [false, true], [true, false]])
        expect(mediaAllowed(p, inCapture, ok), `${p} ${inCapture} ${ok}`).toBe(false)
  })
})

describe('the Mac sound', () => {
  it('path by macOS version', () => {
    expect(systemAudioPath('14.2.0')).toBe('tap')
    expect(systemAudioPath('15.1')).toBe('tap')
    expect(systemAudioPath('26.4')).toBe('tap')
    expect(systemAudioPath('14.1.2')).toBe('screen')
    expect(systemAudioPath('13.0')).toBe('screen')
    expect(systemAudioPath('12.7.1')).toBe('none')
    expect(systemAudioPath('')).toBe('none')
  })
  it('status from the check (14.2+) or the Screen Recording grant (13 to 14.1)', () => {
    expect(soundStatus('tap', 'denied', null)).toBe('not-checked')
    expect(soundStatus('tap', 'denied', { at: 1, ok: true })).toBe('granted')
    expect(soundStatus('tap', 'granted', { at: 1, ok: false })).toBe('silent')
    expect(soundStatus('screen', 'denied', { at: 1, ok: true })).toBe('denied')
    expect(soundStatus('none', 'granted', null)).toBe('unsupported')
  })
  it("System Settings' panes", () => {
    expect(privacyPane('mic', 'tap')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    expect(privacyPane('screen', 'tap')).toMatch(/\?Privacy_AudioCapture$/)
    expect(privacyPane('screen', 'screen')).toMatch(/\?Privacy_ScreenCapture$/)
  })
})

describe('webState', () => {
  const live = { recording: false, since: null, paused: false, elapsed: 0, offer: 'Zoom' as string | null, mic: null }
  it('blanks the offered call app and leaves the rest', () => {
    const s = { sessions: [1], meetingLive: live }
    const w = webState(s)
    expect(w).toEqual({ sessions: [1], meetingLive: { ...live, offer: null } })
    // The Mac's own state is untouched.
    expect(s.meetingLive.offer).toBe('Zoom')
  })
  it('leaves meetings notices out of a web tab\'s Needs you, and the other notices in', () => {
    const item = (id: string, notify: 'meeting' | 'pr-merged') => ({ item: { id, kind: 'notice' as const, detail: { type: 'notice' as const, notify } } })
    const inbox = { open: [item('a', 'meeting'), item('b', 'pr-merged')], snoozed: [item('c', 'meeting')], history: [] }
    const w = webState({ meetingLive: null, inbox } as never) as { inbox: typeof inbox }
    expect(w.inbox.open.map((e) => e.item.id)).toEqual(['b'])
    expect(w.inbox.snoozed).toEqual([])
    expect(inbox.open).toHaveLength(2)
    const plain = { meetingLive: null, inbox: { open: [item('b', 'pr-merged')], snoozed: [], history: [] } }
    expect(webState(plain as never)).toBe(plain)
  })
  it('passes a state with no offer through as it is', () => {
    const s = { meetingLive: { ...live, offer: null } }
    expect(webState(s)).toBe(s)
    const n = { meetingLive: null }
    expect(webState(n)).toBe(n)
    const u = {}
    expect(webState(u)).toBe(u)
  })
  it('blanks the app the mic follows and keeps the rest of mic', () => {
    const mic = { mode: 'follow' as const, app: 'Zoom', state: 'muted' as const, manualOff: false, kept: false, paused: false, reason: null }
    const s = { meetingLive: { ...live, recording: true, offer: null, mic } }
    expect(webState(s).meetingLive.mic).toEqual({ ...mic, app: null })
    expect(s.meetingLive.mic.app).toBe('Zoom')
    const none = { meetingLive: { ...live, recording: true, offer: null, mic: { ...mic, app: null } } }
    expect(webState(none)).toBe(none)
  })
})

describe('privacyPane: Accessibility', () => {
  it('opens Privacy_Accessibility', () => {
    expect(privacyPane('accessibility', 'tap')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  })
})

describe('micLine', () => {
  const mic = (p: Partial<MicLive>): MicLive => ({ mode: 'follow', app: 'Zoom', state: 'unknown', manualOff: false, kept: true, paused: false, reason: null, ...p })
  const text = (p: Partial<MicLive>) => micLine(mic(p))?.text

  it('nothing while nothing records', () => {
    expect(micLine(null)).toBeNull()
    expect(micLine(undefined)).toBeNull()
  })
  it('follows the app: muted, on, and no app name on the web', () => {
    expect(text({ state: 'muted', kept: false })).toBe('Mic: muted in Zoom — not recorded')
    expect(text({ state: 'unmuted' })).toBe('Mic: on in Zoom')
    expect(text({ state: 'muted', app: null })).toBe('Mic: muted in the meeting app — not recorded')
    expect(text({ state: 'unknown' })).toBe('Mic: recorded.')
  })
  it('says why the mute is not known; only Accessibility points at Settings', () => {
    expect(micLine(mic({ reason: 'not-trusted' }))).toEqual({ text: 'Mic: recorded. Allow Accessibility in Settings → Meetings to follow your mute.', settings: true })
    expect(micLine(mic({ reason: 'no-app', app: null }))).toEqual({ text: 'Mic: recorded. No meeting app found.', settings: false })
    expect(text({ reason: 'unreadable' })).toBe("Mic: recorded. Can't see your mute in Zoom.")
    expect(text({ reason: 'no-helper' })).toBe('Mic: recorded. The mute reader is missing; reinstall MasterDeck.')
    expect(text({ reason: 'helper-ended' })).toBe('Mic: recorded. The mute reader stopped; trying again.')
  })
  it('paused: no app state', () => {
    expect(text({ paused: true, kept: false, state: 'muted' })).toBe('Mic: paused.')
    expect(text({ paused: true, kept: false, reason: 'not-trusted' })).toBe('Mic: paused.')
    expect(micLine(mic({ paused: true, kept: false, manualOff: true }))).toEqual({ text: 'Mic: paused.', settings: false })
  })
  it('always mode and the switch come first', () => {
    expect(text({ mode: 'always', state: 'unknown' })).toBe('Mic: always recorded.')
    expect(text({ manualOff: true, kept: false, state: 'unmuted' })).toBe('Mic: off in the recording.')
    expect(text({ manualOff: true, mode: 'always', kept: false })).toBe('Mic: off in the recording.')
  })
})

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MuteApp, MuteReading, MuteRule } from '@shared/meetingMute'
import type { MicLogEntry, MicMode } from '@shared/meetings'
import { MUTE_TICK_MS, MUTE_UNKNOWN_HOLD } from '@shared/meetingMute'
import { MUTE_RESTARTS, MuteWatch } from './mute'
import type { MuteHelper } from './muteHelper'

// Never the real md-mute and never a real app: a fake helper, and a stand-in path for findMute.
let root: string
let bin: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-mutewatch-'))
  bin = join(root, 'md-mute')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  chmodSync(bin, 0o755)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface FakeHelper extends MuteHelper {
  rules: readonly MuteRule[]
  killed: boolean
  send(apps: MuteApp[], trusted?: boolean): void
  exit(): void
}

function watch(over: { mode?: MicMode; trusted?: boolean; noHelper?: boolean } = {}) {
  let mode: MicMode = over.mode ?? 'follow'
  let trusted = over.trusted ?? true
  const gates: boolean[] = []
  const helpers: FakeHelper[] = []
  const logs: Omit<MicLogEntry, 't'>[] = []
  let changes = 0
  const w = new MuteWatch({
    mode: () => mode,
    trusted: () => trusted,
    where: () => ({ env: { MASTERDECK_MUTE: over.noHelper ? join(root, 'none') : bin }, resourcesPath: root, appRoot: root, packaged: true, arch: 'arm64' }),
    gate: (on) => void gates.push(on),
    onChange: () => void changes++,
    log: (e) => void logs.push(e),
    spawn: (_bin, rules) => {
      const lines: ((r: MuteReading) => void)[] = []
      const exits: ((c: number | null, e: string) => void)[] = []
      let t = 0
      const h: FakeHelper = {
        rules,
        killed: false,
        onLine: (cb) => void lines.push(cb),
        onExit: (cb) => void exits.push(cb),
        kill: () => void (h.killed = true),
        send: (apps, tr = true) => lines.forEach((cb) => cb({ t: ++t, trusted: tr, apps })),
        exit: () => exits.forEach((cb) => cb(1, 'gone')),
      }
      helpers.push(h)
      return h
    },
  })
  return {
    w,
    gates,
    logs,
    helpers,
    last: () => helpers[helpers.length - 1],
    changes: () => changes,
    setMode: (m: MicMode) => (mode = m),
    setTrusted: (v: boolean) => (trusted = v),
  }
}
const run = { recording: true, paused: false }
const zoom = (state: MuteApp['state']): MuteApp[] => [{ id: 'zoom', state }]

describe('MuteWatch', () => {
  it('begin() sets the gate (off: nothing known yet) and starts md-mute before Record', () => {
    const t = watch()
    t.w.begin('Zoom')
    expect(t.gates).toEqual([false])
    expect(t.helpers).toHaveLength(1)
    // The offered call app's rule alone.
    expect(t.last().rules.map((r) => r.id)).toEqual(['zoom'])
    expect(t.w.live()).toBeNull()
    t.w.sync(run)
    expect(t.helpers).toHaveLength(1)
    expect(t.w.live()).toEqual({ mode: 'follow', app: null, state: 'unknown', manualOff: false, kept: true, paused: false, reason: 'no-app' })
  })

  it('a muted reading before the recording runs gates before the mic opens', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.last().send(zoom('muted'))
    expect(t.gates).toEqual([false, true])
    t.w.sync(run)
    expect(t.helpers).toHaveLength(1)
    expect(t.w.live()).toMatchObject({ app: 'Zoom', state: 'muted', kept: false })
  })

  it('a start that fails kills the md-mute begin() started', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync({ recording: false, paused: false })
    expect(t.last().killed).toBe(true)
    expect(t.w.live()).toBeNull()
  })

  it('no call app known: every rule; the first app it can read is followed', () => {
    const t = watch()
    t.w.begin(null)
    t.w.sync(run)
    expect(t.last().rules.length).toBeGreaterThan(1)
    t.last().send([{ id: 'zoom', state: 'unknown' }, { id: 'meet', state: 'unmuted' }])
    expect(t.w.live()).toMatchObject({ app: 'Google Meet', state: 'unmuted', kept: true, paused: false, reason: null })
  })

  it('the first muted reading gates; back to the mic after two equal readings', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('muted'))
    expect(t.gates).toEqual([false, true])
    expect(t.w.live()).toMatchObject({ app: 'Zoom', state: 'muted', kept: false, paused: false, reason: null })
    t.last().send(zoom('unmuted'))
    expect(t.gates).toEqual([false, true])
    t.last().send(zoom('unmuted'))
    expect(t.gates).toEqual([false, true, false])
    expect(t.w.live()).toMatchObject({ state: 'unmuted', kept: true })
  })

  it('unknown keeps the mic: the app found but not readable says so', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('unknown'))
    expect(t.gates).toEqual([false])
    expect(t.w.live()).toMatchObject({ app: 'Zoom', state: 'unknown', kept: true, reason: 'unreadable' })
  })

  it('the app gone, or trusted:false, lets the mic in after about 3 s of readings', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('muted'))
    for (let i = 0; i < MUTE_UNKNOWN_HOLD - 1; i++) t.last().send([])
    expect(t.gates).toEqual([false, true])
    t.last().send([])
    expect(t.gates).toEqual([false, true, false])
    expect(t.w.live()).toMatchObject({ app: null, reason: 'no-app', kept: true })
    t.last().send(zoom('muted'))
    for (let i = 0; i < MUTE_UNKNOWN_HOLD - 1; i++) t.last().send(zoom('unknown'), false)
    expect(t.gates).toEqual([false, true, false, true])
    expect(t.w.live()).toMatchObject({ state: 'muted', kept: false })
    t.last().send(zoom('unknown'), false)
    expect(t.gates).toEqual([false, true, false, true, false])
    expect(t.w.live()).toMatchObject({ state: 'unknown', reason: 'not-trusted', kept: true })
    // Not muted: trusted:false is unknown at once.
    t.last().send(zoom('unmuted'))
    t.last().send(zoom('unknown'), false)
    expect(t.w.live()).toMatchObject({ state: 'unknown', reason: 'not-trusted', kept: true })
  })

  it('a short gap in the reading (md-mute searching again) keeps the mute', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('muted'))
    for (let i = 0; i < MUTE_UNKNOWN_HOLD - 1; i++) t.last().send(zoom('unknown'))
    t.last().send(zoom('muted'))
    for (let i = 0; i < MUTE_UNKNOWN_HOLD - 1; i++) t.last().send(zoom('unknown'))
    expect(t.gates).toEqual([false, true])
    expect(t.w.live()).toMatchObject({ state: 'muted', kept: false })
    t.last().send(zoom('unknown'))
    expect(t.gates).toEqual([false, true, false])
    expect(t.w.live()).toMatchObject({ state: 'unknown', reason: 'unreadable', kept: true })
  })

  it('another app followed while muted: still gated until it gives two equal readings', () => {
    const t = watch()
    t.w.begin(null)
    t.w.sync(run)
    t.last().send(zoom('muted'))
    expect(t.gates).toEqual([false, true])
    // Zoom gone, Teams read as unmuted: one reading never lets the mic in.
    t.last().send([{ id: 'teams', state: 'unmuted' }])
    expect(t.gates).toEqual([false, true])
    expect(t.w.live()).toMatchObject({ app: 'Teams', state: 'muted' })
    t.last().send([{ id: 'teams', state: 'unmuted' }])
    expect(t.gates).toEqual([false, true, false])
  })

  it('a muted app that reads unknown for a moment is still followed over another readable one', () => {
    const t = watch()
    t.w.begin(null)
    t.w.sync(run)
    t.last().send(zoom('muted'))
    const both: MuteApp[] = [
      { id: 'zoom', state: 'unknown' },
      { id: 'teams', state: 'unmuted' },
    ]
    for (let i = 0; i < 3; i++) t.last().send(both)
    expect(t.gates).toEqual([false, true])
    expect(t.w.live()).toMatchObject({ app: 'Zoom', state: 'muted' })
  })

  it('Accessibility not allowed: no md-mute, the mic records, the reason says so', () => {
    const t = watch({ trusted: false })
    t.w.begin('Zoom')
    t.w.sync(run)
    expect(t.helpers).toHaveLength(0)
    expect(t.w.live()).toMatchObject({ state: 'unknown', kept: true, reason: 'not-trusted' })
    // Allowed during the recording: the next sync starts it.
    t.setTrusted(true)
    t.w.sync(run)
    expect(t.helpers).toHaveLength(1)
  })

  it('md-mute missing or ended: unknown, the mic records', () => {
    const missing = watch({ noHelper: true })
    missing.w.begin(null)
    missing.w.sync(run)
    expect(missing.helpers).toHaveLength(0)
    expect(missing.w.live()).toMatchObject({ reason: 'no-helper', kept: true })
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('unmuted'))
    t.last().exit()
    expect(t.gates).toEqual([false])
    expect(t.w.running).toBe(false)
    expect(t.w.live()).toMatchObject({ reason: 'helper-ended', kept: true })
  })

  describe('md-mute down while muted', () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it('an exit keeps the mic out until the hold runs out on the reading clock', () => {
      const t = watch()
      t.w.begin('Zoom')
      t.w.sync(run)
      t.last().send(zoom('muted'))
      t.last().exit()
      expect(t.gates).toEqual([false, true])
      expect(t.w.live()).toMatchObject({ state: 'muted', app: 'Zoom', kept: false, reason: null })
      vi.advanceTimersByTime(MUTE_TICK_MS * (MUTE_UNKNOWN_HOLD - 1))
      expect(t.gates).toEqual([false, true])
      vi.advanceTimersByTime(MUTE_TICK_MS)
      expect(t.gates).toEqual([false, true, false])
      expect(t.w.live()).toMatchObject({ state: 'unknown', reason: 'helper-ended', kept: true })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('a restart within the hold keeps the mic out', () => {
      const t = watch()
      t.w.begin('Zoom')
      t.w.sync(run)
      t.last().send(zoom('muted'))
      t.last().exit()
      vi.advanceTimersByTime(MUTE_TICK_MS * 3)
      t.w.sync(run)
      expect(t.w.running).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      t.last().send(zoom('muted'))
      vi.advanceTimersByTime(MUTE_TICK_MS * MUTE_UNKNOWN_HOLD * 2)
      expect(t.gates).toEqual([false, true])
      expect(t.w.live()).toMatchObject({ state: 'muted', kept: false })
    })

    it('a restart that fails keeps the hold; a pause or stop ends it, keeping or dropping the mute', () => {
      const t = watch()
      t.w.begin('Zoom')
      t.w.sync(run)
      t.last().send(zoom('muted'))
      t.last().exit()
      t.setTrusted(false)
      t.w.sync(run)
      expect(t.gates).toEqual([false, true])
      expect(vi.getTimerCount()).toBe(1)
      t.w.sync({ recording: true, paused: true })
      expect(vi.getTimerCount()).toBe(0)
      expect(t.w.live()).toMatchObject({ state: 'muted', paused: true })
      t.w.sync(run)
      expect(vi.getTimerCount()).toBe(1)
      t.w.stop()
      expect(vi.getTimerCount()).toBe(0)
      expect(t.gates.at(-1)).toBe(false)
    })
  })

  it('waiting while following but unable to read; a helper that ended is started again at most MUTE_RESTARTS times', () => {
    const nt = watch({ trusted: false })
    nt.w.begin('Zoom')
    nt.w.sync(run)
    expect(nt.w.waiting).toBe(true)
    nt.w.sync({ recording: true, paused: true })
    expect(nt.w.waiting).toBe(false)
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    expect(t.w.waiting).toBe(false)
    for (let i = 0; i < MUTE_RESTARTS; i++) {
      t.last().exit()
      expect(t.w.waiting).toBe(true)
      t.w.sync(run)
      expect(t.w.running).toBe(true)
    }
    expect(t.helpers).toHaveLength(MUTE_RESTARTS + 1)
    t.last().exit()
    expect(t.w.waiting).toBe(false)
    t.w.sync(run)
    expect(t.helpers).toHaveLength(MUTE_RESTARTS + 1)
    expect(t.w.live()).toMatchObject({ reason: 'helper-ended', kept: true })
    // The next recording may start it again.
    t.w.sync({ recording: false, paused: false })
    t.w.begin('Zoom')
    expect(t.helpers).toHaveLength(MUTE_RESTARTS + 2)
  })

  it("'always' runs no md-mute; switching to it mid-recording kills md-mute and lets the mic in", () => {
    const a = watch({ mode: 'always' })
    a.w.begin('Zoom')
    a.w.sync(run)
    expect(a.helpers).toHaveLength(0)
    expect(a.w.live()).toEqual({ mode: 'always', app: null, state: 'unknown', manualOff: false, kept: true, paused: false, reason: null })
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('muted'))
    t.setMode('always')
    t.w.sync(run)
    expect(t.last().killed).toBe(true)
    expect(t.gates).toEqual([false, true, false])
    t.setMode('follow')
    t.w.sync(run)
    expect(t.helpers).toHaveLength(2)
  })

  it('the manual switch gates in either mode; the next recording starts with it off', () => {
    const t = watch({ mode: 'always' })
    t.w.begin(null)
    t.w.sync(run)
    t.w.setManualOff(true)
    expect(t.gates).toEqual([false, true])
    expect(t.w.live()).toMatchObject({ manualOff: true, kept: false })
    t.w.sync({ recording: false, paused: false })
    expect(t.w.live()).toBeNull()
    t.w.begin(null)
    expect(t.gates.at(-1)).toBe(false)
    t.w.sync(run)
    expect(t.w.live()).toMatchObject({ manualOff: false, kept: true })
  })

  it('pause kills md-mute and keeps the settled mute; resume starts it again', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    const first = t.last()
    first.send(zoom('muted'))
    t.w.sync({ recording: true, paused: true })
    expect(first.killed).toBe(true)
    expect(t.w.live()).toMatchObject({ state: 'muted', kept: false })
    // A line from the killed helper changes nothing.
    first.send(zoom('unmuted'))
    first.send(zoom('unmuted'))
    expect(t.w.live()).toMatchObject({ state: 'muted' })
    t.w.sync(run)
    expect(t.helpers).toHaveLength(2)
    expect(t.gates.at(-1)).toBe(true)
  })

  it('stop and Turn off kill md-mute and set the gate off', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('muted'))
    t.w.stop()
    expect(t.last().killed).toBe(true)
    expect(t.gates.at(-1)).toBe(false)
    expect(t.w.live()).toBeNull()
    const n = t.changes()
    t.w.sync({ recording: false, paused: false })
    expect(t.changes()).toBe(n)
  })

  it('onChange only when what live() says changed', () => {
    const t = watch()
    t.w.begin('Zoom')
    t.w.sync(run)
    t.last().send(zoom('unmuted'))
    const n = t.changes()
    t.last().send(zoom('unmuted'))
    t.last().send(zoom('unmuted'))
    expect(t.changes()).toBe(n)
  })

  it('the Mic log: what md-mute read, why and the gate, only on change and only while recording', () => {
    const t = watch()
    t.w.begin('Google Meet')
    const meet = (state: MuteApp['state'], why: MuteApp['why'], extra: Partial<MuteApp> = {}): MuteApp[] => [{ id: 'meet', state, why, ...extra }]
    // Before the recording runs: nothing logged.
    t.last().send(meet('unknown', 'no-control'))
    expect(t.logs).toEqual([])
    t.w.sync(run)
    t.last().send(meet('unknown', 'no-control', { searched: 900, ms: 30 }))
    t.last().send(meet('unknown', 'no-control', { searched: 0, ms: 0 }))
    t.last().send(meet('muted', 'found', { label: 'Turn on microphone', cached: false }))
    t.last().send(meet('muted', 'found', { label: 'Turn on microphone', cached: true }))
    t.last().send(meet('unmuted', 'found'))
    t.last().send(meet('unmuted', 'found'))
    t.w.sync({ recording: true, paused: true })
    t.w.sync(run)
    t.last().send(meet('unknown', 'not-trusted'), false)
    t.w.stop()
    expect(t.logs).toEqual([
      { state: 'unknown', app: 'Google Meet', why: 'no-control', reason: 'unreadable', gated: false },
      { state: 'muted', app: 'Google Meet', why: 'found', gated: true },
      // One unmuted reading keeps the settled mute (MuteSettle); the second lets the mic in.
      { state: 'unmuted', app: 'Google Meet', why: 'found', gated: true },
      { state: 'unmuted', app: 'Google Meet', why: 'found', gated: false },
      { state: 'unknown', app: 'Google Meet', gated: false, paused: true },
      { state: 'unknown', app: 'Google Meet', gated: false },
      { state: 'unknown', app: null, why: 'not-trusted', reason: 'not-trusted', gated: false },
    ])
  })
})

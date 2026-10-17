import { describe, expect, it } from 'vitest'
import { defaultRoutes, withCell, type ChannelId, type NotifyPrefs } from '@shared/notifications'
import { COALESCE_MS, Notifier, type Note } from './notifier'

function setup(p: Partial<NotifyPrefs> = {}) {
  const prefs: NotifyPrefs = { notifications: defaultRoutes(), notifyPaused: false, ...p }
  const sent: [ChannelId, string, string][] = []
  let now = 1_000
  const sender = (c: ChannelId) => (n: Note, type: string) => void sent.push([c, type, n.title])
  const notifier = new Notifier(() => prefs, { system: sender('system'), needsYou: sender('needsYou'), mobile: sender('mobile') }, () => now)
  return { prefs, sent, notifier, tick: (ms: number) => (now += ms) }
}

const note = (o: Partial<Note> = {}): Note => ({ title: 'T', body: 'B', target: {}, ...o })

describe('Notifier', () => {
  it('routes each type to its channels', () => {
    const { notifier, sent, prefs } = setup()
    prefs.notifications = withCell(prefs.notifications, 'pr-merged', 'needsYou', true)
    expect(notifier.dispatch('pr-merged', note())).toEqual(['system', 'needsYou'])
    expect(notifier.dispatch('monitor', note())).toEqual([])
    expect(sent).toEqual([
      ['system', 'pr-merged', 'T'],
      ['needsYou', 'pr-merged', 'T'],
    ])
  })

  it('reads the settings at each dispatch (no restart)', () => {
    const { notifier, prefs } = setup()
    prefs.notifications = withCell(prefs.notifications, 'session-finished', 'system', false)
    expect(notifier.dispatch('session-finished', note())).toEqual([])
    prefs.notifications = withCell(prefs.notifications, 'session-finished', 'system', true)
    expect(notifier.dispatch('session-finished', note())).toEqual(['system'])
  })

  it('does not add an inbox item to Needs you again', () => {
    const { notifier, sent } = setup()
    expect(notifier.dispatch('ci-failed', note({ itemId: 'offer:x' }))).toEqual(['system'])
    expect(sent.map((s) => s[0])).toEqual(['system'])
  })

  it('pause stops the system channel only', () => {
    const { notifier, prefs } = setup({ notifyPaused: true })
    prefs.notifications = withCell(prefs.notifications, 'pr-ready', 'needsYou', true)
    expect(notifier.dispatch('pr-ready', note())).toEqual(['needsYou'])
  })

  it('coalesces by key within a minute', () => {
    const { notifier, tick } = setup()
    const n = note({ coalesce: 'session-finished:a' })
    expect(notifier.dispatch('session-finished', n)).toEqual(['system'])
    tick(COALESCE_MS - 1)
    expect(notifier.dispatch('session-finished', n)).toEqual([])
    expect(notifier.dispatch('session-finished', note({ coalesce: 'session-finished:b' }))).toEqual(['system'])
    tick(1)
    expect(notifier.dispatch('session-finished', n)).toEqual(['system'])
  })

  it('a test goes through every available channel, paused or not', () => {
    const { notifier, sent } = setup({ notifyPaused: true })
    expect(notifier.test()).toEqual(['system', 'needsYou'])
    expect(sent.map((s) => [s[0], s[1]])).toEqual([
      ['system', 'test'],
      ['needsYou', 'test'],
    ])
  })

  it('one failing channel does not stop the others', () => {
    const prefs: NotifyPrefs = { notifications: withCell(defaultRoutes(), 'pr-ready', 'needsYou', true), notifyPaused: false }
    const got: string[] = []
    const n = new Notifier(() => prefs, {
      system: () => {
        throw new Error('no')
      },
      needsYou: () => void got.push('needsYou'),
      mobile: () => {},
    })
    expect(n.dispatch('pr-ready', note())).toEqual(['system', 'needsYou'])
    expect(got).toEqual(['needsYou'])
  })
})

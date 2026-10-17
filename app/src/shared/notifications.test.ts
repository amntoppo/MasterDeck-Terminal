import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  NOTIFY_TYPES,
  cellOf,
  isMeetingNotice,
  itemTarget,
  defaultRoutes,
  needsYouSystemOn,
  normalizeRoutes,
  routeOf,
  showsInNeedsYou,
  typeOfKind,
  withCell,
  withNeedsYouSystem,
  type NotifyPrefs,
} from './notifications'
import type { InboxItem } from './inbox'

const prefs = (o: Partial<NotifyPrefs> = {}): NotifyPrefs => ({ notifications: defaultRoutes(), notifyPaused: false, ...o })
const kind = (k: InboxItem['kind'], detail: InboxItem['detail'] = { type: 'session' }) => ({ kind: k, detail })

describe('the registry', () => {
  it('has unique ids and a default for every channel', () => {
    expect(new Set(NOTIFY_TYPES.map((t) => t.id)).size).toBe(NOTIFY_TYPES.length)
    expect(new Set(CHANNELS.map((c) => c.id)).size).toBe(CHANNELS.length)
    for (const t of NOTIFY_TYPES) for (const c of CHANNELS) expect(typeof t.defaults[c.id]).toBe('boolean')
  })

  it("defaults are today's behaviour", () => {
    const p = prefs()
    expect(routeOf(p, 'session-finished')).toEqual(['system'])
    expect(routeOf(p, 'pr-ready')).toEqual(['system'])
    expect(routeOf(p, 'pr-merged')).toEqual(['system'])
    expect(routeOf(p, 'workflow')).toEqual(['system'])
    expect(routeOf(p, 'meeting')).toEqual(['system'])
    expect(routeOf(p, 'session-input')).toEqual(['system', 'needsYou'])
    expect(routeOf(p, 'needs-you')).toEqual(['system', 'needsYou'])
    expect(routeOf(p, 'ci-failed')).toEqual(['system', 'needsYou'])
    expect(routeOf(p, 'monitor')).toEqual([])
    expect(routeOf(p, 'update')).toEqual([])
  })
})

describe('normalizeRoutes', () => {
  it('migrates notifyNeedsYou: false to the inbox types only', () => {
    const r = normalizeRoutes(undefined, false)
    expect(r['session-input'].system).toBe(false)
    expect(r['needs-you'].system).toBe(false)
    expect(r['ci-failed'].system).toBe(false)
    expect(r['session-finished'].system).toBe(true)
    expect(r['session-input'].needsYou).toBe(true)
  })

  it('ignores notifyNeedsYou once routes are stored', () => {
    expect(normalizeRoutes({ 'ci-failed': { system: true } }, false)['ci-failed'].system).toBe(true)
    expect(normalizeRoutes({}, false)['ci-failed'].system).toBe(true)
  })

  it('keeps stored cells, fills gaps, drops unknown keys and bad values', () => {
    const r = normalizeRoutes({ 'pr-merged': { system: false, needsYou: true, slack: true }, nope: { system: true }, 'pr-ready': { system: 'yes' } })
    expect(r['pr-merged']).toEqual({ system: false, needsYou: true, mobile: false })
    expect(r['pr-ready'].system).toBe(true)
    expect(Object.keys(r)).toEqual(NOTIFY_TYPES.map((t) => t.id))
    expect('nope' in r).toBe(false)
  })

  it('keeps fixed cells whatever is stored', () => {
    expect(normalizeRoutes({ 'needs-you': { needsYou: false } })['needs-you'].needsYou).toBe(true)
  })

  it('reads garbage as defaults', () => {
    expect(normalizeRoutes('x')).toEqual(defaultRoutes())
    expect(normalizeRoutes([1, 2])).toEqual(defaultRoutes())
  })
})

describe('routeOf', () => {
  it('a cell off stops that type on that channel only', () => {
    const p = prefs({ notifications: withCell(defaultRoutes(), 'pr-merged', 'system', false) })
    expect(routeOf(p, 'pr-merged')).toEqual([])
    expect(routeOf(p, 'pr-ready')).toEqual(['system'])
    const back = prefs({ notifications: withCell(p.notifications, 'pr-merged', 'system', true) })
    expect(routeOf(back, 'pr-merged')).toEqual(['system'])
  })

  it('pause stops system notifications and keeps Needs you and the choices', () => {
    const p = prefs({ notifyPaused: true })
    expect(routeOf(p, 'session-finished')).toEqual([])
    expect(routeOf(p, 'session-input')).toEqual(['needsYou'])
    expect(p.notifications['session-finished'].system).toBe(true)
  })

  it('never routes to an unavailable channel', () => {
    const r = defaultRoutes()
    r['pr-merged'].mobile = true
    expect(routeOf(prefs({ notifications: r }), 'pr-merged')).toEqual(['system'])
  })
})

describe('Needs you as a channel', () => {
  it('maps inbox kinds to types', () => {
    expect(typeOfKind(kind('input'))).toBe('session-input')
    expect(typeOfKind(kind('menu'))).toBe('session-input')
    expect(typeOfKind(kind('question'))).toBe('session-input')
    expect(typeOfKind(kind('waiting'))).toBe('session-input')
    expect(typeOfKind(kind('ci'))).toBe('ci-failed')
    expect(typeOfKind(kind('proposal'))).toBe('needs-you')
    expect(typeOfKind(kind('meeting'))).toBe('needs-you')
    expect(typeOfKind(kind('notice', { type: 'notice', notify: 'pr-merged' }))).toBe('pr-merged')
  })

  it('hides a type whose Needs-you cell is off, never for pause', () => {
    const p = prefs({ notifications: withCell(defaultRoutes(), 'ci-failed', 'needsYou', false) })
    expect(showsInNeedsYou(p, kind('ci'))).toBe(false)
    expect(showsInNeedsYou(p, kind('input'))).toBe(true)
    expect(showsInNeedsYou(prefs({ notifyPaused: true }), kind('ci'))).toBe(true)
    expect(showsInNeedsYou(prefs(), kind('notice', { type: 'notice', notify: 'pr-merged' }))).toBe(false)
  })
})

describe('a notification\'s click', () => {
  it('leads to the item, or to its session (else the list) when Needs you hides it', () => {
    const t = { sessionKey: 'k', itemId: 'wait:k:1' }
    expect(itemTarget(prefs(), kind('input'), t)).toBe(t)
    const off = prefs({ notifications: withCell(defaultRoutes(), 'session-input', 'needsYou', false) })
    expect(itemTarget(off, kind('input'), t)).toEqual({ sessionKey: 'k' })
    const ci = prefs({ notifications: withCell(defaultRoutes(), 'ci-failed', 'needsYou', false) })
    expect(itemTarget(ci, kind('ci'), { needsYou: true as const, itemId: 'offer:x' })).toEqual({ needsYou: true })
  })

  it('knows a meetings notice', () => {
    expect(isMeetingNotice(kind('notice', { type: 'notice', notify: 'meeting' }))).toBe(true)
    expect(isMeetingNotice(kind('notice', { type: 'notice', notify: 'pr-merged' }))).toBe(false)
    expect(isMeetingNotice(kind('meeting'))).toBe(false)
  })
})

describe('cells', () => {
  it('fixed and unavailable cells cannot change', () => {
    expect(cellOf(prefs(), 'needs-you', 'needsYou')).toMatchObject({ checked: true, disabled: true })
    expect(cellOf(prefs(), 'pr-merged', 'mobile')).toMatchObject({ checked: false, disabled: true, why: 'Coming with the mobile app' })
    expect(cellOf(prefs(), 'pr-merged', 'system')).toEqual({ checked: true, disabled: false, why: null })
    const r = defaultRoutes()
    expect(withCell(r, 'needs-you', 'needsYou', false)).toBe(r)
    expect(withCell(r, 'pr-merged', 'mobile', true)).toBe(r)
  })

  it("Setup's switch sets the inbox types' system cells", () => {
    const off = withNeedsYouSystem(defaultRoutes(), false)
    expect(needsYouSystemOn(off)).toBe(false)
    expect(off['session-finished'].system).toBe(true)
    expect(needsYouSystemOn(withNeedsYouSystem(off, true))).toBe(true)
  })
})

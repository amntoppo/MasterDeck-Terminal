import { describe, expect, it } from 'vitest'
import { MUTE_RULES, MuteSettle, muteRuleId, muteRulesLine, parseMuteLine, pickApp } from './meetingMute'

const line = (o: unknown): string => JSON.stringify(o)

describe('MUTE_RULES', () => {
  it('each rule has an id, bundles and exactly one way to read the mute', () => {
    const ids = new Set<string>()
    for (const r of MUTE_RULES) {
      expect(r.id).toMatch(/^[a-z0-9-]{1,32}$/)
      expect(ids.has(r.id)).toBe(false)
      ids.add(r.id)
      expect(r.bundles.length).toBeGreaterThan(0)
      expect(Boolean(r.menu) !== Boolean(r.element)).toBe(true)
      for (const b of r.chromium ?? []) expect(r.bundles).toContain(b)
      const m = r.menu ?? r.element!
      expect(m.muted.length).toBeGreaterThan(0)
      expect(m.unmuted.length).toBeGreaterThan(0)
    }
  })

  it("Zoom's menu item says what it would do: Unmute audio while muted", () => {
    const zoom = MUTE_RULES.find((r) => r.id === 'zoom')!
    expect(zoom.menu).toEqual({ title: 'Meeting', muted: ['Unmute audio'], unmuted: ['Mute audio'] })
  })

  it('no muted prefix starts an unmuted one or the other way round (the helper checks muted first)', () => {
    for (const r of MUTE_RULES) {
      const m = r.menu ?? r.element!
      for (const a of m.muted)
        for (const b of m.unmuted) {
          expect(b.toLowerCase().startsWith(a.toLowerCase())).toBe(false)
          expect(a.toLowerCase().startsWith(b.toLowerCase())).toBe(false)
        }
    }
  })

  it('muteRulesLine is one line with only what the helper reads', () => {
    const s = muteRulesLine()
    expect(s.endsWith('\n')).toBe(true)
    expect(s.slice(0, -1)).not.toContain('\n')
    const j = JSON.parse(s) as { apps: Record<string, unknown>[] }
    expect(j.apps.map((a) => a.id)).toEqual(MUTE_RULES.map((r) => r.id))
    expect(j.apps.every((a) => !('name' in a))).toBe(true)
    expect(j.apps.find((a) => a.id === 'zoom')).toEqual({ id: 'zoom', bundles: ['us.zoom.xos'], menu: MUTE_RULES[0].menu })
    expect(j.apps.find((a) => a.id === 'meet')?.chromium).toContain('com.google.Chrome')
  })
})

describe('parseMuteLine', () => {
  it('reads a line md-mute writes', () => {
    expect(parseMuteLine(line({ t: 5, trusted: true, apps: [{ id: 'zoom', state: 'muted' }, { state: 'unknown', id: 'meet' }] }))).toEqual({
      t: 5,
      trusted: true,
      apps: [
        { id: 'zoom', state: 'muted' },
        { id: 'meet', state: 'unknown' },
      ],
    })
    expect(parseMuteLine(line({ t: 1, trusted: false, apps: [] }))).toEqual({ t: 1, trusted: false, apps: [] })
  })

  it('drops extra fields of an app', () => {
    expect(parseMuteLine(line({ t: 1, trusted: true, apps: [{ id: 'zoom', state: 'unmuted', x: 1 }] }))?.apps).toEqual([{ id: 'zoom', state: 'unmuted' }])
  })

  it('junk is null', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      { trusted: true, apps: [] },
      { t: -1, trusted: true, apps: [] },
      { t: 'now', trusted: true, apps: [] },
      { t: 1, trusted: 'yes', apps: [] },
      { t: 1, trusted: true },
      { t: 1, trusted: true, apps: {} },
      { t: 1, trusted: true, apps: [null] },
      { t: 1, trusted: true, apps: [['zoom', 'muted']] },
      { t: 1, trusted: true, apps: [{ id: 'zoom' }] },
      { t: 1, trusted: true, apps: [{ id: 'zoom', state: 'Muted' }] },
      { t: 1, trusted: true, apps: [{ id: 'Zoom App', state: 'muted' }] },
      { t: 1, trusted: true, apps: [{ id: 3, state: 'muted' }] },
      { t: 1, trusted: true, apps: [{ id: 'zoom', state: 'muted' }, { id: 'zoom', state: 'unmuted' }] },
      // Not trusted, nothing can be read.
      { t: 1, trusted: false, apps: [{ id: 'zoom', state: 'muted' }] },
      { t: 1, trusted: true, apps: Array.from({ length: 33 }, (_, i) => ({ id: `a${i}`, state: 'unknown' })) },
    ]
    for (const b of bad) expect(parseMuteLine(line(b))).toBeNull()
    expect(parseMuteLine('')).toBeNull()
    expect(parseMuteLine('{"t":1,"trusted":true,"apps":[')).toBeNull()
    expect(parseMuteLine('not json')).toBeNull()
    expect(parseMuteLine(line({ t: 1, trusted: true, apps: [], pad: 'x'.repeat(5000) }))).toBeNull()
  })

  it('an id outside the known rules is junk', () => {
    const known = new Set(['zoom'])
    expect(parseMuteLine(line({ t: 1, trusted: true, apps: [{ id: 'zoom', state: 'muted' }] }), known)).not.toBeNull()
    expect(parseMuteLine(line({ t: 1, trusted: true, apps: [{ id: 'teams', state: 'muted' }] }), known)).toBeNull()
  })
})

describe('pickApp', () => {
  const apps = [
    { id: 'meet', state: 'unknown' as const },
    { id: 'teams', state: 'unmuted' as const },
    { id: 'zoom', state: 'muted' as const },
  ]
  it('the preferred app (by name or id) while it is listed, even unknown', () => {
    expect(pickApp(apps, 'Zoom')).toBe('zoom')
    expect(pickApp(apps, 'meet')).toBe('meet')
    expect(pickApp(apps, 'Google Meet')).toBe('meet')
  })
  it('else the first app read as muted or unmuted, else none', () => {
    expect(pickApp(apps, 'Webex')).toBe('teams')
    expect(pickApp(apps, null)).toBe('teams')
    expect(pickApp(apps, 'Slack')).toBe('teams')
    expect(pickApp([{ id: 'meet', state: 'unknown' }], undefined)).toBeNull()
    expect(pickApp([], 'Zoom')).toBeNull()
  })
  it('muteRuleId', () => {
    expect(muteRuleId(' ZOOM ')).toBe('zoom')
    expect(muteRuleId('Webex')).toBe('webex')
    expect(muteRuleId('Slack')).toBeNull()
  })
})

describe('MuteSettle', () => {
  it('two equal readings in a row before the state changes', () => {
    const s = new MuteSettle()
    expect(s.state).toBe('unknown')
    expect(s.push('muted')).toBe('unknown')
    expect(s.push('muted')).toBe('muted')
    expect(s.push('unmuted')).toBe('muted')
    expect(s.push('muted')).toBe('muted')
    expect(s.push('unmuted')).toBe('muted')
    expect(s.push('unmuted')).toBe('unmuted')
    expect(s.push('unknown')).toBe('unmuted')
    expect(s.push('unknown')).toBe('unknown')
    s.push('muted')
    s.push('muted')
    s.reset()
    expect(s.state).toBe('unknown')
    expect(s.push('muted')).toBe('unknown')
  })
})

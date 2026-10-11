import { describe, expect, it } from 'vitest'
import { classifyControl, classifyLabel, MUTE_RULES, MUTE_UNKNOWN_HOLD, MuteSettle, muteRuleId, muteRulesLine, parseMuteLine, pickApp } from './meetingMute'

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
  it('muted settles on the first reading; back to the mic takes two equal readings', () => {
    const s = new MuteSettle()
    expect(s.state).toBe('unknown')
    expect(s.push('muted')).toBe('muted')
    expect(s.push('unmuted')).toBe('muted')
    expect(s.push('muted')).toBe('muted')
    expect(s.push('unknown')).toBe('muted')
    expect(s.push('unmuted')).toBe('muted')
    expect(s.push('unmuted')).toBe('unmuted')
    // Between the two states that keep the mic: at once.
    expect(s.push('unknown')).toBe('unknown')
    expect(s.push('unmuted')).toBe('unmuted')
    expect(s.push('unknown')).toBe('unknown')
    s.push('muted')
    s.reset()
    expect(s.state).toBe('unknown')
    expect(s.push('unmuted')).toBe('unmuted')
  })

  it('leaving muted for unknown takes MUTE_UNKNOWN_HOLD readings in a row (about 3 s)', () => {
    expect(MUTE_UNKNOWN_HOLD).toBe(7)
    const s = new MuteSettle()
    s.push('muted')
    for (let i = 0; i < MUTE_UNKNOWN_HOLD - 1; i++) expect(s.push('unknown')).toBe('muted')
    // Seen again: the count starts over.
    expect(s.push('muted')).toBe('muted')
    for (let i = 0; i < MUTE_UNKNOWN_HOLD - 1; i++) s.push('unknown')
    expect(s.state).toBe('muted')
    expect(s.push('unknown')).toBe('unknown')
    // Unknown, then unmuted: two unmuted readings still leave it.
    s.push('muted')
    s.push('unknown')
    s.push('unknown')
    expect(s.push('unmuted')).toBe('muted')
    expect(s.push('unmuted')).toBe('unmuted')
  })

  it('switched() keeps a settled muted until the new readings leave it; anything else starts over', () => {
    const s = new MuteSettle()
    s.push('muted')
    s.push('unmuted')
    s.switched()
    expect(s.state).toBe('muted')
    // The unmuted before the switch does not count towards the two.
    expect(s.push('unmuted')).toBe('muted')
    expect(s.push('unmuted')).toBe('unmuted')
    s.switched()
    expect(s.state).toBe('unknown')
    expect(s.push('unmuted')).toBe('unmuted')
  })
})

describe('classifyLabel / classifyControl (md-mute reads labels the same way)', () => {
  const teams = MUTE_RULES.find((r) => r.id === 'teams')!.element!
  const meet = MUTE_RULES.find((r) => r.id === 'meet')!.element!

  it("reads the user's own control, case and outer spaces ignored", () => {
    expect(classifyLabel('Mute (⌘+Shift+M)', teams)).toBe('unmuted')
    expect(classifyLabel('  unmute (⌘+Shift+M)', teams)).toBe('muted')
    expect(classifyLabel('Turn on microphone (⌘ + d)', meet)).toBe('muted')
    expect(classifyLabel('Turn off microphone', meet)).toBe('unmuted')
    expect(classifyLabel('Leave', teams)).toBeNull()
    expect(classifyLabel('', teams)).toBeNull()
  })

  it('"Mute all" and the like are never yours', () => {
    for (const l of ['Mute all', 'Unmute all', 'Mute everyone', 'Mute notifications', 'mute ALL participants']) expect(classifyLabel(l, teams), l).toBeNull()
    expect(classifyLabel('Turn off microphone for everyone', meet)).toBeNull()
    expect(classifyControl(['Mute', 'Mute all'], teams)).toBeNull()
    expect(classifyControl(['', 'Unmute'], teams)).toBe('muted')
    expect(classifyControl(['Leave', 'Mute'], teams)).toBe('unmuted')
  })

  it('a bare "Mute" / "Unmute" is the whole label (or one with a shortcut), never "Mute Alice"', () => {
    const webex = MUTE_RULES.find((r) => r.id === 'webex')!.element!
    for (const rule of [teams, webex]) {
      expect(classifyLabel('Mute', rule)).toBe('unmuted')
      expect(classifyLabel(' UNMUTE ', rule)).toBe('muted')
      expect(classifyLabel('Unmute (⌘+Shift+M)', rule)).toBe('muted')
      for (const l of ['Mute Alice', 'Unmute Bob', 'Muted', 'Mute(x)', 'Unmute alice (guest)']) expect(classifyLabel(l, rule), l).toBeNull()
    }
    // The specific ones stay prefixes.
    expect(classifyLabel('Mute microphone (⌘+Shift+M)', teams)).toBe('unmuted')
    expect(classifyLabel('Unmute mic now', teams)).toBe('muted')
    expect(classifyLabel('Unmute my audio, button', webex)).toBe('muted')
    expect(classifyControl(['Mute Alice', 'Mute'], teams)).toBe('unmuted')
    expect(classifyControl(['Mute Alice'], teams)).toBeNull()
    // Without `whole`, a prefix is a prefix.
    expect(classifyLabel('Mute Alice', { muted: ['Unmute'], unmuted: ['Mute'] })).toBe('unmuted')
  })

  it('every whole entry is one of its rule\'s prefixes', () => {
    for (const r of MUTE_RULES) {
      const e = r.element
      for (const w of e?.whole ?? []) expect([...e!.muted, ...e!.unmuted], `${r.id}: ${w}`).toContain(w)
    }
  })

  it('the longest matching prefix decides, muted on a tie', () => {
    const r = { muted: ['Unmute', 'Mute is on'], unmuted: ['Mute'] }
    expect(classifyLabel('Mute is on', r)).toBe('muted')
    expect(classifyLabel('Mute', r)).toBe('unmuted')
    expect(classifyLabel('x', { muted: ['x'], unmuted: ['x'] })).toBe('muted')
  })

  it('every prefix is ASCII (Swift counts Characters, JS UTF-16 units)', () => {
    for (const rule of MUTE_RULES) {
      const m = rule.menu ?? rule.element!
      const all = [...m.muted, ...m.unmuted, ...(rule.element?.exclude ?? []), ...(rule.menu ? [rule.menu.title] : [])]
      for (const p of all) expect(/^[\x20-\x7e]+$/.test(p), `${rule.id}: ${p}`).toBe(true)
    }
  })
})

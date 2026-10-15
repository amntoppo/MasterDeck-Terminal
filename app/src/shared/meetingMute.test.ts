import { describe, expect, it } from 'vitest'
import {
  classifyControl,
  classifyLabel,
  MUTE_CHECK_SPLIT_GRANT,
  MUTE_RULES,
  MUTE_UNKNOWN_HOLD,
  muteCheckApps,
  muteCheckView,
  muteCheckWhy,
  MuteSettle,
  muteRuleId,
  muteRulesLine,
  parseMuteLine,
  pickApp,
  type MuteApp,
  type MuteCheckApp,
  type MuteReading,
} from './meetingMute'

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

  it('Meet is a web rule over the roles a web toggle may have; the line carries roles and the older role', () => {
    const meet = MUTE_RULES.find((r) => r.id === 'meet')!
    expect(meet.web).toBe(true)
    expect(meet.element?.roles).toEqual(['AXButton', 'AXCheckBox', 'AXToggleButton'])
    expect(meet.element?.attrs).toContain('AXDescription')
    const j = JSON.parse(muteRulesLine()) as { apps: { id: string; web?: boolean; element?: { role: string; roles: string[] } }[] }
    const line = j.apps.find((a) => a.id === 'meet')!
    expect(line.web).toBe(true)
    expect(line.element).toMatchObject({ role: 'AXButton', roles: ['AXButton', 'AXCheckBox', 'AXToggleButton'] })
    expect(j.apps.find((a) => a.id === 'teams')).not.toHaveProperty('web')
  })

  it('Meet is searched only on its host; the line carries hosts for a web rule only', () => {
    expect(MUTE_RULES.find((r) => r.id === 'meet')?.hosts).toEqual(['meet.google.com'])
    const j = JSON.parse(muteRulesLine()) as { apps: { id: string; hosts?: string[] }[] }
    expect(j.apps.find((a) => a.id === 'meet')?.hosts).toEqual(['meet.google.com'])
    for (const id of ['zoom', 'teams', 'webex']) expect(j.apps.find((a) => a.id === id)).not.toHaveProperty('hosts')
    // Hosts without web mean nothing to md-mute: not sent.
    const odd = JSON.parse(muteRulesLine([{ id: 'x', name: 'X', bundles: ['b'], hosts: ['acme.example'], menu: { title: 'M', muted: ['U'], unmuted: ['M'] } }]))
    expect(odd.apps[0]).not.toHaveProperty('hosts')
  })
})

describe('parseMuteLine: the diagnostics', () => {
  const app = { id: 'meet', state: 'muted', why: 'found', label: 'Turn on microphone (? + d)', searched: 1834, ms: 212, cached: false }

  it('reads them; a line without them (an older helper) still reads', () => {
    expect(parseMuteLine(line({ t: 1, trusted: true, apps: [app, { id: 'zoom', state: 'unknown', why: 'no-control', searched: 40, ms: 3, cached: false }] }))?.apps).toEqual([
      app,
      { id: 'zoom', state: 'unknown', why: 'no-control', searched: 40, ms: 3, cached: false },
    ])
    expect(parseMuteLine(line({ t: 1, trusted: true, apps: [{ id: 'meet', state: 'unknown', why: 'cut', searched: 0, ms: 0 }] }))?.apps[0].why).toBe('cut')
    expect(parseMuteLine(line({ t: 1, trusted: false, apps: [{ id: 'meet', state: 'unknown', why: 'not-trusted' }] }))?.apps[0].why).toBe('not-trusted')
    expect(parseMuteLine(line({ t: 1, trusted: true, apps: [{ id: 'meet', state: 'unknown' }] }))?.apps).toEqual([{ id: 'meet', state: 'unknown' }])
  })

  it('stays strict: a wrong or inconsistent field makes the whole line junk', () => {
    const bad = [
      { ...app, why: 'maybe' },
      { ...app, why: 'not-running' },
      { ...app, why: 'no-control' },
      { ...app, state: 'unknown' },
      { ...app, label: 'Turn on microphone (⌘ + d)' },
      { ...app, label: 'x'.repeat(81) },
      { ...app, label: '' },
      { ...app, label: 'a\nb' },
      { ...app, label: 5 },
      { id: 'meet', state: 'unknown', why: 'no-control', label: 'Turn off microphone' },
      { id: 'meet', state: 'unknown', label: 'Turn off microphone' },
      { ...app, searched: -1 },
      { ...app, searched: 1.5 },
      { ...app, ms: 'fast' },
      { ...app, cached: 'no' },
    ]
    for (const a of bad) expect(parseMuteLine(line({ t: 1, trusted: true, apps: [a] })), JSON.stringify(a)).toBeNull()
    // Not trusted: only not-trusted.
    expect(parseMuteLine(line({ t: 1, trusted: false, apps: [{ id: 'meet', state: 'unknown', why: 'no-control' }] }))).toBeNull()
  })
})

describe('Check mute reading', () => {
  const reading = (apps: MuteApp[], trusted = true): MuteReading => ({ t: 1, trusted, apps })

  it('every rule gets a row: the last reading, the last real search size, not running when never listed', () => {
    const apps = muteCheckApps([
      reading([{ id: 'meet', state: 'unknown', why: 'no-control', searched: 9000, ms: 640, cached: false }]),
      reading([{ id: 'meet', state: 'unknown', why: 'no-control', searched: 0, ms: 0, cached: false }]),
    ])
    expect(apps.map((a) => a.id)).toEqual(MUTE_RULES.map((r) => r.id))
    expect(apps.find((a) => a.id === 'meet')).toEqual({ id: 'meet', name: 'Google Meet', state: 'unknown', why: 'no-control', searched: 9000, ms: 640 })
    expect(apps.find((a) => a.id === 'zoom')).toEqual({ id: 'zoom', name: 'Zoom', state: 'unknown', why: 'not-running', searched: 0, ms: 0 })
    const found = muteCheckApps([reading([{ id: 'meet', state: 'muted', why: 'found', label: 'Turn on microphone', searched: 1, ms: 1, cached: true }])])
    expect(found.find((a) => a.id === 'meet')).toMatchObject({ state: 'muted', why: 'found', label: 'Turn on microphone' })
    // An older helper: the why from the state.
    expect(muteCheckApps([reading([{ id: 'zoom', state: 'unmuted' }])])[0].why).toBe('found')
    expect(muteCheckApps([reading([{ id: 'zoom', state: 'unknown' }])])[0].why).toBe('no-control')
    expect(muteCheckApps([reading([{ id: 'zoom', state: 'unknown' }], false)])[0].why).toBe('not-trusted')
  })

  it('says why in plain sentences', () => {
    const a = (o: Partial<MuteCheckApp>): MuteCheckApp => ({ id: 'meet', name: 'Google Meet', state: 'unknown', why: 'no-control', searched: 0, ms: 0, ...o })
    const meet = MUTE_RULES.find((r) => r.id === 'meet')!
    const zoom = MUTE_RULES.find((r) => r.id === 'zoom')!
    expect(muteCheckWhy(a({ state: 'muted', why: 'found', label: 'Turn on microphone' }), meet)).toBe("Muted (button says 'Turn on microphone')")
    expect(muteCheckWhy(a({ state: 'unmuted', why: 'found', label: 'Turn off microphone (? + d)' }), meet)).toBe("Unmuted (button says 'Turn off microphone (? + d)')")
    expect(muteCheckWhy(a({ state: 'muted', why: 'found' }), zoom)).toBe('Muted (button found)')
    expect(muteCheckWhy(a({ why: 'not-running' }), meet)).toBe('Not running')
    const web = 'No mute button found — is the call in the front tab, or Meet is full screen / on another desktop — press Check from the same desktop as the call'
    expect(muteCheckWhy(a({}), meet)).toBe(web)
    expect(muteCheckWhy(a({ searched: 9000, ms: 640 }), meet)).toBe(`${web} (9000 elements in 640 ms)`)
    expect(muteCheckWhy(a({}), zoom)).toBe('No mute button found — is a call open?')
    expect(muteCheckWhy(a({ why: 'cut', searched: 40000, ms: 800 }), meet)).toBe('Search cut short (40000 elements in 800 ms)')
    expect(muteCheckWhy(a({ why: 'not-trusted' }), meet)).toBe("Accessibility not given to MasterDeck's helper")
    expect(muteCheckWhy(a({ why: 'error' }), meet)).toBe('The app did not answer (busy or not responding)')
  })

  it('the notes above the table: a missing helper, and a grant that reaches MasterDeck but not its helper', () => {
    const apps = muteCheckApps([reading([{ id: 'meet', state: 'unknown', why: 'not-trusted' }], false)])
    expect(muteCheckView({ ok: true, found: true, trusted: false, gateTrusted: true, apps }).notes).toEqual([MUTE_CHECK_SPLIT_GRANT])
    expect(MUTE_CHECK_SPLIT_GRANT).toBe(
      'macOS gave Accessibility to MasterDeck but not to its helper. Remove MasterDeck from Accessibility in System Settings and allow it again (each new build needs this).',
    )
    // A helper that failed or sent nothing said nothing about trust: only its message.
    for (const message of ['The mute reader sent nothing.', 'The mute reader stopped: exit 2', 'The mute reader did not start.'])
      expect(muteCheckView({ ok: true, found: true, trusted: false, gateTrusted: true, apps: [], message }).notes).toEqual([message])
    expect(muteCheckView({ ok: true, found: true, trusted: false, gateTrusted: false, apps }).notes).toEqual(["Accessibility not given to MasterDeck's helper: Allow it above."])
    expect(muteCheckView({ ok: true, found: false, trusted: false, gateTrusted: true, apps: [] })).toEqual({ notes: ['The mute reader is missing; reinstall MasterDeck.'], rows: [] })
    const ok = muteCheckView({ ok: true, found: true, trusted: true, gateTrusted: true, apps: muteCheckApps([reading([])]) })
    expect(ok.notes).toEqual([])
    expect(ok.rows[0]).toEqual({ id: 'zoom', app: 'Zoom', reads: 'Unknown', why: 'Not running' })
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

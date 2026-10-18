import { describe, expect, it } from 'vitest'
import { cleanRailOrder, dropBefore, isDefaultOrder, moveStep, moveTo, RAIL_DEFAULT, RAIL_SEP, RAIL_SPACER, railOrder, toSaved } from './railOrder'

const D = [...RAIL_DEFAULT]
const all = () => true

describe('railOrder', () => {
  it('nothing saved is the default', () => {
    expect(railOrder([])).toEqual(D)
  })

  it('keeps a saved order as it is', () => {
    const saved = moveTo(D, 'settings', 0)
    expect(railOrder(saved)).toEqual(saved)
    expect(saved[0]).toBe('settings')
  })

  it('puts an icon added in a later version at its default place', () => {
    // An order saved before Schedules and Record existed, with Board moved to the bottom.
    const saved = D.filter((id) => id !== 'schedules' && id !== 'record' && id !== 'board').concat('board')
    const o = railOrder(saved)
    expect(o.indexOf('schedules')).toBe(o.indexOf('workflow') + 1)
    expect(o.indexOf('record')).toBe(o.indexOf('schedules') + 1)
    expect(o.at(-1)).toBe('board')
  })

  it('a new first icon goes first', () => {
    const o = railOrder(D.filter((id) => id !== 'terminals'))
    expect(o[0]).toBe('terminals')
  })

  it('skips ids it does not know, but Settings keeps them', () => {
    const saved = ['future', ...D]
    expect(railOrder(saved)).toEqual(D)
    expect(cleanRailOrder(saved)[0]).toBe('future')
  })

  it('marks out of order fall back to the default', () => {
    const saved = D.filter((id) => id !== RAIL_SEP)
    saved.push(RAIL_SEP)
    expect(railOrder(saved)).toEqual(D)
  })

  it('missing marks come back at their place', () => {
    expect(railOrder(D.filter((id) => id !== RAIL_SPACER && id !== RAIL_SEP))).toEqual(D)
  })
})

describe('cleanRailOrder', () => {
  it('keeps strings only, once each, and no more than 64', () => {
    expect(cleanRailOrder('x')).toEqual([])
    expect(cleanRailOrder(['a', 1, null, 'a', '', 'b'])).toEqual(['a', 'b'])
    expect(cleanRailOrder(Array.from({ length: 100 }, (_, i) => `x${i}`))).toHaveLength(64)
    expect(cleanRailOrder(['y'.repeat(41)])).toEqual([])
  })
})

describe('moveTo', () => {
  it('moves an icon up and down', () => {
    expect(moveTo(D, 'tasks', 0).slice(0, 2)).toEqual(['tasks', 'terminals'])
    const down = moveTo(D, 'terminals', 2)
    expect(down.slice(0, 3)).toEqual(['board', 'terminals', 'prs'])
  })

  it('moves an icon from the top group to the bottom one and back', () => {
    const down = moveTo(D, 'board', D.indexOf('settings'))
    expect(down.indexOf('board')).toBeGreaterThan(down.indexOf(RAIL_SPACER))
    expect(down.indexOf('board')).toBe(down.indexOf('settings') - 1)
    const up = moveTo(down, 'settings', 0)
    expect(up[0]).toBe('settings')
  })

  it('to the end', () => {
    expect(moveTo(D, 'terminals', D.length).at(-1)).toBe('terminals')
  })

  it('never moves a mark, and leaves an unknown id alone', () => {
    expect(moveTo(D, RAIL_SPACER, 0)).toEqual(D)
    expect(moveTo(D, RAIL_SEP, D.length)).toEqual(D)
    expect(moveTo(D, 'nope', 0)).toEqual(D)
  })

  it('in place changes nothing', () => {
    const i = D.indexOf('prs')
    expect(moveTo(D, 'prs', i)).toEqual(D)
    expect(moveTo(D, 'prs', i + 1)).toEqual(D)
  })
})

describe('moveStep', () => {
  it('swaps with the next icon', () => {
    expect(moveStep(D, 'board', 1, all).slice(0, 3)).toEqual(['terminals', 'prs', 'board'])
    expect(moveStep(D, 'board', -1, all).slice(0, 2)).toEqual(['board', 'terminals'])
  })

  it('crosses a mark in one step', () => {
    const o = moveStep(D, 'tasks', 1, all)
    expect(o.indexOf('tasks')).toBe(o.indexOf(RAIL_SEP) + 1)
    const back = moveStep(o, 'tasks', -1, all)
    expect(back).toEqual(D)
    const b = moveStep(D, 'broadcast', -1, all)
    expect(b.indexOf('broadcast')).toBe(b.indexOf(RAIL_SPACER) - 1)
  })

  it('passes over hidden icons, which keep their place', () => {
    // Janitor hidden (the web): Costs ↓ lands after Notes, past Janitor.
    const o = moveStep(D, 'costs', 1, (id) => id !== 'janitor')
    expect(o.slice(o.indexOf(RAIL_SEP) + 1, o.indexOf(RAIL_SEP) + 4)).toEqual(['janitor', 'notes', 'costs'])
  })

  it('passes over a separator that is not drawn', () => {
    // The middle group empty on this screen: Tasks ↓ goes past the hidden line and the spacer.
    const middle = D.slice(D.indexOf(RAIL_SEP) + 1, D.indexOf(RAIL_SPACER))
    const o = moveStep(D, 'tasks', 1, (id) => id !== RAIL_SEP && !middle.includes(id))
    expect(o.indexOf('tasks')).toBe(o.indexOf(RAIL_SPACER) + 1)
  })

  it('stops at the ends', () => {
    expect(moveStep(D, 'terminals', -1, all)).toEqual(D)
    expect(moveStep(D, 'settings', 1, all)).toEqual(D)
    expect(moveStep(D, 'skills', 1, (id) => id !== 'palette' && id !== 'settings')).toEqual(D)
  })
})

describe('dropBefore', () => {
  const entries = [
    { id: 'terminals', mid: 20 },
    { id: 'prs', mid: 60 },
    { id: RAIL_SEP, mid: 80 },
    { id: 'costs', mid: 100 },
    { id: RAIL_SPACER, mid: 300 },
    { id: 'settings', mid: 500 },
  ]
  it('lands before the first entry below the pointer', () => {
    expect(dropBefore(D, entries, 0)).toBe(0)
    expect(dropBefore(D, entries, 40)).toBe(D.indexOf('prs'))
    expect(dropBefore(D, entries, 90)).toBe(D.indexOf('costs'))
    // Above the spacer's middle: the end of the middle group; below it: the bottom group.
    expect(dropBefore(D, entries, 200)).toBe(D.indexOf(RAIL_SPACER))
    expect(dropBefore(D, entries, 400)).toBe(D.indexOf('settings'))
    expect(dropBefore(D, entries, 900)).toBe(D.length)
  })

  it('a drop before the spacer puts the icon in the middle group', () => {
    const o = moveTo(D, 'settings', dropBefore(D, entries, 200))
    expect(o.indexOf('settings')).toBe(o.indexOf(RAIL_SPACER) - 1)
  })
})

describe('toSaved / isDefaultOrder', () => {
  it('keeps ids this version does not know where they were', () => {
    const saved = ['settings', 'future', ...D.filter((id) => id !== 'settings'), 'later']
    const moved = moveTo(railOrder(saved), 'board', 0)
    const out = toSaved(moved, saved)
    expect(out.indexOf('future')).toBe(out.indexOf('settings') + 1)
    expect(out.at(-1)).toBe('later')
    expect(out[0]).toBe('board')
    expect(railOrder(out)).toEqual(moved)
  })

  it('the default is saved as nothing, so a reset follows later defaults', () => {
    expect(toSaved(D)).toEqual([])
    expect(isDefaultOrder([])).toBe(true)
    const moved = moveTo(D, 'settings', 0)
    expect(isDefaultOrder(moved)).toBe(false)
    expect(toSaved(moved)).toEqual(moved)
  })
})

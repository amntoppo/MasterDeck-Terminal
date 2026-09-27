import { describe, expect, it } from 'vitest'
import { inOrder, moveBefore, trimOrder, withNew } from './sessionOrder'

const s = (key: string, startedAt: number) => ({ key, startedAt })

describe('session order', () => {
  it('keeps the saved order whatever the activity; new sessions go on top once', () => {
    const order = ['b', 'a']
    expect(inOrder([s('a', 9), s('b', 1)], order).map((x) => x.key)).toEqual(['b', 'a'])
    expect(withNew(order, [s('a', 9), s('b', 1), s('c', 5), s('d', 7)])).toEqual(['d', 'c', 'b', 'a'])
    expect(withNew(order, [s('a', 9)])).toBe(order)
  })

  it('moves a session before another, or to the end', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(moveBefore(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c'])
  })

  it('trims keys of sessions long gone, never live ones', () => {
    const order = ['x1', 'live', 'x2', 'x3']
    expect(trimOrder(order, new Set(['live']), 2)).toEqual(['live', 'x1'])
    expect(trimOrder(order, new Set(), 10)).toBe(order)
  })
})

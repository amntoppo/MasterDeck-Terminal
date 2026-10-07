import { describe, expect, it } from 'vitest'
import { pruneStars, splitStarred, toggleStar } from './stars'

const s = (key: string, state = 'working') => ({ key, state })

describe('toggleStar', () => {
  it('adds a key that is not starred', () => {
    expect(toggleStar(['a'], 'b')).toEqual(['a', 'b'])
  })
  it('removes a key that is starred', () => {
    expect(toggleStar(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('splitStarred', () => {
  it('puts starred sessions in starred only, keeping the given order', () => {
    const list = [s('a'), s('b', 'idle'), s('c', 'needs-input'), s('d')]
    const { starred, rest } = splitStarred(list, ['d', 'b'])
    expect(starred.map((x) => x.key)).toEqual(['b', 'd'])
    expect(rest.map((x) => x.key)).toEqual(['a', 'c'])
  })
  it('keeps a starred session in starred whatever its status', () => {
    for (const st of ['working', 'idle', 'needs-input']) {
      expect(splitStarred([s('a', st)], ['a']).starred).toHaveLength(1)
    }
  })
  it('leaves a parked session out of starred', () => {
    const { starred, rest } = splitStarred([s('a', 'suspended')], ['a'])
    expect(starred).toEqual([])
    expect(rest.map((x) => x.key)).toEqual(['a'])
  })
  it('with no stars everything is in rest', () => {
    const list = [s('a'), s('b')]
    expect(splitStarred(list, [])).toEqual({ starred: [], rest: list })
  })
})

describe('pruneStars', () => {
  it('returns the same array when nothing ended', () => {
    const stars = ['a', 'b']
    expect(pruneStars(stars, [s('a'), s('b', 'idle')])).toBe(stars)
  })
  it('drops sessions that are done, parked or gone', () => {
    expect(pruneStars(['a', 'b', 'c', 'd'], [s('a'), s('b', 'done'), s('c', 'suspended')])).toEqual(['a'])
  })
  it('never clears on an empty session list (state not loaded yet)', () => {
    const stars = ['a']
    expect(pruneStars(stars, [])).toBe(stars)
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, issueRef, issueUrl, parseConfig, statusGroup, statusRank } from './appConfig'

describe('appConfig', () => {
  it('parses master config show output and fills defaults', () => {
    const c = parseConfig({ configured: true, path: '/p', config: { owner: 'acme', issueRepo: 'tracker', statuses: { inProgress: 'Doing' } } })
    expect(c.configured).toBe(true)
    expect(c.statuses.inProgress).toBe('Doing')
    expect(c.statuses.ready).toBe(DEFAULT_CONFIG.statuses.ready)
    expect(issueRef(c)).toBe('acme/tracker')
    expect(issueUrl(3, c)).toBe('https://github.com/acme/tracker/issues/3')
    expect(parseConfig({}).configured).toBe(false)
    expect(parseConfig(null).owner).toBe('')
  })
  it('ranks and groups statuses', () => {
    const c = parseConfig({ owner: 'a', issueRepo: 'b', columns: ['Todo', 'Doing', 'Review', 'Done', 'Blocked'], statuses: { ready: 'Todo', inProgress: 'Doing', prRaised: 'Review', devDone: 'Done', done: ['Done'], blocked: ['Blocked'], resumable: ['Doing'], assignable: ['Todo'], rank: { Blocked: 0 } } })
    expect(statusRank('Review', c)).toBe(2)
    expect(statusRank('Blocked', c)).toBe(0)
    expect(statusRank('Nope', c)).toBe(-1)
    expect(['Todo', 'Doing', 'Review', 'Done', 'Blocked'].map((s) => statusGroup(s, c))).toEqual(['todo', 'progress', 'review', 'done', 'blocked'])
  })
})

describe('masterEnabled', () => {
  it('defaults to on; only false turns master off', () => {
    expect(parseConfig({}).masterEnabled).toBe(true)
    expect(parseConfig({ masterEnabled: false }).masterEnabled).toBe(false)
    expect(parseConfig({ masterEnabled: 'no' }).masterEnabled).toBe(true)
  })
})

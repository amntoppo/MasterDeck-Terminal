import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseConfig, setConfig } from './appConfig'
import { sessionForIssue } from './derive'
import { asTicket, parseTicket, sameTicket, storedRepo, ticketKey, ticketLabel, ticketRef, ticketUrl } from './ticket'
import type { Session } from './types'

const cfg = parseConfig({ config: { owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] } })

describe('tickets across repos', () => {
  afterEach(() => setConfig(DEFAULT_CONFIG))

  it('the primary repo keeps bare numbers; others carry their repo', () => {
    setConfig(cfg)
    expect(storedRepo('ACME/Tracker')).toBeNull()
    expect(storedRepo('acme/api')).toBe('acme/api')
    expect(ticketKey(null, 12)).toBe(ticketKey('acme/tracker', 12))
    expect(ticketKey('acme/api', 12)).not.toBe(ticketKey(null, 12))
    expect([ticketLabel(null, 12), ticketLabel('acme/api', 12)]).toEqual(['#12', 'api#12'])
    expect(ticketRef('acme/api', 3)).toBe('acme/api#3')
    expect(ticketUrl(null, 3)).toBe('https://github.com/acme/tracker/issues/3')
  })

  it('parses keys, labels and bare numbers', () => {
    setConfig(cfg)
    expect(parseTicket('12')).toEqual({ repo: null, number: 12 })
    expect(parseTicket('api#12')).toEqual({ repo: 'acme/api', number: 12 })
    expect(parseTicket('acme/tracker#9')).toEqual({ repo: null, number: 9 })
    expect(parseTicket('nope')).toBeNull()
    expect(parseTicket(ticketKey('acme/api', 4))).toEqual({ repo: 'acme/api', number: 4 })
  })

  it('checks tickets from IPC', () => {
    setConfig(cfg)
    expect(asTicket(5)).toEqual({ repo: null, number: 5 })
    expect(asTicket({ repo: 'acme/api', number: 5 })).toEqual({ repo: 'acme/api', number: 5 })
    expect(asTicket({ repo: 'bad repo', number: 5 })).toBeNull()
    expect(asTicket({ repo: 'acme/api', number: 0 })).toBeNull()
    expect(asTicket('5')).toBeNull()
  })

  it('a session owns #12 in its own repo only', () => {
    setConfig(cfg)
    const base = { kind: 'background', bgId: 'x', pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1 } as const
    const a = { ...base, key: 'a', sessionId: 'a', name: 'a', issue: 12, issueRepo: 'acme/api' } as Session
    const b = { ...base, key: 'b', sessionId: 'b', name: 'b', issue: 12, issueRepo: null } as Session
    expect(sessionForIssue([a, b], { repo: 'acme/api', number: 12 })?.name).toBe('a')
    expect(sessionForIssue([a, b], { repo: null, number: 12 })?.name).toBe('b')
    expect(sameTicket({ repo: 'acme/tracker', number: 12 }, { repo: null, number: 12 })).toBe(true)
  })

  it('reads repos and boards from the config', () => {
    const c = parseConfig({
      config: {
        owner: 'acme', issueRepo: 'tracker', repos: ['acme/api', 'x'], allRepos: true,
        projects: [{ owner: 'acme', number: 2, title: 'Platform', columns: ['A', 'B'], statuses: { ready: 'A' } }],
      },
    })
    expect(c.repos).toEqual(['acme/tracker', 'acme/api'])
    expect(c.allRepos).toBe(true)
    expect(c.projects.map((p) => [p.owner, p.number, p.title, p.statuses.ready])).toEqual([['acme', 2, 'Platform', 'A']])
    // An older config: its one project.
    expect(parseConfig({ config: { owner: 'acme', issueRepo: 'tracker', project: 1, columns: ['X'] } }).projects.map((p) => [p.number, p.columns])).toEqual([[1, ['X']]])
  })
})

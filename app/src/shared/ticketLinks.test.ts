import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig } from './appConfig'
import { emptyLinks, importLinks, linkInfoMap, parseLinkFile, ticketPrs, ticketSessions, withLink, withPr } from './ticketLinks'

setConfig(parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/web'] }))
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('ticket links', () => {
  it('parses tt.sh state, drops bad entries and keeps branches', () => {
    const f = parseLinkFile({
      sessions: { [A]: { issue: 12, title: 't', branch: 'acme/web@feat/12', linked_at: '2026-10-01T10:00:00Z', prs: ['https://github.com/acme/web/pull/3'] }, bad: { issue: 'x' } },
      branches: { 'acme/web@feat/12': 12 },
    })
    expect(Object.keys(f.sessions)).toEqual([A])
    expect(f.sessions[A].prs).toEqual(['https://github.com/acme/web/pull/3'])
    expect(f.branches).toEqual({ 'acme/web@feat/12': 12 })
    expect(parseLinkFile(null)).toEqual(emptyLinks())
  })
  it('the import fills gaps only: links MasterDeck already has win', () => {
    const own = withLink(emptyLinks(), A, { repo: null, number: 12 }, 't', '', new Date('2026-10-02T00:00:00Z'))
    const legacy = parseLinkFile({ sessions: { [A]: { issue: 13, title: 'u', branch: '', linked_at: '2026-10-03T00:00:00Z', prs: [] }, [B]: { issue: 5, title: 'v', branch: 'acme/web@f', linked_at: '2026-09-01T00:00:00Z', prs: [] } }, branches: { 'acme/web@f': 5 } })
    const m = importLinks(own, legacy)
    expect(m.sessions[A].issue).toBe(12)
    expect(m.sessions[B].issue).toBe(5)
    expect(m.branches['acme/web@f']).toBe(5)
  })
  it('stores the primary repo as a bare number and others with their repo', () => {
    let f = withLink(emptyLinks(), A, { repo: null, number: 12 }, 't', 'acme/web@feat/12', new Date(0))
    f = withLink(f, B, { repo: 'acme/web', number: 4 }, 'w', '', new Date(0))
    expect(f.sessions[A].repo).toBeUndefined()
    expect(f.sessions[B].repo).toBe('acme/web')
    expect(f.branches['acme/web@feat/12']).toBe(12)
    const m = linkInfoMap(f)
    expect(m.get(A)).toEqual({ issue: 12, repo: null, linkedAt: 0 })
    expect(m.get(B)?.repo).toBe('acme/web')
  })
  it('collects PRs per ticket across its sessions, once each', () => {
    let f = withLink(emptyLinks(), A, { repo: null, number: 12 }, 't', '', new Date(0))
    f = withLink(f, B, { repo: 'acme/tracker', number: 12 }, 't', '', new Date(0))
    f = withPr(withPr(f, A, 'https://github.com/acme/web/pull/1'), B, 'https://github.com/acme/api/pull/2')
    f = withPr(f, A, 'https://github.com/acme/web/pull/1')
    expect(ticketPrs(f, { repo: null, number: 12 })).toEqual(['https://github.com/acme/web/pull/1', 'https://github.com/acme/api/pull/2'])
    expect(ticketSessions(f, { repo: null, number: 12 })).toEqual([A, B])
  })
  it('skips adopted links like Sources did', () => {
    const f = parseLinkFile({ sessions: { [A]: { issue: 12, title: '', branch: '', linked_at: '', prs: [], adopted: true } }, branches: {} })
    expect(linkInfoMap(f).size).toBe(0)
  })
})

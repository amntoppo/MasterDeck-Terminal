import { describe, expect, it } from 'vitest'
import { buildPrSummary, parsePrUrl } from './prSummary'

const URL = 'https://github.com/acme/mobile-app/pull/137'
const pull = {
  number: 137, title: 'Notification popup', user: { login: 'rahul' }, state: 'open', draft: false, merged: false,
  base: { ref: 'dev' }, head: { ref: 'feat/1036', sha: 'abc' }, additions: 120, deletions: 7, changed_files: 6, body: 'Adds the bell.',
}

describe('prSummary', () => {
  it('parses the URL', () => {
    expect(parsePrUrl(URL)).toEqual({ owner: 'acme', repo: 'mobile-app', number: 137 })
    expect(parsePrUrl('https://example.com/x')).toBeNull()
  })
  it('builds a summary with the latest review per reviewer and check counts', () => {
    const reviews = [
      { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'a' }, state: 'APPROVED' },
      { user: { login: 'b' }, state: 'COMMENTED' },
      { user: { login: 'c' }, state: 'PENDING' },
    ]
    const checks = { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'skipped' }] }
    const p = buildPrSummary(URL, pull, reviews, checks)!
    expect(p).toMatchObject({ number: 137, title: 'Notification popup', author: 'rahul', state: 'OPEN', base: 'dev', head: 'feat/1036', additions: 120, deletions: 7, changedFiles: 6 })
    expect(p.reviews).toEqual([{ user: 'a', state: 'APPROVED' }, { user: 'b', state: 'COMMENTED' }])
    expect(p.checks).toEqual({ passed: 2, failed: 1, pending: 1, total: 4 })
  })
  it('state: draft, merged, closed', () => {
    expect(buildPrSummary(URL, { ...pull, draft: true }, [], {})!.state).toBe('DRAFT')
    expect(buildPrSummary(URL, { ...pull, state: 'closed', merged: true }, [], {})!.state).toBe('MERGED')
    expect(buildPrSummary(URL, { ...pull, state: 'closed' }, [], {})!.state).toBe('CLOSED')
    expect(buildPrSummary(URL, {}, [], {})).toBeNull()
  })
})

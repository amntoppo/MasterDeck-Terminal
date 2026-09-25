import { describe, expect, it } from 'vitest'
import { parseBranchStatus, parseNumstat, parsePrView } from './git'

describe('parseBranchStatus', () => {
  it('reads branch and ahead/behind', () => {
    const t = '# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -1\n1 .M N... x'
    expect(parseBranchStatus(t)).toEqual({ branch: 'feat/x', ahead: 2, behind: 1 })
  })
  it('handles detached heads and no upstream', () => {
    expect(parseBranchStatus('# branch.oid abc\n# branch.head (detached)\n')).toEqual({ branch: null, ahead: 0, behind: 0 })
  })
})

describe('parseNumstat', () => {
  it('sums lines and counts files, including binaries', () => {
    expect(parseNumstat('10\t2\ta.ts\n-\t-\timg.png\n3\t0\tb.ts\n')).toEqual({ added: 13, removed: 2, files: 3 })
    expect(parseNumstat('')).toEqual({ added: 0, removed: 0, files: 0 })
  })
})

describe('parsePrView', () => {
  const base = { number: 88, url: 'https://github.com/o/r/pull/88', state: 'OPEN', reviewDecision: 'APPROVED' }
  it('success when every check passed', () => {
    const p = parsePrView(JSON.stringify({ ...base, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] }))
    expect(p).toEqual({ ...base, title: null, ci: 'success' })
  })
  it('failure beats pending', () => {
    const p = parsePrView(JSON.stringify({ ...base, statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }, { conclusion: 'FAILURE' }] }))
    expect(p?.ci).toBe('failure')
  })
  it('pending while checks run; null ci with no checks; empty review decision is null', () => {
    expect(parsePrView(JSON.stringify({ ...base, statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }))?.ci).toBe('pending')
    const p = parsePrView(JSON.stringify({ ...base, reviewDecision: '', statusCheckRollup: [] }))
    expect(p?.ci).toBeNull()
    expect(p?.reviewDecision).toBeNull()
  })
  it('null for gh errors', () => {
    expect(parsePrView('no pull requests found for branch "x"')).toBeNull()
  })
})

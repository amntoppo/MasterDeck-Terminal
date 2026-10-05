import { describe, expect, it } from 'vitest'
import { ownsFolderBranch, parkedFor, parseParked, type Parked } from './parked'

const ws = ['/code/acme', '/code/globex']
const base = { dir: '/code/acme/api', workspaces: ws, linked: false, branch: 'feat/x' as string | null | undefined, parked: null as Parked | null }
const parked: Parked = { dir: '/code/acme/api', branch: 'feat/x', review: false }

describe('ownsFolderBranch (is the branch of a session\'s folder its own?)', () => {
  it('a session with no record (started by hand, or before this version) is as it always was', () => {
    expect(ownsFolderBranch(base)).toBe(true) // a main checkout on a feature branch: its branch, its PR
    expect(ownsFolderBranch({ ...base, linked: true })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: null })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: undefined })).toBe(true)
  })
  it('never in a workspace: master\'s, or any account\'s', () => {
    expect(ownsFolderBranch({ ...base, dir: '/code/acme' })).toBe(false)
    expect(ownsFolderBranch({ ...base, dir: '/code/globex/' })).toBe(false)
    expect(ownsFolderBranch({ ...base, dir: '/code/globex', linked: true, parked })).toBe(false)
  })
  it('a session MasterDeck parked in a checkout does not own the branch it found there', () => {
    expect(ownsFolderBranch({ ...base, parked })).toBe(false)
    expect(ownsFolderBranch({ ...base, dir: '/code/acme/api/src', parked })).toBe(false)
    expect(ownsFolderBranch({ ...base, branch: null, parked: { ...parked, branch: '' } })).toBe(false) // detached then and now
  })
  it('until it works in a linked worktree, or its checkout is on another branch (its own)', () => {
    expect(ownsFolderBranch({ ...base, dir: '/code/acme/api/.claude/worktrees/7-x', linked: true, parked })).toBe(true)
    expect(ownsFolderBranch({ ...base, dir: '/code/elsewhere/wt', linked: true, parked })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: 'feat/7-mine', parked })).toBe(true)
    expect(ownsFolderBranch({ ...base, dir: '/code/acme/api/src/', branch: 'feat/7-mine', parked })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: 'feat/7-mine', parked: { ...parked, branch: '' } })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: null, parked })).toBe(true) // detached now, known: not the parked branch
  })
  it('another main checkout is never its own, whatever branch that one is on', () => {
    // Parked in the tracker on main, sent on to the api checkout that someone left on feat/other.
    const tracker: Parked = { dir: '/code/acme/tracker', branch: 'main', review: false }
    expect(ownsFolderBranch({ ...base, dir: '/code/acme/api', branch: 'feat/other', parked: tracker })).toBe(false)
    expect(ownsFolderBranch({ ...base, dir: '/code/acme/api', branch: 'main', parked: tracker })).toBe(false)
    expect(ownsFolderBranch({ ...base, dir: '/code/acme/tracker-old', branch: 'feat/other', parked: tracker })).toBe(false) // a name that only starts alike
  })
  it('a branch that is not known (git failed or timed out) is never taken for another branch', () => {
    expect(ownsFolderBranch({ ...base, branch: undefined, parked })).toBe(false)
    expect(ownsFolderBranch({ ...base, branch: undefined, parked: { ...parked, branch: '' } })).toBe(false)
    expect(ownsFolderBranch({ ...base, branch: undefined, linked: true, parked })).toBe(true) // a worktree needs no branch
  })
  it('a PR review session never does', () => {
    const review = { ...parked, review: true }
    expect(ownsFolderBranch({ ...base, parked: review })).toBe(false)
    expect(ownsFolderBranch({ ...base, branch: 'other', parked: review })).toBe(false)
    expect(ownsFolderBranch({ ...base, linked: true, parked: review })).toBe(false)
  })
})

describe('parked records', () => {
  const AT = '2026-10-05T10:00:00Z'
  const at = Date.parse(AT)
  it('reads the file, dropping what is malformed', () => {
    const m = parseParked({ '4f2a9c1e': { dir: '/code/acme/api', branch: 'feat/x', review: false, name: 'api-7-x', at: AT }, 'name:r': { dir: '/d', branch: '', review: true }, bad: { dir: 3 }, worse: 'x', when: { dir: '/d', branch: '', at: 'yesterday' } })
    expect(m).toEqual({ '4f2a9c1e': { dir: '/code/acme/api', branch: 'feat/x', review: false, at }, 'name:r': { dir: '/d', branch: '', review: true }, when: { dir: '/d', branch: '', review: false } })
    expect(parseParked(null)).toEqual({})
    expect(parseParked([1])).toEqual({})
  })
  it('a session is found by its background id', () => {
    const m = parseParked({ '4f2a9c1e': { dir: '/a', branch: 'x', review: false, at: AT } })
    expect(parkedFor(m, { key: '4f2a9c1e', name: 'api-7-x', cwd: '/anywhere', startedAt: 0 })?.dir).toBe('/a')
    expect(parkedFor(m, { key: '0badc0de', name: 'api-7-x', cwd: '/a', startedAt: at })).toBeNull()
  })
  it('by name only the session that started there, then', () => {
    const m = parseParked({ 'name:review-api-5': { dir: '/code/acme/api', branch: 'y', review: true, at: AT } })
    const s = { key: '0badc0de', name: 'review-api-5', cwd: '/code/acme/api/', startedAt: at + 20_000 }
    expect(parkedFor(m, s)?.review).toBe(true)
    expect(parkedFor(m, { ...s, startedAt: at - 60_000 })?.review).toBe(true) // clocks and the listing lag a little
    // A later session started by hand under the same name, or one somewhere else, is not that one.
    expect(parkedFor(m, { ...s, startedAt: at + 3 * 3600_000 })).toBeNull()
    expect(parkedFor(m, { ...s, cwd: '/code/acme/web' })).toBeNull()
    expect(parkedFor(m, { ...s, name: 'by-hand' })).toBeNull()
    // A record with no time cannot be told apart from a reused name: not honoured.
    expect(parkedFor(parseParked({ 'name:review-api-5': { dir: '/code/acme/api', branch: 'y', review: true } }), s)).toBeNull()
  })
})

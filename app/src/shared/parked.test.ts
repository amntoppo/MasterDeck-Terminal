import { describe, expect, it } from 'vitest'
import { ownsFolderBranch, parkedFor, parseParked, type Parked } from './parked'

const ws = ['/code/acme', '/code/globex']
const base = { dir: '/code/acme/api', workspaces: ws, linked: false, branch: 'feat/x', parked: null as Parked | null }
const parked: Parked = { dir: '/code/acme/api', branch: 'feat/x', review: false }

describe('ownsFolderBranch (is the branch of a session\'s folder its own?)', () => {
  it('a session with no record (started by hand, or before this version) is as it always was', () => {
    expect(ownsFolderBranch(base)).toBe(true) // a main checkout on a feature branch: its branch, its PR
    expect(ownsFolderBranch({ ...base, linked: true })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: null })).toBe(true)
  })
  it('never in a workspace: master\'s, or any account\'s', () => {
    expect(ownsFolderBranch({ ...base, dir: '/code/acme' })).toBe(false)
    expect(ownsFolderBranch({ ...base, dir: '/code/globex/' })).toBe(false)
    expect(ownsFolderBranch({ ...base, dir: '/code/globex', linked: true, parked })).toBe(false)
  })
  it('a session MasterDeck parked in a checkout does not own the branch it found there', () => {
    expect(ownsFolderBranch({ ...base, parked })).toBe(false)
    expect(ownsFolderBranch({ ...base, branch: null, parked: { ...parked, branch: '' } })).toBe(false) // detached then and now
  })
  it('until it works in a linked worktree, or the checkout is on another branch (its own)', () => {
    expect(ownsFolderBranch({ ...base, dir: '/code/acme/api/.claude/worktrees/7-x', linked: true, parked })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: 'feat/7-mine', parked })).toBe(true)
    expect(ownsFolderBranch({ ...base, branch: 'feat/7-mine', parked: { ...parked, branch: '' } })).toBe(true)
  })
  it('a PR review session never does', () => {
    const review = { ...parked, review: true }
    expect(ownsFolderBranch({ ...base, parked: review })).toBe(false)
    expect(ownsFolderBranch({ ...base, branch: 'other', parked: review })).toBe(false)
    expect(ownsFolderBranch({ ...base, linked: true, parked: review })).toBe(false)
  })
})

describe('parked records', () => {
  it('reads the file, dropping what is malformed', () => {
    const m = parseParked({ '4f2a9c1e': { dir: '/code/acme/api', branch: 'feat/x', review: false, name: 'api-7-x' }, 'name:r': { dir: '/d', branch: '', review: true }, bad: { dir: 3 }, worse: 'x' })
    expect(m).toEqual({ '4f2a9c1e': { dir: '/code/acme/api', branch: 'feat/x', review: false }, 'name:r': { dir: '/d', branch: '', review: true } })
    expect(parseParked(null)).toEqual({})
    expect(parseParked([1])).toEqual({})
  })
  it('a session is found by its background id, else by the name it was started with', () => {
    const m = parseParked({ '4f2a9c1e': { dir: '/a', branch: 'x', review: false }, 'name:review-api-5': { dir: '/b', branch: 'y', review: true } })
    expect(parkedFor(m, { key: '4f2a9c1e', name: 'api-7-x' })?.dir).toBe('/a')
    expect(parkedFor(m, { key: '0badc0de', name: 'review-api-5' })?.dir).toBe('/b')
    expect(parkedFor(m, { key: '0badc0de', name: 'by-hand' })).toBeNull()
  })
})

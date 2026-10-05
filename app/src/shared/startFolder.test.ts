import { describe, expect, it } from 'vitest'
import { adoptFresh, folderKind, folderOf } from './startFolder'
import type { DraftAssign } from './types'

const draft = (p: Partial<DraftAssign>): DraftAssign => ({ issue: 7, repo: 'globex/app', name: 'app-7-x', cwd: '/code/globex', prompt: 'p', summary: 's', title: 't', url: 'u', proposalId: null, ...p })

describe('folderKind', () => {
  it('found: the repository\'s checkout', () => {
    expect(folderKind({ cwd: '/code/globex/app', workspace: '/code/globex', found: true, checkoutOf: 'globex/app' }, false)).toBe('found')
  })
  it('not found: says so (the session still starts, in the workspace)', () => {
    expect(folderKind({ cwd: '/code/globex', workspace: '/code/globex', found: false, checkoutOf: 'globex/app' }, false)).toBe('missing')
  })
  it('a folder the user chose, a checkout of the repository or not', () => {
    expect(folderKind({ cwd: '/x', workspace: '/code/globex', found: true, checkoutOf: 'globex/app' }, true)).toBe('chosen-found')
    expect(folderKind({ cwd: '/x', workspace: '/code/globex', found: false, checkoutOf: 'globex/app' }, true)).toBe('chosen')
    expect(folderKind({ cwd: '/x' }, true)).toBe('chosen')
  })
  it('nothing known (a proposal, an older CLI): just the folder', () => {
    expect(folderKind({ cwd: '/code' }, false)).toBe('plain')
    expect(folderKind({ cwd: '/code', found: false }, false)).toBe('plain')
  })
})

describe('folderOf', () => {
  it('reads where a draft starts', () => {
    expect(folderOf(draft({ cwd: '/code/globex/app', workspace: '/code/globex', found: true, checkoutOf: 'globex/app' }))).toEqual({ cwd: '/code/globex/app', workspace: '/code/globex', found: true, checkoutOf: 'globex/app' })
    expect(folderOf(draft({}))).toEqual({ cwd: '/code/globex' })
  })
})

describe('adoptFresh (a draft from master\'s proposal, looked up again)', () => {
  const found = draft({ cwd: '/code/globex/app', workspace: '/code/globex', found: true, checkoutOf: 'globex/app' })
  const missing = draft({ cwd: '/code/globex', workspace: '/code/globex', found: false, checkoutOf: 'globex/app' })
  it('a checkout that exists now wins over the proposal\'s folder', () => {
    expect(adoptFresh('/code/globex', found)).toEqual(folderOf(found))
    expect(adoptFresh('/code/globex/app', found)).toEqual(folderOf(found))
  })
  it('none: the proposal\'s folder stays, and it is said to be missing only when that folder is the workspace looked in', () => {
    expect(adoptFresh('/code/globex', missing)).toEqual(folderOf(missing))
    expect(adoptFresh('/code/custom', missing)).toEqual({ cwd: '/code/custom' })
  })
})

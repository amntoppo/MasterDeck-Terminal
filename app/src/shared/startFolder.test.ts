import { describe, expect, it } from 'vitest'
import { adoptFresh, folderKind, folderOf, startChoice, swapPrompt } from './startFolder'
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
  it('not found after a search that was cut short says how far it looked', () => {
    expect(folderKind({ cwd: '/code/globex', workspace: '/code/globex', found: false, checkoutOf: 'globex/app', searched: 2000 }, false)).toBe('missing-partial')
    expect(folderOf(draft({ workspace: '/code/globex', found: false, checkoutOf: 'globex/app', partial: true, searched: 2000 })).searched).toBe(2000)
    expect(folderOf(draft({ found: false, checkoutOf: 'globex/app', searched: 5 })).searched).toBeUndefined()
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
  it('carries whether Claude Code may work there, when the CLI said', () => {
    expect(folderOf(draft({ trusted: false })).trusted).toBe(false)
    expect(folderOf(draft({ trusted: true })).trusted).toBe(true)
    expect(folderOf(draft({ trusted: null })).trusted).toBeNull()
    expect('trusted' in folderOf(draft({}))).toBe(false)
  })
})

describe('adoptFresh (a draft from master\'s proposal, looked up again)', () => {
  const found = draft({ cwd: '/code/globex/app', workspace: '/code/globex', found: true, checkoutOf: 'globex/app' })
  const missing = draft({ cwd: '/code/globex', workspace: '/code/globex', found: false, checkoutOf: 'globex/app' })
  it('a checkout that exists now replaces the workspace the proposal named: the account\'s, or the config\'s', () => {
    expect(adoptFresh('/code/globex', found, '/code/acme')).toEqual(folderOf(found))
    expect(adoptFresh('/code/acme', found, '/code/acme')).toEqual(folderOf(found))
    expect(adoptFresh('/code/acme/', found, '/code/acme')).toEqual(folderOf(found))
    expect(adoptFresh('/code/globex/app', found, '/code/acme')).toEqual(folderOf(found))
  })
  it('a folder the proposal chose on purpose is never replaced', () => {
    expect(adoptFresh('/code/custom', found, '/code/acme')).toEqual({ cwd: '/code/custom' })
    expect(adoptFresh('/code/custom', missing, '/code/acme')).toEqual({ cwd: '/code/custom' })
  })
  it('no checkout: the proposal\'s folder stays, called missing when it is the workspace looked in', () => {
    expect(adoptFresh('/code/globex', missing, '/code/acme')).toEqual(folderOf(missing))
    expect(adoptFresh('/code/acme', missing, '/code/acme')).toEqual({ cwd: '/code/acme' })
  })
})

describe('swapPrompt (a new draft\'s prompt replaces only a generic one)', () => {
  const known = ['generic for the workspace', 'generic for the checkout']
  it('replaces a prompt MasterDeck wrote itself', () => {
    expect(swapPrompt('generic for the workspace', known, 'generic for the checkout')).toBe('generic for the checkout')
    expect(swapPrompt('generic for the checkout', known, 'generic for the workspace')).toBe('generic for the workspace')
  })
  it('never one the user edited or master wrote by hand', () => {
    expect(swapPrompt('generic for the workspace, and use pnpm', known, 'generic for the checkout')).toBe('generic for the workspace, and use pnpm')
    expect(swapPrompt('Do the migration in /code/custom', [], 'generic for the checkout')).toBe('Do the migration in /code/custom')
  })
})

describe('startChoice (what Start sends for a draft from master\'s proposal)', () => {
  const d = draft({ proposalId: 20, cwd: '/code/globex', prompt: 'p' })
  const same = { name: d.name, prompt: 'p', cwd: '/code/globex', model: '', override: false }
  it('nothing differs: master\'s own proposal is approved, with no model sent', () => {
    expect(startChoice(d, same, 'opus')).toEqual({ edited: false, model: undefined })
  })
  it('another folder, name or prompt: a new proposal that keeps the proposal\'s model', () => {
    expect(startChoice(d, { ...same, cwd: '/code/globex/app' }, 'opus')).toEqual({ edited: true, model: 'opus' })
    expect(startChoice(d, { ...same, prompt: 'p2' }, undefined)).toEqual({ edited: true, model: undefined })
    expect(startChoice(d, { ...same, name: 'x' }, 'opus')).toEqual({ edited: true, model: 'opus' })
  })
  it('a model or account picked in the dialog wins', () => {
    expect(startChoice(d, { ...same, model: 'sonnet' }, 'opus')).toEqual({ edited: true, model: 'sonnet' })
    expect(startChoice(d, { ...same, override: true }, 'opus')).toEqual({ edited: true, model: 'opus' })
  })
})

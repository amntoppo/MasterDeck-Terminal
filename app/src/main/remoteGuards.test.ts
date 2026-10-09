import { afterAll, describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { remoteSettings, knownDirsOnly, chosenFolder, claudeFolder, inboxActCall, MacPanes, worktreeFolder } from './remoteGuards'
it('remote save keeps current remoteEnabled and passes other keys', () => {
  expect(remoteSettings({ remoteEnabled: false, theme: 'dark' }, { remoteEnabled: true })).toEqual({ remoteEnabled: true, theme: 'dark' })
  expect(remoteSettings({ theme: 'dark' }, { remoteEnabled: true })).toEqual({ remoteEnabled: true, theme: 'dark' })
  expect(remoteSettings({ theme: 'dark' }, { remoteEnabled: true, font: 12, theme: 'light' })).toEqual({ remoteEnabled: true, font: 12, theme: 'dark' })
})
it('non-object payload keeps every current setting', () => {
  for (const bad of [null, 'x', 3, [1]]) expect(remoteSettings(bad, { remoteEnabled: true, font: 12 })).toEqual({ remoteEnabled: true, font: 12 })
})
it('keeps only known dirs, normalising trailing slashes', () => {
  expect(knownDirsOnly(['/etc', '/w/repo/', '/w/other'], ['/w/repo', '/w/other'])).toEqual([resolve('/w/repo'), resolve('/w/other')])
})
it('a chosen folder from the Mac\'s own window must be a folder that is there', () => {
  expect(chosenFolder(false, tmpdir())).toEqual({ ok: true, cwd: tmpdir() })
  for (const none of [undefined, null, '']) for (const remote of [false, true]) expect(chosenFolder(remote, none)).toEqual({ ok: true })
  expect(chosenFolder(false, 'relative/x')).toEqual({ ok: false, message: 'not a folder on this Mac: relative/x' })
  expect(chosenFolder(false, `${tmpdir()}/no-such-folder-here`)).toMatchObject({ ok: false })
  expect(chosenFolder(false, __filename)).toMatchObject({ ok: false })
  expect(chosenFolder(false, 3)).toEqual({ ok: false, message: 'not a folder on this Mac' })
})
describe('a chosen folder from a browser', () => {
  // ws/repo and ws/other are workspace repositories; ws/out is a link to a folder outside the workspace.
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'md-chosen-')))
  const ws = join(top, 'ws')
  const repo = join(ws, 'repo')
  const outside = join(top, 'outside')
  for (const d of [repo, join(ws, 'other'), outside]) mkdirSync(d, { recursive: true })
  symlinkSync(outside, join(ws, 'out'))
  symlinkSync(repo, join(top, 'repo-link'))
  const known = [repo, join(ws, 'other')]
  afterAll(() => rmSync(top, { recursive: true, force: true }))

  it('is allowed when it is one of the workspace repositories', () => {
    expect(chosenFolder(true, repo, known)).toEqual({ ok: true, cwd: repo })
    expect(chosenFolder(true, `${repo}/`, known)).toEqual({ ok: true, cwd: repo })
    // Another spelling of the same folder: the repository as MasterDeck found it.
    expect(chosenFolder(true, join(top, 'repo-link'), known)).toEqual({ ok: true, cwd: repo })
  })
  it('is refused when it is anything else', () => {
    const no = { ok: false, message: expect.stringContaining('only in one of the workspace\'s repositories') }
    for (const bad of [ws, outside, tmpdir(), join(ws, 'missing'), 'relative/x', 'repo', `${ws}/repo/..`])
      expect(chosenFolder(true, bad, known)).toEqual(no)
    expect(chosenFolder(true, repo)).toEqual(no)
    expect(chosenFolder(true, 3, known)).toEqual({ ok: false, message: 'not a folder on this Mac' })
  })
  it('is refused when a link leads out of the workspace', () => {
    expect(chosenFolder(true, join(ws, 'out'), known)).toMatchObject({ ok: false })
    // Even listed by name: the link's target is not a known repository.
    expect(chosenFolder(true, join(ws, 'out'), [...known, outside + '-not'])).toMatchObject({ ok: false })
  })
})
it('claude is opened only from the Mac\'s own window, in a folder that is there', () => {
  expect(claudeFolder(false, tmpdir())).toEqual({ ok: true, cwd: tmpdir() })
  expect(claudeFolder(true, tmpdir())).toEqual({ ok: false, message: 'Do this on your Mac: open Claude in that folder once and accept its prompt.' })
  expect(claudeFolder(false, join(tmpdir(), 'no-such-folder-here'))).toMatchObject({ ok: false })
  expect(claudeFolder(false, 'relative/x')).toEqual({ ok: false, message: 'not a folder on this Mac: relative/x' })
  expect(claudeFolder(false, __filename)).toMatchObject({ ok: false })
  for (const bad of [undefined, null, '', 3, '~']) expect(claudeFolder(false, bad)).toMatchObject({ ok: false })
})
it('an inbox action from the web app takes the path it always did; only opening Claude on the Mac is refused', () => {
  // The paired web app is the user's own window elsewhere: reply, approve and the rest are passed
  // on exactly as from the Mac's window (no remote mark: text and master relay as before).
  for (const remote of [false, true]) {
    expect(inboxActCall(remote, 'i1', 'reply', { text: '/compact' })).toEqual({ ok: true, id: 'i1', type: 'reply', payload: { text: '/compact' } })
    expect(inboxActCall(remote, 'i1', 'approve', null)).toEqual({ ok: true, id: 'i1', type: 'approve', payload: {} })
    for (const type of ['option', 'menu', 'continue', 'compact', 'reject', 'send', 'login', 'dismiss', 'snooze', 'loop-more'])
      expect(inboxActCall(remote, 'i1', type, { a: 1 })).toEqual({ ok: true, id: 'i1', type, payload: { a: 1 } })
    expect(inboxActCall(remote, 'i1', 'reply', 'nope')).toEqual({ ok: true, id: 'i1', type: 'reply', payload: {} })
  }
  // Open Claude there… opens a tab on the Mac: never for a browser, whatever the item says.
  expect(inboxActCall(true, 'i1', 'trust', {})).toEqual({ ok: false, message: 'Do this on your Mac: open Claude in that folder once and accept its prompt.' })
  expect(inboxActCall(false, 'i1', 'trust', {})).toEqual({ ok: true, id: 'i1', type: 'trust', payload: {} })
  for (const [id, type] of [[1, 'approve'], ['i1', null], [undefined, undefined]])
    expect(inboxActCall(false, id, type, {})).toEqual({ ok: false, message: 'bad inbox action' })
})

describe('MacPanes (spec §4 size rule)', () => {
  it("a browser's size applies only while the Mac's window does not show the pane", () => {
    const m = new MacPanes()
    expect(m.remoteSize('p', 80, 24)).toEqual([80, 24])
    m.local('p', 120) // the window shows it
    expect(m.remoteSize('p', 80, 24)).toBeNull()
    expect(m.remoteSize('other', 80, 24)).toEqual([80, 24])
    m.local('p', 0) // hidden on the Mac
    expect(m.remoteSize('p', 80, 24)).toEqual([80, 24])
    m.local('p', 100)
    m.closed('p')
    expect(m.remoteSize('p', 80, 24)).toEqual([80, 24])
  })
  it('a size of 0 never resizes', () => {
    expect(new MacPanes().remoteSize('p', 0, 0)).toBeNull()
  })
})

it("a worktree is made only from the Mac's own window, in a folder that is there", () => {
  expect(worktreeFolder(false, tmpdir())).toEqual({ ok: true, cwd: tmpdir() })
  expect(worktreeFolder(true, tmpdir())).toMatchObject({ ok: false })
  expect(worktreeFolder(false, join(tmpdir(), 'no-such-folder-here'))).toMatchObject({ ok: false })
  expect(worktreeFolder(false, undefined)).toMatchObject({ ok: false })
})

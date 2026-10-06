import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteSettings, knownDirsOnly, chosenFolder, claudeFolder, inboxActCall, MacPanes } from './remoteGuards'
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
it('a chosen folder counts only from the Mac\'s own window, and must be a folder that is there', () => {
  expect(chosenFolder(false, tmpdir())).toEqual({ ok: true, cwd: tmpdir() })
  // A browser's is dropped (not an error: the draft is made without it).
  expect(chosenFolder(true, tmpdir())).toEqual({ ok: true })
  expect(chosenFolder(true, 'relative/x')).toEqual({ ok: true })
  for (const none of [undefined, null, '']) expect(chosenFolder(false, none)).toEqual({ ok: true })
  expect(chosenFolder(false, 'relative/x')).toEqual({ ok: false, message: 'not a folder on this Mac: relative/x' })
  expect(chosenFolder(false, `${tmpdir()}/no-such-folder-here`)).toMatchObject({ ok: false })
  expect(chosenFolder(false, __filename)).toMatchObject({ ok: false })
  expect(chosenFolder(false, 3)).toEqual({ ok: false, message: 'not a folder on this Mac' })
})
it('claude is opened only from the Mac\'s own window, in a folder that is there', () => {
  expect(claudeFolder(false, tmpdir())).toEqual({ ok: true, cwd: tmpdir() })
  expect(claudeFolder(true, tmpdir())).toEqual({ ok: false, message: 'Do this on your Mac: open Claude in that folder once and accept its prompt.' })
  expect(claudeFolder(false, join(tmpdir(), 'no-such-folder-here'))).toMatchObject({ ok: false })
  expect(claudeFolder(false, 'relative/x')).toEqual({ ok: false, message: 'not a folder on this Mac: relative/x' })
  expect(claudeFolder(false, __filename)).toMatchObject({ ok: false })
  for (const bad of [undefined, null, '', 3, '~']) expect(claudeFolder(false, bad)).toMatchObject({ ok: false })
})
it('an inbox action keeps who asked: a browser never passes for the window', () => {
  expect(inboxActCall(false, 'i1', 'approve', { text: 'x' })).toEqual({ ok: true, id: 'i1', type: 'approve', payload: { text: 'x' }, remote: false })
  expect(inboxActCall(true, 'i1', 'approve', null)).toEqual({ ok: true, id: 'i1', type: 'approve', payload: {}, remote: true })
  expect(inboxActCall(true, 'i1', 'reply', 'nope')).toMatchObject({ ok: true, payload: {}, remote: true })
  // Open Claude there… opens a tab on the Mac: never for a browser, whatever the item says.
  expect(inboxActCall(true, 'i1', 'trust', {})).toEqual({ ok: false, message: 'Do this on your Mac: open Claude in that folder once and accept its prompt.' })
  expect(inboxActCall(false, 'i1', 'trust', {})).toMatchObject({ ok: true, remote: false })
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

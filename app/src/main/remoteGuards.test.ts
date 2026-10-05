import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { remoteSettings, knownDirsOnly, localFolder, MacPanes } from './remoteGuards'
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
it('a chosen folder counts only from the Mac\'s own window', () => {
  expect(localFolder(false, '/code/globex/app')).toBe('/code/globex/app')
  expect(localFolder(true, '/code/globex/app')).toBeUndefined()
  for (const bad of [undefined, null, '', 3, ['/x']]) expect(localFolder(false, bad)).toBeUndefined()
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

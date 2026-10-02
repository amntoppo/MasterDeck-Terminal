import { it, expect } from 'vitest'
import { remoteSettings, knownDirsOnly } from './remoteGuards'
it('remote save keeps current remoteEnabled and passes other keys', () => {
  expect(remoteSettings({ remoteEnabled: false, theme: 'dark' }, { remoteEnabled: true })).toEqual({ remoteEnabled: true, theme: 'dark' })
  expect(remoteSettings({ theme: 'dark' }, { remoteEnabled: true })).toEqual({ remoteEnabled: true, theme: 'dark' })
})
it('non-object payload keeps current remoteEnabled', () => {
  for (const bad of [null, 'x', 3, [1]]) expect(remoteSettings(bad, { remoteEnabled: true })).toEqual({ remoteEnabled: true })
})
it('keeps only known dirs, normalising trailing slashes', () => {
  expect(knownDirsOnly(['/etc', '/w/repo/', '/w/other'], ['/w/repo', '/w/other'])).toEqual(['/w/repo', '/w/other'])
})

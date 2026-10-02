import { it, expect } from 'vitest'
import { stripRemoteSettings, knownDirsOnly } from './remoteGuards'
it('drops remoteEnabled only', () => {
  expect(stripRemoteSettings({ remoteEnabled: false, theme: 'dark' })).toEqual({ theme: 'dark' })
})
it('keeps only known dirs, normalising trailing slashes', () => {
  expect(knownDirsOnly(['/etc', '/w/repo/', '/w/other'], ['/w/repo', '/w/other'])).toEqual(['/w/repo', '/w/other'])
})

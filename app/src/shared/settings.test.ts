import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'

describe('normalizeSettings', () => {
  it('defaults and clamps', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ idleNudgeMinutes: 0, contextWarnPct: 150, budgetPerTicketUsd: 'x', dockBadge: false })).toEqual({
      ...DEFAULT_SETTINGS,
      idleNudgeMinutes: 1,
      contextWarnPct: 100,
      dockBadge: false,
    })
  })
})

describe('remote settings', () => {
  it('defaults off', () => {
    expect(normalizeSettings({})).toMatchObject({ remoteEnabled: false })
  })
  it('drops the retired remoteUrl and keeps remoteEnabled', () => {
    expect('remoteUrl' in normalizeSettings({ remoteUrl: 'https://x' })).toBe(false)
    expect(normalizeSettings({ remoteEnabled: true }).remoteEnabled).toBe(true)
  })
})

describe('instant typing', () => {
  it('defaults on and keeps a boolean', () => {
    expect(normalizeSettings({}).instantTyping).toBe(true)
    expect(normalizeSettings({ instantTyping: false }).instantTyping).toBe(false)
    expect(normalizeSettings({ instantTyping: 'no' }).instantTyping).toBe(true)
  })
})

describe('watch new PRs', () => {
  it('defaults on and keeps a boolean', () => {
    expect(normalizeSettings({}).watchPrs).toBe(true)
    expect(normalizeSettings({ watchPrs: false }).watchPrs).toBe(false)
    expect(normalizeSettings({ watchPrs: 'no' }).watchPrs).toBe(true)
  })
})

describe('meetings', () => {
  it('a settings file from before meetings reads with the defaults', () => {
    const old = { idleNudgeMinutes: 30, dockBadge: false, remoteEnabled: true }
    expect(normalizeSettings(old).meetings).toEqual(DEFAULT_SETTINGS.meetings)
    expect(normalizeSettings(old)).toMatchObject(old)
  })
  it('keeps a stored consent', () => {
    expect(normalizeSettings({ meetings: { consentAt: 10, consentVersion: 1, offer: false } }).meetings).toMatchObject({ consentAt: 10, consentVersion: 1, offer: false })
  })
})

describe('theme', () => {
  it('defaults to dark and keeps a known choice', () => {
    expect(normalizeSettings({}).theme).toBe('dark')
    for (const t of ['light', 'dark', 'system'] as const) expect(normalizeSettings({ theme: t }).theme).toBe(t)
    expect(normalizeSettings({ theme: 'solarized' }).theme).toBe('dark')
  })
})

describe('update settings', () => {
  it('default to automatic downloads on the stable channel', () => {
    expect(normalizeSettings({})).toMatchObject({ autoDownloadUpdates: true, updateChannel: 'stable' })
  })
  it('keep a boolean and a known channel', () => {
    expect(normalizeSettings({ autoDownloadUpdates: false, updateChannel: 'beta' })).toMatchObject({ autoDownloadUpdates: false, updateChannel: 'beta' })
    expect(normalizeSettings({ autoDownloadUpdates: 'no', updateChannel: 'nightly' })).toMatchObject({ autoDownloadUpdates: true, updateChannel: 'stable' })
  })
})

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

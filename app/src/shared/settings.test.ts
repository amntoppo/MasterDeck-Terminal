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
  it('defaults off with no URL', () => {
    expect(normalizeSettings({})).toMatchObject({ remoteEnabled: false, remoteUrl: '' })
  })
  it('keeps https and localhost URLs, drops others', () => {
    expect(normalizeSettings({ remoteUrl: 'https://md.example.workers.dev/' }).remoteUrl).toBe('https://md.example.workers.dev')
    expect(normalizeSettings({ remoteUrl: 'http://localhost:8787' }).remoteUrl).toBe('http://localhost:8787')
    expect(normalizeSettings({ remoteUrl: 'http://evil.example' }).remoteUrl).toBe('')
    expect(normalizeSettings({ remoteUrl: 'javascript:alert(1)' }).remoteUrl).toBe('')
    expect(normalizeSettings({ remoteEnabled: true }).remoteEnabled).toBe(true)
  })
})

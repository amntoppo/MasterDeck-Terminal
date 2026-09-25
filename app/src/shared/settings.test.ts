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

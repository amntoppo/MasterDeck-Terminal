import { describe, expect, it } from 'vitest'
import { remoteStatusWhenOff } from './remoteSnapshot'

describe('remoteStatusWhenOff', () => {
  it('explains what is missing only when enabled', () => {
    expect(remoteStatusWhenOff({ remoteEnabled: false }, true)).toEqual({ conn: 'off', message: null, lastSyncAt: null, hasToken: true })
    expect(remoteStatusWhenOff({ remoteEnabled: true }, false).message).toBe('Sign in first (Settings → Account)')
  })
})

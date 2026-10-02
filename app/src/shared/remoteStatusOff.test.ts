import { describe, expect, it } from 'vitest'
import { remoteStatusWhenOff } from './remoteSnapshot'

describe('remoteStatusWhenOff', () => {
  it('explains what is missing only when enabled', () => {
    expect(remoteStatusWhenOff({ remoteEnabled: false, remoteUrl: '' }, true)).toEqual({ conn: 'off', message: null, lastSyncAt: null, hasToken: true })
    expect(remoteStatusWhenOff({ remoteEnabled: true, remoteUrl: 'https://x.dev' }, false).message).toBe('add the desktop token')
    expect(remoteStatusWhenOff({ remoteEnabled: true, remoteUrl: '' }, true).message).toBe('set the backend address')
  })
})

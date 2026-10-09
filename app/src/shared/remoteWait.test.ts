import { describe, expect, it } from 'vitest'
import { REMOTE_WAIT_MS, remoteWait } from './remoteSnapshot'

describe('remoteWait', () => {
  it('connects as soon as the session list is in', () => {
    expect(remoteWait('ok', undefined, 0)).toEqual({ connect: true })
  })

  it('waits while the list is loading', () => {
    expect(remoteWait('pending', undefined, 5_000)).toEqual({ connect: false, message: 'waiting for sessions to load' })
  })

  it('says why when claude agents fails, first line only, trimmed', () => {
    expect(remoteWait('error', '  spawn claude ENOENT\nmore detail', 1_000)).toEqual({
      connect: false,
      message: 'waiting for sessions to load: claude agents failed: spawn claude ENOENT',
    })
    expect(remoteWait('error', 'x'.repeat(300), 0)).toEqual({
      connect: false,
      message: `waiting for sessions to load: claude agents failed: ${'x'.repeat(119)}…`,
    })
    expect(remoteWait('error', undefined, 0)).toEqual({ connect: false, message: 'waiting for sessions to load: claude agents failed' })
  })

  it('stops waiting after REMOTE_WAIT_MS', () => {
    expect(remoteWait('error', 'boom', REMOTE_WAIT_MS - 1).connect).toBe(false)
    expect(remoteWait('error', 'boom', REMOTE_WAIT_MS)).toEqual({ connect: true })
    expect(remoteWait('pending', undefined, REMOTE_WAIT_MS)).toEqual({ connect: true })
  })
})

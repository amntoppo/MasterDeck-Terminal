import { describe, expect, it } from 'vitest'
import { REMOTE_WAIT_MS, agentsFailure, remoteWait } from './remoteSnapshot'

describe('remoteWait', () => {
  it('connects as soon as the session list is in', () => {
    expect(remoteWait('ok', undefined, 0)).toEqual({ connect: true })
  })

  it('waits while the list is loading', () => {
    expect(remoteWait('pending', undefined, 5_000)).toEqual({ connect: false, message: 'waiting for sessions to load' })
  })

  it('says why when claude agents fails, as the source words it', () => {
    // pollAgents' own wording: "claude agents: <stderr>".
    expect(remoteWait('error', '  claude agents: spawn claude ENOENT\nmore detail', 1_000)).toEqual({
      connect: false,
      message: 'waiting for sessions to load: claude agents: spawn claude ENOENT',
    })
    expect(remoteWait('error', 'claude agents printed invalid JSON', 0)).toEqual({
      connect: false,
      message: 'waiting for sessions to load: claude agents printed invalid JSON',
    })
  })

  it('stops waiting after REMOTE_WAIT_MS', () => {
    expect(remoteWait('error', 'boom', REMOTE_WAIT_MS - 1).connect).toBe(false)
    expect(remoteWait('error', 'boom', REMOTE_WAIT_MS)).toEqual({ connect: true })
    expect(remoteWait('pending', undefined, REMOTE_WAIT_MS)).toEqual({ connect: true })
  })
})

describe('agentsFailure', () => {
  it('falls back when the error says nothing', () => {
    expect(agentsFailure(undefined)).toBe('claude agents failed')
    expect(agentsFailure('claude agents: ')).toBe('claude agents failed')
  })

  it('keeps the first line, at most 120 characters', () => {
    expect(agentsFailure(`claude agents: ${'x'.repeat(300)}`)).toBe(`claude agents: ${'x'.repeat(104)}…`)
    expect(agentsFailure(`claude agents: ${'x'.repeat(300)}`)).toHaveLength(120)
  })
})

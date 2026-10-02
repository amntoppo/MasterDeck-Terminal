import { describe, expect, it } from 'vitest'
import { DEFAULT_REMOTE_URL, PROVIDERS, remoteUrl } from './account'

describe('account shared', () => {
  it('lists the three providers in order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['google', 'github', 'apple'])
  })
  it('uses the default URL unless a safe override is set', () => {
    expect(remoteUrl({})).toBe(DEFAULT_REMOTE_URL)
    expect(remoteUrl({ MASTERDECK_REMOTE_URL: 'http://localhost:8787/' })).toBe('http://localhost:8787')
    expect(remoteUrl({ MASTERDECK_REMOTE_URL: 'http://evil.test' })).toBe(DEFAULT_REMOTE_URL)
    expect(remoteUrl({ MASTERDECK_REMOTE_URL: 'https://dev.masterdeck.dev@evil.test' })).toBe(DEFAULT_REMOTE_URL)
    expect(remoteUrl({ MASTERDECK_REMOTE_URL: 'https://x.dev/p' })).toBe(DEFAULT_REMOTE_URL)
    expect(remoteUrl({ MASTERDECK_REMOTE_URL: 'https://x.dev/' })).toBe('https://x.dev')
  })
})

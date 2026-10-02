import { it, expect } from 'vitest'
import { nextRequest } from './nextBrowserRequest'
it('shows the oldest unexpired request', () => {
  const now = 1000
  expect(nextRequest([{ id: 'a', expiresAt: 900 } as any, { id: 'c', expiresAt: 3000 } as any, { id: 'b', expiresAt: 2000 } as any], now)?.id).toBe('b')
  expect(nextRequest([], now)).toBeNull()
  expect(nextRequest(undefined, now)).toBeNull()
})
import { allowArmed } from './nextBrowserRequest'
it('arms Allow only after the delay', () => {
  expect(allowArmed(1000, 1000)).toBe(false)
  expect(allowArmed(1000, 1599)).toBe(false)
  expect(allowArmed(1000, 1600)).toBe(true)
})

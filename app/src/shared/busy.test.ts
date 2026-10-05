import { describe, expect, it } from 'vitest'
import { whileBusy } from './busy'

describe('whileBusy', () => {
  it('is busy while the work runs, and not after', async () => {
    const seen: boolean[] = []
    await whileBusy((b) => seen.push(b), async () => expect(seen).toEqual([true]))
    expect(seen).toEqual([true, false])
  })
  it('a rejected or throwing run does not stay busy, and does not reject', async () => {
    const seen: boolean[] = []
    await expect(whileBusy((b) => seen.push(b), () => Promise.reject(new Error('window is gone')))).resolves.toBeUndefined()
    await expect(whileBusy((b) => seen.push(b), () => { throw new Error('no bridge') })).resolves.toBeUndefined()
    expect(seen).toEqual([true, false, true, false])
  })
})

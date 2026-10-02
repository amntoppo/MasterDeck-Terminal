import { afterEach, describe, expect, it } from 'vitest'
import { onConfirmRequest, setIsWeb, webConfirm } from './webConfirm'

type Req = Parameters<Parameters<typeof onConfirmRequest>[0]>[0]

describe('webConfirm', () => {
  afterEach(() => setIsWeb(() => false))
  it('queues requests and resolves each in order', async () => {
    setIsWeb(() => true)
    const seen: Req[] = []
    const off = onConfirmRequest((r) => seen.push(r))
    const a = webConfirm('Stop A?')
    const b = webConfirm('Delete B?', { confirmLabel: 'Delete', danger: true })
    expect(seen.filter(Boolean).map((r) => r!.message)).toEqual(['Stop A?'])
    seen.at(-1)!.resolve(true)
    expect(seen.at(-1)).toMatchObject({ message: 'Delete B?', confirmLabel: 'Delete', danger: true })
    seen.at(-1)!.resolve(false)
    expect(seen.at(-1)).toBeNull()
    expect(await a).toBe(true)
    expect(await b).toBe(false)
    off()
  })
  it('on desktop resolves true without showing (native dialog already confirms)', async () => {
    setIsWeb(() => false)
    let calls = 0
    const off = onConfirmRequest(() => calls++)
    expect(await webConfirm('Stop?')).toBe(true)
    expect(calls).toBe(0)
    off()
  })
})

import { describe, expect, it } from 'vitest'
import { startLoopback } from './loopback'

const url = (port: number, p: string) => `http://127.0.0.1:${port}${p}`

describe('startLoopback', () => {
  it('resolves the first valid callback, then refuses the rest', async () => {
    const lb = await startLoopback()
    const r = await fetch(url(lb.port, '/callback?code=c1&state=s1'))
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('go back to MasterDeck')
    expect(await lb.result).toEqual({ code: 'c1', state: 's1' })
    const again = await fetch(url(lb.port, '/callback?code=c2&state=s2')).then((x) => x.status, () => 'refused')
    expect([410, 'refused']).toContain(again)
    expect(await lb.result).toEqual({ code: 'c1', state: 's1' })
  })
  it('404s other paths and 400s missing/oversized params without resolving', async () => {
    const lb = await startLoopback({ timeoutMs: 300 })
    expect((await fetch(url(lb.port, '/other?code=c&state=s'))).status).toBe(404)
    expect((await fetch(url(lb.port, '/callback?code=c'))).status).toBe(400)
    expect((await fetch(url(lb.port, '/callback?code=' + 'x'.repeat(257) + '&state=s'))).status).toBe(400)
    expect((await fetch(url(lb.port, '/callback?code=c&state=s'), { method: 'POST' })).status).toBe(404)
    expect(await lb.result).toBeNull()
  })
  it('times out with null and stops listening', async () => {
    const lb = await startLoopback({ timeoutMs: 50 })
    expect(await lb.result).toBeNull()
    await expect(fetch(url(lb.port, '/callback?code=c&state=s'))).rejects.toThrow()
  })
  it('close() resolves null', async () => {
    const lb = await startLoopback()
    lb.close()
    expect(await lb.result).toBeNull()
    await expect(fetch(url(lb.port, '/callback?code=c&state=s'))).rejects.toThrow()
  })
})

import { it, expect } from 'vitest'
import { IpcRegistry } from './ipcRegistry'
it('registers with ipc and can call by channel', async () => {
  const seen: string[] = []
  const ipc = { handle: (ch: string) => seen.push('h:' + ch), on: (ch: string) => seen.push('o:' + ch) }
  const r = new IpcRegistry(ipc)
  r.handle('a', (_e, x: number) => x + 1)
  r.on('b', () => undefined)
  expect(seen).toEqual(['h:a', 'o:b'])
  expect(await r.call('a', [1])).toBe(2)
  await expect(r.call('nope', [])).rejects.toThrow()
})

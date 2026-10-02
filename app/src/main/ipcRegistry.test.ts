import { it, expect } from 'vitest'
import { IpcRegistry, isRemote } from './ipcRegistry'
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
it('isRemote tells the bridge stub from a real IPC event (remote stops skip the native dialog)', async () => {
  let viaIpc: ((e: unknown) => unknown) | undefined
  const r = new IpcRegistry({ handle: (_ch, fn) => (viaIpc = fn), on: () => undefined })
  r.handle('stop', (e) => (isRemote(e) ? 'no dialog' : 'dialog'))
  expect(await r.call('stop', [])).toBe('no dialog')
  expect(viaIpc!({ sender: {} })).toBe('dialog')
  expect(isRemote(null)).toBe(false)
})

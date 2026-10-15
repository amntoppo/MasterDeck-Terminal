import { Terminal } from '@xterm/headless'
import type { IBuffer } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { findUrls } from '@shared/termLinks'
import { cellRange, logicalLine } from './termText'

const term = async (text: string, cols = 20) => {
  const t = new Terminal({ cols, rows: 10, allowProposedApi: true })
  await new Promise<void>((r) => t.write(text, r))
  return t.buffer.active as unknown as IBuffer
}

describe('logicalLine', () => {
  it('joins a wrapped address and maps it back across rows', async () => {
    const buf = await term('dev: http://127.0.0.1:20060/docs?x=1 ok\r\nnext')
    for (const y of [1, 2]) {
      const line = logicalLine(buf, y)
      const [u] = findUrls(line.text)
      expect(u.url).toBe('http://127.0.0.1:20060/docs?x=1')
      expect(cellRange(line, u.start, u.end)).toEqual({ start: { x: 6, y: 1 }, end: { x: 16, y: 2 } })
    }
    expect(logicalLine(buf, 3).text.trimEnd()).toBe('next')
  })

  it('counts wide characters by their cells', async () => {
    const buf = await term('日本 http://a.test/', 40)
    const line = logicalLine(buf, 1)
    const [u] = findUrls(line.text)
    expect(cellRange(line, u.start, u.end)).toEqual({ start: { x: 6, y: 1 }, end: { x: 19, y: 1 } })
  })
})

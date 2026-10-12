import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_CH } from '@shared/meetings'

const electron = vi.hoisted(() => ({ send: vi.fn(), exposed: {} as Record<string, unknown> }))
vi.mock('electron', () => ({
  ipcRenderer: { send: electron.send },
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (electron.exposed[k] = v) },
}))

describe('the capture preload', () => {
  // It runs sandboxed: it may require only electron. The two preload inputs are built together, so
  // any value import (even a constant from @shared) could be split into a chunk shared with the
  // main window's preload, which a sandboxed preload cannot require: only `import type` besides electron.
  it("imports only 'electron' and types", () => {
    const src = readFileSync(join(__dirname, 'capture.ts'), 'utf8')
    const imports = [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"][^'"]+['"]|^\s*import\s*['"][^'"]+['"]/gm)].map((m) => m[0].trim())
    expect(imports.length).toBeGreaterThan(0)
    for (const i of imports) expect(i.startsWith('import type ') || /from ['"]electron['"]$/.test(i), i).toBe(true)
    expect(src).not.toMatch(/\brequire\(|\bimport\(/)
  })

  it("sends on CAPTURE_CH's channels", async () => {
    await import('./capture')
    const c = electron.exposed.capture as Record<string, (...a: unknown[]) => void>
    c.chunk({ id: 'm', track: 'you', seq: 0 }, new Uint8Array())
    c.audio('m', new Uint8Array())
    c.level('you', 0.5)
    c.ended('stopped')
    expect(electron.send.mock.calls.map((x) => x[0])).toEqual([CAPTURE_CH.chunk, CAPTURE_CH.audio, CAPTURE_CH.level, CAPTURE_CH.ended])
  })
})

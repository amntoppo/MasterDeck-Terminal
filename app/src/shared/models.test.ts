import { describe, expect, it } from 'vitest'
import { defaultModelLabel, MODELS } from './models'

describe('models', () => {
  it('names the configured default model', () => {
    expect(defaultModelLabel(null)).toBe('Default')
    expect(defaultModelLabel('opus[1m]')).toBe('Default · Opus (1M context)')
    expect(defaultModelLabel('claude-sonnet-5')).toBe('Default · claude-sonnet-5')
  })
  it('only lists values master accepts for --model', () => {
    for (const m of MODELS) expect(m.value).toMatch(/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/)
  })
})

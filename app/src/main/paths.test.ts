import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from './paths'

const saved = { h: process.env.MASTERDECK_HOME, s: process.env.MASTERDECK_CLAUDE_SETTINGS }
afterEach(() => {
  for (const [k, v] of [['MASTERDECK_HOME', saved.h], ['MASTERDECK_CLAUDE_SETTINGS', saved.s]] as const)
    v === undefined ? delete process.env[k] : (process.env[k] = v)
})

describe('claudeSettings', () => {
  it('defaults to the real settings.json', () => {
    delete process.env.MASTERDECK_HOME
    delete process.env.MASTERDECK_CLAUDE_SETTINGS
    expect(resolvePaths('/a', '/r', false).claudeSettings).toBe(join(homedir(), '.claude', 'settings.json'))
  })
  it('an isolated MASTERDECK_HOME gets its own settings file', () => {
    process.env.MASTERDECK_HOME = '/tmp/iso'
    delete process.env.MASTERDECK_CLAUDE_SETTINGS
    expect(resolvePaths('/a', '/r', false).claudeSettings).toBe(join('/tmp/iso', 'claude-settings.json'))
  })
  it('an explicit MASTERDECK_CLAUDE_SETTINGS wins', () => {
    process.env.MASTERDECK_HOME = '/tmp/iso'
    process.env.MASTERDECK_CLAUDE_SETTINGS = '/tmp/x.json'
    expect(resolvePaths('/a', '/r', false).claudeSettings).toBe('/tmp/x.json')
  })
})

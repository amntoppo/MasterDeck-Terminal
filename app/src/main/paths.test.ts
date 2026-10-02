import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from './paths'

const KEYS = ['MASTERDECK_HOME', 'MASTERDECK_CLAUDE_SETTINGS', 'MASTERDECK_SKILLS_DIR', 'MASTERDECK_ISOLATED'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const clear = () => KEYS.forEach((k) => delete process.env[k])
afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))))

describe('isolation', () => {
  it('defaults to the real settings and skills', () => {
    clear()
    const p = resolvePaths('/a', '/r', false)
    expect(p.claudeSettings).toBe(join(homedir(), '.claude', 'settings.json'))
    expect(p.skillsDir).toBe(join(homedir(), '.claude', 'skills'))
  })
  it('MASTERDECK_HOME alone does not move settings or skills', () => {
    clear()
    process.env.MASTERDECK_HOME = '/tmp/iso'
    const p = resolvePaths('/a', '/r', false)
    expect(p.home).toBe('/tmp/iso')
    expect(p.claudeSettings).toBe(join(homedir(), '.claude', 'settings.json'))
    expect(p.skillsDir).toBe(join(homedir(), '.claude', 'skills'))
  })
  it('MASTERDECK_ISOLATED=1 puts both under MASTERDECK_HOME', () => {
    clear()
    process.env.MASTERDECK_HOME = '/tmp/iso'
    process.env.MASTERDECK_ISOLATED = '1'
    const p = resolvePaths('/a', '/r', false)
    expect(p.claudeSettings).toBe(join('/tmp/iso', 'claude-settings.json'))
    expect(p.skillsDir).toBe(join('/tmp/iso', 'skills'))
  })
  it('explicit overrides win over the flag', () => {
    clear()
    process.env.MASTERDECK_HOME = '/tmp/iso'
    process.env.MASTERDECK_ISOLATED = '1'
    process.env.MASTERDECK_CLAUDE_SETTINGS = '/tmp/x.json'
    process.env.MASTERDECK_SKILLS_DIR = '/tmp/sk'
    const p = resolvePaths('/a', '/r', false)
    expect(p.claudeSettings).toBe('/tmp/x.json')
    expect(p.skillsDir).toBe('/tmp/sk')
  })
})

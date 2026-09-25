import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reinstallSkill, skillStatus, syncSkills } from './skills'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'skills-'))
  const bundled = join(root, 'bundled')
  const target = join(root, 'target')
  mkdirSync(join(bundled, 'alpha', 'scripts'), { recursive: true })
  writeFileSync(join(bundled, 'alpha', 'SKILL.md'), 'v1')
  writeFileSync(join(bundled, 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
  mkdirSync(join(bundled, 'alpha', 'tests'))
  writeFileSync(join(bundled, 'alpha', 'tests', 't.py'), 'x')
  mkdirSync(join(bundled, 'beta'))
  writeFileSync(join(bundled, 'beta', 'SKILL.md'), 'b')
  return { root, bundled, target }
}

describe('skills', () => {
  it('installs missing skills without tests, executable scripts kept executable', () => {
    const { bundled, target } = setup()
    const r = syncSkills(bundled, target, '1.0.0')
    expect(r.errors).toEqual([])
    expect(r.skills.map((s) => [s.name, s.state])).toEqual([['alpha', 'installed'], ['beta', 'installed']])
    expect(existsSync(join(target, 'alpha', 'tests'))).toBe(false)
    if (process.platform !== 'win32') expect(statSync(join(target, 'alpha', 'scripts', 'run.sh')).mode & 0o111).toBeTruthy()
  })
  it('updates an unmodified copy, leaves a user-modified one and symlinks alone', () => {
    const { root, bundled, target } = setup()
    syncSkills(bundled, target, '1.0.0')
    writeFileSync(join(bundled, 'alpha', 'SKILL.md'), 'v2')
    writeFileSync(join(bundled, 'beta', 'SKILL.md'), 'b2')
    writeFileSync(join(target, 'beta', 'SKILL.md'), 'my edit')
    const r = syncSkills(bundled, target, '1.1.0')
    expect(readFileSync(join(target, 'alpha', 'SKILL.md'), 'utf8')).toBe('v2')
    expect(r.skills.find((s) => s.name === 'beta')?.state).toBe('modified')
    expect(readFileSync(join(target, 'beta', 'SKILL.md'), 'utf8')).toBe('my edit')
    // the replaced copy is backed up
    expect(readdirSync(join(target, '.masterdeck-backup')).some((n) => n.startsWith('alpha-'))).toBe(true)
    const linkTarget = join(root, 'elsewhere')
    mkdirSync(linkTarget)
    symlinkSync(linkTarget, join(target, 'gamma'))
    mkdirSync(join(bundled, 'gamma'))
    writeFileSync(join(bundled, 'gamma', 'SKILL.md'), 'g')
    expect(skillStatus(bundled, target, 'gamma').state).toBe('linked')
  })
  it('reinstalls on request and keeps the old folder', () => {
    const { bundled, target } = setup()
    mkdirSync(join(target, 'alpha'), { recursive: true })
    writeFileSync(join(target, 'alpha', 'SKILL.md'), 'mine')
    expect(skillStatus(bundled, target, 'alpha').state).toBe('custom')
    const r = reinstallSkill(bundled, target, 'alpha', '1.0.0')
    expect(r.ok).toBe(true)
    expect(readFileSync(join(target, 'alpha', 'SKILL.md'), 'utf8')).toBe('v1')
    expect(reinstallSkill(bundled, target, 'nope', '1').ok).toBe(false)
  })
})

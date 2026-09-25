import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { installStatusline, isInstalled, uninstallStatusline } from './statusline'

let dir: string
let o: { settingsPath: string; home: string; scriptPath: string; python: string; now: () => number }
const CAVEMAN = { type: 'command', command: 'bash "/x/caveman-statusline.sh"' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-'))
  o = { settingsPath: join(dir, 'settings.json'), home: join(dir, 'masterdeck'), scriptPath: '/app/statusline_tee.py', python: 'python3', now: () => 42 }
})

const settings = () => JSON.parse(readFileSync(o.settingsPath, 'utf8'))

describe('status line installer', () => {
  it('saves the existing status line, replaces it, and backs up settings', () => {
    writeFileSync(o.settingsPath, JSON.stringify({ theme: 'dark', statusLine: CAVEMAN }))
    expect(installStatusline(o).ok).toBe(true)
    expect(settings().statusLine.command).toBe('python3 "/app/statusline_tee.py"')
    expect(settings().theme).toBe('dark')
    expect(JSON.parse(readFileSync(join(o.home, 'statusline-original.json'), 'utf8')).command).toBe(CAVEMAN.command)
    expect(readdirSync(o.home)).toContain('settings.backup.42.json')
    expect(isInstalled(o.settingsPath, o.scriptPath)).toBe(true)
  })
  it('installing twice keeps the first original', () => {
    writeFileSync(o.settingsPath, JSON.stringify({ statusLine: CAVEMAN }))
    installStatusline(o)
    expect(installStatusline(o).message).toBe('already installed')
    expect(JSON.parse(readFileSync(join(o.home, 'statusline-original.json'), 'utf8')).command).toBe(CAVEMAN.command)
  })
  it('uninstall restores the original', () => {
    writeFileSync(o.settingsPath, JSON.stringify({ statusLine: CAVEMAN }))
    installStatusline(o)
    uninstallStatusline(o)
    expect(settings().statusLine).toEqual(CAVEMAN)
    expect(isInstalled(o.settingsPath, o.scriptPath)).toBe(false)
  })
  it('uninstall removes the key when there was no status line before', () => {
    writeFileSync(o.settingsPath, JSON.stringify({ theme: 'x' }))
    installStatusline(o)
    uninstallStatusline(o)
    expect(settings()).toEqual({ theme: 'x' })
  })
  it('reports a corrupt settings file instead of overwriting it', () => {
    writeFileSync(o.settingsPath, '{broken')
    expect(installStatusline(o).ok).toBe(false)
    expect(readFileSync(o.settingsPath, 'utf8')).toBe('{broken')
  })
})

describe('status line installer: files on disk', () => {
  it('keeps a symlinked settings.json a symlink', async () => {
    const { symlinkSync, lstatSync } = await import('node:fs')
    const real = join(dir, 'dotfiles-settings.json')
    writeFileSync(real, JSON.stringify({ statusLine: CAVEMAN }))
    symlinkSync(real, o.settingsPath)
    installStatusline(o)
    expect(lstatSync(o.settingsPath).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8')).statusLine.command).toBe('python3 "/app/statusline_tee.py"')
  })
  it('refreshTee restores a deleted script and leaves a current one alone', async () => {
    const { refreshTee } = await import('./statusline')
    const bundled = join(dir, 'bundled.py')
    const installed = join(dir, 'md', 'tee.py')
    writeFileSync(bundled, 'v2')
    expect(refreshTee(bundled, installed)).toBeNull()
    expect(readFileSync(installed, 'utf8')).toBe('v2')
    expect(refreshTee(bundled, installed)).toBeNull()
  })
})

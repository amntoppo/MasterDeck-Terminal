import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helperArgs, helperScript } from './updateHelper'
import { parseResult } from './updates'

// The helper against fake .app folders in a temp dir (paths with spaces), with stand-ins for open,
// osascript, xattr and the kill on the PATH's place (MD_* variables). Nothing here touches /Applications.

let root: string
let apps: string
let app: string
let dir: string
let staged: string
let script: string
let calls: string
let sleeper: ChildProcess | null = null

const write = (p: string, text: string, mode = 0o644) => {
  writeFileSync(p, text)
  chmodSync(p, mode)
}
const bundle = (path: string, marker: string) => {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(path, 'Contents', 'marker'), marker)
}
const markerOf = (path: string) => readFileSync(join(path, 'Contents', 'marker'), 'utf8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md helper '))
  apps = join(root, 'My Apps')
  app = join(apps, 'MasterDeck.app')
  dir = join(root, 'Application Support', 'MasterDeck', 'updates')
  staged = join(dir, '0.10.0', 'stage', 'MasterDeck.app')
  mkdirSync(dir, { recursive: true })
  bundle(app, 'old')
  bundle(staged, 'new')
  script = join(dir, 'update-helper.sh')
  write(script, helperScript(), 0o755)
  calls = join(root, 'calls.log')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // open: logs, and writes the health marker when FAKE_HEALTHY says so (the new app's "I am up").
  write(
    join(bin, 'open'),
    `#!/bin/bash\na="\${@: -1}"\necho "open $a $(cat "$a/Contents/marker")" >> "${calls}"\nif [ $# -gt 1 ]; then echo "open-env \${*:1:$#-1}" >> "${calls}"; fi\nif [ "$FAKE_HEALTHY" = 1 ] && [ "$(cat "$a/Contents/marker")" = new ]; then touch "${dir}/healthy-0.10.0"; fi\n`,
    0o755,
  )
  write(join(bin, 'kill'), `#!/bin/bash\necho "kill $1" >> "${calls}"\n`, 0o755)
  write(join(bin, 'xattr'), `#!/bin/bash\necho "xattr $*" >> "${calls}"\n`, 0o755)
  // A password prompt that is cancelled.
  write(join(bin, 'osascript'), `#!/bin/bash\necho "osascript" >> "${calls}"\necho "execution error: User canceled. (-128)" >&2\nexit 1\n`, 0o755)
})

afterEach(() => {
  sleeper?.kill()
  sleeper = null
  try {
    chmodSync(apps, 0o755)
  } catch {
    /* already */
  }
  rmSync(root, { recursive: true, force: true })
})

/** A pid that has exited (the quitting app, gone). */
function deadPid(): number {
  const r = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

function run(pid: number, relaunch: boolean, extra: Record<string, string> = {}) {
  const bin = join(root, 'bin')
  const r = spawnSync('/bin/bash', [script, ...helperArgs({ pid, app, staged, dir, version: '0.10.0', from: '0.9.0', relaunch })], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      MD_OPEN: join(bin, 'open'),
      MD_KILL: join(bin, 'kill'),
      MD_XATTR: join(bin, 'xattr'),
      MD_OSASCRIPT: join(bin, 'osascript'),
      MD_PID_WAIT: '2',
      MD_HEALTH_WAIT: '1',
      MD_POLL: '0.1',
      ...extra,
    },
    timeout: 15_000,
  })
  const result = existsSync(join(dir, 'result.json')) ? parseResult(readFileSync(join(dir, 'result.json'), 'utf8')) : null
  const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
  return { code: r.status, result, log }
}

describe('update helper', () => {
  it('is bash 3.2 syntax', () => {
    expect(spawnSync('/bin/bash', ['-n', script]).status).toBe(0)
  })

  it('swaps, opens the new app, and finishes when it is healthy', { timeout: 20_000 }, () => {
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1' })
    expect(r.code).toBe(0)
    expect(markerOf(app)).toBe('new')
    expect(r.result).toMatchObject({ ok: true, from: '0.9.0', version: '0.10.0' })
    expect(existsSync(join(apps, '.MasterDeck.app.previous'))).toBe(false)
    expect(existsSync(staged)).toBe(false)
    expect(r.log).toContain(`open ${app} new`)
    expect(r.log.some((l) => l.startsWith('xattr -dr com.apple.quarantine'))).toBe(true)
  })

  it("passes MasterDeck's own variables on to the app it opens (open drops the environment)", { timeout: 20_000 }, () => {
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1', MASTERDECK_USER_DATA: '/tmp/a b', MASTER_HOME: '/tmp/m', OTHER: 'x' })
    expect(r.result?.ok).toBe(true)
    expect(r.log).toContain('open-env --env MASTERDECK_USER_DATA=/tmp/a b --env MASTER_HOME=/tmp/m')
  })

  it('opens the app with no extra arguments when none of them is set', { timeout: 20_000 }, () => {
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1' })
    expect(r.log.some((l) => l.startsWith('open-env'))).toBe(false)
  })

  it('tries twice, then puts the previous app back and opens it', { timeout: 20_000 }, () => {
    const r = run(deadPid(), true)
    expect(r.code).toBe(1)
    expect(markerOf(app)).toBe('old')
    expect(r.result).toMatchObject({ ok: false, version: '0.10.0', reason: 'unhealthy' })
    expect(r.log.filter((l) => l === `open ${app} new`)).toHaveLength(2)
    expect(r.log.filter((l) => l === `kill ${app}`)).toHaveLength(2)
    expect(r.log[r.log.length - 1]).toBe(`open ${app} old`)
    expect(existsSync(join(apps, '.MasterDeck.app.previous'))).toBe(false)
  })

  it('leaves everything alone when the old app never quits', { timeout: 20_000 }, () => {
    sleeper = spawn('/bin/sleep', ['30'])
    const r = run(sleeper.pid!, true, { FAKE_HEALTHY: '1' })
    expect(r.code).toBe(1)
    expect(markerOf(app)).toBe('old')
    expect(markerOf(staged)).toBe('new')
    expect(r.result).toMatchObject({ ok: false, reason: 'still-running' })
    expect(r.log).toEqual([])
  })

  it('a refused password keeps the old app and says permission', { timeout: 20_000 }, () => {
    chmodSync(apps, 0o555)
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1' })
    expect(r.code).toBe(1)
    expect(markerOf(app)).toBe('old')
    expect(r.result).toMatchObject({ ok: false, reason: 'permission' })
    expect(r.log[0]).toBe('osascript')
    // The old app comes back up for the user.
    expect(r.log[r.log.length - 1]).toBe(`open ${app} old`)
  })

  it('install on quit swaps without opening anything', { timeout: 20_000 }, () => {
    const r = run(deadPid(), false)
    expect(r.code).toBe(0)
    expect(markerOf(app)).toBe('new')
    expect(r.result).toMatchObject({ ok: true, version: '0.10.0' })
    expect(r.log.some((l) => l.startsWith('open'))).toBe(false)
    expect(existsSync(join(apps, '.MasterDeck.app.previous'))).toBe(false)
  })
})

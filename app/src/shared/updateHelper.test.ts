import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helperArgs, helperScript } from './updateHelper'
import { parseResult } from './updates'

// The helper against fake .app folders in a temp dir (paths with spaces, quotes and $), with
// stand-ins for open, osascript, xattr and the kill (MD_* variables). The osascript stand-in either
// refuses (a cancelled password prompt) or runs the root command with /bin/sh as this user, with the
// folder made writable for it, so the administrator path is really run. Nothing here touches
// /Applications or asks for a password.

const PLIST = (v: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>\n`

let root = ''
let apps: string
let app: string
let dir: string
let staged: string
let zip: string
let zipSha: string
let script: string
let calls: string
let bin: string
const procs: ChildProcess[] = []

const write = (p: string, text: string, mode = 0o644) => {
  writeFileSync(p, text)
  chmodSync(p, mode)
}
const bundle = (path: string, marker: string, version = '0.10.0') => {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(path, 'Contents', 'marker'), marker)
  writeFileSync(join(path, 'Contents', 'Info.plist'), PLIST(version))
}
const markerOf = (path: string) => readFileSync(join(path, 'Contents', 'marker'), 'utf8')
/**
 * A process that ps lists as running from a bundle: sleep started with the bundle's executable as
 * its argv[0] (exec -a), so no binary is copied (XProtect would scan every copy).
 */
const runFrom = (bundlePath: string) => spawn('/bin/bash', ['-c', 'exec -a "$0" /bin/sleep 30', join(bundlePath, 'Contents', 'MacOS', 'MasterDeck')])
/** Running (a child that exited stays a zombie until node reaps it, so kill(pid, 0) is not enough). */
const alive = (pid: number) => {
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
  const stat = r.stdout.trim()
  return stat !== '' && !stat.startsWith('Z')
}

/** A fresh layout. `appsName` / `dataName` let a test use nasty folder names. */
function setup(o: { appsName?: string; dataName?: string; zipVersion?: string; zipMarker?: string } = {}) {
  root = mkdtempSync(join(tmpdir(), 'md helper '))
  apps = join(root, o.appsName ?? 'My Apps')
  app = join(apps, 'MasterDeck.app')
  dir = join(root, 'Application Support', o.dataName ?? 'MasterDeck', 'updates')
  staged = join(dir, '0.10.0', 'stage', 'MasterDeck.app')
  mkdirSync(dir, { recursive: true })
  bundle(app, 'old', '0.9.0')
  bundle(staged, 'new')
  // The downloaded zip (what the root path unpacks again), built like electron-builder's.
  const src = join(root, 'zipsrc', 'MasterDeck.app')
  bundle(src, o.zipMarker ?? 'new', o.zipVersion ?? '0.10.0')
  zip = join(dir, '0.10.0', 'MasterDeck-0.10.0-arm64-mac.zip')
  const z = spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', src, zip])
  expect(z.status).toBe(0)
  zipSha = createHash('sha512').update(readFileSync(zip)).digest('base64')
  script = join(dir, 'update-helper.sh')
  write(script, helperScript(), 0o755)
  calls = join(root, 'calls.log')
  bin = join(root, 'bin')
  mkdirSync(bin)
  // open: logs, writes the health marker when FAKE_HEALTHY says so (the new app's "I am up"), and
  // with FAKE_RUN starts the new bundle's executable (a stuck new app the helper has to kill).
  write(
    join(bin, 'open'),
    `#!/bin/bash
a="\${@: -1}"
echo "open $a $(cat "$a/Contents/marker")" >> "$FAKE_CALLS"
if [ $# -gt 1 ]; then echo "open-env \${*:1:$#-1}" >> "$FAKE_CALLS"; fi
if [ "$(cat "$a/Contents/marker")" = new ]; then
  [ "$FAKE_HEALTHY" = 1 ] && touch "$FAKE_DIR/healthy-0.10.0"
  if [ "$FAKE_RUN" = 1 ]; then (exec -a "$a/Contents/MacOS/MasterDeck" /bin/sleep 60) >/dev/null 2>&1 & echo $! >> "$FAKE_DIR/../started"; fi
fi
`,
    0o755,
  )
  write(join(bin, 'kill'), `#!/bin/bash\necho "kill $1" >> "$FAKE_CALLS"\n`, 0o755)
  write(join(bin, 'xattr'), `#!/bin/bash\necho "xattr $*" >> "$FAKE_CALLS"\n`, 0o755)
  // A password prompt that is cancelled.
  write(join(bin, 'osascript-cancel'), `#!/bin/bash\necho "osascript" >> "$FAKE_CALLS"\necho "execution error: User canceled. (-128)" >&2\nexit 1\n`, 0o755)
  // The password given: the last argument is the root command; run it as /bin/sh would, as this
  // user, with the folder writable for that moment (root could write it).
  write(
    join(bin, 'osascript-root'),
    `#!/bin/bash
echo "osascript" >> "$FAKE_CALLS"
printf '%s' "\${@: -1}" > "$FAKE_DIR/../root-command"
chmod u+w "$FAKE_APPS"
/bin/sh -c "\${@: -1}"
rc=$?
chmod u-w "$FAKE_APPS"
[ "$rc" = 0 ] || echo "execution error: The command exited with a non-zero status. ($rc)" >&2
exit $rc
`,
    0o755,
  )
}

afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL')
  try {
    for (const pid of readFileSync(join(dir, '..', 'started'), 'utf8').trim().split('\n')) if (pid) process.kill(Number(pid), 'SIGKILL')
  } catch {
    /* none started */
  }
  try {
    chmodSync(apps, 0o755)
  } catch {
    /* already */
  }
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

/** A pid that has exited (the quitting app, gone). */
function deadPid(): number {
  const r = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

function run(pid: number, relaunch: boolean, extra: Record<string, string> = {}, sha = zipSha, timeout = 15_000) {
  const r = spawnSync('/bin/bash', [script, ...helperArgs({ pid, app, staged, dir, version: '0.10.0', from: '0.9.0', relaunch, zip, sha512: sha })], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      MD_OPEN: join(bin, 'open'),
      MD_KILL: join(bin, 'kill'),
      MD_XATTR: join(bin, 'xattr'),
      MD_OSASCRIPT: join(bin, 'osascript-cancel'),
      MD_PID_WAIT: '2',
      MD_HEALTH_WAIT: '1',
      MD_KILL_WAIT: '2',
      MD_POLL: '0.1',
      FAKE_CALLS: calls,
      FAKE_DIR: dir,
      FAKE_APPS: apps,
      ...extra,
    },
    timeout,
  })
  const result = existsSync(join(dir, 'result.json')) ? parseResult(readFileSync(join(dir, 'result.json'), 'utf8')) : null
  const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
  return { code: r.status, result, log }
}

const prevOf = () => join(apps, '.MasterDeck.app.previous')

describe('update helper', () => {
  it('is bash 3.2 syntax', () => {
    setup()
    expect(spawnSync('/bin/bash', ['-n', script]).status).toBe(0)
  })

  it('swaps, opens the new app, and finishes when it is healthy', { timeout: 20_000 }, () => {
    setup()
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1' })
    expect(r.code).toBe(0)
    expect(markerOf(app)).toBe('new')
    expect(r.result).toMatchObject({ ok: true, from: '0.9.0', version: '0.10.0' })
    expect(existsSync(prevOf())).toBe(false)
    expect(existsSync(staged)).toBe(false)
    expect(r.log).toContain(`open ${app} new`)
    expect(r.log.some((l) => l.startsWith('xattr -dr com.apple.quarantine'))).toBe(true)
  })

  it("passes MasterDeck's own variables on to the app it opens (open drops the environment)", { timeout: 20_000 }, () => {
    setup()
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1', MASTERDECK_USER_DATA: '/tmp/a b', MASTER_HOME: '/tmp/m', OTHER: 'x' })
    expect(r.result?.ok).toBe(true)
    expect(r.log).toContain('open-env --env MASTERDECK_USER_DATA=/tmp/a b --env MASTER_HOME=/tmp/m')
  })

  it('opens the app with no extra arguments when none of them is set', { timeout: 20_000 }, () => {
    setup()
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1' })
    expect(r.log.some((l) => l.startsWith('open-env'))).toBe(false)
  })

  it('tries twice, then puts the previous app back and opens it', { timeout: 20_000 }, () => {
    setup()
    const r = run(deadPid(), true)
    expect(r.code).toBe(1)
    expect(markerOf(app)).toBe('old')
    expect(r.result).toMatchObject({ ok: false, version: '0.10.0', reason: 'unhealthy' })
    expect(r.log.filter((l) => l === `open ${app} new`)).toHaveLength(2)
    expect(r.log.filter((l) => l === `kill ${app}`)).toHaveLength(2)
    expect(r.log[r.log.length - 1]).toBe(`open ${app} old`)
    expect(existsSync(prevOf())).toBe(false)
  })

  it('leaves everything alone when the old app never quits', { timeout: 20_000 }, () => {
    setup()
    const sleeper = spawn('/bin/sleep', ['30'])
    procs.push(sleeper)
    const r = run(sleeper.pid!, true, { FAKE_HEALTHY: '1' })
    expect(r.code).toBe(1)
    expect(markerOf(app)).toBe('old')
    expect(markerOf(staged)).toBe('new')
    expect(r.result).toMatchObject({ ok: false, reason: 'still-running' })
    expect(r.log).toEqual([])
  })

  it('touches nothing while the app runs again from the bundle (a relaunch, or opened again at once)', { timeout: 40_000 }, () => {
    setup({ appsName: 'Apps (x).y' })
    const running = runFrom(app)
    procs.push(running)
    // Until bash has exec'd, ps shows "/bin/bash -c …": wait for the bundle's path.
    const until = Date.now() + 10_000
    while (!spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout.split('\n').some((l) => l.startsWith(join(app, 'Contents', 'MacOS'))))
      if (Date.now() > until) throw new Error('the stand-in app did not start')
    for (const relaunch of [false, true]) {
      const r = run(deadPid(), relaunch, { FAKE_HEALTHY: '1' }, zipSha, 18_000)
      expect(r.code).toBe(1)
      expect(r.result).toMatchObject({ ok: false, reason: 'still-running' })
      expect(markerOf(app)).toBe('old')
      expect(markerOf(staged)).toBe('new')
      expect(existsSync(prevOf())).toBe(false)
      expect(r.log).toEqual([])
      expect(alive(running.pid!)).toBe(true)
    }
  })

  it('kills only what runs from the bundle itself, its path matched literally (not as a pattern)', { timeout: 40_000 }, () => {
    // "Apps (x).y" as a regex is "Apps x" followed by any character: it would hit "Apps x-y" and miss itself.
    setup({ appsName: 'Apps (x).y' })
    const decoyApp = join(root, 'Apps x-y', 'MasterDeck.app')
    bundle(decoyApp, 'decoy')
    const decoy = runFrom(decoyApp)
    procs.push(decoy)
    // Two health waits, two kills and a ps per poll: slow on a busy machine, so a longer limit.
    const r = run(deadPid(), true, { FAKE_RUN: '1', MD_KILL: '' }, zipSha, 35_000)
    expect(r.result).toMatchObject({ ok: false, reason: 'unhealthy' })
    const started = readFileSync(join(dir, '..', 'started'), 'utf8').trim().split('\n').map(Number)
    expect(started).toHaveLength(2)
    for (const pid of started) expect(alive(pid)).toBe(false)
    expect(alive(decoy.pid!)).toBe(true)
    expect(markerOf(app)).toBe('old')
  })

  it('a refused password keeps the old app and says permission', { timeout: 20_000 }, () => {
    setup()
    chmodSync(apps, 0o555)
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1' })
    expect(r.code).toBe(1)
    expect(markerOf(app)).toBe('old')
    expect(r.result).toMatchObject({ ok: false, reason: 'permission' })
    expect(r.log[0]).toBe('osascript')
    // The old app comes back up for the user.
    expect(r.log[r.log.length - 1]).toBe(`open ${app} old`)
  })

  const NASTY_APPS = `My "Apps" $HOME 'x' \\ (1)`
  const NASTY_DATA = `Master'Deck "$PATH" \`id\``

  it('with the password: unpacks the verified zip as root (never the staged copy), with nasty paths', { timeout: 20_000 }, () => {
    setup({ appsName: NASTY_APPS, dataName: NASTY_DATA, zipMarker: 'from-zip' })
    // Anything the user could have put into the staged folder is not what gets installed.
    writeFileSync(join(staged, 'Contents', 'marker'), 'tampered')
    chmodSync(apps, 0o555)
    const r = run(deadPid(), true, { FAKE_HEALTHY: '0', MD_OSASCRIPT: join(bin, 'osascript-root') })
    // The zip's app went in (FAKE_HEALTHY only reacts to "new": no marker, so it rolled back as root too).
    expect(r.log[0]).toBe('osascript')
    expect(r.log).toContain(`open ${app} from-zip`)
    expect(r.result).toMatchObject({ ok: false, reason: 'unhealthy' })
    expect(markerOf(app)).toBe('old')
    expect(r.log.filter((l) => l === 'osascript')).toHaveLength(2)
    // Every value went in single-quoted; the shell expanded none of them.
    const cmd = readFileSync(join(dir, '..', 'root-command'), 'utf8')
    expect(cmd).toContain(`APP='${app.replace(/'/g, `'\\''`)}'`)
    expect(cmd).not.toContain('update-helper.sh')
  })

  it('with the password: swaps in the zip and finishes when healthy; the backup stays (root owns it)', { timeout: 20_000 }, () => {
    setup({ appsName: NASTY_APPS, dataName: NASTY_DATA })
    chmodSync(apps, 0o555)
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1', MD_OSASCRIPT: join(bin, 'osascript-root') })
    expect(r.code).toBe(0)
    expect(r.result).toMatchObject({ ok: true, version: '0.10.0' })
    expect(markerOf(app)).toBe('new')
    expect(markerOf(prevOf())).toBe('old')
    expect(existsSync(join(apps, '.MasterDeck.app.new'))).toBe(false)
  })

  it('with the password: MasterDeck opened again while macOS asked for it is left alone (checked again as root, right before the renames)', { timeout: 30_000 }, () => {
    setup({ appsName: NASTY_APPS })
    // The prompt can take minutes: the user opens MasterDeck meanwhile. This stand-in starts the app
    // from the bundle after the helper's own check, waits until ps lists it, then runs the root command.
    write(
      join(bin, 'osascript-reopen'),
      `#!/bin/bash
echo "osascript" >> "$FAKE_CALLS"
(exec -a "$FAKE_APP/Contents/MacOS/MasterDeck" /bin/sleep 60) >/dev/null 2>&1 &
echo $! >> "$FAKE_DIR/../started"
end=$((SECONDS + 10))
until /bin/ps -axo command= | grep -qF "$FAKE_APP/Contents/MacOS/"; do [ "$SECONDS" -ge "$end" ] && exit 99; sleep 0.1; done
chmod u+w "$FAKE_APPS"
/bin/sh -c "\${@: -1}"
rc=$?
chmod u-w "$FAKE_APPS"
[ "$rc" = 0 ] || echo "execution error: The command exited with a non-zero status. ($rc)" >&2
exit $rc
`,
      0o755,
    )
    chmodSync(apps, 0o555)
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1', MD_OSASCRIPT: join(bin, 'osascript-reopen'), FAKE_APP: app }, zipSha, 25_000)
    expect(r.code).toBe(1)
    expect(r.result).toMatchObject({ ok: false, reason: 'still-running' })
    expect(markerOf(app)).toBe('old')
    expect(existsSync(prevOf())).toBe(false)
    expect(existsSync(join(apps, '.MasterDeck.app.new'))).toBe(false)
    // Nothing opened (it already runs), and what runs was not killed.
    expect(r.log).toEqual(['osascript'])
    const [pid] = readFileSync(join(dir, '..', 'started'), 'utf8').trim().split('\n').map(Number)
    expect(alive(pid)).toBe(true)
  })

  it('the root swap and the user swap both check for a running app right before their renames', () => {
    const s = helperScript()
    const root = s.slice(s.indexOf("<<'ROOTSWAP'"), s.indexOf('ROOTSWAP\n\nread'))
    expect(root.indexOf('/bin/ps -axo command=')).toBeGreaterThan(-1)
    expect(root.indexOf('/bin/ps -axo command=')).toBeLessThan(root.indexOf('/bin/rm -rf "$PREV" "$NEW"'))
    expect(root.indexOf('/usr/bin/plutil')).toBeLessThan(root.indexOf('/bin/ps -axo command='))
    const user = s.slice(s.indexOf('swap_user() {'), s.indexOf('do_swap() {'))
    expect(user.indexOf('app_pids')).toBeGreaterThan(-1)
    expect(user.indexOf('app_pids')).toBeLessThan(user.indexOf('rm -rf "$PREV" "$NEW"'))
  })

  it('with the password: a zip whose SHA-512 is not the verified one is not installed', { timeout: 20_000 }, () => {
    setup({ appsName: NASTY_APPS })
    chmodSync(apps, 0o555)
    const r = run(deadPid(), true, { FAKE_HEALTHY: '1', MD_OSASCRIPT: join(bin, 'osascript-root') }, Buffer.alloc(64).toString('base64'))
    expect(r.code).toBe(1)
    expect(r.result).toMatchObject({ ok: false, reason: 'swap-failed' })
    expect(markerOf(app)).toBe('old')
    expect(existsSync(prevOf())).toBe(false)
    expect(r.log[r.log.length - 1]).toBe(`open ${app} old`)
  })

  it('with the password: a zip holding another version is not installed', { timeout: 20_000 }, () => {
    setup({ zipVersion: '0.9.5' })
    chmodSync(apps, 0o555)
    const r = run(deadPid(), false, { MD_OSASCRIPT: join(bin, 'osascript-root') })
    expect(r.result).toMatchObject({ ok: false, reason: 'swap-failed' })
    expect(markerOf(app)).toBe('old')
  })

  it('install on quit swaps without opening anything and keeps the backup for the new app to remove', { timeout: 20_000 }, () => {
    setup()
    const r = run(deadPid(), false)
    expect(r.code).toBe(0)
    expect(markerOf(app)).toBe('new')
    expect(r.result).toMatchObject({ ok: true, version: '0.10.0' })
    expect(r.log.some((l) => l.startsWith('open'))).toBe(false)
    expect(markerOf(prevOf())).toBe('old')
  })

  it('waits two minutes for the health marker by default', () => {
    expect(helperScript()).toContain('HEALTH_WAIT="${MD_HEALTH_WAIT:-120}"')
  })
})

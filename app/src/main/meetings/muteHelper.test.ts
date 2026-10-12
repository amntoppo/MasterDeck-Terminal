import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MuteReading, MuteRule } from '../../shared/meetingMute'
import { findMute, spawnMute, type MuteWhere } from './muteHelper'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-mute-test-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function script(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Resolves with what the helper sent until it ended. */
function run(bin: string, rules?: readonly MuteRule[], killAfter?: number): Promise<{ lines: MuteReading[]; code: number | null; error: string }> {
  return new Promise((resolve) => {
    const h = spawnMute(bin, rules)
    const lines: MuteReading[] = []
    h.onLine((r) => lines.push(r))
    h.onExit((code, error) => resolve({ lines, code, error }))
    if (killAfter !== undefined) setTimeout(() => h.kill(), killAfter)
  })
}

const posix = process.platform !== 'win32'

describe('findMute', () => {
  const where = (over: Partial<MuteWhere>): MuteWhere => ({
    env: {},
    resourcesPath: join(root, 'Resources'),
    appRoot: join(root, 'app'),
    packaged: true,
    arch: 'arm64',
    ...over,
  })

  it.skipIf(!posix)('MASTERDECK_MUTE first, then the app’s own; none is null', () => {
    const own = script(join(root, 'own', 'md-mute'), 'exit 0')
    const bundled = script(join(root, 'Resources', 'mute', 'arm64', 'md-mute'), 'exit 0')
    const dev = script(join(root, 'app', 'resources', 'mute', 'arm64', 'md-mute'), 'exit 0')
    expect(findMute(where({ env: { MASTERDECK_MUTE: own } }))).toBe(own)
    expect(findMute(where({ env: { MASTERDECK_MUTE: join(root, 'nope') } }))).toBeNull()
    expect(findMute(where({}))).toBe(bundled)
    expect(findMute(where({ packaged: false }))).toBe(dev)
    expect(findMute(where({ arch: 'x64' }))).toBeNull()
    chmodSync(bundled, 0o644)
    expect(findMute(where({}))).toBeNull()
  })
})

describe('spawnMute', () => {
  it.skipIf(!posix)('sends the rules once on stdin and passes on only lines that parse, also split ones', { timeout: 20_000 }, async () => {
    const got = join(root, 'rules.txt')
    const bin = script(
      join(root, 'md-mute'),
      `IFS= read -r rules; printf '%s\\n' "$rules" > "${got}"
printf '{"t":1,"trusted":true,"apps":[{"id":"zoom","state":"muted"}]}\\n'
printf 'junk\\n'
printf '{"t":2,"trusted":true,"apps":[{"id":"teams","state":"unknown"}]}\\n'
printf '{"t":3,"trusted":true,"ap'; sleep 0.2; printf 'ps":[{"id":"zoom","state":"unmuted"}]}\\n'
printf '{"t":4,"trusted":false,"apps":[]}'`,
    )
    const rules: MuteRule[] = [{ id: 'zoom', name: 'Zoom', bundles: ['us.zoom.xos'], menu: { title: 'Meeting', muted: ['Unmute audio'], unmuted: ['Mute audio'] } }]
    const r = await run(bin, rules)
    expect(r.code).toBe(0)
    // teams is not one of the rules: junk. The last line has no newline: never complete.
    expect(r.lines.map((l) => l.t)).toEqual([1, 3])
    expect(r.lines[1].apps).toEqual([{ id: 'zoom', state: 'unmuted' }])
    expect(JSON.parse(readFileSync(got, 'utf8')).apps[0].id).toBe('zoom')
  })

  it.skipIf(!posix)('kill ends a helper that would run for ever; a refusal brings its stderr', { timeout: 20_000 }, async () => {
    const forever = script(join(root, 'forever'), 'while true; do printf \'{"t":1,"trusted":false,"apps":[]}\\n\'; sleep 0.05; done')
    // Killed after its first line (a fixed wait was too short with the full suite running).
    const k = await new Promise<{ lines: number; code: number | null }>((resolve) => {
      const h = spawnMute(forever)
      let lines = 0
      h.onLine(() => {
        if (lines++ === 0) h.kill()
      })
      h.onExit((code) => resolve({ lines, code }))
    })
    expect(k.lines).toBeGreaterThan(0)
    const refuse = script(join(root, 'refuse'), 'read -r x; echo "md-mute: rules are not valid" >&2; exit 2')
    const f = await run(refuse)
    expect(f).toMatchObject({ code: 2, error: 'md-mute: rules are not valid', lines: [] })
    const missing = await run(join(root, 'not-there'))
    expect(missing.code).toBeNull()
    expect(missing.error).toMatch(/ENOENT/)
  })

  // The real helper when scripts/mute.sh built it here: a protocol check that reads no real app
  // (the one rule names a bundle no Mac has) and asks for no permission (AXIsProcessTrusted only).
  const built = join(__dirname, '..', '..', '..', 'resources', 'mute', process.arch, 'md-mute')
  it.skipIf(process.platform !== 'darwin' || !existsSync(built))('the built md-mute speaks the protocol', { timeout: 20_000 }, async () => {
    const rules: MuteRule[] = [{ id: 'none', name: 'None', bundles: ['dev.masterdeck.test.none'], menu: { title: 'Meeting', muted: ['a'], unmuted: ['b'] } }]
    const r = await run(built, rules, 1000)
    expect(r.lines.length).toBeGreaterThanOrEqual(2)
    for (const l of r.lines) {
      expect(typeof l.trusted).toBe('boolean')
      expect(l.apps).toEqual([])
    }
    // A rule with neither menu nor element is refused.
    const bad = await run(built, [{ id: 'none', name: 'None', bundles: ['x'] }])
    expect(bad.code).toBe(2)
    expect(bad.error).toMatch(/neither menu nor element/)
  })
})

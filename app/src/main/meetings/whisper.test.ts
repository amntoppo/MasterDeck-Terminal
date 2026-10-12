import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findWhisper, killRunning, parseWhisperJson, transcribe, whisperThreads, type WhisperWhere } from './whisper'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-whisper-test-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function script(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const JSON_OUT = JSON.stringify({
  transcription: [
    { timestamps: { from: '00:00:00,000', to: '00:00:02,500' }, offsets: { from: 0, to: 2500 }, text: ' Hello alice.' },
    { offsets: { from: 2500, to: 4000 }, text: ' [BLANK_AUDIO]' },
    { offsets: { from: 4000, to: 6120 }, text: ' The acme ticket is done.' },
    { offsets: { from: 'x', to: 1 }, text: 'bad' },
  ],
})

/** A stand-in whisper-cli: records its arguments, writes the -oj file the real one writes. */
function fakeWhisper(dir: string, exit = 0): string {
  return script(
    join(dir, 'whisper-cli'),
    `printf '%s\\n' "$@" > "${join(dir, 'args.txt')}"
of=""; while [ $# -gt 0 ]; do [ "$1" = "-of" ] && of="$2"; shift; done
${exit === 0 ? `cat > "$of.json" <<'EOF'\n${JSON_OUT}\nEOF` : `echo "error: failed to open model" >&2; exit ${exit}`}`,
  )
}

describe('findWhisper', () => {
  const where = (over: Partial<WhisperWhere>): WhisperWhere => ({
    env: {},
    resourcesPath: join(root, 'Resources'),
    appRoot: join(root, 'app'),
    packaged: true,
    arch: 'arm64',
    pathEnv: '',
    ...over,
  })

  // Bash stand-ins and the executable bit: POSIX only.
  it.skipIf(process.platform === 'win32')('MASTERDECK_WHISPER first, then the app’s own, then PATH; none is null', () => {
    const own = script(join(root, 'own', 'whisper-cli'), 'exit 0')
    const bundled = script(join(root, 'Resources', 'whisper', 'arm64', 'whisper-cli'), 'exit 0')
    const dev = script(join(root, 'app', 'resources', 'whisper', 'arm64', 'whisper-cli'), 'exit 0')
    const onPath = script(join(root, 'bin', 'whisper-cli'), 'exit 0')
    const path = `${join(root, 'empty')}:${join(root, 'bin')}`
    expect(findWhisper(where({ env: { MASTERDECK_WHISPER: own }, pathEnv: path }))).toBe(own)
    // Set but not runnable is not silently replaced by another one.
    expect(findWhisper(where({ env: { MASTERDECK_WHISPER: join(root, 'nope') }, pathEnv: path }))).toBeNull()
    expect(findWhisper(where({ pathEnv: path }))).toBe(bundled)
    expect(findWhisper(where({ packaged: false, pathEnv: path }))).toBe(dev)
    expect(findWhisper(where({ arch: 'x64', pathEnv: path }))).toBe(onPath)
    expect(findWhisper(where({ arch: 'x64' }))).toBeNull()
    // Not executable: skipped.
    chmodSync(onPath, 0o644)
    expect(findWhisper(where({ arch: 'x64', pathEnv: path }))).toBeNull()
  })
})

describe('parseWhisperJson', () => {
  it('reads offsets in ms and the text; skips silence markers and broken rows', () => {
    expect(parseWhisperJson(JSON_OUT)).toEqual([
      { start: 0, end: 2500, text: 'Hello alice.' },
      { start: 4000, end: 6120, text: 'The acme ticket is done.' },
    ])
    expect(parseWhisperJson('{"transcription": 3}')).toEqual([])
  })

  it('a raw tab or newline in the text (whisper-cli leaves them unescaped) is read as a space', () => {
    const raw = '{"transcription": [{"offsets": {"from": 0, "to": 900}, "text": " ship\tit\nnow"}]}'
    expect(() => JSON.parse(raw)).toThrow()
    expect(parseWhisperJson(raw)).toEqual([{ start: 0, end: 900, text: 'ship it now' }])
  })

  it('a file that is not JSON is a failure, not silence', () => {
    expect(() => parseWhisperJson('not json')).toThrow(/could not be read/)
    expect(() => parseWhisperJson('{"transcription": [')).toThrow(/could not be read/)
  })
})

// Bash stand-ins for whisper-cli: POSIX only.
describe.skipIf(process.platform === 'win32')('transcribe', () => {
  it('runs whisper-cli with the model, the file, JSON out, the language and the threads', async () => {
    const bin = fakeWhisper(join(root, 'w'))
    const segs = await transcribe({ bin, wav: '/tmp/acme/chunk-0001.wav', model: '/tmp/acme/ggml-base.bin', language: 'en', threads: 3 })
    expect(segs.map((s) => s.text)).toEqual(['Hello alice.', 'The acme ticket is done.'])
    const args = readFileSync(join(root, 'w', 'args.txt'), 'utf8').trim().split('\n')
    expect(args.slice(0, 4)).toEqual(['-m', '/tmp/acme/ggml-base.bin', '-f', '/tmp/acme/chunk-0001.wav'])
    expect(args).toContain('-oj')
    expect(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2)).toEqual(['-l', 'en'])
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '3'])
  }, 20_000)

  it('a language that is not a code is auto', async () => {
    const bin = fakeWhisper(join(root, 'w'))
    await transcribe({ bin, wav: 'a.wav', model: 'm.bin', language: '; rm -rf', threads: 1 })
    const args = readFileSync(join(root, 'w', 'args.txt'), 'utf8').trim().split('\n')
    expect(args[args.indexOf('-l') + 1]).toBe('auto')
  }, 20_000)

  it('a failure says why, from the end of what whisper-cli printed', async () => {
    const bin = fakeWhisper(join(root, 'w'), 3)
    await expect(transcribe({ bin, wav: 'a.wav', model: 'm.bin', language: 'auto', threads: 1 })).rejects.toThrow(/failed \(3\): error: failed to open model/)
  }, 20_000)

  it('no JSON written is an error; a hung whisper-cli is stopped', async () => {
    const quiet = script(join(root, 'q', 'whisper-cli'), 'exit 0')
    await expect(transcribe({ bin: quiet, wav: 'a.wav', model: 'm.bin', language: 'auto', threads: 1 })).rejects.toThrow(/no transcript/)
    const hung = script(join(root, 'h', 'whisper-cli'), 'sleep 30')
    await expect(transcribe({ bin: hung, wav: 'a.wav', model: 'm.bin', language: 'auto', threads: 1, timeoutMs: 300 })).rejects.toThrow(/failed/)
  }, 20_000)

  it('garbage in the JSON file rejects', async () => {
    const bin = script(join(root, 'g', 'whisper-cli'), `of=""; while [ $# -gt 0 ]; do [ "$1" = "-of" ] && of="$2"; shift; done\nprintf '{"transcription": [garbage' > "$of.json"`)
    await expect(transcribe({ bin, wav: 'a.wav', model: 'm.bin', language: 'auto', threads: 1 })).rejects.toThrow(/could not be read/)
  }, 20_000)

  it('killRunning stops a running whisper-cli and removes its temp folder', async () => {
    const seen = join(root, 'k', 'of.txt')
    const bin = script(
      join(root, 'k', 'whisper-cli'),
      `of=""; while [ $# -gt 0 ]; do [ "$1" = "-of" ] && of="$2"; shift; done\nprintf '%s' "$of" > "${seen}"\nsleep 30`,
    )
    const run = transcribe({ bin, wav: 'a.wav', model: 'm.bin', language: 'auto', threads: 1 })
    await vi.waitFor(() => expect(existsSync(seen) && readFileSync(seen, 'utf8').length > 0).toBe(true), { timeout: 5000 })
    const tmp = dirname(readFileSync(seen, 'utf8'))
    expect(existsSync(tmp)).toBe(true)
    killRunning()
    await expect(run).rejects.toThrow(/failed \(SIGKILL\)/)
    expect(existsSync(tmp)).toBe(false)
    // Nothing left to stop: a second call does nothing.
    killRunning()
  }, 20_000)

})

describe('whisperThreads', () => {
  it('leaves two cores to the Mac', () => {
    expect(whisperThreads(10)).toBe(8)
    expect(whisperThreads(2)).toBe(1)
    expect(whisperThreads(1)).toBe(1)
  })
})

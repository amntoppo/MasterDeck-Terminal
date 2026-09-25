import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editQueue, isQueueEdit, readQueue, shiftQueue, unshiftQueue } from './queue'

const SID = '4f2a9c1e-1234-4abc-9def-0123456789ab'
const SCRIPTS = resolve(__dirname, '../../../skills/queue/scripts')

describe('queue store', () => {
  it('adds, moves, removes and clears; an empty queue has no file', () => {
    const d = mkdtempSync(join(tmpdir(), 'q-'))
    editQueue(SID, { op: 'add', text: '  first  ' }, d)
    editQueue(SID, { op: 'add', text: 'second\nline two' }, d)
    editQueue(SID, { op: 'add', text: 'third' }, d)
    expect(readQueue(SID, d)).toEqual(['first', 'second\nline two', 'third'])
    expect(editQueue(SID, { op: 'move', index: 2, text: 'third', to: 0 }, d).items).toEqual(['third', 'first', 'second\nline two'])
    expect(editQueue(SID, { op: 'remove', index: 1, text: 'first' }, d).items).toEqual(['third', 'second\nline two'])
    editQueue(SID, { op: 'clear' }, d)
    expect(readQueue(SID, d)).toEqual([])
    expect(() => readFileSync(join(d, `${SID}.jsonl`))).toThrow()
  })
  it('refuses an edit aimed at an item the hook already took', () => {
    const d = mkdtempSync(join(tmpdir(), 'q-'))
    editQueue(SID, { op: 'add', text: 'a' }, d)
    editQueue(SID, { op: 'add', text: 'b' }, d)
    shiftQueue(SID, d) // the Stop hook sent "a"
    const r = editQueue(SID, { op: 'remove', index: 0, text: 'a' }, d)
    expect(r.ok).toBe(false)
    expect(r.items).toEqual(['b'])
  })
  it('shift and unshift for a send now that fails', () => {
    const d = mkdtempSync(join(tmpdir(), 'q-'))
    editQueue(SID, { op: 'add', text: 'a' }, d)
    editQueue(SID, { op: 'add', text: 'b' }, d)
    expect(shiftQueue(SID, d)).toBe('a')
    unshiftQueue(SID, 'a', d)
    expect(readQueue(SID, d)).toEqual(['a', 'b'])
    expect(shiftQueue('../etc/passwd', d)).toBeNull()
  })
  it('only accepts well-formed edits over IPC', () => {
    expect(isQueueEdit({ op: 'add', text: 'x' })).toBe(true)
    expect(isQueueEdit({ op: 'remove', index: 0, text: 'x' })).toBe(true)
    expect(isQueueEdit({ op: 'remove', index: -1, text: 'x' })).toBe(false)
    expect(isQueueEdit({ op: 'move', index: 0, text: 'x' })).toBe(false)
    expect(isQueueEdit({ op: 'drop' })).toBe(false)
    expect(isQueueEdit(null)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('queue store and the queue skill hooks share one format', () => {
  const hook = (script: string, home: string, input: object) =>
    execFileSync('bash', [join(SCRIPTS, script)], { input: JSON.stringify(input), env: { ...process.env, HOME: home }, encoding: 'utf8' })

  it('what /queue stores, the app reads; what the app stores, the Stop hook runs in order', () => {
    const home = mkdtempSync(join(tmpdir(), 'qh-'))
    const dir = join(home, '.claude', 'queue')
    mkdirSync(dir, { recursive: true })
    hook('queue-submit.sh', home, { session_id: SID, prompt: '/queue fix the "quoted" bit' })
    expect(readQueue(SID, dir)).toEqual(['fix the "quoted" bit'])
    editQueue(SID, { op: 'add', text: 'then run the tests\nand report' }, dir)
    const first = JSON.parse(hook('queue-drain.sh', home, { session_id: SID }))
    expect(first.decision).toBe('block')
    expect(first.reason).toContain('fix the "quoted" bit')
    const second = JSON.parse(hook('queue-drain.sh', home, { session_id: SID }))
    expect(second.reason).toContain('then run the tests\nand report')
    expect(readQueue(SID, dir)).toEqual([])
    expect(hook('queue-drain.sh', home, { session_id: SID })).toBe('')
  })
  it('a hand-written line still shows', () => {
    const home = mkdtempSync(join(tmpdir(), 'qh-'))
    const dir = join(home, '.claude', 'queue')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SID}.jsonl`), '"ok"\nnot json\n')
    expect(readQueue(SID, dir)).toEqual(['ok', 'not json'])
  })
})

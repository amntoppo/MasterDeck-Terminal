import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BtwEntry, BtwEvent } from '@shared/btw'
import { BtwAsker, BtwStore, BtwTerminal, type BtwChild } from './btw'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'btw-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const SID = '092cdc65-fa47-4a2e-b05d-6af0eb208c74'

class FakeChild extends EventEmitter implements BtwChild {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  killed = false
  input = ''
  constructor() {
    super()
    this.stdin.on('data', (d: Buffer) => (this.input += d.toString()))
  }
  kill(): void {
    this.killed = true
    setImmediate(() => this.emit('close', null))
  }
  say(o: unknown): void {
    this.stdout.write(`${JSON.stringify(o)}\n`)
  }
  async close(code = 0): Promise<void> {
    await new Promise((r) => setImmediate(r))
    this.emit('close', code)
    await new Promise((r) => setImmediate(r))
  }
}

const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })

function setup() {
  const events: BtwEvent[] = []
  const store = new BtwStore(join(dir, 'btw'), (e) => events.push(e))
  const calls: { cmd: string; args: string[]; cwd: string }[] = []
  let child!: FakeChild
  const asker = new BtwAsker(store, () => '/bin/claude', () => ({ PATH: '/bin' }), null, (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    child = new FakeChild()
    return child
  })
  return { store, events, calls, asker, child: () => child }
}

describe('BtwAsker', () => {
  it('asks a forked, tool-less claude -p and keeps the answer', async () => {
    const t = setup()
    const r = t.asker.ask({ key: 'k1', sessionId: SID, model: 'claude-haiku-5-5' }, '  What was the word? ')
    expect(r.ok).toBe(true)
    const args = t.calls[0].args
    expect(args.slice(0, 5)).toEqual(['-p', '--resume', SID, '--fork-session', '--no-session-persistence'])
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}')
    expect(args.slice(-2)).toEqual(['--model', 'claude-haiku-5-5'])
    expect(t.calls[0].cwd).toContain('masterdeck-btw-')
    expect(t.child().input).toContain('Side question: What was the word?')
    expect(t.asker.busy('k1')).toBe(true)
    expect(t.asker.ask({ key: 'k1', sessionId: SID, model: null }, 'again').ok).toBe(false)

    t.child().say(delta('PINE'))
    t.child().say(delta('APPLE'))
    t.child().say({ type: 'result', subtype: 'success', is_error: false, result: 'PINEAPPLE', total_cost_usd: 0.02, modelUsage: { 'claude-haiku-5-5': {} } })
    await t.child().close(0)

    const [e] = t.store.list('k1')
    expect(e).toMatchObject({ question: 'What was the word?', answer: 'PINEAPPLE', status: 'done', source: 'panel', costUsd: 0.02 })
    expect(e.doneAt).not.toBeNull()
    expect(t.asker.busy('k1')).toBe(false)
    // Written to disk, and read back by a new store.
    const again = new BtwStore(join(dir, 'btw'), () => {})
    expect(again.list('k1')[0].answer).toBe('PINEAPPLE')
  })

  it('shows an error with what claude said', async () => {
    const t = setup()
    t.asker.ask({ key: 'k1', sessionId: SID, model: null }, 'q')
    expect(t.calls[0].args).not.toContain('--model')
    t.child().stderr.write('No conversation found with session ID: x\n')
    await t.child().close(1)
    expect(t.store.list('k1')[0]).toMatchObject({ status: 'error', error: 'No conversation found with session ID: x' })
  })

  it('stops an answer on the way', async () => {
    const t = setup()
    const r = t.asker.ask({ key: 'k1', sessionId: SID, model: null }, 'q')
    t.child().say(delta('half'))
    await new Promise((res) => setTimeout(res, 150))
    expect(t.asker.stop('k1', r.ok ? r.id : '')).toBe(true)
    await new Promise((res) => setImmediate(res))
    await new Promise((res) => setImmediate(res))
    expect(t.child().killed).toBe(true)
    expect(t.store.list('k1')[0]).toMatchObject({ status: 'stopped', answer: 'half' })
    expect(t.events.some((e) => 'entry' in e && e.entry.answer === 'half' && e.entry.status === 'asking')).toBe(true)
  })

  it('refuses bad questions and sessions without a conversation', () => {
    const t = setup()
    expect(t.asker.ask({ key: 'k1', sessionId: SID, model: null }, '  ').ok).toBe(false)
    expect(t.asker.ask({ key: 'k1', sessionId: 'not-a-uuid', model: null }, 'q').ok).toBe(false)
    expect(t.calls).toHaveLength(0)
  })

  it('passes earlier answers to the next question', async () => {
    const t = setup()
    t.asker.ask({ key: 'k1', sessionId: SID, model: null }, 'first?')
    t.child().say({ type: 'result', subtype: 'success', is_error: false, result: 'one' })
    await t.child().close(0)
    t.asker.ask({ key: 'k1', sessionId: SID, model: null }, 'second?')
    expect(t.child().input).toContain('first?')
    expect(t.child().input).toContain('one')
    await t.child().close(0)
  })
})

describe('BtwStore', () => {
  it('marks an answer left on its way as stopped, and removes entries', () => {
    const f = join(dir, 'btw')
    const s1 = new BtwStore(f, () => {})
    const e: BtwEntry = { id: 'a', question: 'q', answer: '', at: 1, doneAt: null, source: 'panel', status: 'asking' }
    s1.put('k', e)
    const events: BtwEvent[] = []
    const s2 = new BtwStore(f, (ev) => events.push(ev))
    expect(s2.list('k')[0].status).toBe('stopped')
    expect(s2.remove('k', 'a')).toBe(true)
    expect(events).toEqual([{ key: 'k', removed: 'a' }])
    expect(JSON.parse(readFileSync(join(f, 'k.json'), 'utf8')).entries).toEqual([])
  })
  it('refuses keys that are not file names', () => {
    const s = new BtwStore(join(dir, 'btw'), () => {})
    expect(s.list('../x')).toEqual([])
    s.put('../x', { id: 'a', question: 'q', answer: '', at: 1, doneAt: null, source: 'panel', status: 'done' })
    expect(s.list('../x')).toEqual([])
  })
})

describe('BtwTerminal', () => {
  const hist = (display: string, at: number, sessionId = SID) =>
    `${JSON.stringify({ display, pastedContents: {}, timestamp: at, project: '/work/acme', sessionId })}\n`
  const sessions = [{ key: '092cdc65', sessionId: SID, bgId: '092cdc65' }]
  const screenWith = (answer: string, open = true) =>
    open ? `❯ hi\n▔▔▔\n\n    /btw what is left?\n\n      ${answer}\n\n    c to copy · f to fork · Esc to close\n` : '❯ hi\n'

  it('files /btw lines under their session and reads the answer off the screen', async () => {
    const file = join(dir, 'history.jsonl')
    writeFileSync(file, hist('/btw an old one', 1000) + hist('not btw', 1001))
    const store = new BtwStore(join(dir, 'btw'), () => {})
    let now = 10_000_000
    const screens = [screenWith('Two'), screenWith('Two tests'), screenWith('', false)]
    let reads = 0
    const term = new BtwTerminal(
      file,
      join(dir, 'offset.json'),
      store,
      async () => screens[Math.min(reads++, screens.length - 1)],
      () => now,
      async (ms) => {
        now += ms
      },
    )
    await term.poll([])
    expect(store.list('092cdc65')).toEqual([])
    await term.poll(sessions)
    // The first read takes what is there, as old: no answer to read.
    expect(store.list('092cdc65')).toMatchObject([{ question: 'an old one', source: 'terminal', status: 'done', captured: false }])

    appendFileSync(file, hist('/btw what is left?', now - 1000) + hist('/btw other session', now, 'ffffffff-0000-0000-0000-000000000000'))
    await term.poll(sessions)
    await new Promise((r) => setTimeout(r, 10))
    const list = store.list('092cdc65')
    expect(list).toHaveLength(2)
    expect(list[1]).toMatchObject({ question: 'what is left?', answer: 'Two tests', status: 'done', captured: true, partial: false })

    // Nothing new: nothing changes; the offset survives a restart.
    const term2 = new BtwTerminal(file, join(dir, 'offset.json'), store, async () => null, () => now)
    await term2.poll(sessions)
    expect(store.list('092cdc65')).toHaveLength(2)
  })

  it('waits for a session that is listed after its /btw, and drops one never listed', async () => {
    const file = join(dir, 'history.jsonl')
    writeFileSync(file, '')
    const store = new BtwStore(join(dir, 'btw'), () => {})
    let now = 10_000_000
    const term = new BtwTerminal(file, join(dir, 'offset.json'), store, async () => null, () => now, async (ms) => {
      now += ms
    })
    const other = { key: 'other', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', bgId: null }
    await term.poll([other])
    appendFileSync(file, hist('/btw new one', now) + hist('/btw never listed', now, 'ffffffff-0000-0000-0000-000000000000'))
    await term.poll([other])
    expect(store.list('092cdc65')).toEqual([])
    now += 10_000
    await term.poll([other, { ...sessions[0], bgId: null }])
    expect(store.list('092cdc65')).toMatchObject([{ question: 'new one', status: 'done', captured: false }])
    now += 3 * 60_000
    await term.poll([other])
    await term.poll([other, { key: 'late', sessionId: 'ffffffff-0000-0000-0000-000000000000', bgId: null }])
    expect(store.list('late')).toEqual([])
  })

  it('says when the answer could not be read', async () => {
    const file = join(dir, 'history.jsonl')
    writeFileSync(file, '')
    const store = new BtwStore(join(dir, 'btw'), () => {})
    let now = 10_000_000
    const term = new BtwTerminal(file, join(dir, 'offset.json'), store, async () => null, () => now, async (ms) => {
      now += ms
    })
    await term.poll(sessions)
    appendFileSync(file, hist('/btw what is left?', now))
    await term.poll(sessions)
    await new Promise((r) => setTimeout(r, 10))
    expect(store.list('092cdc65')[0]).toMatchObject({ status: 'done', captured: false, answer: '' })
  })
})

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeckHooks, hookScript } from './deckHooks'
import { deckHooksInstalled, installDeckHooks } from './hooks'
import { editQueue, queueAnswer, readQueue, shiftQueue } from './queue'

const SID = '4d1bc2b2-2edb-4304-91fd-6633dc9bd935'

describe.skipIf(process.platform === 'win32')('the hook script', () => {
  it('is valid bash, logs events and prints the ticket context at SessionStart', () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-'))
    const d = new DeckHooks(home)
    d.setup()
    execFileSync('bash', ['-n', d.script])
    const run = (ev: string, input: object) => execFileSync(d.script, [ev], { input: JSON.stringify(input) }).toString()
    expect(run('Notification', { session_id: SID, notification_type: 'idle_prompt', message: "it's 100% idle" })).toBe('')
    d.setContext(SID, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } })
    expect(JSON.parse(run('SessionStart', { session_id: SID, source: 'compact' }))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } })
    expect(d.readEvents()).toEqual(new Set([SID]))
    expect(d.sessions[SID].notice?.message).toBe("it's 100% idle")
    expect(d.sessions[SID].compactedAt).not.toBeNull()
  })
  it('hands a permission request to MasterDeck and prints its answer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-'))
    const d = new DeckHooks(home)
    d.setup()
    const { spawn } = await import('node:child_process')
    const p = spawn(d.script, ['PermissionRequest'])
    let out = ''
    p.stdout.on('data', (b) => (out += b))
    p.stdin.end(JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' } }))
    let reqs = d.pending()
    for (let i = 0; i < 40 && !reqs.length; i++) {
      await new Promise((r) => setTimeout(r, 100))
      reqs = d.pending()
    }
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({ sessionId: SID, tool: 'Bash', input: { command: 'ls' } })
    expect(d.answer(reqs[0].id, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })).toBe(true)
    await new Promise((r) => p.on('exit', r))
    expect(JSON.parse(out).hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(d.pending()).toEqual([])
  })
  it('lets the terminal answer alone when MasterDeck is not running', () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-'))
    writeFileSync(join(home, 'x'), '')
    const script = join(home, 'hook.sh')
    writeFileSync(script, hookScript(join(home, 'deck'), join(home, 'queue')), { mode: 0o755 })
    const t = Date.now()
    expect(execFileSync(script, ['PermissionRequest'], { input: JSON.stringify({ session_id: SID, tool_name: 'Bash' }) }).toString()).toBe('')
    expect(Date.now() - t).toBeLessThan(3000)
  })
})

describe.skipIf(process.platform === 'win32')('installDeckHooks', () => {
  it('adds one entry per event, keeps the rest, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'))
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] } }))
    expect(installDeckHooks(p, dir, '/h/deck/hook.sh').ok).toBe(true)
    expect(deckHooksInstalled(p)).toBe(true)
    const s = JSON.parse(readFileSync(p, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.Stop).toHaveLength(2)
    expect(s.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'command', command: '"/h/deck/hook.sh" PermissionRequest', timeout: 600 })
    expect(installDeckHooks(p, dir, '/h/deck/hook.sh').message).toBe('already installed')
    installDeckHooks(p, dir, '/other/deck/hook.sh')
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.PermissionRequest).toHaveLength(1)
  })
})

describe.skipIf(process.platform === 'win32')('the /queue hook', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'dq-'))
    const queues = join(home, 'queue')
    mkdirSync(queues)
    const d = new DeckHooks(home, queues)
    d.setup()
    execFileSync('bash', ['-n', d.script])
    const run = (ev: string, input: object) => execFileSync(d.script, [ev], { input: JSON.stringify(input) }).toString()
    const stale = () => utimesSync(join(d.dir, 'alive'), new Date(0), new Date(0))
    return { d, queues, run, stale }
  }
  it('stores, lists and clears /queue prompts and never logs them', () => {
    const { d, queues, run } = setup()
    expect(JSON.parse(run('UserPromptSubmit', { session_id: SID, prompt: '/queue fix the "quoted" bit' }))).toEqual({ decision: 'block', reason: 'Queued #1: fix the "quoted" bit' })
    expect(readQueue(SID, queues)).toEqual(['fix the "quoted" bit'])
    expect(JSON.parse(run('UserPromptSubmit', { session_id: SID, prompt: '/queue' })).reason).toBe('Queue (1):\n1. fix the "quoted" bit')
    expect(run('UserPromptSubmit', { session_id: SID, prompt: 'hello /queue' })).toBe('')
    expect(JSON.parse(run('UserPromptSubmit', { session_id: SID, prompt: '/queue clear' })).reason).toBe('Queue cleared.')
    expect(readQueue(SID, queues)).toEqual([])
    expect(() => readFileSync(join(d.dir, 'events.jsonl'), 'utf8')).toThrow()
  }, 20_000)
  it('Stop while MasterDeck runs: the app answers, and the item goes exactly once', async () => {
    const { d, queues } = setup()
    editQueue(SID, { op: 'add', text: 'next one' }, queues)
    editQueue(SID, { op: 'add', text: 'after' }, queues)
    const { spawn } = await import('node:child_process')
    const p = spawn(d.script, ['Stop'])
    let out = ''
    p.stdout.on('data', (b) => (out += b))
    p.stdin.end(JSON.stringify({ session_id: SID }))
    let reqs = d.queueRequests()
    for (let i = 0; i < 40 && !reqs.length; i++) (await new Promise((r) => setTimeout(r, 100)), (reqs = d.queueRequests()))
    expect(reqs).toEqual([{ id: expect.any(String), sid: SID }])
    expect(d.claimQueue(reqs[0].id)).toBe(true)
    expect(d.claimQueue(reqs[0].id)).toBe(false)
    const items = readQueue(SID, queues)
    d.answerQueue(reqs[0].id, queueAnswer(items[0], items.length - 1))
    shiftQueue(SID, queues)
    await new Promise((r) => p.on('exit', r))
    expect(JSON.parse(out)).toEqual(queueAnswer('next one', 1))
    expect(readQueue(SID, queues)).toEqual(['after'])
  }, 20_000)
  it('Stop without MasterDeck: the hook drains one item itself', () => {
    const { d, queues, run, stale } = setup()
    editQueue(SID, { op: 'add', text: 'a' }, queues)
    stale()
    expect(JSON.parse(run('Stop', { session_id: SID }))).toEqual(queueAnswer('a', 0))
    expect(readQueue(SID, queues)).toEqual([])
    expect(run('Stop', { session_id: SID })).toBe('')
    expect(d.queueRequests()).toEqual([])
  }, 20_000)
  it('MasterDeck alive but silent: the hook takes its request back and drains, once', () => {
    const { d, queues, run } = setup()
    editQueue(SID, { op: 'add', text: 'a' }, queues)
    editQueue(SID, { op: 'add', text: 'b' }, queues)
    const t = Date.now()
    expect(JSON.parse(run('Stop', { session_id: SID }))).toEqual(queueAnswer('a', 1))
    expect(Date.now() - t).toBeLessThan(9000) // under the 10s hook timeout
    expect(readQueue(SID, queues)).toEqual(['b'])
    expect(d.queueRequests()).toEqual([])
  }, 20_000)
  it('queue-off: hooks installed by hand handle /queue, MasterDeck stays out', () => {
    const { d, queues, run, stale } = setup()
    d.setQueueOff(true)
    expect(run('UserPromptSubmit', { session_id: SID, prompt: '/queue x' })).toBe('')
    editQueue(SID, { op: 'add', text: 'a' }, queues)
    stale()
    expect(run('Stop', { session_id: SID })).toBe('')
    expect(readQueue(SID, queues)).toEqual(['a'])
    d.setQueueOff(false)
    expect(JSON.parse(run('Stop', { session_id: SID }))).toEqual(queueAnswer('a', 0))
  }, 20_000)
  it('MASTERDECK_QUEUE_DIR moves the queue for the app and for the hook', () => {
    const home = mkdtempSync(join(tmpdir(), 'dq-'))
    const queues = join(home, 'elsewhere')
    const prev = process.env.MASTERDECK_QUEUE_DIR
    process.env.MASTERDECK_QUEUE_DIR = queues
    try {
      const d = new DeckHooks(home)
      d.setup()
      // The session's own env never splits it from the app: the hook uses the dir the app baked in.
      const env = { ...process.env, MASTERDECK_QUEUE_DIR: join(home, 'other') }
      execFileSync(d.script, ['UserPromptSubmit'], { input: JSON.stringify({ session_id: SID, prompt: '/queue moved' }), env })
      expect(readQueue(SID)).toEqual(['moved'])
      expect(readQueue(SID, queues)).toEqual(['moved'])
    } finally {
      if (prev === undefined) delete process.env.MASTERDECK_QUEUE_DIR
      else process.env.MASTERDECK_QUEUE_DIR = prev
    }
  }, 20_000)
})

describe('pumpQueue (MasterDeck answers a Stop)', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'dp-'))
    const queues = join(home, 'queue')
    const d = new DeckHooks(home, queues)
    for (const sub of ['queue-requests', 'queue-answers']) mkdirSync(join(d.dir, sub), { recursive: true })
    editQueue(SID, { op: 'add', text: 'a' }, queues)
    editQueue(SID, { op: 'add', text: 'b' }, queues)
    const request = (pid: number, ageMs = 0) => {
      const id = `${Math.floor((Date.now() - ageMs) / 1000)}-${pid}-7`
      writeFileSync(join(d.dir, 'queue-requests', `${id}.json`), JSON.stringify({ id, sid: SID }))
      return id
    }
    const answer = (id: string) => join(d.dir, 'queue-answers', `${id}.json`)
    return { d, queues, request, answer }
  }
  it('a live hook gets the next prompt, and the item goes once', () => {
    const { d, queues, request, answer } = setup()
    const id = request(process.pid)
    d.pumpQueue()
    d.pumpQueue()
    expect(JSON.parse(readFileSync(answer(id), 'utf8'))).toEqual(queueAnswer('a', 1))
    expect(readQueue(SID, queues)).toEqual(['b'])
  })
  it('a hook that is gone (dead pid, or older than its wait) loses nothing', () => {
    const { d, queues, request, answer } = setup()
    const dead = request(99_999_999)
    const old = request(process.pid, 20_000)
    d.pumpQueue()
    expect(readQueue(SID, queues)).toEqual(['a', 'b'])
    expect(existsSync(answer(dead))).toBe(false)
    expect(existsSync(answer(old))).toBe(false)
  })
  it('cannot claim a request the hook took back', () => {
    const { d, request } = setup()
    const id = request(process.pid)
    const r = join(d.dir, 'queue-requests', id)
    writeFileSync(`${r}.gone`, readFileSync(`${r}.json`))
    rmSync(`${r}.json`)
    expect(d.claimQueue(id)).toBe(false)
  })
  it('sweeps answers nobody read after a minute', () => {
    const { d, answer } = setup()
    const id = `${Math.floor(Date.now() / 1000) - 120}-1-1`
    writeFileSync(answer(id), '{}')
    const fresh = `${Math.floor(Date.now() / 1000)}-1-1`
    writeFileSync(answer(fresh), '{}')
    d.pumpQueue()
    expect(readdirSync(join(d.dir, 'queue-answers'))).toEqual([`${fresh}.json`])
  })
})

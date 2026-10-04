import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  it('legacy sessions (alive at the migration, still running the skill hooks) get no queue work from it', () => {
    const { d, queues, run, stale } = setup()
    const OTHER = '5d1bc2b2-2edb-4304-91fd-6633dc9bd935'
    const file = join(d.dir, 'legacy-sids')
    // At the migration the session list is not in yet: every session is skipped.
    d.markLegacy()
    expect(run('UserPromptSubmit', { session_id: OTHER, prompt: '/queue y' })).toBe('')
    // The first list names them: only those stay skipped.
    d.pruneLegacy(new Set([SID]))
    expect(readFileSync(file, 'utf8')).toBe(`${SID}\n`)
    expect(run('UserPromptSubmit', { session_id: SID, prompt: '/queue x' })).toBe('')
    editQueue(SID, { op: 'add', text: 'a' }, queues)
    stale()
    expect(run('Stop', { session_id: SID })).toBe('')
    expect(readQueue(SID, queues)).toEqual(['a'])
    expect(d.readEvents()).toEqual(new Set([SID])) // the Stop is still logged
    expect(JSON.parse(run('UserPromptSubmit', { session_id: OTHER, prompt: '/queue y' })).reason).toBe('Queued #1: y')
    d.pruneLegacy(new Set([SID, OTHER]))
    expect(readFileSync(file, 'utf8')).toBe(`${SID}\n`)
    // None of them alive any more: the file goes.
    d.pruneLegacy(new Set([OTHER]))
    expect(existsSync(file)).toBe(false)
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
  it('a hook that reads its answer and exits at once still gets the item exactly once', () => {
    const { d, queues, request, answer } = setup()
    const id = request(process.pid)
    let calls = 0
    // Alive at the claim; by the shift check it has read (removed) its answer and exited.
    const isAlive = () => {
      if (calls++ === 0) return true
      rmSync(answer(id), { force: true })
      return false
    }
    d.pumpQueue(Date.now(), isAlive)
    expect(readQueue(SID, queues)).toEqual(['b'])
    d.pumpQueue()
    expect(readQueue(SID, queues)).toEqual(['b'])
  })
  it('a hook that died before reading its answer: the item stays, the answer goes', () => {
    const { d, queues, request, answer } = setup()
    const id = request(process.pid)
    let calls = 0
    d.pumpQueue(Date.now(), () => calls++ === 0)
    expect(readQueue(SID, queues)).toEqual(['a', 'b'])
    expect(existsSync(answer(id))).toBe(false)
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

describe.skipIf(process.platform === 'win32')('the master reports guard (PreToolUse on SendMessage)', () => {
  const MASTER = '11111111-1111-4111-8111-111111111111'
  const setup = (config?: object | string) => {
    const home = mkdtempSync(join(tmpdir(), 'mr-'))
    const cfg = join(home, 'master-config.json')
    const write = (c: object | string) => writeFileSync(cfg, typeof c === 'string' ? c : JSON.stringify(c))
    if (config !== undefined) write(config)
    const d = new DeckHooks(home, join(home, 'queue'), cfg)
    d.setup()
    execFileSync('bash', ['-n', d.script])
    const raw = (input: string) => execFileSync(d.script, ['MasterReport'], { input }).toString()
    const send = (to: unknown, message: unknown, extra: object = {}, sid = SID) =>
      raw(JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to, message, ...extra } }))
    const denied = (out: string) => {
      const o = JSON.parse(out).hookSpecificOutput
      expect(o).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
      return o.permissionDecisionReason as string
    }
    return { d, write, raw, send, denied }
  }
  const Q = 'gamerun-expo#440: question — ready for instructions; what should I pick up?'

  it('lets a report to master through, by name or in the ListAgents form', () => {
    const { send } = setup()
    expect(send('master-agent', '#12: done\n\nPR is up')).toBe('')
    expect(send('master-agent [abc123]', Q)).toBe('')
    expect(send('Master-Agent', '#12: blocked — no access')).toBe('')
  }, 20_000)
  it('denies a report to any other session, with the reason', () => {
    const { send, denied } = setup()
    expect(denied(send('masterdeck [a11992]', Q))).toBe(
      "MasterDeck: reports like 'gamerun-expo#440: question' go only to master-agent. Send it to master-agent by name; if SendMessage then says it is not reachable, do not send it to any other session — ask the user here.",
    )
    expect(denied(send('masterdeck', '#12: done'))).toMatch(/reports like '#12: done' go only to master-agent\./)
    expect(denied(send('master-agent-2', '\n\n  #7 : ANSWERED — use the staging key'))).toMatch(/'#7: answered'/)
    expect(denied(send('master-agent [x] extra', '#12: blocked — stuck'))).toMatch(/go only to master-agent/)
    // owner/name#N, and markdown or quote characters before the label.
    expect(denied(send('masterdeck', 'gamerun/gamerun-expo#440: blocked — no access'))).toMatch(/'gamerun\/gamerun-expo#440: blocked'/)
    expect(denied(send('masterdeck', '**#12: done** PR is up'))).toMatch(/'#12: done'/)
    expect(denied(send('masterdeck', '> `#12: question` — which key?'))).toMatch(/'#12: question'/)
    expect(denied(send('masterdeck', ' - _acme/app#3: answered_ — yes'))).toMatch(/'acme\/app#3: answered'/)
    // A heading marker or a list number before the label.
    expect(denied(send('masterdeck', '## #12: done'))).toMatch(/'#12: done'/)
    expect(denied(send('masterdeck', '1. acme/app#3: blocked — no access'))).toMatch(/'acme\/app#3: blocked'/)
    expect(denied(send('masterdeck', '> 2) **#12: question** — which?'))).toMatch(/'#12: question'/)
    // The report in the summary alone is still a report.
    expect(denied(send('masterdeck', 'see below', { summary: '#12: done' }))).toMatch(/'#12: done'/)
  }, 20_000)
  it('leaves everything that is not a report alone', () => {
    const { send, raw } = setup()
    expect(send('masterdeck', 'can you check PR #12 for me?')).toBe('')
    expect(send('masterdeck', 'I think #12: is done by now')).toBe('')
    expect(send('masterdeck', 'All done with #12: the PR is up\n#12: done')).toBe('')
    expect(send('researcher', '#12: master-agent here — you went idle; are you done?')).toBe('')
    expect(send('researcher', '#12: doneness is a spectrum')).toBe('')
    expect(send('team-lead', { type: 'shutdown_response', request_id: '#12: done' })).toBe('')
    expect(send('masterdeck', 'a/b/c#12: done')).toBe('')
    expect(send('masterdeck', '12. done')).toBe('')
    expect(send('masterdeck', '##12: done')).toBe('')
    expect(send(undefined, '#12: done')).toBe('')
    expect(raw('{"tool_input": {"to": "masterdeck", "message": "#12: done"')).toBe('')
    expect(raw('not json #1')).toBe('')
    expect(raw('')).toBe('')
  }, 20_000)
  it('reads the master name from the config at run time', () => {
    const { send, write, denied } = setup({ masterName: 'boss' })
    expect(send('boss', '#12: done')).toBe('')
    expect(send('Boss [9f]', '#12: done')).toBe('')
    expect(denied(send('master-agent', '#12: done'))).toMatch(/go only to boss\./)
    write({ masterName: 'chief' })
    expect(send('chief', '#12: done')).toBe('')
    expect(denied(send('boss', '#12: done'))).toMatch(/go only to chief\./)
    // A broken or empty config falls back to master-agent.
    write('{ nope')
    expect(send('master-agent', '#12: done')).toBe('')
    expect(denied(send('chief', '#12: done'))).toMatch(/go only to master-agent\./)
    write({ masterName: '  ' })
    expect(send('master-agent', '#12: done')).toBe('')
  }, 20_000)
  it('with master turned off, a report goes to no session at all', () => {
    const { send, denied } = setup({ masterEnabled: false })
    expect(denied(send('master-agent', '#12: done'))).toBe(
      "MasterDeck: master-agent is turned off, so reports like '#12: done' go to no session; say it to the user here instead.",
    )
    expect(denied(send('masterdeck', '#12: question — which key?'))).toMatch(/turned off/)
    expect(send('masterdeck', 'hello')).toBe('')
  }, 20_000)
  it('the master session itself may send anything', () => {
    const { d, send, denied } = setup()
    expect(denied(send('gamerun-expo-440', '#440: answered — use staging', {}, MASTER))).toMatch(/go only to/)
    d.setMasterSessions([MASTER])
    expect(send('gamerun-expo-440', '#440: answered — use staging', {}, MASTER)).toBe('')
    expect(denied(send('masterdeck', '#440: done'))).toMatch(/go only to/)
    d.setMasterSessions([])
    expect(existsSync(join(d.dir, 'master-sids'))).toBe(false)
    expect(denied(send('gamerun-expo-440', '#440: answered — use staging', {}, MASTER))).toMatch(/go only to/)
  }, 20_000)
  it('a subagent or teammate reporting to its parent is not checked', () => {
    const { raw, denied } = setup()
    const input = (extra: object) => JSON.stringify({ session_id: SID, tool_name: 'SendMessage', tool_input: { to: 'team-lead', message: '#12: done' }, ...extra })
    expect(raw(input({ agent_id: 'a1b2c3' }))).toBe('')
    expect(raw(input({ agent_type: 'general-purpose' }))).toBe('')
    expect(denied(raw(input({ agent_id: null, agent_type: '' })))).toMatch(/go only to/)
  }, 20_000)
  it('the master is exempt by its background id too, at once after a start, done or not', () => {
    const { d, send, denied } = setup()
    // startMaster knows only the bg id (the first 8 characters of the session id) until the next poll.
    d.addMasterSession(MASTER.slice(0, 8), 1_000)
    expect(readFileSync(join(d.dir, 'master-sids'), 'utf8')).toBe(`${MASTER.slice(0, 8)}\n`)
    expect(send('gamerun-expo-440', '#440: answered — use staging', {}, MASTER)).toBe('')
    expect(denied(send('gamerun-expo-440', '#440: answered — x', {}, SID))).toMatch(/go only to/)
    // A poll that does not list it yet keeps it; ten minutes later it is only what the polls say.
    d.setMasterSessions([], 2_000)
    expect(send('gamerun-expo-440', '#440: answered — use staging', {}, MASTER)).toBe('')
    d.setMasterSessions([], 1_000 + 11 * 60_000)
    expect(existsSync(join(d.dir, 'master-sids'))).toBe(false)
  }, 20_000)
  it('does nothing without jq', () => {
    const { d, denied } = setup()
    // A PATH with what the script needs, except jq.
    const bin = mkdtempSync(join(tmpdir(), 'nojq-'))
    for (const tool of ['cat', 'sed', 'head', 'date', 'grep']) symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`]).toString().trim(), join(bin, tool))
    const input = JSON.stringify({ session_id: SID, tool_input: { to: 'masterdeck', message: '#12: done' } })
    expect(denied(execFileSync('/bin/bash', [d.script, 'MasterReport'], { input }).toString())).toMatch(/go only to/)
    expect(execFileSync('/bin/bash', [d.script, 'MasterReport'], { input, env: { PATH: bin } }).toString()).toBe('')
  }, 20_000)
})

describe.skipIf(process.platform === 'win32')('installDeckHooks, the master reports guard', () => {
  it('adds the SendMessage entry, upgrades an older install, and follows a moved script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'))
    const p = join(dir, 'settings.json')
    installDeckHooks(p, dir, '/h/deck/hook.sh')
    const guard = () => (JSON.parse(readFileSync(p, 'utf8')).hooks.PreToolUse as { matcher?: string; hooks: { command: string; timeout?: number }[] }[]).filter((m) => m.matcher === 'SendMessage')
    expect(guard()).toEqual([{ matcher: 'SendMessage', hooks: [{ type: 'command', command: '"/h/deck/hook.sh" MasterReport', timeout: 10 }] }])
    // An install from before the guard existed is not complete: it gets the entry at the next launch.
    const s = JSON.parse(readFileSync(p, 'utf8'))
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((m: { matcher?: string }) => m.matcher !== 'SendMessage')
    writeFileSync(p, JSON.stringify(s))
    expect(deckHooksInstalled(p)).toBe(false)
    expect(installDeckHooks(p, dir, '/h/deck/hook.sh').message).toBe('MasterDeck hooks installed')
    expect(guard()).toHaveLength(1)
    expect(deckHooksInstalled(p)).toBe(true)
    expect(installDeckHooks(p, dir, '/h/deck/hook.sh').message).toBe('already installed')
    installDeckHooks(p, dir, '/other/deck/hook.sh')
    expect(guard()).toEqual([{ matcher: 'SendMessage', hooks: [{ type: 'command', command: '"/other/deck/hook.sh" MasterReport', timeout: 10 }] }])
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.PreToolUse.filter((m: { matcher?: string }) => m.matcher === 'Monitor')).toHaveLength(1)
  })
})

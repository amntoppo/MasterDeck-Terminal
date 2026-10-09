import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CompiledLoop } from './flow'
import { CHECK_PASSED, DECIDE, LOOP_MARK, loopCommand, loopScript } from './loopHook'

// macOS's own bash is 3.2, the one hooks run under there.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'
const SID = 'bbbbbbbb-1111-2222-3333-444444444444'
const STEP = 'tp-abc123'

const def = ({ check, agentDone, limits, ...over }: Partial<CompiledLoop> = {}): CompiledLoop => ({
  id: 'lp',
  name: 'Fix',
  plan: '1. Run the tests and fix what fails.',
  met: '',
  limit: '',
  then: '',
  after: null,
  ...over,
  check: { command: 'false', output: '', outputMode: 'match', timeoutMin: 5, ...check },
  agentDone: { on: false, goal: '', ...agentDone },
  limits: { iterations: 10, minutes: 0, stall: 0, ...limits },
})

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'lp', step: STEP, state: 'open', iteration: 0, startedAt: Date.now(), history: [], reason: null, lastCheck: null, ...over,
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=acme', '-c', 'user.email=dev@acme.test', ...args], { cwd, stdio: 'pipe' })

interface Opts {
  loops?: CompiledLoop[]
  file?: object | string
}

/** A home with loop.sh, a session workflow with the loops, an armed loop file, and a git repo. */
function setup(o: Opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'loop-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'loop-repo-'))
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  mkdirSync(join(home, 'workflows', 'sessions'), { recursive: true })
  mkdirSync(join(home, 'workflows', 'loops'), { recursive: true })
  const script = join(home, 'workflows', 'loop.sh')
  writeFileSync(script, loopScript(home), { mode: 0o755 })
  writeFileSync(
    join(home, 'workflows', 'sessions', `${SID}.json`),
    JSON.stringify({ steps: [{ id: STEP, trigger: 'after-push', note: 'n', loops: o.loops ?? [def()] }] }),
  )
  const L = join(home, 'workflows', 'loops', `${SID}.json`)
  const file = o.file ?? { loops: [entry()] }
  writeFileSync(L, typeof file === 'string' ? file : JSON.stringify(file))
  const run = (input: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    execFileSync(BASH, [script], {
      input: JSON.stringify({ session_id: SID, cwd: repo, stop_hook_active: true, last_assistant_message: 'Working on it.', ...input }),
      cwd: repo,
      env: { ...process.env, ...env },
    }).toString()
  const answer = (input?: Record<string, unknown>, env?: Record<string, string>) => {
    const out = run(input, env)
    return out ? JSON.parse(out) : null
  }
  const loops = () => JSON.parse(readFileSync(L, 'utf8')).loops
  const runs = () => {
    try {
      return readFileSync(join(home, 'workflows', 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { home, repo, script, L, run, answer, loops, runs }
}

const decide = (input: object) => JSON.parse(execFileSync('jq', ['-c', DECIDE], { input: JSON.stringify(input) }).toString())

const result = (over: Record<string, unknown> = {}) => ({ ran: true, passed: false, said: false, exit: 1, tail: 'FAIL', hash: 'h1', ms: 1000, ...over })

describe('loopCommand', () => {
  it('runs loop.sh with bash and carries the mark', () => {
    expect(loopCommand("/x/it's")).toBe(`bash '/x/it'\\''s/workflows/loop.sh' # ${LOOP_MARK}`)
  })
})

describe.skipIf(process.platform === 'win32')('DECIDE', () => {
  const NOW = 1_760_000_000_000
  const base = (o: { e?: object; d?: CompiledLoop[]; r?: Record<string, unknown>; extra?: object[] } = {}) => ({
    file: { loops: [entry({ startedAt: NOW - 60_000, ...o.e }), ...(o.extra ?? [])] },
    defs: o.d ?? [def()],
    result: result(o.r),
    now: NOW,
    sid: SID,
    progress: '/h/workflows/loops/sid-',
  })

  it('counts an iteration and keeps going', () => {
    const out = decide(base())
    expect(out.file.loops[0]).toMatchObject({ iteration: 1, state: 'open', lastCheck: { n: 1, passed: false, exit: 1, tail: 'FAIL' } })
    expect(out.answer.decision).toBe('block')
    expect(out.answer.reason).toContain('iteration 1/10')
    expect(out.answer.systemMessage).toBe('↻ loop 1/10')
    expect(out.run).toEqual({ at: NOW, sid: SID, trigger: 'loop', ids: 'lp', iteration: 1, state: 'open' })
  })

  it('counts the extra iterations Run 5 more adds', () => {
    const at = decide(base({ e: { iteration: 9 } }))
    expect(at.file.loops[0].state).toBe('limit')
    const more = decide(base({ e: { iteration: 9, extra: 5 } }))
    expect(more.file.loops[0].state).toBe('open')
    expect(more.answer.reason).toContain('iteration 10/15')
  })

  it('says how much time is left', () => {
    const out = decide(base({ d: [def({ limits: { iterations: 10, minutes: 20, stall: 0 } })] }))
    expect(out.answer.reason).toContain('iteration 1/10, 19 min left.')
  })

  it('a met loop with nothing after it lets the stop through', () => {
    const out = decide(base({ r: { passed: true, exit: 0 } }))
    expect(out.file.loops[0]).toMatchObject({ state: 'met', reason: 'criterion met after 1 iteration' })
    expect(out.answer).toBeNull()
    expect(out.opened).toEqual([])
  })

  it('leaves a file with no open loop alone', () => {
    const file = { loops: [entry({ state: 'stopped' }), 3] }
    expect(decide({ ...base(), file })).toEqual({ file, answer: null, run: null, opened: [] })
  })

  it('stops a loop its workflow no longer has', () => {
    const out = decide(base({ d: [] }))
    expect(out.file.loops[0]).toMatchObject({ state: 'stopped', reason: 'the workflow no longer has this loop' })
    expect(out.answer).toBeNull()
  })

  it('stall needs the last N hashes equal', () => {
    const h = (hash: string, n: number) => ({ n, hash })
    const d = [def({ limits: { iterations: 10, minutes: 0, stall: 3 } })]
    expect(decide(base({ d, e: { iteration: 2, history: [h('h1', 1), h('h1', 2)] } })).file.loops[0].reason).toBe('stopped: no progress in 3 iterations')
    expect(decide(base({ d, e: { iteration: 2, history: [h('h0', 1), h('h1', 2)], startedAt: NOW } })).file.loops[0].state).toBe('open')
  })

  it('after Run 5 more (stallFrom), only fresh rounds count toward the stall limit', () => {
    const h = (hash: string, n: number) => ({ n, hash })
    const d = [def({ limits: { iterations: 10, minutes: 0, stall: 3 } })]
    // Stalled at 3, given 5 more: the old rounds are all the same hash, the new one too.
    const e = { iteration: 3, extra: 5, stallFrom: 3, history: [h('h1', 1), h('h1', 2), h('h1', 3)] }
    const one = decide(base({ d, e }))
    expect(one.file.loops[0]).toMatchObject({ state: 'open', iteration: 4 })
    const two = decide({ ...base({ d }), file: one.file })
    expect(two.file.loops[0].state).toBe('open')
    const three = decide({ ...base({ d }), file: two.file })
    expect(three.file.loops[0]).toMatchObject({ state: 'limit', iteration: 6, reason: 'stopped: no progress in 3 iterations' })
  })

  it('opens the loop after this one by its outcome or a plain arrow, not the other', () => {
    const d = [
      def({ met: '2.met.1. Repeat until the loop "B" is done.' }),
      def({ id: 'lb', name: 'B', plan: '1. Lint.', after: { loop: 'lp', via: 'met' } }),
      def({ id: 'lc', name: 'C', plan: '1. Other.', after: { loop: 'lp', via: 'limit' } }),
    ]
    const met = decide(base({ d, r: { passed: true, exit: 0 } }))
    expect(met.opened).toEqual(['lb'])
    expect(met.file.loops.map((l: { id: string; state: string }) => [l.id, l.state])).toEqual([['lp', 'met'], ['lb', 'open']])
    expect(met.file.loops[1]).toMatchObject({ step: STEP, iteration: 0, startedAt: NOW, history: [] })
    expect(met.answer.reason).toContain('Loop "Fix" is done: criterion met after 1 iteration. Now:\n2.met.1.')
    expect(met.answer.reason).toContain('Then the loop "B" starts')
    expect(met.answer.reason).toContain('/h/workflows/loops/sid-lb.md')
    // A plain arrow: opened whatever the outcome; the answer blocks even with no branch text.
    const then = [def(), def({ id: 'lb', name: 'B', after: { loop: 'lp', via: 'then' } })]
    const limit = decide(base({ d: then, e: { iteration: 9 } }))
    expect(limit.opened).toEqual(['lb'])
    expect(limit.answer.reason).toMatch(/^Loop "Fix" is over: stopped: 10\/10 iterations, `false` still failing\./)
    // A finished run of the next loop is replaced by a fresh one.
    const again = decide(base({ d: then, e: { iteration: 9 }, extra: [entry({ id: 'lb', state: 'met', iteration: 4 })] }))
    expect(again.file.loops[1]).toMatchObject({ id: 'lb', state: 'open', iteration: 0 })
  })
  it('a closed loop hands over its branch, then what comes after it, then the next loop', () => {
    // Only a then arrow's blocks: the stop is blocked so the session does them.
    const only = decide(base({ d: [def({ then: '3. Open the PR.' })], r: { passed: true, exit: 0 } }))
    expect(only.answer.reason).toBe('Loop "Fix" is done: criterion met after 1 iteration.\nAfter the loop:\n3. Open the PR.')
    const d = [
      def({ met: '2.met.1. Push.', then: '3. Open the PR.' }),
      def({ id: 'lb', name: 'B', plan: '1. Lint.', after: { loop: 'lp', via: 'then' } }),
    ]
    const all = decide(base({ d, r: { passed: true, exit: 0 } }))
    const r: string = all.answer.reason
    expect(r.indexOf('Now:\n2.met.1. Push.')).toBeGreaterThan(0)
    expect(r.indexOf('After the loop:\n3. Open the PR.')).toBeGreaterThan(r.indexOf('2.met.1. Push.'))
    expect(r.indexOf('Then the loop "B" starts')).toBeGreaterThan(r.indexOf('3. Open the PR.'))
    // A session file from before the field: no then text, the stop goes through.
    const { then: _, ...old } = def()
    expect(decide(base({ d: [old as CompiledLoop], r: { passed: true, exit: 0 } })).answer).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('CHECK_PASSED', () => {
  const passed = (o: object, re = '') =>
    execFileSync('jq', ['--arg', 're', re, CHECK_PASSED], { input: JSON.stringify(o) }).toString().trim()
  it('the exit code decides without a pattern, the pattern with one', () => {
    expect(passed({ exit: 0, out: '', output: '' })).toBe('true')
    expect(passed({ exit: 1, out: '', output: '' })).toBe('false')
    expect(passed({ exit: 1, out: 'server ready', output: 'ready', mode: 'match' }, 'ready')).toBe('true')
    expect(passed({ exit: 0, out: 'server ready', output: 'ready', mode: 'no-match' }, 'ready')).toBe('false')
    expect(passed({ exit: 0, out: 'x', output: '(', mode: 'match' }, '(')).toBe('false')
  })
})

describe.skipIf(process.platform === 'win32')('the loop hook script', { timeout: 20_000 }, () => {
  it('is valid bash, and lets the stop through without jq', () => {
    const t = setup()
    execFileSync(BASH, ['-n', t.script])
    const bin = mkdtempSync(join(tmpdir(), 'loop-bin-'))
    symlinkSync('/bin/cat', join(bin, 'cat'))
    const out = execFileSync(BASH, [t.script], { input: JSON.stringify({ session_id: SID }), env: { PATH: bin } }).toString()
    expect(out).toBe('')
    expect(t.loops()[0].iteration).toBe(0)
  })

  it('lets the stop through with no loop file, a corrupt one, or no open loop', () => {
    const t = setup({ file: '{not json' })
    expect(t.run()).toBe('')
    expect(readFileSync(t.L, 'utf8')).toBe('{not json')
    const none = setup({ file: { loops: [entry({ state: 'met' })] } })
    expect(none.run()).toBe('')
    expect(none.runs()).toEqual([])
    const stopped = setup({ file: { loops: [entry({ state: 'stopped' })] } })
    expect(stopped.run()).toBe('')
    expect(stopped.loops()[0]).toMatchObject({ state: 'stopped', iteration: 0 })
    const gone = setup()
    expect(gone.run({ session_id: 'cccccccc-1111-2222-3333-444444444444' })).toBe('')
    expect(gone.run({ session_id: '../x' })).toBe('')
  })

  it('a failing check blocks with the iteration, the output tail, the round and the progress file', () => {
    const t = setup({ loops: [def({ check: { command: "echo 'expected 2, got 3'; exit 1" } as CompiledLoop['check'] })] })
    const a = t.answer()
    expect(a.decision).toBe('block')
    expect(a.reason).toContain('↻ Loop "Fix": iteration 1/10.')
    expect(a.reason).toContain('The check failed:\nexpected 2, got 3')
    expect(a.reason).toContain('1. Run the tests and fix what fails.')
    expect(a.reason).toContain(join(t.home, 'workflows', 'loops', `${SID}-lp.md`))
    const [l] = t.loops()
    expect(l).toMatchObject({ state: 'open', iteration: 1 })
    expect(l.history).toHaveLength(1)
    expect(l.history[0]).toMatchObject({ n: 1, passed: false, said: false, exit: 1, tail: 'expected 2, got 3\n' })
    expect(typeof l.history[0].hash).toBe('string')
    expect(t.runs()).toEqual([expect.objectContaining({ sid: SID, trigger: 'loop', ids: 'lp', iteration: 1, state: 'open' })])
  })

  it('a passing check ends the loop; the met branch is handed over when there is one', () => {
    const t = setup({ loops: [def({ check: { command: 'true' } as CompiledLoop['check'] })] })
    expect(t.run()).toBe('')
    expect(t.loops()[0]).toMatchObject({ state: 'met', reason: 'criterion met after 1 iteration' })
    const m = setup({ loops: [def({ check: { command: 'true' } as CompiledLoop['check'], met: '2.met.1. Open the PR.' })] })
    const a = m.answer()
    expect(a.decision).toBe('block')
    expect(a.reason).toBe('Loop "Fix" is done: criterion met after 1 iteration. Now:\n2.met.1. Open the PR.')
  })

  it('the output pattern decides, both ways, whatever the exit code', () => {
    const chk = (command: string, output: string, outputMode: 'match' | 'no-match') =>
      ({ command, output, outputMode, timeoutMin: 5 })
    expect(setup({ loops: [def({ check: chk('echo ready; exit 1', 'rea+dy', 'match') })] }).run()).toBe('')
    expect(setup({ loops: [def({ check: chk('echo starting', 'ready', 'match') })] }).answer().decision).toBe('block')
    expect(setup({ loops: [def({ check: chk('echo all good', 'FAIL', 'no-match') })] }).run()).toBe('')
    expect(setup({ loops: [def({ check: chk('echo 1 FAIL; exit 0', 'FAIL', 'no-match') })] }).answer().decision).toBe('block')
  })

  it('agent says done: only a line that starts with the marker counts', () => {
    const agentOnly = () => setup({ loops: [def({ check: { command: '' } as CompiledLoop['check'], agentDone: { on: true, goal: 'the page loads' } })] })
    const t = agentOnly()
    const a = t.answer()
    expect(a.reason).toMatch(/Not done yet/)
    expect(a.reason).toContain('(the page loads)')
    expect(t.answer({ last_assistant_message: 'I will write LOOP DONE: later' }).decision).toBe('block')
    expect(t.run({ last_assistant_message: 'Fixed it.\nLOOP DONE: all green' })).toBe('')
    expect(t.loops()[0]).toMatchObject({ state: 'met', reason: 'criterion met after 3 iterations' })
  })

  it('done, then verified: a claim the check does not back up is answered with its output', () => {
    const both = (command: string) =>
      setup({ loops: [def({ check: { command } as CompiledLoop['check'], agentDone: { on: true, goal: 'green' } })] })
    const t = both('echo ran >> ran.txt; echo still red; exit 1')
    // Not said: the check does not run.
    expect(t.answer().reason).toMatch(/Not done yet/)
    expect(() => statSync(join(t.repo, 'ran.txt'))).toThrow()
    const a = t.answer({ last_assistant_message: 'LOOP DONE: fixed' })
    expect(a.reason).toContain('Your LOOP DONE claim was not backed by the check:\nstill red')
    expect(readFileSync(join(t.repo, 'ran.txt'), 'utf8')).toBe('ran\n')
    const ok = both('true')
    expect(ok.run({ last_assistant_message: 'LOOP DONE: fixed' })).toBe('')
    expect(ok.loops()[0].state).toBe('met')
  })

  it('falls back to the transcript when the input has no last message', () => {
    const t = setup({ loops: [def({ check: { command: '' } as CompiledLoop['check'], agentDone: { on: true, goal: 'g' } })] })
    const tp = join(t.home, 'transcript.jsonl')
    writeFileSync(
      tp,
      [
        { type: 'user', message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nLOOP DONE: it loads' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )
    expect(t.run({ last_assistant_message: undefined, transcript_path: tp })).toBe('')
    expect(t.loops()[0].state).toBe('met')
  })

  it('the transcript counts only its last assistant entry: an older claim is not this turn\'s', () => {
    const t = setup({ loops: [def({ check: { command: '' } as CompiledLoop['check'], agentDone: { on: true, goal: 'g' } })] })
    const tp = join(t.home, 'transcript.jsonl')
    const write = (last: object) =>
      writeFileSync(
        tp,
        [
          { type: 'assistant', message: { content: [{ type: 'text', text: 'LOOP DONE: an old round' }] } },
          { type: 'user', message: { content: 'go on' } },
          last,
        ].map((l) => JSON.stringify(l)).join('\n') + '\n',
      )
    // The last one has no text (a tool call): nothing said.
    write({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })
    expect(t.answer({ last_assistant_message: undefined, transcript_path: tp }).reason).toMatch(/Not done yet/)
    write({ type: 'assistant', message: { content: [{ type: 'text', text: 'Still looking.' }] } })
    expect(t.answer({ last_assistant_message: undefined, transcript_path: tp }).reason).toMatch(/Not done yet/)
    expect(t.loops()[0]).toMatchObject({ state: 'open', iteration: 2 })
  })

  it('stops at the iteration limit, with the limit branch when there is one', () => {
    const t = setup({ loops: [def({ limits: { iterations: 2 } as CompiledLoop['limits'] })] })
    expect(t.answer().decision).toBe('block')
    expect(t.run()).toBe('')
    expect(t.loops()[0]).toMatchObject({ state: 'limit', iteration: 2, reason: 'stopped: 2/2 iterations, `false` still failing' })
    const b = setup({ loops: [def({ limits: { iterations: 1 } as CompiledLoop['limits'], limit: '2.limit.1. Tell the user.' })] })
    expect(b.answer().reason).toBe('Loop "Fix" is over: stopped: 1/1 iterations, `false` still failing. Now:\n2.limit.1. Tell the user.')
  })

  it('stops at the time limit', () => {
    const t = setup({
      loops: [def({ limits: { minutes: 60 } as CompiledLoop['limits'] })],
      file: { loops: [entry({ startedAt: Date.now() - 61 * 60_000 })] },
    })
    expect(t.run()).toBe('')
    expect(t.loops()[0]).toMatchObject({ state: 'limit', reason: 'stopped: time limit (60 min)' })
  })

  it('stops when nothing changes, durations aside; a change in the repo resets it', () => {
    const counter = 'n=$(cat .n 2>/dev/null || echo 0); n=$((n+1)); echo $n > .n; echo "1 failing, took $n.2s"; exit 1'
    const t = setup({ loops: [def({ check: { command: counter } as CompiledLoop['check'], limits: { stall: 3 } as CompiledLoop['limits'] })] })
    // .n is in the repo but untracked: keep it out of the git fingerprint.
    writeFileSync(join(t.repo, '.git', 'info', 'exclude'), '.n\n')
    expect(t.answer().decision).toBe('block')
    expect(t.answer().decision).toBe('block')
    writeFileSync(join(t.repo, 'b.txt'), 'b\n')
    expect(t.answer().decision).toBe('block')
    expect(t.answer().decision).toBe('block')
    expect(t.run()).toBe('')
    expect(t.loops()[0]).toMatchObject({ state: 'limit', iteration: 5, reason: 'stopped: no progress in 3 iterations' })
  })

  it('a check that runs too long fails, and everything it started is killed', () => {
    const t = setup({ loops: [def({ check: { command: 'sleep 30 & echo $! > child.pid; wait' } as CompiledLoop['check'] })] })
    const t0 = Date.now()
    const a = t.answer({}, { MASTERDECK_LOOP_TIMEOUT_S: '1' })
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(a.reason).toContain('check timed out after 1 s')
    expect(t.loops()[0].history[0]).toMatchObject({ passed: false })
    const child = Number(readFileSync(join(t.repo, 'child.pid'), 'utf8'))
    expect(() => process.kill(child, 0)).toThrow()
    // Nothing on stderr (no job-control notice for the session to show).
    const p = spawnSync(BASH, [t.script], {
      input: JSON.stringify({ session_id: SID, cwd: t.repo, last_assistant_message: 'x' }),
      cwd: t.repo,
      env: { ...process.env, MASTERDECK_LOOP_TIMEOUT_S: '1' },
    })
    expect(p.stderr.toString()).toBe('')
    expect(JSON.parse(p.stdout.toString()).reason).toContain('iteration 2/10')
  })

  it('history keeps the last 50; a tail is at most 40 lines and 4 KB', () => {
    const old = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, hash: `h${i}` }))
    const t = setup({
      loops: [def({ check: { command: 'i=0; while [ $i -lt 100 ]; do i=$((i+1)); echo "line $i $(printf %0200d 0)"; done; exit 1' } as CompiledLoop['check'], limits: { iterations: 100 } as CompiledLoop['limits'] })],
      file: { loops: [entry({ iteration: 50, history: old })] },
    })
    t.run()
    const [l] = t.loops()
    expect(l.history).toHaveLength(50)
    expect(l.history[0].n).toBe(2)
    expect(l.history[49].n).toBe(51)
    expect(l.lastCheck.tail.length).toBeLessThanOrEqual(4096)
    expect(l.lastCheck.tail.split('\n').length).toBeLessThanOrEqual(41)
    expect(l.lastCheck.tail).toContain('line 100')
  })

  it('ignores stop_hook_active', () => {
    const a = setup().answer({ stop_hook_active: true })
    const b = setup().answer({ stop_hook_active: false })
    expect(a.reason.replace(/\/loop-home-[^/]+\//, '/')).toBe(b.reason.replace(/\/loop-home-[^/]+\//, '/'))
  })

  it("runs the check in the session's folder", () => {
    const t = setup({ loops: [def({ check: { command: 'test -f marker' } as CompiledLoop['check'] })] })
    expect(t.answer().decision).toBe('block')
    writeFileSync(join(t.repo, 'marker'), '')
    expect(t.run()).toBe('')
  })

  it('a closed loop opens the next one: its file entry and an empty progress file', () => {
    const t = setup({
      loops: [
        def({ check: { command: 'true' } as CompiledLoop['check'], met: '2.met.1. Repeat until the loop "B" is done.' }),
        def({ id: 'lb', name: 'B', check: { command: 'false' } as CompiledLoop['check'], after: { loop: 'lp', via: 'met' } }),
      ],
    })
    const a = t.answer()
    expect(a.reason).toContain('Then the loop "B" starts')
    expect(t.loops().map((l: { id: string; state: string }) => [l.id, l.state])).toEqual([['lp', 'met'], ['lb', 'open']])
    expect(readFileSync(join(t.home, 'workflows', 'loops', `${SID}-lb.md`), 'utf8')).toBe('')
    // The next turn end checks B.
    expect(t.answer().reason).toContain('↻ Loop "B": iteration 1/10.')
  })

  it('a workflow file it cannot read leaves the loop alone; one without the loop stops it', () => {
    const wf = (t: ReturnType<typeof setup>) => join(t.home, 'workflows', 'sessions', `${SID}.json`)
    // No session workflow and no default one.
    const gone = setup()
    rmSync(wf(gone))
    const before = readFileSync(gone.L, 'utf8')
    expect(gone.run()).toBe('')
    expect(readFileSync(gone.L, 'utf8')).toBe(before)
    expect(gone.runs()).toEqual([])
    // Not JSON (a file being written, a broken edit).
    const bad = setup()
    writeFileSync(wf(bad), '{"steps": [')
    expect(bad.run()).toBe('')
    expect(bad.loops()[0]).toMatchObject({ state: 'open', iteration: 0 })
    // Read, and the loop is not in it: nothing could ever end it, so it ends.
    const other = setup()
    writeFileSync(wf(other), JSON.stringify({ steps: [{ id: STEP, trigger: 'after-push', note: 'n' }] }))
    expect(other.run()).toBe('')
    expect(other.loops()[0]).toMatchObject({ state: 'stopped', reason: 'the workflow no longer has this loop' })
  })

  it('a Stop loop or Run 5 more during the check is kept: the hook writes nothing', async () => {
    for (const change of [
      (l: Record<string, unknown>) => ({ ...l, state: 'stopped', reason: 'stopped by you', endedAt: 1 }),
      (l: Record<string, unknown>) => ({ ...l, startedAt: (l.startedAt as number) + 1, extra: 5 }),
    ]) {
      const t = setup({ loops: [def({ check: { command: 'sleep 2; exit 1' } as CompiledLoop['check'] })] })
      const p = spawn(BASH, [t.script], { cwd: t.repo })
      let out = ''
      p.stdout.on('data', (b) => (out += b))
      p.stdin.end(JSON.stringify({ session_id: SID, cwd: t.repo, last_assistant_message: 'x' }))
      await new Promise((r) => setTimeout(r, 700))
      const changed = { loops: [change(t.loops()[0])] }
      writeFileSync(t.L, JSON.stringify(changed))
      const code = await new Promise((r) => p.on('close', r))
      expect(code).toBe(0)
      expect(out).toBe('')
      expect(JSON.parse(readFileSync(t.L, 'utf8'))).toEqual(changed)
      expect(t.runs()).toEqual([])
      expect(readdirSync(join(t.home, 'workflows', 'loops')).filter((n) => n.endsWith('.tmp'))).toEqual([])
    }
  })

  it('writes only under workflows/loops and runs.jsonl', () => {
    const t = setup({ loops: [def({ check: { command: 'echo x; exit 1' } as CompiledLoop['check'] })] })
    const tree = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? tree(join(dir, d.name)).map((p) => `${d.name}/${p}`) : [d.name],
      )
    const before = tree(t.home)
    t.run({}, { MASTERDECK_LOOP_TIMEOUT_S: '5' })
    const after = tree(t.home)
    expect(after.filter((p) => !before.includes(p))).toEqual(['workflows/runs.jsonl'])
    expect(before.filter((p) => !after.includes(p))).toEqual([])
  })
})

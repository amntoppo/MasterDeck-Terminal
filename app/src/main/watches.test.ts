import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canDeliver, enqueue, eventMessage, handedOver, parseWatchRequest, QUEUE_MAX } from '@shared/watches'
import type { Session } from '@shared/types'
import { DeckHooks } from './deckHooks'
import { installDeckHooks } from './hooks'
import { Watches } from './watches'

const SID = '4d1bc2b2-2edb-4304-91fd-6633dc9bd935'
const call = (input: object) => ({ session_id: SID, cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: input })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await wait(50)
}

describe('watch helpers', () => {
  it('reads a command Monitor call and nothing else', () => {
    const r = parseWatchRequest(JSON.stringify({ id: '1-2-3', at: 5, data: call({ command: 'echo hi', description: 'PR comments', timeout_ms: 1800000 }) }))
    expect(r).toEqual({ id: '1-2-3', at: 5, sessionId: SID, cwd: '/tmp', command: 'echo hi', description: 'PR comments' })
    expect(parseWatchRequest(JSON.stringify({ id: '1', data: call({ ws: { url: 'wss://x' }, description: 'ws' }) }))).toBeNull()
    expect(parseWatchRequest(JSON.stringify({ id: '1', data: { ...call({ command: 'x' }), tool_name: 'Bash' } }))).toBeNull()
    expect(parseWatchRequest('not json')).toBeNull()
  })
  it('denies the call with why, and says so once more on a re-arm', () => {
    const a = handedOver('PR comments', false) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
    expect(a.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(a.hookSpecificOutput.permissionDecisionReason).toMatch(/no time limit.*do not re-arm/)
    expect(JSON.stringify(handedOver('x', true))).toMatch(/already running/)
  })
  it('groups lines by monitor and keeps the newest', () => {
    expect(eventMessage([{ description: 'a', lines: ['1', '2'] }, { description: 'b', lines: [] }])).toBe('[MasterDeck monitor: a]\n1\n2')
    const q: string[] = []
    expect(enqueue(q, Array.from({ length: QUEUE_MAX + 5 }, (_, i) => `${i}`))).toBe(5)
    expect(q[0]).toBe('5')
  })
  it('delivers only once the turn is over', () => {
    expect(canDeliver({ state: 'idle' })).toBe(true)
    expect(canDeliver({ state: 'working' })).toBe(false)
    expect(canDeliver({ state: 'working', waitingOn: 'monitor: x' })).toBe(true)
    expect(canDeliver({ state: 'needs-input' })).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('monitors run by MasterDeck', () => {
  it('the hook hands a Monitor call over only when the setting says MasterDeck', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-'))
    const d = new DeckHooks(home)
    d.setup()
    const run = (answer: (id: string) => object | null) =>
      new Promise<string>((resolve) => {
        const p = spawn(d.script, ['MonitorCall'])
        let out = ''
        p.stdout.on('data', (b) => (out += b))
        p.on('exit', () => resolve(out))
        p.stdin.end(JSON.stringify(call({ command: 'echo hi', description: 'x' })))
        const tick = setInterval(() => {
          for (const r of d.watchRequests()) {
            clearInterval(tick)
            d.answerWatch(r.id, answer(r.id))
          }
        }, 50)
        p.on('exit', () => clearInterval(tick))
      })
    // Setting on Claude Code: the hook returns at once, the call runs as usual.
    d.setMonitorsBy('claude')
    expect(await run(() => handedOver('x', false))).toBe('')
    d.setMonitorsBy('masterdeck')
    expect(JSON.parse(await run(() => handedOver('x', false))).hookSpecificOutput.permissionDecision).toBe('deny')
    // MasterDeck passes it back (e.g. not a command monitor): nothing printed.
    expect(await run(() => null)).toBe('')
    expect(d.watchRequests()).toEqual([])
   }, 30_000)
  it('is registered on PreToolUse for Monitor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-'))
    const p = join(dir, 'settings.json')
    require('node:fs').writeFileSync(p, '{}')
    installDeckHooks(p, dir, '/h/deck/hook.sh')
    const s = JSON.parse(require('node:fs').readFileSync(p, 'utf8'))
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Monitor', hooks: [{ type: 'command', command: '"/h/deck/hook.sh" MonitorCall', timeout: 15 }] }])
    expect(installDeckHooks(p, dir, '/h/deck/hook.sh').message).toBe('already installed')
  })
  it('runs the script with no time limit and sends what it prints once the turn is over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-'))
    const sent: string[] = []
    let session = { key: 'k', sessionId: SID, name: 'n', state: 'working' } as unknown as Session
    const w = new Watches(join(dir, 'watches.json'), () => process.env, async (_s, text) => (sent.push(text), { ok: true, message: 'sent' }), () => {})
    const req = { id: 'a1', at: 0, sessionId: SID, cwd: dir, command: 'echo one; echo two; sleep 0.3; echo three', description: 'test monitor' }
    expect(w.add(req)).toEqual({ already: false })
    expect(w.add({ ...req, id: 'a2' })).toEqual({ already: true })
    await until(() => w.info()[0]?.events === 2)
    w.deliver([session])
    expect(sent).toEqual([])
    expect(w.info()[0]).toMatchObject({ description: 'test monitor', events: 2, queued: 2 })
    session = { ...session, state: 'idle' } as Session
    w.deliver([session])
    await until(() => sent.length === 1)
    expect(sent[0]).toBe('[MasterDeck monitor: test monitor]\none\ntwo')
    await until(() => w.info().length === 0)
    w.deliver([session])
    await until(() => sent.length === 2)
    expect(sent[1]).toMatch(/^\[MasterDeck monitor: test monitor\]\nthree\n\(monitor ended: its script exited \(code 0\)\)$/)
    await until(() => sent.length === 2)
    expect(w.info()).toEqual([])
  })
  it('ends a script left running by a killed app before starting it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-'))
    const file = join(dir, 'watches.json')
    const a = new Watches(file, () => process.env, async () => ({ ok: true, message: '' }), () => {})
    a.add({ id: 'c1', at: 0, sessionId: SID, cwd: dir, command: 'while true; do sleep 1; done # leftover-test', description: 'left' })
    const pid = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))[0].pid as number
    expect(pid).toBeGreaterThan(1)
    // No killAll: as if the app was killed.
    const b = new Watches(file, () => process.env, async () => ({ ok: true, message: '' }), () => {})
    b.load()
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await until(() => !alive())
    expect(alive()).toBe(false)
    expect(b.info()).toHaveLength(1)
    b.killAll()
  })
  it('starts saved monitors again at launch, and stops one on request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-'))
    const file = join(dir, 'watches.json')
    const a = new Watches(file, () => process.env, async () => ({ ok: true, message: '' }), () => {})
    a.add({ id: 'b1', at: 0, sessionId: SID, cwd: dir, command: 'while true; do sleep 1; done', description: 'forever' })
    a.killAll()
    const sent: string[] = []
    const b = new Watches(file, () => process.env, async (_s, t) => (sent.push(t), { ok: true, message: '' }), () => {})
    b.load()
    expect(b.info().map((x) => x.description)).toEqual(['forever'])
    expect(b.stop('b1')).toBe(true)
    b.deliver([{ key: 'k', sessionId: SID, name: 'n', state: 'idle' } as unknown as Session])
    await wait(20)
    expect(sent).toEqual(['[MasterDeck monitor: forever]\n(monitor stopped from MasterDeck)'])
    expect(b.info()).toEqual([])
  })
})

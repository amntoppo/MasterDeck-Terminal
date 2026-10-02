import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Command } from '@shared/remote'
import type { AppState, Session } from '@shared/types'
import { RemoteCommands, type RemoteDeps } from './remoteCommands'

const ok = (message = 'ok') => ({ ok: true, message })
function sess(key: string, state: Session['state'], extra: Partial<Session> = {}): Session {
  return { key, sessionId: `${key}-sid`, name: key, kind: 'background', bgId: key, pid: null, cwd: '/w', state, rawState: state, startedAt: 0, issue: null, ...extra }
}
function st(sessions: Session[], openIds: string[] = [], queueHook = true): AppState {
  const e = (id: string) => ({ item: { id, kind: 'question', priority: 1, sessionKey: 'a', ticket: null, title: '', body: '', actions: [], detail: { type: 'session' } }, state: 'open', firstSeen: 0, lastSeen: 0 })
  return { sessions, inbox: { open: openIds.map(e), snoozed: [], history: [] }, hooks: { ticket: true, pr: true, queue: queueHook } } as unknown as AppState
}
function deps(state: AppState | null, over: Partial<RemoteDeps> = {}): RemoteDeps {
  return {
    state: () => state,
    inboxAct: vi.fn(async () => ok('acted')),
    draftAssign: vi.fn(async (t) => ({ ok: true as const, draft: { issue: t.number, repo: t.repo, name: 'app-142', cwd: '/w/app', prompt: 'Work on #142', summary: '', title: 'T', url: 'u', proposalId: null } })),
    startAssign: vi.fn(async () => ok('started')),
    stopBg: vi.fn(async () => ok('stopped')),
    resume: vi.fn(async () => ok('resumed')),
    sendNow: vi.fn(async () => ok('sent')),
    queueEdit: vi.fn(() => ok('queued')),
    setManualStatus: vi.fn(() => ok('status set')),
    ...over,
  }
}
const file = () => join(mkdtempSync(join(tmpdir(), 'rc-')), 'remote-done.json')
let n = 0
const cmd = (c: Record<string, unknown>): Command => ({ id: `c${++n}`, createdAt: 0, by: 'client:test', ...c }) as Command

describe('RemoteCommands', () => {
  it('inbox commands go through the inbox with who did it', async () => {
    const d = deps(st([sess('a', 'idle')], ['q1']))
    const rc = new RemoteCommands(d, file())
    expect(await rc.run(cmd({ type: 'inbox.act', itemId: 'q1', args: { action: 'option', key: 'B', text: 'Yes' } }))).toMatchObject({ ok: true })
    expect(d.inboxAct).toHaveBeenCalledWith('q1', 'option', { key: 'B', text: 'Yes', by: 'remote:client:test' })
    await rc.run(cmd({ type: 'inbox.snooze', itemId: 'q1', args: { minutes: 30 } }))
    expect(d.inboxAct).toHaveBeenLastCalledWith('q1', 'snooze', { minutes: 30, by: 'remote:client:test' })
    await rc.run(cmd({ type: 'inbox.dismiss', itemId: 'q1', args: {} }))
    expect(d.inboxAct).toHaveBeenLastCalledWith('q1', 'dismiss', { by: 'remote:client:test' })
  })

  it('a closed item is stale and nothing runs', async () => {
    const d = deps(st([sess('a', 'idle')], []))
    const r = await new RemoteCommands(d, file()).run(cmd({ type: 'inbox.act', itemId: 'q1', args: { action: 'reply', text: 'x' } }))
    expect(r).toEqual({ ok: false, status: 'stale', message: 'that is no longer waiting on you' })
    expect(d.inboxAct).not.toHaveBeenCalled()
  })

  it('session.start drafts like the board, then starts; a prompt replaces the draft', async () => {
    const d = deps(st([]))
    const rc = new RemoteCommands(d, file())
    await rc.run(cmd({ type: 'session.start', args: { issue: 142, repo: 'o/app', model: 'opus' } }))
    expect(d.draftAssign).toHaveBeenCalledWith({ repo: 'o/app', number: 142 })
    expect(d.startAssign).toHaveBeenLastCalledWith({ issue: 142, repo: 'o/app', name: 'app-142', cwd: '/w/app', prompt: 'Work on #142', proposalId: null, edited: false, approved: false, model: 'opus' })
    await rc.run(cmd({ type: 'session.start', args: { issue: 142, prompt: 'Only read the code' } }))
    expect(d.startAssign).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Only read the code', edited: true }))
  })

  it('session.start reports a failed draft', async () => {
    const d = deps(st([]), { draftAssign: vi.fn(async () => ({ ok: false as const, message: 'no workspace for o/x' })) })
    expect(await new RemoteCommands(d, file()).run(cmd({ type: 'session.start', args: { issue: 1, repo: 'o/x' } }))).toEqual({ ok: false, message: 'no workspace for o/x' })
    expect(d.startAssign).not.toHaveBeenCalled()
  })

  it('stop: background sessions only, by bgId', async () => {
    const d = deps(st([sess('a', 'working'), sess('i', 'working', { kind: 'interactive', bgId: null })]))
    const rc = new RemoteCommands(d, file())
    expect(await rc.run(cmd({ type: 'session.stop', args: { key: 'a' } }))).toMatchObject({ ok: true })
    expect(d.stopBg).toHaveBeenCalledWith('a')
    expect(await rc.run(cmd({ type: 'session.stop', args: { key: 'i' } }))).toEqual({ ok: false, message: 'i runs in another terminal; only background sessions can be stopped remotely' })
  })

  it('resume: only an ended or suspended session', async () => {
    const d = deps(st([sess('a', 'done'), sess('b', 'idle')]))
    const rc = new RemoteCommands(d, file())
    await rc.run(cmd({ type: 'session.resume', args: { key: 'a' } }))
    expect(d.resume).toHaveBeenCalledWith('a-sid', 'a', '/w')
    expect(await rc.run(cmd({ type: 'session.resume', args: { key: 'b' } }))).toEqual({ ok: false, message: 'b is idle, not stopped' })
  })

  it('send now types at once; via queue waits for a busy session and sends to an idle one', async () => {
    const d = deps(st([sess('busy', 'working'), sess('free', 'idle')]))
    const rc = new RemoteCommands(d, file())
    await rc.run(cmd({ type: 'session.send', args: { key: 'busy', text: 'hi', via: 'now' } }))
    expect(d.sendNow).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'busy' }), 'hi')
    await rc.run(cmd({ type: 'session.send', args: { key: 'busy', text: 'later', via: 'queue' } }))
    expect(d.queueEdit).toHaveBeenLastCalledWith('busy-sid', { op: 'add', text: 'later' })
    await rc.run(cmd({ type: 'session.send', args: { key: 'free', text: 'go', via: 'queue' } }))
    expect(d.sendNow).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'free' }), 'go')
  })

  it('via queue without the queue hook fails clearly (Review Focus 3)', async () => {
    const d = deps(st([sess('busy', 'working')], [], false))
    expect(await new RemoteCommands(d, file()).run(cmd({ type: 'session.send', args: { key: 'busy', text: 'x', via: 'queue' } }))).toEqual({
      ok: false,
      message: 'the queue hook is not installed (Settings → Hooks & skills), so a queued message would never be sent; send it now instead',
    })
    expect(d.queueEdit).not.toHaveBeenCalled()
  })

  it('an unknown session fails and nothing is typed (Review Focus 2)', async () => {
    const d = deps(st([]))
    expect(await new RemoteCommands(d, file()).run(cmd({ type: 'session.send', args: { key: 'gone', text: 'x', via: 'now' } }))).toEqual({ ok: false, message: 'session not found' })
    expect(d.sendNow).not.toHaveBeenCalled()
  })

  it('queue.edit and setStatus', async () => {
    const d = deps(st([sess('a', 'idle')]))
    const rc = new RemoteCommands(d, file())
    await rc.run(cmd({ type: 'queue.edit', args: { key: 'a', edit: { op: 'clear' } } }))
    expect(d.queueEdit).toHaveBeenLastCalledWith('a-sid', { op: 'clear' })
    await rc.run(cmd({ type: 'session.setStatus', args: { key: 'a', status: null } }))
    expect(d.setManualStatus).toHaveBeenCalledWith('a', null)
  })

  it('unknown types and a loading app', async () => {
    expect(await new RemoteCommands(deps(st([])), file()).run(cmd({ type: 'shell.run', args: {} }))).toEqual({ ok: false, message: 'bad command' })
    expect(await new RemoteCommands(deps(null), file()).run(cmd({ type: 'session.stop', args: { key: 'a' } }))).toEqual({ ok: false, transient: true, message: 'MasterDeck is still loading; try again' })
  })

  it('runs a command id once, across restarts (Review Focus 1)', async () => {
    const f = file()
    const d = deps(st([sess('a', 'idle')]))
    const c = cmd({ type: 'session.send', args: { key: 'a', text: 'once', via: 'now' } })
    const first = await new RemoteCommands(d, f).run(c)
    expect(first).toMatchObject({ ok: true })
    // A new instance (the app relaunched) reads the stored outcome instead of running it again.
    expect(await new RemoteCommands(d, f).run(c)).toEqual(first)
    expect(d.sendNow).toHaveBeenCalledTimes(1)
  })

  it('the same id twice at once runs once', async () => {
    const d = deps(st([sess('a', 'idle')]))
    const rc = new RemoteCommands(d, file())
    const c = cmd({ type: 'session.stop', args: { key: 'a' } })
    const [x, y] = await Promise.all([rc.run(c), rc.run(c)])
    expect(x).toEqual(y)
    expect(d.stopBg).toHaveBeenCalledTimes(1)
  })

  it('a handler that throws is a failure, not a crash', async () => {
    const d = deps(st([sess('a', 'idle')]), { sendNow: vi.fn(async () => { throw new Error('pty gone') }) })
    expect(await new RemoteCommands(d, file()).run(cmd({ type: 'session.send', args: { key: 'a', text: 'x', via: 'now' } }))).toEqual({ ok: false, message: 'failed: Error: pty gone' })
  })
})

describe('RemoteCommands fix round 1', () => {
  const MSG = 'master-agent cannot be controlled remotely'
  it('master-agent is protected from stop, send, resume, queue.edit and setStatus', async () => {
    const d = deps(st([sess('m', 'working', { name: 'master-agent' })]))
    const rc = new RemoteCommands(d, file())
    expect(await rc.run(cmd({ type: 'session.stop', args: { key: 'm' } }))).toEqual({ ok: false, message: MSG })
    expect(await rc.run(cmd({ type: 'session.send', args: { key: 'm', text: 'x', via: 'now' } }))).toEqual({ ok: false, message: MSG })
    expect(await rc.run(cmd({ type: 'session.resume', args: { key: 'm' } }))).toEqual({ ok: false, message: MSG })
    expect(await rc.run(cmd({ type: 'queue.edit', args: { key: 'm', edit: { op: 'clear' } } }))).toEqual({ ok: false, message: MSG })
    expect(await rc.run(cmd({ type: 'session.setStatus', args: { key: 'm', status: null } }))).toEqual({ ok: false, message: MSG })
    expect(d.stopBg).not.toHaveBeenCalled()
    expect(d.sendNow).not.toHaveBeenCalled()
    expect(d.resume).not.toHaveBeenCalled()
    expect(d.queueEdit).not.toHaveBeenCalled()
    expect(d.setManualStatus).not.toHaveBeenCalled()
  })

  it('send into needs-input refuses for both via values', async () => {
    const d = deps(st([sess('p', 'needs-input')]))
    const rc = new RemoteCommands(d, file())
    const m = { ok: false, message: 'p is waiting on a prompt; answer it from Needs you instead' }
    expect(await rc.run(cmd({ type: 'session.send', args: { key: 'p', text: 'x', via: 'now' } }))).toEqual(m)
    expect(await rc.run(cmd({ type: 'session.send', args: { key: 'p', text: 'x', via: 'queue' } }))).toEqual(m)
    expect(d.sendNow).not.toHaveBeenCalled()
    expect(d.queueEdit).not.toHaveBeenCalled()
  })

  it('send to a suspended session says resume first; to a done one says not found', async () => {
    const d = deps(st([sess('s', 'suspended'), sess('x', 'done')]))
    const rc = new RemoteCommands(d, file())
    expect(await rc.run(cmd({ type: 'session.send', args: { key: 's', text: 'x', via: 'now' } }))).toEqual({ ok: false, message: 's is suspended; resume it first' })
    expect(await rc.run(cmd({ type: 'session.send', args: { key: 'x', text: 'x', via: 'now' } }))).toEqual({ ok: false, message: 'session not found' })
    expect(d.sendNow).not.toHaveBeenCalled()
  })

  it('queue.edit returns only ok and message', async () => {
    const d = deps(st([sess('a', 'idle')]), { queueEdit: vi.fn(() => ({ ok: true, message: 'q', items: [1, 2, 3] }) as never) })
    expect(await new RemoteCommands(d, file()).run(cmd({ type: 'queue.edit', args: { key: 'a', edit: { op: 'clear' } } }))).toEqual({ ok: true, message: 'q' })
  })

  it('the loading outcome is not remembered, so a redelivery runs', async () => {
    let state: AppState | null = null
    const d = deps(null, { state: () => state })
    const rc = new RemoteCommands(d, file())
    const c = cmd({ type: 'session.stop', args: { key: 'a' } })
    expect(await rc.run(c)).toEqual({ ok: false, transient: true, message: 'MasterDeck is still loading; try again' })
    state = st([sess('a', 'working')])
    expect(await rc.run(c)).toMatchObject({ ok: true })
    expect(d.stopBg).toHaveBeenCalledTimes(1)
  })

  it('validates every command against the wire contract before running it, and remembers the refusal', async () => {
    const f = file()
    const d = deps(st([sess('a', 'idle')], ['q1']))
    const rc = new RemoteCommands(d, f)
    const slash = cmd({ type: 'session.send', args: { key: 'a', text: '/clear', via: 'now' } })
    expect(await rc.run(slash)).toEqual({ ok: false, message: 'bad command' })
    expect(await rc.run(cmd({ type: 'nope.run', args: {} }))).toEqual({ ok: false, message: 'bad command' })
    expect(await rc.run(cmd({ type: 'inbox.act', itemId: 'q1', args: { action: 'option', key: '!touch /tmp/x;#', text: 'x' } }))).toEqual({ ok: false, message: 'bad command' })
    expect(d.sendNow).not.toHaveBeenCalled()
    expect(d.inboxAct).not.toHaveBeenCalled()
    // persisted like other final outcomes: a fresh instance returns it without running
    expect(await new RemoteCommands(deps(st([sess('a', 'idle')])), f).run(slash)).toEqual({ ok: false, message: 'bad command' })
  })

  it('setStatus needs a live session with that key', async () => {
    const d = deps(st([sess('a', 'idle'), sess('old', 'done')]))
    const rc = new RemoteCommands(d, file())
    expect(await rc.run(cmd({ type: 'session.setStatus', args: { key: 'gone', status: 'x' } }))).toEqual({ ok: false, message: 'session not found' })
    expect(await rc.run(cmd({ type: 'session.setStatus', args: { key: 'old', status: 'x' } }))).toEqual({ ok: false, message: 'session not found' })
    expect(d.setManualStatus).not.toHaveBeenCalled()
    expect(await rc.run(cmd({ type: 'session.setStatus', args: { key: 'a', status: 'x' } }))).toMatchObject({ ok: true })
  })
})

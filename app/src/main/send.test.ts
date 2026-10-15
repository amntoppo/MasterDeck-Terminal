import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'

// A red test must not be able to start a process: the hidden attach is a fake.
const spawned: { writes: string[]; screen: string }[] = []
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const p = { writes: [] as string[], screen: attachScreen }
    spawned.push(p)
    let onData: (d: string) => void = () => {}
    setTimeout(() => onData(p.screen), 20)
    return {
      onData: (cb: (d: string) => void) => (onData = cb),
      onExit: () => {},
      write: (d: string) => p.writes.push(d),
      kill: () => {},
    }
  }),
}))

import { HeldStore } from './held'
import type { MasterCli } from './masterCli'
import type { ModDeliverResult } from './modDeliver'
import type { PtyManager } from './ptys'
import { Sender, TYPING_MS } from './send'

let attachScreen = ''

/** A Claude Code screen: its prompt box with `draft` typed (''; the dim placeholder), or no box (null). */
function screen(draft: string | null): string {
  // As Claude Code draws it: a no-break space after the glyph, the placeholder dim right after it.
  const inner = draft === null ? '' : draft ? `❯ ${draft}` : '❯ \x1b[2mTry "write a test for acme"\x1b[22m'
  const box = draft === null ? '  Esc to cancel' : `${'─'.repeat(40)} acme-fix ─\r\n${inner}\r\n${'─'.repeat(60)}`
  return `\x1b[2J\x1b[H⏺ Done.\r\n\r\n${box}\r\n  ⏵⏵ auto mode on\r\n`
}

const sess = (p: Partial<Session> = {}): Session => ({
  key: 'k1', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'fix-12', kind: 'background', bgId: 'abcd1234',
  pid: 1, cwd: '/', state: 'idle', rawState: 'idle', startedAt: 1, issue: 12, ...p,
})

/** A pane with `raw` on screen; `typedAt` the user's last key; `onPaste` runs as MasterDeck's paste goes in. */
function pane(raw: string, o: { alive?: boolean; typedAt?: number; onPaste?: () => void } = {}) {
  const writes: string[] = []
  const st = { raw, typedAt: o.typedAt ?? 0 }
  const ptys = {
    isAlive: () => o.alive ?? true,
    tail: () => st.raw,
    screen: () => ({ raw: st.raw, cols: 80, rows: 12 }),
    inputAt: () => st.typedAt,
    write: (_id: string, d: string) => {
      writes.push(d)
      if (d.startsWith('\x1b[200~')) o.onPaste?.()
    },
  } as unknown as PtyManager
  return { ptys, writes, st }
}

const cli = (say = vi.fn(async () => ({ ok: true, message: 'ok' }))) => ({ say }) as unknown as MasterCli

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-send-'))
  spawned.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function sender(ptys: PtyManager, s: Session, o: { mod?: (text: string) => ModDeliverResult; say?: ReturnType<typeof vi.fn> } = {}) {
  const held = new HeldStore(join(dir, 'held.json'))
  const delivered: string[] = []
  const snd = new Sender(ptys, cli(o.say), () => ({}), () => 'claude', (k) => (k === s.key ? s : undefined), {
    held,
    modTakes: () => !!o.mod,
    mod: o.mod ? { deliver: async (_sid, text) => (delivered.push(text), o.mod!(text)) } : undefined,
  })
  return { snd, held, delivered }
}

const PASTE = (t: string) => `\x1b[200~${t}\x1b[201~`

describe('Sender: a message never mixes with what the user is typing (#123)', () => {
  it('open pane: an empty prompt gets the message, pasted then Enter', async () => {
    const s = sess()
    const p = pane(screen(''))
    const r = await sender(p.ptys, s).snd.send(s, 'PR #3 has a review', false)
    expect(r).toMatchObject({ ok: true })
    expect(p.writes).toEqual([PASTE('PR #3 has a review'), '\r'])
  })

  it('open pane: text in the prompt holds the message and types nothing', async () => {
    const s = sess()
    const p = pane(screen('refactor the login'))
    const { snd, held } = sender(p.ptys, s)
    const r = await snd.send(s, 'PR #3 has a review', false, { from: 'PR watch' })
    expect(r).toMatchObject({ ok: true, held: true })
    expect(p.writes).toEqual([])
    expect(held.list()).toMatchObject([{ key: 'k1', text: 'PR #3 has a review', from: 'PR watch', reason: 'draft' }])
  })

  it('open pane: a key typed in the last few seconds holds it, even with nothing on screen yet', async () => {
    const s = sess()
    const p = pane(screen(''), { typedAt: Date.now() - 500 })
    const { snd, held } = sender(p.ptys, s)
    expect(await snd.send(s, 'hello', false)).toMatchObject({ held: true })
    expect(held.list()[0].reason).toBe('typing')
    expect(p.writes).toEqual([])
  })

  it('open pane: a key typed while the paste goes in keeps Enter back', async () => {
    const s = sess()
    const p = pane(screen(''), { onPaste: () => (p.st.typedAt = Date.now()) })
    const r = await sender(p.ptys, s).snd.send(s, 'hello', false)
    // ok: it is in the prompt for the user to send; a caller that retried would put it there twice.
    expect(r).toMatchObject({ ok: true, typedNotSent: true })
    expect(p.writes).toEqual([PASTE('hello')])
  })

  it('a message sent while another is going in waits behind it instead of being refused', async () => {
    const s = sess()
    const p = pane(screen(''))
    let release: (r: ModDeliverResult) => void = () => {}
    const { snd, held } = sender(p.ptys, s, { mod: () => ({ kind: 'sent' }) })
    ;(snd as unknown as { d: { mod: unknown } }).d.mod = { deliver: () => new Promise<ModDeliverResult>((r) => (release = r)) }
    const first = snd.send(s, 'first', false)
    await new Promise((r) => setTimeout(r, 10))
    expect(await snd.send(s, 'second', false)).toMatchObject({ ok: true, held: true })
    expect(held.list()[0]).toMatchObject({ text: 'second', reason: 'sending' })
    // While the first is in flight the Stop hook gets nothing (it might be that very message).
    expect(snd.takeHeldFor(s.sessionId)).toBe(null)
    release({ kind: 'sent' })
    await first
    expect(snd.takeHeldFor(s.sessionId)).toMatchObject({ text: 'second' })
  })

  it('open pane: no prompt box on screen holds it; Send now types it then', async () => {
    const s = sess()
    const p = pane(screen(null))
    const { snd, held } = sender(p.ptys, s)
    expect(await snd.send(s, 'hello', false)).toMatchObject({ held: true })
    expect(held.list()[0].reason).toBe('unknown')
    const r = await snd.sendHeld(held.list()[0].id, false)
    expect(r).toMatchObject({ ok: true })
    expect(p.writes).toEqual([PASTE('hello'), '\r'])
    expect(held.list()).toEqual([])
  })

  it('Send now never types over a draft', async () => {
    const s = sess()
    const p = pane(screen('half a thought'))
    const { snd, held } = sender(p.ptys, s)
    await snd.send(s, 'hello', false)
    const r = await snd.sendHeld(held.list()[0].id, false)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/prompt has text/)
    expect(p.writes).toEqual([])
    expect(held.list()).toHaveLength(1)
  })

  it('a later message waits behind a held one; both go in order once the prompt is empty', async () => {
    const s = sess()
    const p = pane(screen('my draft'))
    const { snd, held } = sender(p.ptys, s)
    await snd.send(s, 'first', false)
    p.st.raw = screen('')
    expect(await snd.send(s, 'second', false)).toMatchObject({ held: true })
    expect(p.writes).toEqual([])
    await snd.pumpHeld([s], false)
    await snd.pumpHeld([s], false)
    expect(p.writes).toEqual([PASTE('first'), '\r', PASTE('second'), '\r'])
    expect(held.list()).toEqual([])
  })

  it('a held message waits while the draft is there and goes when it is gone', async () => {
    const s = sess()
    const p = pane(screen('my draft'))
    const { snd, held } = sender(p.ptys, s)
    await snd.send(s, 'hello', false)
    await snd.pumpHeld([s], false)
    expect(p.writes).toEqual([])
    p.st.raw = screen('')
    p.st.typedAt = Date.now() - TYPING_MS - 1
    await snd.pumpHeld([s], false)
    expect(p.writes).toEqual([PASTE('hello'), '\r'])
    expect(held.list()).toEqual([])
  })

  it('messages of a session that ended are dropped', async () => {
    const s = sess()
    const p = pane(screen('my draft'))
    const { snd, held } = sender(p.ptys, s)
    await snd.send(s, 'hello', false)
    await snd.pumpHeld([{ ...s, state: 'done' }], false)
    expect(held.list()).toEqual([])
    await snd.send(s, 'again', false)
    await snd.pumpHeld([], false)
    expect(held.list()).toEqual([])
  })

  it('the core mod gets it first and nothing is typed, draft or not', async () => {
    const s = sess()
    const p = pane(screen('refactor the login'))
    const { snd, held, delivered } = sender(p.ptys, s, { mod: () => ({ kind: 'sent' }) })
    expect(await snd.send(s, 'PR #3 has a review', false)).toMatchObject({ ok: true })
    expect(delivered).toEqual(['PR #3 has a review'])
    expect(p.writes).toEqual([])
    expect(held.list()).toEqual([])
  })

  it('a mod that does not take it in time leaves it to the guarded typing', async () => {
    const s = sess()
    const p = pane(screen('refactor the login'))
    const { snd, held } = sender(p.ptys, s, { mod: () => ({ kind: 'unclaimed' }) })
    expect(await snd.send(s, 'hello', false)).toMatchObject({ held: true })
    expect(p.writes).toEqual([])
    expect(held.list()).toHaveLength(1)
  })

  it('commands are never handed to the mod (it would send them as words)', async () => {
    const s = sess()
    const p = pane(screen(''))
    const { snd, delivered } = sender(p.ptys, s, { mod: () => ({ kind: 'sent' }) })
    await snd.send(s, '/reload-plugins', false)
    expect(delivered).toEqual([])
    expect(p.writes).toEqual([PASTE('/reload-plugins'), '\r'])
  })

  it('hidden attach: a draft on its screen holds the message and nothing is typed', async () => {
    const s = sess()
    attachScreen = screen('refactor the login')
    const p = pane('', { alive: false })
    const { snd, held } = sender(p.ptys, s)
    expect(await snd.send(s, 'hello', false)).toMatchObject({ held: true })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].writes).toEqual([])
    expect(held.list()[0].reason).toBe('draft')
  })

  it('hidden attach: an empty prompt gets the message', async () => {
    const s = sess()
    attachScreen = screen('')
    const p = pane('', { alive: false })
    const r = await sender(p.ptys, s).snd.send(s, 'hello', false)
    expect(r).toMatchObject({ ok: true })
    expect(spawned[0].writes).toEqual([PASTE('hello'), '\r'])
  })

  it('master say --to: relayed by master-agent, never typed into any terminal', async () => {
    const s = sess({ kind: 'interactive', bgId: null })
    const p = pane(screen('refactor the login'), { alive: false })
    const say = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const r = await sender(p.ptys, s, { say }).snd.send(s, 'hello', true)
    expect(r).toMatchObject({ ok: true })
    expect(say).toHaveBeenCalledWith('fix-12', 'hello')
    expect(p.writes).toEqual([])
    expect(spawned).toHaveLength(0)
  })

  it('the Stop hook takes the first held message of the session whose turn ended', async () => {
    const s = sess()
    const p = pane(screen('my draft'))
    const { snd, held } = sender(p.ptys, s)
    await snd.send(s, 'one', false)
    await snd.send(s, 'two', false)
    expect(snd.heldSessionIds()).toEqual(new Set([s.sessionId]))
    const next = snd.takeHeldFor(s.sessionId)
    expect(next).toMatchObject({ text: 'one', left: 1 })
    snd.heldDelivered(next!.id)
    expect(held.list().map((m) => m.text)).toEqual(['two'])
    expect(snd.takeHeldFor('other')).toBe(null)
  })

  it('the Stop hook never hands over a command: as an answer it would be read as words', async () => {
    const s = sess()
    const p = pane(screen('my draft'))
    const { snd, held } = sender(p.ptys, s)
    await snd.send(s, '/compact', false)
    expect(held.list()).toHaveLength(1)
    expect(snd.takeHeldFor(s.sessionId)).toBe(null)
  })
})

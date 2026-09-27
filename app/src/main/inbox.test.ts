import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InboxItem } from '@shared/inbox'
import { Inbox, type InboxEvent } from './inbox'

const item = (id: string, o: Partial<InboxItem> = {}): InboxItem => ({
  id,
  kind: 'question',
  priority: 90,
  sessionKey: 's',
  ticket: null,
  title: 'T',
  body: 'B',
  actions: [{ type: 'reply', label: 'Reply' }],
  detail: { type: 'session' },
  ...o,
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  let now = 1_000_000
  const clock = { tick: (ms: number) => (now += ms) }
  const box = new Inbox(join(dir, 'inbox.json'), join(dir, 'events.jsonl'), () => now)
  const events: InboxEvent[] = []
  box.on('event', (e) => events.push(e))
  return { dir, box, events, clock, reopen: () => new Inbox(join(dir, 'inbox.json'), join(dir, 'events.jsonl'), () => now) }
}

describe('Inbox', () => {
  it('opens new items (quietly on the first build) and resolves gone ones with why', () => {
    const { box, events } = setup()
    box.update([item('a')], true)
    expect(events).toEqual([])
    box.update([item('a'), item('b', { kind: 'ci', priority: 70 })])
    expect(events.map((e) => [e.type, e.entry.item.id])).toEqual([['added', 'b']])
    box.update([item('a')])
    expect(events.at(-1)).toMatchObject({ type: 'resolved' })
    expect(box.view().history[0]).toMatchObject({ resolvedHow: 'CI no longer failing' })
    expect(box.view().open.map((e) => e.item.id)).toEqual(['a'])
  })

  it('resolves nothing while silent (the state is still loading)', () => {
    const { box } = setup()
    box.update([item('a')], true)
    box.update([], true)
    expect(box.view().open.map((e) => e.item.id)).toEqual(['a'])
    expect(box.view().history).toEqual([])
  })

  it('orders open items by priority', () => {
    const { box } = setup()
    box.update([item('low', { priority: 10 }), item('high', { priority: 100 })], true)
    expect(box.view().open.map((e) => e.item.id)).toEqual(['high', 'low'])
  })

  it('dismiss hides an item until it goes; the history says dismissed', async () => {
    const { box } = setup()
    box.update([item('a')], true)
    expect((await box.act('a', 'dismiss', {}, async () => ({ ok: true, message: '' }))).ok).toBe(true)
    box.update([item('a')])
    expect(box.view().open).toEqual([])
    box.update([])
    expect(box.view().history[0].resolvedHow).toBe('dismissed')
  })

  it('snooze hides until the time, wake brings it back', async () => {
    const { box, clock } = setup()
    box.update([item('a')], true)
    await box.act('a', 'snooze', { minutes: 30 }, async () => ({ ok: true, message: '' }))
    box.update([item('a')])
    expect(box.view().snoozed.map((e) => e.item.id)).toEqual(['a'])
    clock.tick(31 * 60_000)
    box.update([item('a')])
    expect(box.view().open.map((e) => e.item.id)).toEqual(['a'])
    await box.act('a', 'snooze', { minutes: 30 }, async () => ({ ok: true, message: '' }))
    await box.act('a', 'wake', {}, async () => ({ ok: true, message: '' }))
    expect(box.view().open).toHaveLength(1)
  })

  it('runs only actions the item has, only while open; records who did it and how it ended', async () => {
    const { box, events } = setup()
    box.update([item('a')], true)
    const calls: string[] = []
    const run = async (_i: InboxItem, type: string) => {
      calls.push(type)
      return { ok: true, message: 'replied' }
    }
    expect((await box.act('a', 'approve', {}, run)).ok).toBe(false)
    expect((await box.act('nope', 'reply', {}, run)).ok).toBe(false)
    expect(await box.act('a', 'reply', { text: 'x', by: 'phone' }, run)).toEqual({ ok: true, message: 'replied' })
    expect(calls).toEqual(['reply'])
    expect(events.at(-1)).toMatchObject({ type: 'action', action: 'reply', by: 'phone' })
    box.update([])
    expect(box.view().history[0].resolvedHow).toBe('replied (phone)')
  })

  it('is saved, and logs every event', async () => {
    const { box, reopen, dir } = setup()
    box.update([item('a'), item('b')], true)
    await box.act('b', 'dismiss', {}, async () => ({ ok: true, message: '' }))
    box.update([item('a')])
    box.flush()
    const again = reopen()
    expect(again.view().open.map((e) => e.item.id)).toEqual(['a'])
    expect(again.view().history.map((e) => e.item.id)).toEqual(['b'])
    const log = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(log.map((l) => l.type)).toEqual(['action', 'resolved'])
    expect(log[1]).toMatchObject({ id: 'b', how: 'dismissed' })
  })
})

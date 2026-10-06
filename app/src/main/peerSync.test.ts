import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PEER_SYNC_MIN_MS, PeerSync, type PeerSyncDeps } from './peerSync'
import { PeerStore } from './peers'
import type { Session } from '@shared/types'

const sess = (key: string, over: Partial<Session> = {}): Session => ({ key, sessionId: `${key}-sid`, name: key, kind: 'background', bgId: key, pid: 1, cwd: '/w', state: 'idle', rawState: 'idle', startedAt: 0, issue: null, ...over })

function rig(over: Partial<PeerSyncDeps> = {}) {
  let now = 1_000_000
  const store = new PeerStore(join(mkdtempSync(join(tmpdir(), 'ps-')), 'p.json'), () => now)
  store.load()
  const sessions = [sess('a'), sess('b'), sess('c')]
  const summaries: Record<string, { at: number; text: string }> = {}
  const deps: PeerSyncDeps = {
    store,
    sessions: () => sessions,
    facts: (k) => store.of(k).map((p) => ({ key: p, name: p, cwd: '/w', branch: null, ticket: null, state: 'idle', summary: summaries[p] ?? null })),
    summaryStale: vi.fn(() => true),
    makeSummary: vi.fn(async (k: string) => { summaries[k] = { at: now, text: `sum ${k} ${now}` }; return { ok: true as const, summary: { at: now } } }),
    setDelta: vi.fn(),
    clearDelta: vi.fn(),
    deltaPending: () => true,
    rewriteContext: vi.fn(),
    hooksLive: () => true,
    deliver: vi.fn(async () => ({ ok: true, message: 'sent' })),
    now: () => now,
    ...over,
  }
  const sync = new PeerSync(deps)
  return { sync, deps, store, sessions, summaries, tick: (ms: number) => (now += ms) }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('PeerSync', () => {
  it('does nothing on Stop for a session without peers', async () => {
    const r = rig()
    r.sync.onStop('a-sid')
    await flush()
    expect(r.deps.makeSummary).not.toHaveBeenCalled()
    expect(r.deps.setDelta).not.toHaveBeenCalled()
  })
  it('summarizes a linked session on Stop and writes a delta for each unseen peer', async () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.store.set('a', 'c', true)
    r.sync.onStop('a-sid')
    await flush()
    expect(r.deps.makeSummary).toHaveBeenCalledWith('a')
    expect(r.deps.setDelta).toHaveBeenCalledTimes(2)
    expect(r.deps.setDelta).toHaveBeenCalledWith('b-sid', expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ hookEventName: 'UserPromptSubmit' }) }))
    expect(r.deps.rewriteContext).toHaveBeenCalled()
    expect(r.store.seen('b', 'a')).toBe(r.summaries.a.at)
  })
  it('debounces: a second Stop within PEER_SYNC_MIN_MS makes no summary', async () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    r.tick(PEER_SYNC_MIN_MS - 1)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).toHaveBeenCalledTimes(1)
    r.tick(2)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).toHaveBeenCalledTimes(2)
  })
  it('skips when the summary is not stale', async () => {
    const r = rig({ summaryStale: () => false })
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).not.toHaveBeenCalled()
  })
  it('writes no second delta when the peer already saw that summary', async () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    r.sync.refreshAll(['a'])
    expect(r.deps.setDelta).toHaveBeenCalledTimes(1)
  })
  it('syncNow ignores the debounce and uses Sender when hooks are not live', async () => {
    const r = rig({ hooksLive: () => false })
    r.store.set('a', 'b', true)
    expect((await r.sync.syncNow('a')).ok).toBe(true)
    expect((await r.sync.syncNow('a')).ok).toBe(true)
    expect(r.deps.makeSummary).toHaveBeenCalledTimes(2)
    expect(r.deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ key: 'b' }), expect.stringContaining('Linked session a updated'))
    expect(r.deps.setDelta).not.toHaveBeenCalled()
  })
  it('syncNow refuses an unlinked or unknown session', async () => {
    const r = rig()
    expect((await r.sync.syncNow('a')).ok).toBe(false)
    expect((await r.sync.syncNow('zz')).ok).toBe(false)
  })
  it('auto off: Stop does nothing, syncNow still works', async () => {
    const r = rig({ auto: () => false })
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).not.toHaveBeenCalled()
    expect((await r.sync.syncNow('a')).ok).toBe(true)
  })
  it('unlinked clears the pending delta only of a session left without peers', () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.store.set('a', 'c', true)
    r.store.set('a', 'b', false)
    r.sync.unlinked(['a', 'b'])
    expect(r.deps.clearDelta).toHaveBeenCalledTimes(1)
    expect(r.deps.clearDelta).toHaveBeenCalledWith('b-sid')
  })
  it('composes one delta per target with every peer it has not seen', async () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.store.set('a', 'c', true)
    r.sync.onStop('b-sid'); await flush()
    r.tick(1000)
    r.sync.onStop('c-sid'); await flush()
    const toA = vi.mocked(r.deps.setDelta).mock.calls.filter(([sid]) => sid === 'a-sid')
    const last = toA[toA.length - 1][1] as { hookSpecificOutput: { additionalContext: string } }
    expect(last.hookSpecificOutput.additionalContext).toContain('Linked session b updated')
    expect(last.hookSpecificOutput.additionalContext).toContain('Linked session c updated')
    expect(r.store.seen('a', 'b')).toBe(r.summaries.b.at)
    expect(r.store.seen('a', 'c')).toBe(r.summaries.c.at)
  })
  it('syncNow waits for a summary in flight, then makes and delivers a fresh one', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let calls = 0
    const r = rig({ hooksLive: () => false })
    const base = r.deps.makeSummary
    r.deps.makeSummary = vi.fn(async (k: string) => {
      calls++
      if (calls === 1) await gate
      r.tick(10)
      return base(k)
    })
    r.store.set('a', 'b', true)
    const first = r.sync.syncNow('a')
    const second = r.sync.syncNow('a')
    release()
    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)
    expect(r.deps.makeSummary).toHaveBeenCalledTimes(2)
    expect(r.deps.deliver).toHaveBeenCalledTimes(2)
    expect(r.summaries.a.text).toBe('sum a 1000020')
    expect(r.deps.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'b' }), expect.stringContaining('sum a 1000020'))
  })
  it('one failing delivery does not stop the rest', async () => {
    const r = rig({ hooksLive: () => false, deliver: vi.fn(async (s: Session) => { if (s.key === 'b') throw new Error('boom'); return { ok: true, message: 'sent' } }) })
    r.store.set('a', 'b', true)
    r.store.set('a', 'c', true)
    expect((await r.sync.syncNow('a')).ok).toBe(true)
    expect(r.deps.deliver).toHaveBeenCalledTimes(2)
    expect(r.store.seen('b', 'a')).toBe(0)
    expect(r.store.seen('c', 'a')).toBe(r.summaries.a.at)
  })
  it('a delta already read is not repeated in the next one', async () => {
    const r = rig({ deltaPending: () => false })
    r.store.set('a', 'b', true)
    r.store.set('a', 'c', true)
    r.sync.onStop('b-sid'); await flush()
    r.tick(1000)
    r.sync.onStop('c-sid'); await flush()
    const toA = vi.mocked(r.deps.setDelta).mock.calls.filter(([sid]) => sid === 'a-sid')
    const last = (toA[toA.length - 1][1] as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    expect(last).toContain('Linked session c updated')
    expect(last).not.toContain('Linked session b updated')
  })
})

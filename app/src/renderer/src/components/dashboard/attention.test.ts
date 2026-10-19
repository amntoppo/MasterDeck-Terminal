import { describe, expect, it } from 'vitest'
import type { AttentionAction, AttentionItem } from '@shared/dashboard'
import { DIRECT, rowActions } from './attention'

const item = (actions: AttentionAction[], inboxId?: string): AttentionItem => ({
  id: inboxId ?? 'pr:https://github.com/acme/api/pull/1:ci',
  tier: 'now',
  rank: 80,
  title: 'A thing',
  why: '',
  at: 0,
  target: { view: 'terminals' },
  actions,
  fingerprint: '',
  ...(inboxId ? { inboxId } : {}),
})
const none = new Set<string>()
const open: AttentionAction = { type: 'open', label: 'Open', target: { session: 'k' } }

describe('rowActions', () => {
  it('runs the direct inbox kinds from the row', () => {
    for (const action of DIRECT) {
      const a: AttentionAction = { type: 'inbox', action: action as never, label: 'Go', primary: true }
      const r = rowActions(item([a, open], 'i1'), none)
      expect(r.direct).toEqual([a, open])
      expect(r.answerHere).toBe(false)
    }
  })

  it('leaves the other inbox kinds to Reply…', () => {
    const reply: AttentionAction = { type: 'inbox', action: 'reply', label: 'Reply', primary: true }
    const r = rowActions(item([reply, open], 'i2'), none)
    expect(r.direct).toEqual([open])
    expect(r.answerHere).toBe(true)
  })

  it('a start held for trust never runs Try again from the row', () => {
    const approve: AttentionAction = { type: 'inbox', action: 'approve', label: 'Try again', primary: true }
    const r = rowActions(item([approve], 'held:p1:x'), new Set(['held:p1:x']))
    expect(r.direct).toEqual([])
    expect(r.answerHere).toBe(true)
    // Another item's approve still runs.
    expect(rowActions(item([approve], 'held:p2:x'), new Set(['held:p1:x'])).direct).toEqual([approve])
  })

  it('derived items keep their own buttons and have no Reply…', () => {
    const review: AttentionAction = { type: 'review', label: 'Review', primary: true }
    const r = rowActions(item([review, open]), new Set(['pr:https://github.com/acme/api/pull/1:ci']))
    expect(r.direct).toEqual([review, open])
    expect(r.answerHere).toBe(false)
  })
})

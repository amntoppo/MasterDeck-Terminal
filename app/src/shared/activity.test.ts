import { describe, expect, it } from 'vitest'
import { asksQuestion, pendingTasks, turnEnded } from './activity'
import { sessionStatus } from './review'

const T0 = Date.parse('2026-09-28T10:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const use = (min: number, id: string, name: string, input: object) =>
  JSON.stringify({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (min: number, id: string, text: string, isError = false) =>
  JSON.stringify({ type: 'user', timestamp: at(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } })
const note = (min: number, body: string) => JSON.stringify({ type: 'user', timestamp: at(min), message: { role: 'user', content: `<task-notification>${body}</task-notification>` } })
const now = (min: number) => T0 + min * 60_000

describe('pendingTasks', () => {
  const monitor = [use(0, 'tu1', 'Monitor', { description: 'review comments on #617', timeout_ms: 1_800_000, command: 'x' }), result(0, 'tu1', 'Monitor started (task bler8jgi2, expires in 30m unless the source ends first)')]

  it('counts a running Monitor until it expires', () => {
    expect(pendingTasks(monitor, now(10))).toMatchObject([{ kind: 'monitor', label: 'review comments on #617' }])
    expect(pendingTasks(monitor, now(31))).toEqual([])
  })
  it('keeps a Monitor pending through its events, and drops it when it expires or stops', () => {
    const ev = note(5, '<task-id>bler8jgi2</task-id><summary>Monitor event</summary><event>#617 new comment</event>')
    expect(pendingTasks([...monitor, ev], now(10))).toHaveLength(1)
    expect(pendingTasks([...monitor, note(6, '<task-id>bler8jgi2</task-id><event>[Monitor expired after 30m with 1 event delivered.]</event>')], now(10))).toEqual([])
    expect(pendingTasks([...monitor, note(6, '<task-id>bler8jgi2</task-id><tool-use-id>tu1</tool-use-id><status>stopped</status>')], now(10))).toEqual([])
    expect(pendingTasks([...monitor, use(7, 'tu9', 'TaskStop', { task_id: 'bler8jgi2' })], now(10))).toEqual([])
  })
  it('tracks background commands and agents until their notification', () => {
    const lines = [
      use(0, 'b1', 'Bash', { command: 'npm test', description: 'Run tests', run_in_background: true }),
      result(0, 'b1', 'Command running in background with ID: bx12345'),
      use(1, 'a1', 'Agent', { description: 'Explore repo', prompt: 'p', run_in_background: true }),
      result(1, 'a1', 'Async agent launched successfully.\nagentId: a0c49010ed26dee3c'),
      use(2, 'b2', 'Bash', { command: 'ls' }),
    ]
    expect(pendingTasks(lines, now(3)).map((t) => t.kind)).toEqual(['shell', 'agent'])
    const done = note(4, '<task-id>a0c49010ed26dee3c</task-id><tool-use-id>a1</tool-use-id><status>completed</status>')
    expect(pendingTasks([...lines, done], now(5)).map((t) => t.id)).toEqual(['b1'])
    expect(pendingTasks([...lines, done, note(6, '<task-id>bx12345</task-id><status>completed</status>')], now(7))).toEqual([])
  })
  it('drops a launch that failed, and background work that never reports back after hours', () => {
    const lines = [use(0, 'b1', 'Bash', { command: 'x', run_in_background: true })]
    expect(pendingTasks([...lines, result(0, 'b1', 'boom', true)], now(1))).toEqual([])
    expect(pendingTasks(lines, now(7 * 60))).toEqual([])
  })
  it('counts a scheduled wakeup until a little past its time', () => {
    const lines = [use(0, 'w1', 'ScheduleWakeup', { delaySeconds: 600, reason: 'check CI', prompt: 'p' })]
    expect(pendingTasks(lines, now(5))).toMatchObject([{ kind: 'wakeup', label: 'check CI' }])
    expect(pendingTasks(lines, now(13))).toEqual([])
    expect(pendingTasks([...lines, use(1, 'w2', 'ScheduleWakeup', { stop: true })], now(5))).toEqual([])
  })
})

describe('asksQuestion', () => {
  it('sees a question at the end of the last message', () => {
    expect(asksQuestion({ text: 'Opened PR #12.\n\nWant me to also update the docs?', options: [] })).toBeTruthy()
    expect(asksQuestion({ text: 'Which one?\n\n1. A\n2. B', options: [1, 2] })).toBeTruthy()
  })
  it('ignores a statement, and question marks in code or links', () => {
    expect(asksQuestion({ text: 'Done. PR #12 is open.', options: [] })).toBeNull()
    expect(asksQuestion({ text: 'Fixed `a?.b` and https://x.io/?q=1 — all green.', options: [] })).toBeNull()
    expect(asksQuestion(null)).toBeNull()
  })
})

describe('turnEnded', () => {
  const said = (min: number, text: string) => JSON.stringify({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'text', text }] } })
  it('is true after Claude answered, false mid tool call or after a new message', () => {
    expect(turnEnded([use(0, 'm', 'Monitor', {}), result(0, 'm', 'Monitor started (task abcdef1)'), said(1, 'Watching.')])).toBe(true)
    expect(turnEnded([said(0, 'Let me check.'), use(1, 'b', 'Bash', { command: 'ls' })])).toBe(false)
    expect(turnEnded([said(0, 'Done.'), note(1, '<task-id>x</task-id><event>e</event>')])).toBe(false)
  })
})

describe('sessionStatus with activity', () => {
  it('is Idle only with nothing running and no question', () => {
    expect(sessionStatus({ state: 'idle' }, null, null).key).toBe('idle')
    expect(sessionStatus({ state: 'idle', waitingOn: 'monitor: CI' }, null, null).key).toBe('waiting')
    expect(sessionStatus({ state: 'working', waitingOn: 'monitor: CI' }, null, null).key).toBe('waiting')
    expect(sessionStatus({ state: 'idle', asking: 'Push it?', waitingOn: 'monitor: CI' }, null, null)).toMatchObject({ key: 'question', why: 'Push it?' })
    expect(sessionStatus({ state: 'working' }, null, null).key).toBe('working')
  })
  it('lets the PR stage show over a background wait', () => {
    expect(sessionStatus({ state: 'idle', waitingOn: 'monitor: review' }, { kind: 'in-review', prs: [1], why: '' }, null).key).toBe('in-review')
  })
})

describe('background agents (async by default)', () => {
  it('counts an Agent call whose result says it launched, until its notification', () => {
    const lines = [
      use(0, 'ag1', 'Agent', { description: 'Implement Task 1', prompt: 'p', subagent_type: 'general-purpose' }),
      result(0, 'ag1', 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ab9784b045241c470 (internal ID)'),
    ]
    expect(pendingTasks(lines, now(2))).toMatchObject([{ kind: 'agent', label: 'Implement Task 1' }])
    const done = note(5, '<task-id>ab9784b045241c470</task-id><tool-use-id>ag1</tool-use-id><status>completed</status>')
    expect(pendingTasks([...lines, done], now(6))).toEqual([])
  })
  it('ignores an Agent call that ran in the foreground', () => {
    const lines = [use(0, 'ag2', 'Agent', { description: 'Explore', prompt: 'p' }), result(1, 'ag2', 'Here is what I found: …')]
    expect(pendingTasks(lines, now(2))).toEqual([])
  })
  it('makes the session Working while agents run, Waiting only for monitors', () => {
    expect(sessionStatus({ state: 'idle', busyWith: 'background agent: Implement Task 1' }, null, null)).toMatchObject({ key: 'working', why: 'background agent: Implement Task 1' })
    expect(sessionStatus({ state: 'working', busyWith: 'background agent: x', waitingOn: 'monitor: CI' }, { kind: 'in-review', prs: [1], why: '' }, null).key).toBe('working')
    expect(sessionStatus({ state: 'idle', waitingOn: 'monitor: CI' }, null, null).key).toBe('waiting')
  })
})

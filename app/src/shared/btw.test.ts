import { describe, expect, it } from 'vitest'
import {
  BTW_ENTRIES_MAX,
  applyBtwEvent,
  btwModel,
  btwPrompt,
  capEntries,
  checkQuestion,
  parseBtwScreen,
  parseHistoryLine,
  parseStreamLine,
  sameQuestion,
  type BtwEntry,
} from './btw'

const entry = (o: Partial<BtwEntry> = {}): BtwEntry => ({
  id: 'a',
  question: 'q',
  answer: 'ans',
  at: 1,
  doneAt: 2,
  source: 'panel',
  status: 'done',
  ...o,
})

// A background session's screen with the /btw box open (claude logs, rendered; Claude Code 2.1.296).
const OPEN = [
  ' ▝▝   ▝▝   ~/work/acme',
  '',
  '',
  '❯ Remember the word TANGO55. Reply only OK.',
  '',
  '⏺ OK',
  '',
  '✻ Cooked for 3s · done 6:07 AM',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '',
  '    /btw what word did I ask you to remember? Then list the numbers 1 to 40, one per line.',
  '',
  '      TANGO55',
  '',
  '      1',
  '      2',
  '        - indented',
  '',
  '    ↑/↓ to scroll · c to copy · f to fork · Esc to close · ← 4 agents',
].join('\n')

const ANSWERING = [
  '▔▔▔▔▔▔▔▔▔▔',
  '',
  '    /btw what word did I ask you',
  '    to remember?',
  '',
  '      ✻ Answering…',
  '',
  '  Esc to close · ← 4 agents',
].join('\n')

describe('parseBtwScreen', () => {
  it('reads the question, the answer and whether it scrolls', () => {
    expect(parseBtwScreen(OPEN)).toEqual({
      question: 'what word did I ask you to remember? Then list the numbers 1 to 40, one per line.',
      answer: 'TANGO55\n\n1\n2\n  - indented',
      answering: false,
      more: true,
    })
  })
  it('sees an answer still on its way, with a wrapped question', () => {
    expect(parseBtwScreen(ANSWERING)).toEqual({
      question: 'what word did I ask you to remember?',
      answer: '',
      answering: true,
      more: false,
    })
  })
  it('a short answer has no scroll arrows', () => {
    const s = OPEN.replace('↑/↓ to scroll · ', '')
    expect(parseBtwScreen(s)?.more).toBe(false)
  })
  it('is null without the box, or with /btw only typed at the prompt', () => {
    expect(parseBtwScreen('❯ hello\n\n⏺ hi')).toBeNull()
    expect(parseBtwScreen('❯ /btw what is it\n  Esc to close')).toBeNull()
  })
})

describe('sameQuestion', () => {
  it('compares the start, whitespace and case aside', () => {
    expect(sameQuestion('What  word did I\nask?', 'what word did I ask?')).toBe(true)
    expect(sameQuestion('a long question '.repeat(10), 'a long question a long question a long question a long question…')).toBe(true)
    expect(sameQuestion('one', 'two')).toBe(false)
    expect(sameQuestion('one', '')).toBe(false)
  })
})

describe('parseHistoryLine', () => {
  const line = (display: string) => JSON.stringify({ display, pastedContents: {}, timestamp: 5, project: '/work/acme', sessionId: 's1' })
  it('takes /btw questions', () => {
    expect(parseHistoryLine(line('/btw what is left?'))).toEqual({ sessionId: 's1', question: 'what is left?', at: 5 })
    expect(parseHistoryLine(line('  /btw  two\nlines '))).toEqual({ sessionId: 's1', question: 'two\nlines', at: 5 })
  })
  it('skips other prompts, /btw alone and broken lines', () => {
    expect(parseHistoryLine(line('fix the /btw tab'))).toBeNull()
    expect(parseHistoryLine(line('/btw'))).toBeNull()
    expect(parseHistoryLine(line('/btwx hi'))).toBeNull()
    expect(parseHistoryLine('{"display":"/btw x"')).toBeNull()
  })
})

describe('parseStreamLine', () => {
  it('reads text deltas, whole messages, the model and the result', () => {
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PINE"}}}')).toEqual({ kind: 'delta', text: 'PINE' })
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-5-5"}}}')).toEqual({ kind: 'model', model: 'claude-haiku-5-5' })
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"A"},{"type":"tool_use"},{"type":"text","text":"B"}]}}')).toEqual({ kind: 'text', text: 'AB' })
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"AB","total_cost_usd":0.01,"modelUsage":{"claude-haiku-5-5":{}}}')).toEqual({
      kind: 'result',
      ok: true,
      text: 'AB',
      costUsd: 0.01,
      model: 'claude-haiku-5-5',
    })
    expect(parseStreamLine('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"]}')).toMatchObject({ kind: 'result', ok: false, text: 'boom' })
  })
  it('ignores the rest', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init"}')).toBeNull()
    expect(parseStreamLine('not json')).toBeNull()
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta"}}}')).toBeNull()
  })
})

describe('btwPrompt', () => {
  it('frames the question and carries earlier answered ones, newest 20', () => {
    const earlier = Array.from({ length: 25 }, (_, i) => entry({ id: `e${i}`, question: `q${i}`, answer: `a${i}`, at: i }))
    earlier.push(entry({ id: 'x', question: 'failed', status: 'error', answer: '' }))
    const p = btwPrompt('What now?', earlier)
    expect(p).toContain('no tools')
    expect(p.endsWith('Side question: What now?')).toBe(true)
    expect(p).not.toContain('q4\n')
    expect(p).toContain('q5\n')
    expect(p).toContain('a24')
    expect(p).not.toContain('failed')
  })
  it('has no earlier part without earlier answers', () => {
    expect(btwPrompt('Q', [])).not.toContain('Earlier side questions')
  })
})

describe('checkQuestion', () => {
  it('trims and refuses empty, long and control characters', () => {
    expect(checkQuestion('  hi\r\nthere ')).toEqual({ ok: true, question: 'hi\nthere' })
    expect(checkQuestion('   ').ok).toBe(false)
    expect(checkQuestion(5).ok).toBe(false)
    expect(checkQuestion('x'.repeat(4001)).ok).toBe(false)
    expect(checkQuestion('a\x1b[2Jb').ok).toBe(false)
  })
})

describe('btwModel', () => {
  it('passes model ids only', () => {
    expect(btwModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]')
    expect(btwModel('<synthetic>')).toBeNull()
    expect(btwModel('--settings x')).toBeNull()
    expect(btwModel(null)).toBeNull()
  })
})

describe('entries', () => {
  it('keeps the newest, oldest first', () => {
    const many = Array.from({ length: BTW_ENTRIES_MAX + 5 }, (_, i) => entry({ id: `e${i}`, at: BTW_ENTRIES_MAX + 5 - i }))
    const kept = capEntries(many)
    expect(kept).toHaveLength(BTW_ENTRIES_MAX)
    expect(kept[0].at).toBe(6)
    expect(kept.at(-1)!.at).toBe(BTW_ENTRIES_MAX + 5)
  })
  it('applies events', () => {
    const l = [entry({ id: 'a', at: 1 })]
    const l2 = applyBtwEvent(l, { key: 'k', entry: entry({ id: 'b', at: 2 }) })
    expect(l2.map((e) => e.id)).toEqual(['a', 'b'])
    expect(applyBtwEvent(l2, { key: 'k', entry: entry({ id: 'a', at: 1, answer: 'new' }) })[0].answer).toBe('new')
    expect(applyBtwEvent(l2, { key: 'k', removed: 'a' }).map((e) => e.id)).toEqual(['b'])
  })
})

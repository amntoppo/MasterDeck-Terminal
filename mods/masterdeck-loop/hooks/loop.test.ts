import { expect, test } from 'claude-code/testing'

import { MAX_DEFAULT, firstPrompt, isActive, newLoop, nextPrompt, parseLoopArgs, progressText, tailOf } from './loop'

test('reads /md-loop: a start, stop, where it stands, and mistakes', async () => {
  expect(parseLoopArgs('npm test -- fix the failing tests')).toEqual({ kind: 'start', check: 'npm test', goal: 'fix the failing tests', max: MAX_DEFAULT })
  expect(parseLoopArgs('--max 8 npm run lint && npm test -- make CI green -- really')).toEqual({ kind: 'start', check: 'npm run lint && npm test', goal: 'make CI green -- really', max: 8 })
  expect(parseLoopArgs('  stop ')).toEqual({ kind: 'stop' })
  expect(parseLoopArgs('')).toEqual({ kind: 'status' })
  expect(parseLoopArgs('npm test').kind).toBe('error')
  expect(parseLoopArgs('--max 50 npm test -- go').kind).toBe('error')
  expect(parseLoopArgs(' -- go').kind).toBe('error')
})

test('writes the rounds\' prompts with the check and what still fails', async () => {
  const l = newLoop('npm test', 'fix the tests', 3)
  expect(firstPrompt(l)).toContain('round 1 of 3')
  expect(firstPrompt(l)).toContain('`npm test`')
  const next = nextPrompt({ ...l, round: 2, last: { exit: 1, tail: 'FAIL a.test.ts' } })
  expect(next).toContain('still fails (exit 1; round 2 of 3)')
  expect(next).toContain('FAIL a.test.ts')
  expect(next).toContain('Keep working on: fix the tests')
})

test('keeps the last lines of a check, within a size', async () => {
  const out = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  expect(tailOf(out, '', 3)).toBe('line 97\nline 98\nline 99')
  expect(tailOf('a', 'b')).toBe('a\nb')
  expect(tailOf('x'.repeat(5000), '', 40, 100).length).toBe(101)
})

test('says where the loop stands', async () => {
  const l = newLoop('npm test', 'fix', 5)
  expect(progressText(l)).toBe('Loop round 1 of 5 · Claude is working · check `npm test`')
  expect(progressText({ ...l, status: 'checking' })).toBe('Loop round 1 of 5 · running `npm test`…')
  expect(progressText({ ...l, round: 2, status: 'passed' })).toBe('✓ Loop done in 2 rounds: `npm test` passes')
  expect(progressText({ ...l, round: 5, status: 'gave-up', last: { exit: 2, tail: '' } })).toBe('✗ Loop stopped after 5 rounds: `npm test` still fails (exit 2)')
  expect(progressText({ ...l, status: 'stopped', note: 'you interrupted the turn' })).toBe('Loop stopped in round 1 of 5: you interrupted the turn')
  expect([isActive(l), isActive({ ...l, status: 'checking' }), isActive({ ...l, status: 'passed' }), isActive(null)]).toEqual([true, true, false, false])
})

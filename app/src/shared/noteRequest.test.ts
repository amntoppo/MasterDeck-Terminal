import { describe, expect, it } from 'vitest'
import { appendText, parseNoteRequest, sessionText } from './noteRequest'

const ok = (raw: unknown) => {
  const r = parseNoteRequest(raw)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const err = (raw: unknown) => {
  const r = parseNoteRequest(raw)
  if (r.ok) throw new Error('accepted')
  return r.error
}

describe('parseNoteRequest', () => {
  it('reads the three commands', () => {
    expect(ok({ op: 'new', arg: ' Plan ', body: '- a\n' })).toEqual({ op: 'new', title: 'Plan', text: '- a' })
    expect(ok({ op: 'ticket', arg: 'acme/web#12', body: 'x' })).toEqual({ op: 'ticket', repo: 'acme/web', number: 12, text: 'x' })
    expect(ok({ op: 'ticket', arg: '#7', body: 'x' })).toEqual({ op: 'ticket', repo: null, number: 7, text: 'x' })
    const id = 'n-' + 'a'.repeat(32)
    expect(ok({ op: 'append', arg: id, body: 'x' })).toEqual({ op: 'append', id, text: 'x' })
  })
  it('refuses what it cannot place', () => {
    expect(err({ op: 'new', arg: '', body: 'x' })).toMatch(/title/)
    expect(err({ op: 'new', arg: 'x'.repeat(201), body: 'x' })).toMatch(/200/)
    expect(err({ op: 'new', arg: 't', body: ' \n ' })).toMatch(/No text/)
    expect(err({ op: 'ticket', arg: 'acme/web#0', body: 'x' })).toMatch(/owner\/name#12/)
    expect(err({ op: 'ticket', arg: '../etc#1', body: 'x' })).toMatch(/owner\/name#12/)
    expect(err({ op: 'ticket', arg: 'acme/..#1', body: 'x' })).toMatch(/owner\/name#12/)
    // A ticket's note is reached by its ticket, and a path is never an id.
    expect(err({ op: 'append', arg: 't-acme~web~12', body: 'x' })).toMatch(/id/)
    expect(err({ op: 'append', arg: '../x', body: 'x' })).toMatch(/id/)
    expect(err({ op: 'delete', arg: 'n-' + 'a'.repeat(32), body: 'x' })).toMatch(/Unknown/)
    expect(err(['new'])).toMatch(/Not a note request/)
    expect(err({ op: 'new', arg: 1, body: 'x' })).toMatch(/Not a note request/)
  })
  it('a title loses its line breaks', () => {
    expect(ok({ op: 'new', arg: 'a\nb\tc', body: 'x' })).toMatchObject({ title: 'a b c' })
  })
})

describe('sessionText', () => {
  it('drops terminal colours and control characters, keeps lines and tabs', () => {
    expect(sessionText('\n\x1b[31mred\x1b[0m\r\nnext\tcol\x07\x00 \n\n')).toBe('red\nnext\tcol')
    expect(sessionText('\x1b]8;;https://e.x\x07link\x1b]8;;\x07')).toBe('link')
  })
})

describe('appendText', () => {
  it('adds a paragraph under the text there, or starts it', () => {
    expect(appendText('', 'b')).toBe('b')
    expect(appendText('a\n\n\n', 'b')).toBe('a\n\nb')
  })
})

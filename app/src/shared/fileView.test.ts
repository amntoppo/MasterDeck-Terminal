import { describe, expect, it } from 'vitest'
import { FILE_MAX_BYTES, FILE_MAX_LINES, limitOf, messageFor, viewKind } from './fileView'

describe('viewKind', () => {
  it('renders Markdown', () => {
    expect(viewKind('README.md')).toEqual({ kind: 'markdown' })
    expect(viewKind('docs/x.MARKDOWN')).toEqual({ kind: 'markdown' })
  })
  it('picks a language from the extension or the name', () => {
    expect(viewKind('src/x.ts')).toEqual({ kind: 'code', lang: 'typescript' })
    expect(viewKind('x.tsx')).toEqual({ kind: 'code', lang: 'typescript' })
    expect(viewKind('a.py')).toEqual({ kind: 'code', lang: 'python' })
    expect(viewKind('a/Makefile')).toEqual({ kind: 'code', lang: 'makefile' })
    expect(viewKind('Dockerfile')).toEqual({ kind: 'code', lang: 'dockerfile' })
    expect(viewKind('x.json')).toEqual({ kind: 'code', lang: 'json' })
  })
  it('falls back to plain text', () => {
    expect(viewKind('x.unknownext')).toEqual({ kind: 'text' })
    expect(viewKind('LICENSE')).toEqual({ kind: 'text' })
  })
})

describe('limitOf', () => {
  it('says what is too much to show', () => {
    expect(limitOf({ bytes: 10, binary: false })).toBeNull()
    expect(limitOf({ bytes: 10, binary: true })).toBe('binary')
    expect(limitOf({ bytes: FILE_MAX_BYTES + 1, binary: false })).toBe('too-large')
    expect(limitOf({ bytes: 10, lines: FILE_MAX_LINES + 1, binary: false })).toBe('too-large')
  })
})

describe('messageFor', () => {
  it('gives a plain sentence for each reason', () => {
    for (const r of ['binary', 'too-large', 'missing', 'outside', 'not-file'] as const) expect(messageFor(r)).toMatch(/\w/)
    expect(messageFor('too-large')).toContain('1 MB')
  })
})

import { describe, expect, it } from 'vitest'
import {
  checkFirstMessage,
  cloneArgs,
  cloneBlock,
  clonedLine,
  cloneName,
  cloneNameError,
  cloneOptions,
  cloneOwnsBranch,
  parseClones,
} from './clone'

const SID = 'a0cd01ba-e314-4d94-9050-647904c6e104'
const line = (o: object) => JSON.stringify(o)

describe('cloneName', () => {
  it('adds (clone), then counts past the names taken', () => {
    expect(cloneName('fix-login', [])).toBe('fix-login (clone)')
    expect(cloneName('fix-login', ['fix-login (clone)'])).toBe('fix-login (clone 2)')
    expect(cloneName('fix-login', ['fix-login (clone)', 'fix-login (clone 2)'])).toBe('fix-login (clone 3)')
  })
  it('counts on for a clone of a clone instead of nesting', () => {
    expect(cloneName('fix-login (clone)', ['fix-login (clone)'])).toBe('fix-login (clone 2)')
    expect(cloneName('fix-login (clone 2)', ['fix-login (clone)', 'fix-login (clone 2)'])).toBe('fix-login (clone 3)')
  })
  it('keeps to the name rule and its length', () => {
    expect(cloneName('ünïcode/name', [])).toBe('n-code-name (clone)')
    expect(cloneName('---', [])).toBe('session (clone)')
    const long = cloneName('a'.repeat(120), [])
    expect(long.length).toBe(100)
    expect(long.endsWith(' (clone)')).toBe(true)
    expect(cloneNameError(long)).toBeNull()
  })
})

describe('cloneNameError', () => {
  it('takes spaces and parentheses, refuses the rest', () => {
    expect(cloneNameError('fix login (clone 2)')).toBeNull()
    expect(cloneNameError('')).toMatch(/name/)
    expect(cloneNameError('-x')).toMatch(/letter or digit/)
    expect(cloneNameError('a;rm')).toMatch(/letters/)
    expect(cloneNameError('a'.repeat(101))).toMatch(/100/)
  })
})

describe('cloneBlock', () => {
  it('refuses a session with no conversation', () => {
    expect(cloneBlock({ sessionId: 'pending', state: 'idle' })).toMatch(/no conversation/)
    expect(cloneBlock({ sessionId: SID, state: 'idle', noConversation: true })).toMatch(/no conversation/)
  })
  it('refuses a session that needs input', () => {
    expect(cloneBlock({ sessionId: SID, state: 'needs-input' })).toMatch(/answer/)
    expect(cloneBlock({ sessionId: SID, state: 'idle' }, true)).toMatch(/answer/)
  })
  it('lets the rest through, stopped and working ones too', () => {
    for (const state of ['idle', 'working', 'done', 'suspended'] as const) expect(cloneBlock({ sessionId: SID, state })).toBeNull()
  })
})

describe('cloneOptions', () => {
  const asst = (requestedModel: unknown, model: unknown, extra: object = {}) =>
    line({ type: 'assistant', requestedModel, message: { model, content: [] }, ...extra })
  it('takes the newest requestedModel (it keeps [1m]) and permission mode', () => {
    const text = [
      line({ type: 'permission-mode', permissionMode: 'auto' }),
      asst('claude-haiku-5-5', 'claude-haiku-5-5'),
      line({ type: 'permission-mode', permissionMode: 'plan' }),
      asst('claude-opus-5-5[1m]', 'claude-opus-5-5'),
      line({ type: 'user', message: { content: 'hi' } }),
    ].join('\n')
    expect(cloneOptions(text, true)).toEqual({ model: 'claude-opus-5-5[1m]', permissionMode: 'plan' })
  })
  it('falls back to message.model, skips <synthetic> and sidechains', () => {
    const text = [asst(undefined, 'claude-sonnet-5-5'), asst('<synthetic>', '<synthetic>'), asst('claude-x', 'claude-x', { isSidechain: true })].join('\n')
    expect(cloneOptions(text, true).model).toBe('claude-sonnet-5-5')
  })
  it('never carries default, bypassPermissions or an unknown mode, and never an older one past them', () => {
    for (const m of ['default', 'bypassPermissions', 'dontAsk', 'weird'])
      expect(cloneOptions([line({ type: 'permission-mode', permissionMode: 'plan' }), line({ type: 'permission-mode', permissionMode: m })].join('\n'), true).permissionMode).toBeNull()
  })
  it('skips a cut first line and broken ones; nothing found: nulls', () => {
    expect(cloneOptions(`ermission-mode","permissionMode":"plan"}\n{broken\n`, false)).toEqual({ model: null, permissionMode: null })
    expect(cloneOptions('', true)).toEqual({ model: null, permissionMode: null })
  })
  it('refuses a model value that is not a model name', () => {
    expect(cloneOptions(asst('--dangerously-skip-permissions', 'x y'), true).model).toBeNull()
  })
})

describe('checkFirstMessage', () => {
  it('trims and allows empty', () => {
    expect(checkFirstMessage('  go on  ', false)).toEqual({ ok: true, text: 'go on' })
    expect(checkFirstMessage(undefined, false)).toEqual({ ok: true, text: '' })
  })
  it('refuses a leading dash and an overlong text', () => {
    expect(checkFirstMessage('-p', false).ok).toBe(false)
    expect(checkFirstMessage('x'.repeat(20_001), false).ok).toBe(false)
  })
  it('holds a browser to noEscape, not the window', () => {
    expect(checkFirstMessage('/compact', false).ok).toBe(true)
    expect(checkFirstMessage('/compact', true).ok).toBe(false)
    expect(checkFirstMessage('!rm -rf x', true).ok).toBe(false)
    expect(checkFirstMessage('try the other approach', true).ok).toBe(true)
  })
})

describe('cloneArgs', () => {
  it('resumes with --fork-session under the new name, the message last', () => {
    expect(cloneArgs({ sessionId: SID, name: 'x (clone)', settings: ['--settings', '/a.json'], model: 'claude-opus-5-5[1m]', permissionMode: 'plan', prompt: 'go' })).toEqual([
      '--bg', '--settings', '/a.json', '--resume', SID, '--fork-session', '-n', 'x (clone)', '--model', 'claude-opus-5-5[1m]', '--permission-mode', 'plan', 'go',
    ])
    expect(cloneArgs({ sessionId: SID, name: 'y', settings: [], model: null, permissionMode: null, prompt: '' })).toEqual(['--bg', '--resume', SID, '--fork-session', '-n', 'y'])
  })
})

describe('parseClones', () => {
  it('keeps well-formed records by bg id only', () => {
    const raw = {
      '83c38441': { from: { key: 'a0cd01ba', name: 'orig' }, at: 5, branch: 'main', ticket: { repo: 'acme/web', number: 7 }, linked: true },
      '11111111': { from: { key: 'k', name: 'n' }, at: 1, branch: null, ticket: { number: -1 } },
      'not-a-bg': { from: { key: 'k', name: 'n' }, at: 1 },
      '22222222': { from: { name: 'n' }, at: 1 },
    }
    expect(parseClones(raw)).toEqual({
      '83c38441': { from: { key: 'a0cd01ba', name: 'orig' }, at: 5, branch: 'main', ticket: { repo: 'acme/web', number: 7 }, linked: true },
      '11111111': { from: { key: 'k', name: 'n' }, at: 1, branch: null },
    })
    expect(parseClones([])).toEqual({})
    expect(parseClones(null)).toEqual({})
  })
})

describe('clonedLine', () => {
  const at = Date.parse('2026-10-16T23:41:40.000Z')
  it('drops the copied lines (the original timestamps), keeps the clone own and untimed ones', () => {
    expect(clonedLine(line({ type: 'pr-link', prUrl: 'https://github.com/acme/web/pull/1', timestamp: '2026-10-16T23:41:21.569Z' }), at)).toBe(false)
    expect(clonedLine(line({ type: 'user', timestamp: '2026-10-16T23:41:49.991Z' }), at)).toBe(true)
    expect(clonedLine(line({ type: 'custom-title', customTitle: 'x' }), at)).toBe(true)
  })
})

describe('cloneOwnsBranch', () => {
  it('owns the folder branch only once it moved off the one it was cloned on', () => {
    expect(cloneOwnsBranch({ branch: '136-clone' }, '136-clone')).toBe(false)
    expect(cloneOwnsBranch({ branch: '136-clone' }, 'other')).toBe(true)
    expect(cloneOwnsBranch({ branch: '136-clone' }, undefined)).toBe(false)
    expect(cloneOwnsBranch({ branch: null }, null)).toBe(false)
  })
})

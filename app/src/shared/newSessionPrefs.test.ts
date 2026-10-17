import { describe, expect, it } from 'vitest'
import { choiceFor, initialAccount, NO_NEW_SESSION_PREFS, parseNewSessionPrefs, prefsAccountKey, rememberChoice, resolveChoice, type ChoiceContext } from './newSessionPrefs'

const a = { cwd: '/work/acme/api', model: 'opus', workflow: 'tdd', mode: 'plan' }
const b = { cwd: '/work/other/web', model: '', workflow: 'default', mode: '' }
const ctx: ChoiceContext = {
  defaultCwd: '/work',
  cwdExists: true,
  models: ['opus', 'sonnet', 'haiku'],
  configured: null,
  workflows: ['default', 'tdd'],
  defaultWorkflow: 'default',
  modes: ['', 'plan', 'acceptEdits'],
}

describe('parseNewSessionPrefs', () => {
  it('reads back what was saved', () => {
    const p = rememberChoice(NO_NEW_SESSION_PREFS, true, 'acme-dev', a)
    expect(parseNewSessionPrefs(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })
  it('drops junk', () => {
    expect(parseNewSessionPrefs(null)).toEqual(NO_NEW_SESSION_PREFS)
    expect(parseNewSessionPrefs('x')).toEqual(NO_NEW_SESSION_PREFS)
    const p = parseNewSessionPrefs({ last: '../bad', by: { 'bad login!': a, ok: { cwd: 3, model: 'x'.repeat(200), workflow: 'w', mode: 'plan' }, n: null } })
    expect(p.last).toBeNull()
    expect(p.by).toEqual({ ok: { cwd: '', model: '', workflow: 'w', mode: 'plan' } })
  })
  it('keeps the single-account set under ""', () => {
    expect(parseNewSessionPrefs({ last: null, by: { '': a } }).by['']).toEqual(a)
  })
})

describe('saving and loading per account', () => {
  it('keeps one set with one account, whatever login is passed', () => {
    expect(prefsAccountKey(false, 'acme-dev')).toBe('')
    const p = rememberChoice(NO_NEW_SESSION_PREFS, false, null, a)
    expect(p.last).toBeNull()
    expect(choiceFor(p, false, 'anyone')).toEqual(a)
  })
  it('keeps each account its own set and the last account started', () => {
    let p = rememberChoice(NO_NEW_SESSION_PREFS, true, 'acme-dev', a)
    p = rememberChoice(p, true, 'acme-ops', b)
    expect(p.last).toBe('acme-ops')
    expect(choiceFor(p, true, 'acme-dev')).toEqual(a)
    expect(choiceFor(p, true, 'acme-ops')).toEqual(b)
    p = rememberChoice(p, true, 'acme-dev', { ...a, model: 'haiku' })
    expect(p.last).toBe('acme-dev')
    expect(choiceFor(p, true, 'acme-dev')?.model).toBe('haiku')
    expect(choiceFor(p, true, 'acme-ops')).toEqual(b)
  })
  it('saves nothing without an account when there are two or more', () => {
    expect(rememberChoice(NO_NEW_SESSION_PREFS, true, null, a)).toBe(NO_NEW_SESSION_PREFS)
    expect(choiceFor(rememberChoice(NO_NEW_SESSION_PREFS, true, 'x', a), true, null)).toBeNull()
  })
  it('keeps at most 20 accounts, dropping the oldest', () => {
    let p = NO_NEW_SESSION_PREFS
    for (let i = 0; i < 25; i++) p = rememberChoice(p, true, `u${i}`, a)
    expect(Object.keys(p.by)).toHaveLength(20)
    expect(choiceFor(p, true, 'u0')).toBeNull()
    expect(choiceFor(p, true, 'u24')).toEqual(a)
    expect(Object.keys(parseNewSessionPrefs(p).by)).toHaveLength(20)
  })
})

describe('initialAccount', () => {
  const p = rememberChoice(NO_NEW_SESSION_PREFS, true, 'acme-dev', a)
  it('opens on the last account started while it is a healthy choice', () => {
    expect(initialAccount(p, true, ['acme-dev', 'acme-ops'])).toBe('acme-dev')
    expect(initialAccount(p, true, ['acme-ops'])).toBeNull()
    expect(initialAccount(p, false, ['acme-dev'])).toBeNull()
    expect(initialAccount(NO_NEW_SESSION_PREFS, true, ['acme-dev'])).toBeNull()
  })
})

describe('resolveChoice', () => {
  it('gives the defaults with nothing remembered', () => {
    expect(resolveChoice(null, ctx)).toEqual({ choice: { cwd: '/work', model: '', workflow: 'default', mode: '' }, notes: {} })
  })
  it('takes a remembered choice that is still offered', () => {
    expect(resolveChoice(a, ctx)).toEqual({ choice: a, notes: {} })
  })
  it('falls back field by field with a note', () => {
    const r = resolveChoice({ cwd: '/gone', model: 'gpt', workflow: 'deleted', mode: 'yolo' }, { ...ctx, cwdExists: false })
    expect(r.choice).toEqual({ cwd: '/work', model: '', workflow: 'default', mode: '' })
    expect(Object.keys(r.notes).sort()).toEqual(['cwd', 'mode', 'model', 'workflow'])
    expect(r.notes.cwd).toContain('/gone')
  })
  it('shows the configured model as the Default option', () => {
    expect(resolveChoice({ ...a, model: 'opus' }, { ...ctx, configured: 'opus' }).choice.model).toBe('')
  })
  it('does not judge the workflow when the list could not be read', () => {
    expect(resolveChoice(a, { ...ctx, workflows: [] })).toEqual({ choice: { ...a, workflow: 'default' }, notes: {} })
  })
})

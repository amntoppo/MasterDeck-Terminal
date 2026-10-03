import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionAccounts, sessionSettings } from './sessionAccounts'

const file = () => join(mkdtempSync(join(tmpdir(), 'sa-')), 'session-accounts.json')

describe('SessionAccounts', () => {
  it('records by session id and key; a resume (new id, same key) still finds it after a restart', () => {
    const f = file()
    const a = new SessionAccounts(f)
    expect(a.get({ sessionId: 's1', key: 'k1' })).toBeNull()
    a.set(['s1', 'k1'], 'bob-work')
    expect(new SessionAccounts(f).get({ sessionId: 's2', key: 'k1' })).toBe('bob-work')
  })
  it('a missing or broken file reads as empty; bad logins are skipped', () => {
    const f = file()
    writeFileSync(f, '{nope')
    expect(new SessionAccounts(f).get({ sessionId: 's1', key: 'k1' })).toBeNull()
    writeFileSync(f, JSON.stringify({ s1: 'bad login!', s2: 'alice' }))
    const b = new SessionAccounts(f)
    expect(b.get({ sessionId: 's1', key: 'x' })).toBeNull()
    expect(b.get({ sessionId: 's2', key: 'x' })).toBe('alice')
  })
  it('a session started by name is recorded once it shows up; an old expectation goes', () => {
    const a = new SessionAccounts(file())
    a.expect('fix-12', 'bob-work', 0)
    a.claim([{ sessionId: 's9', key: 'k9', name: 'other', state: 'idle' }], 1_000)
    expect(a.get({ sessionId: 's9', key: 'k9' })).toBeNull()
    a.claim([{ sessionId: 's9', key: 'k9', name: 'fix-12', state: 'working' }], 2_000)
    expect(a.get({ sessionId: 's9', key: 'k9' })).toBe('bob-work')
    a.expect('late', 'alice', 0)
    a.claim([], 11 * 60_000)
    a.claim([{ sessionId: 's8', key: 'k8', name: 'late', state: 'idle' }], 11 * 60_000 + 1)
    expect(a.get({ sessionId: 's8', key: 'k8' })).toBeNull()
  })
})

describe('sessionSettings', () => {
  const ok = (l: string | null | undefined) => ({ ok: true as const, args: ['--settings', `/a/${l}`], account: l ?? 'alice' })
  it('one account: no arguments, nothing asked', async () => {
    let asked = false
    const r = await sessionSettings(false, ok, 'bob-work', async () => ((asked = true), 'alice'))
    expect(r).toEqual({ ok: true, args: [], account: null })
    expect(asked).toBe(false)
  })
  it('the given account first, else the fallback', async () => {
    expect(await sessionSettings(true, ok, 'bob-work', async () => 'alice')).toMatchObject({ account: 'bob-work' })
    expect(await sessionSettings(true, ok, null, async () => 'alice')).toMatchObject({ account: 'alice' })
  })
  it('a refusal stands, and no --settings in multi mode (accounts still loading) is refused, never gh active', async () => {
    const no = () => ({ ok: false as const, message: 'GitHub account bob-work needs to log in again' })
    expect(await sessionSettings(true, no, 'bob-work', async () => null)).toEqual(no())
    const none = () => ({ ok: true as const, args: [], account: null })
    expect((await sessionSettings(true, none, 'bob-work', async () => null)).ok).toBe(false)
  })
})

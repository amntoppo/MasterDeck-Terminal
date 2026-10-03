import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bgIdFromOutput, resumeAs, SessionAccounts, sessionSettings } from './sessionAccounts'
import type { Runner } from './run'
import type { Session } from '@shared/types'

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

describe('SessionAccounts backfill', () => {
  it('a live row with a new session id and a known key (claude attach resumed it) gets the account, also after a restart', () => {
    const f = file()
    const a = new SessionAccounts(f)
    a.set(['s1', 'k1'], 'bob-work')
    a.claim([{ sessionId: 's2', key: 'k1', name: 'fix-12', state: 'working' }])
    expect(new SessionAccounts(f).get({ sessionId: 's2', key: 's2' })).toBe('bob-work')
  })
  it('a known id with its bg key not yet recorded fills the key; ended rows are left alone', () => {
    const a = new SessionAccounts(file())
    a.set(['s1'], 'bob-work')
    a.claim([{ sessionId: 's1', key: 'k1', name: 'x', state: 'idle' }, { sessionId: 's3', key: 'k1x', name: 'y', state: 'done' }])
    expect(a.get({ sessionId: 'other', key: 'k1' })).toBe('bob-work')
  })
  it('recording a resumed id does not give its account to another session of the same name', () => {
    const a = new SessionAccounts(file())
    a.set(['s1'], 'bob-work')
    a.claim([{ sessionId: 's7', key: 'k7', name: 'resumed', state: 'working' }])
    expect(a.get({ sessionId: 's7', key: 'k7' })).toBeNull()
  })
})

// Claude Code 2.1.288's real output (ANSI stripped): a plain start, and a resume with flags (a copy under a new id).
const START_OUT = `backgrounded · 1a2b3c4d
  claude agents             list sessions
  claude attach 1a2b3c4d    open in this terminal
  claude logs 1a2b3c4d      show recent output
  claude stop 1a2b3c4d      stop this session
`
const RESUME_OUT = `note: background session 72a76c62 keeps its own saved options, so the flags you passed started a copy as 7138e681. Without flags, the same command continues 72a76c62 itself.
backgrounded · 7138e681
  claude agents             list sessions
  claude attach 7138e681    open in this terminal
  claude logs 7138e681      show recent output
  claude stop 7138e681      stop this session
`

describe('bgIdFromOutput', () => {
  it('the new id: `backgrounded · <id>`, never the old id in the note', () => {
    expect(bgIdFromOutput(START_OUT)).toBe('1a2b3c4d')
    expect(bgIdFromOutput(RESUME_OUT)).toBe('7138e681')
    expect(bgIdFromOutput(`\x1b[1mbackgrounded\x1b[0m · \x1b[36m7138e681\x1b[0m\n`)).toBe('7138e681')
  })
  it('else `claude attach <id>`; else null (no guessing from other hex)', () => {
    expect(bgIdFromOutput('  claude attach 1a2b3c4d    open in this terminal\n')).toBe('1a2b3c4d')
    expect(bgIdFromOutput('note: background session 72a76c62 keeps its own saved options')).toBeNull()
    expect(bgIdFromOutput('resumed 1a2b3c4d-0000-4000-8000-000000000000')).toBeNull()
    expect(bgIdFromOutput('')).toBeNull()
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

describe('resumeAs', () => {
  const S1 = '11111111-1111-4111-8111-111111111111'
  const S2 = '22222222-2222-4222-8222-222222222222'
  const setup = (out: string) => {
    const a = new SessionAccounts(file())
    const calls: string[][] = []
    const run: Runner = async (_c, args) => (calls.push(args), { code: 0, stdout: out, stderr: '' })
    const live: { name: string; state: Session['state'] }[] = []
    const d = {
      run,
      claude: 'claude',
      accounts: a,
      // As index.ts: the given account, else the recorded one, else the primary (alice).
      settings: async (l: string | null, fb: () => Promise<string | null>) => {
        const login = l || (await fb()) || 'alice'
        return { ok: true as const, args: ['--settings', `/acc/${login}.settings.json`], account: login }
      },
      accountOf: async (s: { sessionId: string; key: string }) => a.get(s),
      live: () => live,
    }
    return { a, calls, d, live }
  }
  it('a resume gets a new session id and bg id: the second resume still runs as the recorded account', async () => {
    const { a, calls, d } = setup(RESUME_OUT)
    a.set([S1, 'aaaa1111'], 'bob-work')
    expect((await resumeAs(d, { id: S1, key: 'aaaa1111', name: 'fix-12', named: ['-n', 'fix-12'], cwd: '/w', account: null })).ok).toBe(true)
    expect(calls[0]).toEqual(['--bg', '--settings', '/acc/bob-work.settings.json', '--resume', S1, '-n', 'fix-12'])
    // The new row shows up (new session id, the printed bg id), then stops.
    a.claim([{ sessionId: S2, key: '7138e681', name: 'fix-12', state: 'working' }])
    await resumeAs(d, { id: S2, key: null, name: 'fix-12', named: ['-n', 'fix-12'], cwd: '/w', account: null })
    expect(calls[1]).toContain('/acc/bob-work.settings.json')
  })
  it('no bg id printed: matched by name, unless another live session has that name', async () => {
    const one = setup('resumed\n')
    await resumeAs(one.d, { id: S1, key: null, name: 'fix-12', named: [], cwd: '/w', account: 'bob-work' })
    one.a.claim([{ sessionId: S2, key: '3c4d5e6f', name: 'fix-12', state: 'working' }])
    expect(one.a.get({ sessionId: S2, key: 'x' })).toBe('bob-work')
    const two = setup('resumed\n')
    two.live.push({ name: 'resumed', state: 'working' })
    await resumeAs(two.d, { id: S1, key: null, name: 'resumed', named: [], cwd: '/w', account: 'bob-work' })
    two.a.claim([{ sessionId: S2, key: '3c4d5e6f', name: 'resumed', state: 'working' }])
    expect(two.a.get({ sessionId: S2, key: '3c4d5e6f' })).toBeNull()
  })
  it('a refused account runs nothing', async () => {
    const { calls, d } = setup('')
    const r = await resumeAs(
      { ...d, settings: async () => ({ ok: false as const, message: 'GitHub account bob-work needs to log in again' }) },
      { id: S1, key: null, name: 'x', named: [], cwd: '/w', account: 'bob-work' },
    )
    expect(r).toEqual({ ok: false, message: 'GitHub account bob-work needs to log in again' })
    expect(calls).toEqual([])
  })
})

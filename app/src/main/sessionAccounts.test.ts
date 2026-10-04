import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bgIdFromOutput, copyFromOutput, resumeAs, wokeFromOutput, SessionAccounts, sessionSettings } from './sessionAccounts'
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

describe('SessionAccounts: gh\'s active account, and writes from elsewhere', () => {
  it('a session known to run without --settings has no login, and says so; a real account replaces the mark', () => {
    const f = file()
    const a = new SessionAccounts(f)
    a.set(['s1', 'k1'], 'bob-work')
    a.markGhActive(['s1', 'k1'])
    expect(a.get({ sessionId: 's1', key: 'k1' })).toBeNull()
    expect(a.ghActive({ sessionId: 's1', key: 'k1' })).toBe(true)
    expect(a.ghActive({ sessionId: 's2', key: 'k2' })).toBe(false)
    const b = new SessionAccounts(f)
    expect(b.ghActive({ sessionId: 'x', key: 'k1' })).toBe(true)
    expect(b.get({ sessionId: 'x', key: 'k1' })).toBeNull()
    b.set(['s1', 'k1'], 'alice')
    expect(b.ghActive({ sessionId: 's1', key: 'k1' })).toBe(false)
    expect(b.get({ sessionId: 's1', key: 'k1' })).toBe('alice')
  })
  it('keeps what `master spawn` wrote to the file meanwhile, and reads it', () => {
    const f = file()
    const a = new SessionAccounts(f)
    a.set(['s1'], 'alice')
    writeFileSync(f, JSON.stringify({ s1: 'alice', '6d996951': 'bob-work' }))
    a.claim([])
    expect(a.get({ sessionId: 'new', key: '6d996951' })).toBe('bob-work')
    writeFileSync(f, JSON.stringify({ s1: 'alice', '6d996951': 'bob-work', aaaa1111: 'bob-work' }))
    a.set(['s2'], 'alice')
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf8'))).sort()).toEqual(['6d996951', 'aaaa1111', 's1', 's2'])
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

// Real output of 2.1.288 (the controller's probes): a resume with any flag starts a copy; a bare one wakes the same session.
const COPY_OUT = `note: background session e168c2bf keeps its own saved options, so the flags you passed started a copy as 6d996951. Without flags, the same command continues e168c2bf itself.
backgrounded · 6d996951 · dupprobe-md (idle — send a prompt to start)
`
const WOKE_OUT = `note: woke session e168c2bf with its saved options (-n, --model, --permission-mode).
backgrounded · e168c2bf · dupprobe-md (idle — send a prompt to start)
`

// 2.1.288: `--settings` is in the list only when the session was started with it.
const WOKE_SETTINGS_OUT = `note: woke session 458e2f9e with its saved options (-n, --settings, --model, --permission-mode).
backgrounded · 458e2f9e · fix-12 (idle — send a prompt to start)
`

const WOKE_CUT = [
  'note: woke session e168c2bf with its saved options (-n, --model\nbackgrounded · e168c2bf · fix-12\n',
  'note: woke session e168c2bf with its saved options (-n, --model, …).\nbackgrounded · e168c2bf\n',
  'note: woke session e168c2bf with its saved options (-n, ...)\nbackgrounded · e168c2bf\n',
  'note: woke session e168c2bf with its saved options (-n, --mod',
]

describe('resume output', () => {
  it('the id after `backgrounded ·` is the one that runs now, with the name after it or not', () => {
    expect(bgIdFromOutput(COPY_OUT)).toBe('6d996951')
    expect(bgIdFromOutput(WOKE_OUT)).toBe('e168c2bf')
  })
  it('copyFromOutput: the old and the new id, only when a copy was started', () => {
    expect(copyFromOutput(COPY_OUT)).toEqual({ old: 'e168c2bf', copy: '6d996951' })
    expect(copyFromOutput(RESUME_OUT)).toEqual({ old: '72a76c62', copy: '7138e681' })
    expect(copyFromOutput(WOKE_OUT)).toBeNull()
    expect(copyFromOutput(START_OUT)).toBeNull()
    expect(copyFromOutput('')).toBeNull()
  })
  it('wokeFromOutput: the session and the options it was started with', () => {
    expect(wokeFromOutput(WOKE_OUT)).toEqual({ id: 'e168c2bf', options: ['-n', '--model', '--permission-mode'], complete: true })
    expect(wokeFromOutput(WOKE_SETTINGS_OUT)).toEqual({ id: '458e2f9e', options: ['-n', '--settings', '--model', '--permission-mode'], complete: true })
    // Cut short (no closing parenthesis, or an ellipsis): the list is not the whole truth.
    for (const cut of WOKE_CUT) expect(wokeFromOutput(cut)).toMatchObject({ id: 'e168c2bf', complete: false })
    expect(wokeFromOutput(COPY_OUT)).toBeNull()
    expect(wokeFromOutput(START_OUT)).toBeNull()
  })
})

describe('resumeAs', () => {
  const S1 = 'e168c2bf-1111-4111-8111-111111111111'
  type Row = Pick<Session, 'sessionId' | 'key' | 'bgId' | 'name' | 'state' | 'pid' | 'kind'>
  const row = (o: Partial<Row> = {}): Row => ({ sessionId: S1, key: 'e168c2bf', bgId: 'e168c2bf', name: 'fix-12', state: 'idle', pid: null, kind: 'background', ...o })
  const setup = (out: string, multi = true) => {
    const a = new SessionAccounts(file())
    const calls: string[][] = []
    const superseded: string[] = []
    const copies: string[] = []
    const run: Runner = async (_c, args) => (calls.push(args), { code: 0, stdout: out, stderr: '' })
    // `live` is the last poll; a refresh replaces it with `fresh` when that is set.
    const st: { live: Row[] | null; fresh?: Row[] | null; refreshes: number; asked: number } = { live: [row()], refreshes: 0, asked: 0 }
    const d = {
      run,
      claude: 'claude',
      accounts: a,
      multi: () => multi,
      // As index.ts: nothing with one account; else the given account, the recorded one, the primary (alice).
      settings: async (l: string | null, fb: () => Promise<string | null>) => {
        st.asked++
        if (!multi) return { ok: true as const, args: [], account: null }
        const login = l || (await fb()) || 'alice'
        return { ok: true as const, args: ['--settings', `/acc/${login}.settings.json`], account: login }
      },
      accountOf: async (s: { sessionId: string; key: string }) => a.get(s),
      live: () => st.live,
      refresh: async () => {
        st.refreshes++
        if (st.fresh !== undefined) st.live = st.fresh
      },
      copied: (old: { bgId: string; sessionId: string }, copy: string) => void (superseded.push(old.bgId, old.sessionId), copies.push(`${old.bgId}>${copy}`)),
    }
    return { a, calls, superseded, copies, d, st }
  }
  const o = { id: S1, key: 'e168c2bf', name: 'fix-12', cwd: '/w', account: null as string | null }

  it('one account: a bare resume wakes the same session; no flags, nothing recorded, no account asked', async () => {
    const { a, calls, superseded, d, st } = setup(WOKE_OUT, false)
    expect(await resumeAs(d, o)).toMatchObject({ ok: true, copy: null })
    expect(calls).toEqual([['--bg', '--resume', S1]])
    expect(superseded).toEqual([])
    expect(st.asked).toBe(0)
    expect(a.ghActive({ sessionId: S1, key: 'e168c2bf' })).toBe(false)
  })
  it('two accounts, resumed as its recorded account (or none given): bare, and the account is not even resolved', async () => {
    const { a, calls, d, st } = setup(WOKE_SETTINGS_OUT)
    a.set([S1, 'e168c2bf'], 'bob-work')
    await resumeAs(d, o)
    await resumeAs(d, { ...o, account: 'Bob-Work' })
    expect(calls).toEqual([['--bg', '--resume', S1], ['--bg', '--resume', S1]])
    expect(st.asked).toBe(0)
    // Started with --settings: the record stands.
    expect(a.get({ sessionId: S1, key: 'e168c2bf' })).toBe('bob-work')
  })
  it('two accounts, no record: still bare (no copy on its own)', async () => {
    const { calls, superseded, d } = setup(WOKE_SETTINGS_OUT)
    await resumeAs(d, o)
    expect(calls).toEqual([['--bg', '--resume', S1]])
    expect(superseded).toEqual([])
  })
  it('two accounts, woken without --settings: it runs as gh\'s active account; a stale record goes and it is marked', async () => {
    const { a, calls, d } = setup(WOKE_OUT)
    a.set([S1, 'e168c2bf'], 'bob-work') // recorded by an earlier build under the old ids
    await resumeAs(d, o)
    expect(calls).toEqual([['--bg', '--resume', S1]])
    expect(a.get({ sessionId: S1, key: 'e168c2bf' })).toBeNull()
    expect(a.ghActive({ sessionId: S1, key: 'e168c2bf' })).toBe(true)
    // A note that was cut short proves nothing: the record stays.
    for (const cut of WOKE_CUT) {
      const c = setup(cut)
      c.a.set([S1, 'e168c2bf'], 'bob-work')
      await resumeAs(c.d, o)
      expect(c.a.get({ sessionId: S1, key: 'e168c2bf' })).toBe('bob-work')
      expect(c.a.ghActive({ sessionId: S1, key: 'e168c2bf' })).toBe(false)
    }
    // One account: nothing to mark.
    const one = setup(WOKE_OUT, false)
    await resumeAs(one.d, o)
    expect(one.a.ghActive({ sessionId: S1, key: 'e168c2bf' })).toBe(false)
  })
  it('another account picked: a copy with --settings and its name, recorded; the old session is left alone and superseded', async () => {
    const { a, calls, superseded, copies, d } = setup(COPY_OUT)
    a.set([S1, 'e168c2bf'], 'bob-work')
    const r = await resumeAs(d, { ...o, account: 'alice' })
    // The copy is told apart from the old one: its ticket link and PRs follow (Sources.noteCopy).
    expect(copies).toEqual(['e168c2bf>6d996951'])
    expect(r).toMatchObject({ ok: true, copy: { old: 'e168c2bf', copy: '6d996951' } })
    expect(calls).toEqual([['--bg', '--settings', '/acc/alice.settings.json', '--resume', S1, '-n', 'fix-12']])
    expect(calls.flat()).not.toContain('rm')
    expect(superseded.sort()).toEqual(['e168c2bf', S1].sort())
    expect(a.get({ sessionId: 'new', key: '6d996951' })).toBe('alice')
    // The old session keeps its own record.
    expect(a.get({ sessionId: S1, key: 'e168c2bf' })).toBe('bob-work')
  })
  it('an account picked for a session with no record is a choice too', async () => {
    const { calls, superseded, d } = setup(COPY_OUT)
    await resumeAs(d, { ...o, account: 'alice' })
    expect(calls).toEqual([['--bg', '--settings', '/acc/alice.settings.json', '--resume', S1, '-n', 'fix-12']])
    expect(superseded).toContain('e168c2bf')
  })
  it('a rename: a copy under the new name; the same name is no rename', async () => {
    const { calls, superseded, d } = setup(COPY_OUT, false)
    await resumeAs(d, { ...o, rename: 'fix-12-again' })
    expect(calls).toEqual([['--bg', '--resume', S1, '-n', 'fix-12-again']])
    expect(superseded).toContain('e168c2bf')
    const same = setup(WOKE_OUT, false)
    await resumeAs(same.d, { ...o, rename: 'fix-12' })
    expect(same.calls).toEqual([['--bg', '--resume', S1]])
  })
  it('a copy is refused while the old session runs, by a fresh read of the list and its pid alone', async () => {
    // The last poll says stopped; the fresh read shows a process (state done or not).
    const { calls, superseded, d, st } = setup(COPY_OUT)
    st.fresh = [row({ pid: 4242, state: 'done' })]
    const r = await resumeAs(d, { ...o, account: 'alice' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/fix-12 is running/)
    expect(st.refreshes).toBe(1)
    expect(calls).toEqual([])
    expect(superseded).toEqual([])
    // The fresh read failed: no guess.
    const none = setup(COPY_OUT)
    none.st.fresh = null
    expect((await resumeAs(none.d, { ...o, account: 'alice' })).ok).toBe(false)
    expect(none.calls).toEqual([])
  })
  it('nothing is superseded unless the output says this session was copied', async () => {
    const woke = setup(WOKE_OUT)
    await resumeAs(woke.d, { ...o, account: 'alice' })
    expect(woke.superseded).toEqual([])
    const other = setup(COPY_OUT)
    other.st.live = [row({ key: 'aaaa1111', bgId: 'aaaa1111' })]
    await resumeAs(other.d, { ...o, key: 'aaaa1111', account: 'alice' })
    expect(other.superseded).toEqual([])
  })
  it('not a background session (History, an interactive one for Start here): --settings and -n as a new start', async () => {
    const multi = setup(START_OUT)
    multi.st.live = []
    await resumeAs(multi.d, { ...o, key: null, account: 'bob-work' })
    expect(multi.calls).toEqual([['--bg', '--settings', '/acc/bob-work.settings.json', '--resume', S1, '-n', 'fix-12']])
    expect(multi.superseded).toEqual([])
    expect(multi.a.get({ sessionId: S1, key: 'x' })).toBe('bob-work')
    expect(multi.a.get({ sessionId: 'new', key: '1a2b3c4d' })).toBe('bob-work')
    const one = setup(START_OUT, false)
    one.st.live = [row({ kind: 'interactive', bgId: null, key: S1, pid: 99, state: 'working' })]
    await resumeAs(one.d, { ...o, key: null })
    expect(one.calls).toEqual([['--bg', '--resume', S1, '-n', 'fix-12']])
    // A name that can't be passed safely is left out.
    const odd = setup(START_OUT, false)
    odd.st.live = []
    await resumeAs(odd.d, { ...o, key: null, name: '--model x' })
    expect(odd.calls).toEqual([['--bg', '--resume', S1]])
  })
  it('the session list not loaded: read once more; still unknown, one account resumes bare as it always did, two refuse', async () => {
    const got = setup(WOKE_OUT, false)
    got.st.live = null
    got.st.fresh = [row()]
    await resumeAs(got.d, o)
    expect(got.calls).toEqual([['--bg', '--resume', S1]])
    expect(got.st.refreshes).toBe(1)
    const one = setup(WOKE_OUT, false)
    one.st.live = null
    expect((await resumeAs(one.d, o)).ok).toBe(true)
    expect(one.calls).toEqual([['--bg', '--resume', S1]])
    const two = setup(WOKE_OUT)
    two.st.live = null
    const r = await resumeAs(two.d, o)
    expect(r.ok).toBe(false)
    expect(two.calls).toEqual([])
    // A rename needs the list (it starts a copy): refused with one account too.
    const ren = setup(COPY_OUT, false)
    ren.st.live = null
    expect((await resumeAs(ren.d, { ...o, rename: 'other' })).ok).toBe(false)
    expect(ren.calls).toEqual([])
  })
  it('no bg id printed for a new background session: matched by name, unless another live session has that name', async () => {
    const one = setup('resumed\n')
    one.st.live = []
    await resumeAs(one.d, { ...o, key: null, account: 'bob-work' })
    one.a.claim([{ sessionId: 's2', key: '3c4d5e6f', name: 'fix-12', state: 'working' }])
    expect(one.a.get({ sessionId: 's2', key: 'x' })).toBe('bob-work')
    const two = setup('resumed\n')
    two.st.live = [row({ sessionId: 's9', key: 'k9', bgId: 'k9', pid: 7, state: 'working' })]
    await resumeAs(two.d, { ...o, key: null, account: 'bob-work' })
    two.a.claim([{ sessionId: 's2', key: '3c4d5e6f', name: 'fix-12', state: 'working' }])
    expect(two.a.get({ sessionId: 's2', key: '3c4d5e6f' })).toBeNull()
  })
  it('a refused account (only asked when flags are needed), or a failed command, runs or records nothing', async () => {
    const { calls, d } = setup('')
    const no = { ...d, settings: async () => ({ ok: false as const, message: 'GitHub account bob-work needs to log in again' }) }
    expect(await resumeAs(no, { ...o, account: 'bob-work' })).toEqual({ ok: false, message: 'GitHub account bob-work needs to log in again' })
    expect(calls).toEqual([])
    // A bare resume needs no account: still loading or logged out, it wakes all the same.
    expect((await resumeAs(no, o)).ok).toBe(true)
    expect(calls).toEqual([['--bg', '--resume', S1]])
    const bad = setup('', false)
    const f = await resumeAs({ ...bad.d, run: async () => ({ code: 1, stdout: '', stderr: 'no such session' }) }, o)
    expect(f).toEqual({ ok: false, message: 'no such session' })
  })
})

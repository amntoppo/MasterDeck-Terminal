import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareSetupDir, SetupPump } from './setupClaude'

const fresh = () => mkdtempSync(join(tmpdir(), 'md-setup-claude-'))
const ask = (dir: string, id: string, ...args: string[]) => {
  mkdirSync(join(dir, 'requests'), { recursive: true })
  writeFileSync(join(dir, 'requests', `${id}.req`), args.map((a) => `${a}\0`).join(''))
}
const answerOf = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, 'answers', `${id}.json`), 'utf8'))
const settle = () => new Promise((r) => setTimeout(r, 0))
const detect = {
  user: 'alice',
  owners: [{ login: 'acme', type: 'organization', repos: [{ repo: 'acme/api', openIssues: 2 }], projects: [{ owner: 'acme', number: 3, title: 'Team', columns: ['Todo', 'Done'], id: 'P1', statuses: {} }] }],
}

function pump(dir: string) {
  const h = {
    tools: vi.fn(async () => ({ ok: true, tools: { jq: { ok: true, detail: 'jq-1.7' } } })),
    accounts: vi.fn(async () => ({ ok: true, accounts: [{ login: 'alice', active: true, ok: true, projectScope: true }] })),
    discover: vi.fn(async (_login: string) => ({ ok: true as const, data: detect })),
  }
  return { h, p: new SetupPump(() => dir, h) }
}

describe('prepareSetupDir', () => {
  it('writes the briefing, an executable helper and its permissions, and drops the last conversation', () => {
    const dir = fresh()
    ask(dir, '1-1-1', 'tools')
    writeFileSync(join(dir, 'review.json'), '{}')
    prepareSetupDir(dir, 'darwin')
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('# MasterDeck: setting up with the user')
    expect(statSync(join(dir, 'md-setup.sh')).mode & 0o111).toBeTruthy()
    const allow = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).permissions.allow
    expect(allow).toContain('Bash(./md-setup.sh:*)')
    expect(allow.some((a: string) => a.includes('brew'))).toBe(false)
    expect(existsSync(join(dir, 'requests'))).toBe(false)
    expect(existsSync(join(dir, 'review.json'))).toBe(false)
  })
})

describe('SetupPump', () => {
  it('answers tools and accounts itself, and claims each request once', async () => {
    const dir = fresh()
    const { h, p } = pump(dir)
    ask(dir, '1-1-1', 'tools')
    ask(dir, '1-1-2', 'accounts')
    expect(p.poll().requests).toEqual([])
    await settle()
    expect(answerOf(dir, '1-1-1').tools.jq.ok).toBe(true)
    expect(answerOf(dir, '1-1-2').accounts[0].login).toBe('alice')
    p.poll()
    expect(h.tools).toHaveBeenCalledTimes(1)
  })

  it("discover answers a short list and hands the full answer to the window once per login it doesn't know", async () => {
    const dir = fresh()
    const { h, p } = pump(dir)
    ask(dir, '1-1-1', 'discover', 'alice')
    p.poll()
    await settle()
    expect(h.discover).toHaveBeenCalledWith('alice')
    const a = answerOf(dir, '1-1-1')
    expect(a.owners[0].projects[0]).toEqual({ owner: 'acme', number: 3, title: 'Team', columns: ['Todo', 'Done'], sprintField: null, items: 0, closed: false })
    expect(a.owners[0].projects[0].id).toBeUndefined()
    expect(p.poll().found).toEqual({ alice: detect })
    expect(p.poll(['alice']).found).toEqual({})
    p.reset()
    expect(p.poll().found).toEqual({})
  })

  it('refuses a bad login without asking GitHub', () => {
    const dir = fresh()
    const { h, p } = pump(dir)
    ask(dir, '1-1-1', 'discover', '--paginate')
    p.poll()
    expect(answerOf(dir, '1-1-1').ok).toBe(false)
    expect(h.discover).not.toHaveBeenCalled()
  })

  it('hands review (with its parsed draft) and gh-login to the window, and writes its answer', () => {
    const dir = fresh()
    const { p } = pump(dir)
    writeFileSync(join(dir, 'review.json'), '{"accounts":[]}')
    ask(dir, '1-1-1', 'review', 'review.json')
    ask(dir, '1-1-2', 'gh-login')
    const got = p.poll().requests
    expect(got).toEqual([
      { id: '1-1-1', cmd: 'review', draft: { accounts: [] } },
      { id: '1-1-2', cmd: 'gh-login' },
    ])
    expect(p.answer('1-1-1', { ok: true })).toBe(true)
    expect(answerOf(dir, '1-1-1')).toEqual({ ok: true })
    // Once only; never an id that was not claimed.
    expect(p.answer('1-1-1', { ok: true })).toBe(false)
    expect(p.answer('9-9-9', { ok: true })).toBe(false)
    expect(p.answer('../x', { ok: true })).toBe(false)
  })

  it('refuses a draft outside its folder, or one that is not JSON', () => {
    const dir = fresh()
    const out = join(fresh(), 'review.json')
    writeFileSync(out, '{}')
    writeFileSync(join(dir, 'bad.json'), '{nope')
    const { p } = pump(dir)
    ask(dir, '1-1-1', 'review', out)
    ask(dir, '1-1-2', 'review', 'bad.json')
    ask(dir, '1-1-3', 'rm', '-rf')
    expect(p.poll().requests).toEqual([])
    expect(answerOf(dir, '1-1-1').errors[0]).toContain('in this folder')
    expect(answerOf(dir, '1-1-2').errors[0]).toContain('not valid JSON')
    expect(answerOf(dir, '1-1-3').error).toContain('unknown command')
  })

  it('never follows a requests or answers folder the session replaced with a link', () => {
    const dir = fresh()
    const outside = fresh()
    writeFileSync(join(outside, 'keep.txt'), 'mine')
    utimesSync(join(outside, 'keep.txt'), new Date(0), new Date(0))
    symlinkSync(outside, join(dir, 'answers'))
    const { p } = pump(dir)
    p.poll()
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    expect(lstatSync(join(dir, 'answers'), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('skips request names it did not make', () => {
    const dir = fresh()
    const { h, p } = pump(dir)
    ask(dir, 'x; rm', 'tools')
    p.poll()
    expect(h.tools).not.toHaveBeenCalled()
  })
})

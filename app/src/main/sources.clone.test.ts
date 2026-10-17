import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import { Sources } from './sources'
import { CloneStore } from './clones'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-clone-src-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ORIG = { key: 'a0cd01ba', sessionId: 'a0cd01ba-e314-4d94-9050-647904c6e104', name: 'orig' }
const CLONE = { key: '83c38441', sessionId: '83c38441-0b1b-4ac0-9c63-9a58105daadf', name: 'orig (clone)' }
const AT = Date.parse('2026-10-16T23:41:40.000Z')
const session = (o: typeof ORIG) => ({ ...o, kind: 'background', bgId: o.key, pid: 1, cwd: dir, state: 'idle', rawState: 'idle', startedAt: AT, issue: null })

function make() {
  const p = (n: string) => join(dir, n)
  const paths = { libDir: dir, bundledTee: p('tee'), installedTee: p('tee2'), home: dir, statsDir: p('stats'), claudeSettings: p('settings.json'), projectsDir: p('projects'), ledger: p('ledger'), masterWorkspace: p('ws'), python: 'python3', babysitState: p('bs'), ticketLinks: p('links.json'), bundledSkills: p('skills'), skillsDir: p('skills2'), config: p('config.json') }
  const src = new Sources(paths as never, (async () => ({ code: 1, stdout: '', stderr: 'no' })) as never, {} as never, () => {})
  const priv = src as unknown as Record<string, any>
  priv.config = parseConfig({ owner: 'acme', issueRepo: 'web', repos: ['acme/web'] })
  const clones = new CloneStore(p('session-clones.json'))
  src.setClones(clones)
  priv.rawSessions = [session(ORIG), session(CLONE)]
  return { src, priv, clones }
}

const pr = (n: number, ts: string) => JSON.stringify({ type: 'pr-link', sessionId: CLONE.sessionId, prUrl: `https://github.com/acme/web/pull/${n}`, timestamp: ts })

describe('Sources and clones', () => {
  it("a clone's transcript gives it only the PRs it made after it was cloned", () => {
    const { priv, clones } = make()
    clones.add(CLONE.key, { from: { key: ORIG.key, name: ORIG.name }, at: AT, branch: 'main' })
    const t = join(dir, 'clone.jsonl')
    writeFileSync(t, [pr(1, '2026-10-16T23:41:21.569Z'), pr(2, '2026-10-16T23:42:00.000Z')].join('\n') + '\n')
    priv.followPrs(t, CLONE.key)
    expect(priv.openedPrs[CLONE.key]).toEqual(['https://github.com/acme/web/pull/2'])
    expect(priv.createdPrs[CLONE.key]).toEqual(['https://github.com/acme/web/pull/2'])
  })

  it('a session that is not a clone still takes every PR of its transcript', () => {
    const { priv } = make()
    const t = join(dir, 'orig.jsonl')
    writeFileSync(t, [pr(1, '2026-10-16T23:41:21.569Z'), pr(2, '2026-10-16T23:42:00.000Z')].join('\n') + '\n')
    priv.followPrs(t, ORIG.key)
    expect(priv.openedPrs[ORIG.key]).toHaveLength(2)
  })

  it("a clone takes its folder branch's PR only once it moved off the branch it was cloned on", () => {
    const { priv, clones } = make()
    clones.add(CLONE.key, { from: { key: ORIG.key, name: ORIG.name }, at: AT, branch: '136-x' })
    const k = { key: CLONE.key, name: CLONE.name, cwd: dir, startedAt: AT }
    expect(priv.branchDir(dir, k, '136-x')).toBeUndefined()
    expect(priv.branchDir(dir, k, '136-y')).toBe(dir)
    expect(priv.branchDir(dir, { ...k, key: ORIG.key }, '136-x')).toBe(dir)
  })

  it('the built state says what a clone came from, and which sessions have no conversation', () => {
    const { src, priv, clones } = make()
    clones.add(CLONE.key, { from: { key: ORIG.key, name: ORIG.name }, at: AT, branch: null })
    priv.noTranscript = new Set([ORIG.sessionId])
    const ss = src.build().sessions
    expect(ss.find((s) => s.key === CLONE.key)?.clonedFrom).toEqual({ key: ORIG.key, name: ORIG.name })
    expect(ss.find((s) => s.key === ORIG.key)?.clonedFrom).toBeUndefined()
    expect(ss.find((s) => s.key === ORIG.key)?.noConversation).toBe(true)
    expect(ss.find((s) => s.key === CLONE.key)?.noConversation).toBeUndefined()
  })

  it('links a clone started with Keep ticket link once it is listed, once', async () => {
    const { src, priv, clones } = make()
    mkdirSync(join(dir, 'projects'), { recursive: true })
    clones.add(CLONE.key, { from: { key: ORIG.key, name: ORIG.name }, at: AT, branch: null, ticket: { repo: null, number: 7 } })
    clones.add('11111111', { from: { key: ORIG.key, name: ORIG.name }, at: AT, branch: null })
    const linker = vi.fn(async () => ({ ok: true, message: 'linked' }))
    src.setLinker(linker)
    priv.carryLinks()
    await new Promise((r) => setTimeout(r, 5))
    expect(linker).toHaveBeenCalledTimes(1)
    expect(linker).toHaveBeenCalledWith({ repo: null, number: 7 }, CLONE.sessionId, dir)
    expect(clones.get(CLONE.key)?.linked).toBe(true)
    priv.carryTried = {}
    priv.carryLinks()
    expect(linker).toHaveBeenCalledTimes(1)
  })
})

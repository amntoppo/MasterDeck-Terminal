import { describe, expect, it } from 'vitest'
import { toDefaultBranch } from './defaultBranch'
import type { RunResult } from './run'

/** A fake git: answers by the joined args, and records every call. */
function fakeGit(answers: Record<string, Partial<RunResult>>) {
  const calls: string[] = []
  const run = async (_cmd: string, args: string[]): Promise<RunResult> => {
    const key = args.join(' ')
    calls.push(key)
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k))?.[1] ?? {}
    return { code: 0, stdout: '', stderr: '', ...hit }
  }
  return { run, calls }
}

const base = {
  'rev-parse --show-toplevel': { stdout: '/w/repo\n' },
  'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main\n' },
}

describe('toDefaultBranch', () => {
  it('stashes changes, switches to the default branch, and fast-forwards', async () => {
    const g = fakeGit({ ...base, 'branch --show-current': { stdout: 'docs/x\n' }, 'status --porcelain': { stdout: ' M a.md\n' }, pull: { stdout: 'Fast-forward\n' } })
    const r = await toDefaultBranch(g.run, '/w/repo', '2026-09-28')
    expect(g.calls).toContain('stash push --include-untracked -m masterdeck: docs/x before switching to main (2026-09-28)')
    expect(g.calls).toContain('switch main')
    expect(g.calls).toContain('pull --ff-only')
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/^Switched repo from docs\/x to main; stashed the changes on docs\/x/)
  })
  it('switches without a stash when clean, and says nothing when already on it and up to date', async () => {
    const clean = fakeGit({ ...base, 'branch --show-current': { stdout: 'feat\n' }, pull: { stdout: 'Already up to date.\n' } })
    expect((await toDefaultBranch(clean.run, '/w/repo')).message).toBe('Switched repo from feat to main')
    expect(clean.calls.some((c) => c.startsWith('stash'))).toBe(false)
    const on = fakeGit({ ...base, 'branch --show-current': { stdout: 'main\n' }, pull: { stdout: 'Already up to date.\n' } })
    expect(await toDefaultBranch(on.run, '/w/repo')).toEqual({ ok: true, message: null })
  })
  it('puts the changes back when the switch fails', async () => {
    const g = fakeGit({ ...base, 'branch --show-current': { stdout: 'docs/x\n' }, 'status --porcelain': { stdout: '?? n\n' }, 'switch main': { code: 1, stderr: 'error: boom' } })
    const r = await toDefaultBranch(g.run, '/w/repo')
    expect(g.calls).toContain('stash pop')
    expect(r).toEqual({ ok: false, message: 'Stayed on docs/x: could not switch to main (error: boom)' })
  })
  it('leaves a folder alone that is not a repo root', async () => {
    const g = fakeGit({ 'rev-parse --show-toplevel': { stdout: '/w/repo\n' } })
    expect(await toDefaultBranch(g.run, '/w/repo/sub')).toEqual({ ok: true, message: null })
    expect(g.calls).toEqual(['rev-parse --show-toplevel'])
  })
})

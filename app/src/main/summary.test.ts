import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Runner } from './run'
import { Summaries } from './summary'

const SID = '4f2a9c1e-1234-4abc-9def-0123456789ab'

describe('Summaries', () => {
  it('summarizes with claude -p, saves it, and leaves no empty project folder behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sum-'))
    const projects = join(root, 'projects')
    mkdirSync(projects)
    const transcript = join(root, 't.jsonl')
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the login bug' } }) + '\n')
    const kept = join(projects, '-somewhere-else')
    mkdirSync(kept)
    writeFileSync(join(kept, 'x.jsonl'), '{}')
    let args: string[] = []
    let stdin = ''
    const run: Runner = async (cmd, a, opts) => {
      if (cmd !== 'claude') return { code: 1, stdout: '', stderr: 'no git' }
      args = a
      stdin = opts?.stdin ?? ''
      // What Claude Code does: a project folder for the cwd, even without saving the session.
      mkdirSync(join(projects, `-private-tmp-${basename(opts!.cwd!)}`, 'memory'), { recursive: true })
      return { code: 0, stdout: '**Goal**\n- Fix the login bug\n', stderr: '' }
    }
    const s = new Summaries(run, () => 'claude', join(root, 'summaries'), projects)
    const r = await s.make({ sessionId: SID, name: 'login', transcript, cwd: null, issue: 'o/r#5', prs: [] })
    expect(r.ok).toBe(true)
    expect(args).toEqual(['-p', '--model', 'haiku', '--no-session-persistence'])
    expect(stdin).toContain('USER: Fix the login bug')
    expect(stdin).toContain('o/r#5')
    expect(s.get(SID)?.text).toContain('Fix the login bug')
    expect(readdirSync(projects)).toEqual(['-somewhere-else'])
    expect(existsSync(join(kept, 'x.jsonl'))).toBe(true)
    expect((await s.make({ sessionId: 'nope', name: 'x', transcript, cwd: null, issue: null, prs: [] })).ok).toBe(false)
  })
})

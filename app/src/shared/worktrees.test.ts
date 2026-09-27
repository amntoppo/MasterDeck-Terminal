import { describe, expect, it } from 'vitest'
import { newWorktreeScan, scanWorktreeLines, worktreeAddPaths } from './worktrees'

const H = '/Users/me'
const line = (cwd: string, content: unknown[]) => JSON.stringify({ type: 'assistant', cwd, message: { role: 'assistant', content } })

describe('worktreeAddPaths', () => {
  it('resolves the path against cd, -C and the cwd, skipping options', () => {
    expect(worktreeAddPaths('cd /w/expo && git worktree add --detach .claude/worktrees/989-x origin/main 2>&1 | tail -1', '/w/agentic', H)).toEqual(['/w/expo/.claude/worktrees/989-x'])
    expect(worktreeAddPaths('git -C ~/w/app worktree add -b feat/1 ../app-1 origin/dev', '/tmp', H)).toEqual(['/Users/me/w/app-1'])
    expect(worktreeAddPaths('git worktree add "/abs/path with space" main', '/tmp', H)).toEqual(['/abs/path with space'])
    expect(worktreeAddPaths('git worktree list; git status', '/tmp', H)).toEqual([])
  })
})

describe('scanWorktreeLines', () => {
  it('collects EnterWorktree, its result, worktree adds and worktree cwds, once each', () => {
    const scan = newWorktreeScan()
    scanWorktreeLines(
      [
        line('/w/agentic', [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /w/expo && git worktree add --detach .claude/worktrees/989-x origin/main' } }]),
        line('/w/agentic', [{ type: 'tool_use', name: 'EnterWorktree', input: { path: '/w/expo/.claude/worktrees/989-x' } }]),
        JSON.stringify({ type: 'user', cwd: '/w/agentic', message: { role: 'user', content: [{ type: 'tool_result', content: 'Created worktree at /w/agentic/.claude/worktrees/989-runbook on branch worktree-989. The session is now working in the worktree.' }] } }),
        line('/w/agentic/.claude/worktrees/989-runbook', [{ type: 'text', text: 'hi' }]),
      ],
      scan,
      H,
    )
    expect(scan.paths).toEqual(['/w/expo/.claude/worktrees/989-x', '/w/agentic/.claude/worktrees/989-runbook'])
  })
})

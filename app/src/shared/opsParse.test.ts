import { describe, expect, it } from 'vitest'
import { summarizeTranscript } from './history'
import { parseWorktreeList } from './janitor'

describe('parseWorktreeList', () => {
  it('reads paths, branches and detached heads', () => {
    const t = 'worktree /r\nHEAD aaa\nbranch refs/heads/dev\n\nworktree /r/.claude/worktrees/x\nHEAD bbb\nbranch refs/heads/feat/x\n\nworktree /r/.claude/worktrees/y\nHEAD ccc\ndetached\n'
    expect(parseWorktreeList(t)).toEqual([
      { path: '/r', branch: 'dev', head: 'aaa' },
      { path: '/r/.claude/worktrees/x', branch: 'feat/x', head: 'bbb' },
      { path: '/r/.claude/worktrees/y', branch: null, head: 'ccc' },
    ])
  })
})

describe('summarizeTranscript', () => {
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/w', message: { content: 'start' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/lib/paywall_sheet.dart' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I updated Paywall_Sheet.dart to show the price.' }] } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'paywall', sessionId: 's' }),
    'not json paywall_sheet',
  ]
  it('finds files, snippets, title and cwd; case-insensitive fixed string', () => {
    const h = summarizeTranscript('s-1', '/p/s-1.jsonl', lines, 'paywall_sheet.dart', 5)!
    expect(h.title).toBe('paywall')
    expect(h.cwd).toBe('/w')
    expect(h.matches).toBe(2)
    expect(h.files).toEqual(['/w/lib/paywall_sheet.dart'])
    expect(h.snippets[0]).toContain('Paywall_Sheet.dart')
  })
  it('regex characters are literal; no match is null', () => {
    expect(summarizeTranscript('s', '/p', lines, 'paywall.*dart', 1)).toBeNull()
  })
})

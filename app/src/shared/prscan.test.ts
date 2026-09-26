import { describe, expect, it } from 'vitest'
import { addPrUrls, newPrScanState, scanLines } from './prscan'

const use = (id: string, command: string, name = 'Bash') =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { command } }] } })
const result = (id: string, content: unknown, is_error = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })

describe('scanLines', () => {
  it("reads Claude Code's pr-link entries (real shape), newest link last", () => {
    const s = newPrScanState()
    const pl = (n: number, repo = 'mobile-app') =>
      JSON.stringify({ type: 'pr-link', sessionId: 'x', prNumber: n, prUrl: `https://github.com/acme/${repo}/pull/${n}`, prRepository: `acme/${repo}`, timestamp: '2026-09-25T01:00:00Z' })
    expect(scanLines([pl(137)], s)).toBe(true)
    expect(scanLines([pl(605, 'api-server'), pl(137)], s)).toBe(true)
    expect(s.urls).toEqual(['https://github.com/acme/api-server/pull/605', 'https://github.com/acme/mobile-app/pull/137'])
    expect(scanLines([pl(137)], s)).toBe(false)
  })

  it('finds the URL printed by gh pr create run from a worktree (real shape)', () => {
    const s = newPrScanState()
    const found = scanLines(
      [
        use('t1', 'cd /repo/.claude/worktrees/cicd; gh pr create --repo acme/flutter-app --base dev --title x'),
        result('t1', 'https://github.com/acme/flutter-app/pull/66'),
      ],
      s,
    )
    expect(found).toBe(true)
    expect(s.urls).toEqual(['https://github.com/acme/flutter-app/pull/66'])
    expect(s.pending.size).toBe(0)
  })
  it('handles the result arriving in a later batch, and array content', () => {
    const s = newPrScanState()
    expect(scanLines([use('t2', 'git push -u origin x && gh pr create --fill')], s)).toBe(false)
    const found = scanLines(
      [result('t2', [{ type: 'text', text: 'remote: Create a pull request for x by visiting:\nremote: https://github.com/o/r/pull/new/x\nhttps://github.com/o/r/pull/143' }])],
      s,
    )
    expect(found).toBe(true)
    expect(s.urls).toEqual(['https://github.com/o/r/pull/143'])
  })
  it('ignores PR URLs from other commands, failed creates, and duplicates', () => {
    const s = newPrScanState()
    scanLines(
      [
        use('a', 'gh pr view 12 --repo o/r'),
        result('a', 'https://github.com/o/r/pull/12'),
        use('b', 'gh pr create --fill'),
        result('b', 'a pull request for branch "x" already exists: https://github.com/o/r/pull/9', true),
        use('c', 'gh pr create --fill'),
        result('c', 'https://github.com/o/r/pull/20'),
        use('d', 'gh pr create --fill'),
        result('d', 'https://github.com/o/r/pull/20'),
        'garbage line with tool_use',
      ],
      s,
    )
    expect(s.urls).toEqual(['https://github.com/o/r/pull/20'])
  })
  it('ignores a pr-link with a malformed URL', () => {
    const s = newPrScanState()
    expect(scanLines([JSON.stringify({ type: 'pr-link', prUrl: 'javascript:alert(1)' })], s)).toBe(false)
    expect(s.urls).toEqual([])
  })
  it('recognizes MCP create_pull_request tools', () => {
    const s = newPrScanState()
    scanLines(
      [
        JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'm', name: 'mcp__github__create_pull_request', input: { title: 't' } }] } }),
        result('m', [{ type: 'text', text: '{"html_url":"https://github.com/o/r/pull/7"}' }]),
      ],
      s,
    )
    expect(s.urls).toEqual(['https://github.com/o/r/pull/7'])
  })
})

describe('addPrUrls', () => {
  it('adds to an empty list, keeps the latest last, and reports changes', () => {
    const list: string[] = []
    expect(addPrUrls(list, ['https://github.com/o/a/pull/1', 'https://github.com/o/b/pull/2'])).toBe(true)
    expect(list).toEqual(['https://github.com/o/a/pull/1', 'https://github.com/o/b/pull/2'])
    expect(addPrUrls(list, ['https://github.com/o/b/pull/2'])).toBe(false)
    expect(addPrUrls(list, ['https://github.com/o/a/pull/1'])).toBe(true)
    expect(list).toEqual(['https://github.com/o/b/pull/2', 'https://github.com/o/a/pull/1'])
  })
})

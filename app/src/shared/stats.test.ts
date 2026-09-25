import { describe, expect, it } from 'vitest'
import { contextLevel, contextWindowFor, parseStatusline, parseTranscriptTail, statsFromTranscript } from './stats'

const STATUS = JSON.stringify({
  session_id: 'abc',
  model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5 (1M)' },
  workspace: { current_dir: '/repo/.claude/worktrees/x', project_dir: '/repo' },
  cost: { total_cost_usd: 1.84, total_lines_added: 124, total_lines_removed: 37 },
  context_window: { used_percentage: 62.4 },
  permission_mode: 'auto',
})

describe('parseStatusline', () => {
  it('reads every field', () => {
    const s = parseStatusline(STATUS, 1000)!
    expect(s).toMatchObject({
      costUsd: 1.84,
      contextPct: 62.4,
      model: 'Opus 5.5 (1M)',
      permissionMode: 'auto',
      currentDir: '/repo/.claude/worktrees/x',
      linesAdded: 124,
      linesRemoved: 37,
      source: 'statusline',
      updatedAt: 1000,
    })
  })
  it('returns null for a truncated file (keep the last good value)', () => {
    expect(parseStatusline(STATUS.slice(0, 40), 1)).toBeNull()
    expect(parseStatusline('', 1)).toBeNull()
  })
  it('computes context from token counts when the percentage is absent', () => {
    const s = parseStatusline(
      JSON.stringify({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 1000, cache_read_input_tokens: 49000, cache_creation_input_tokens: 0 },
        },
      }),
      1,
    )!
    expect(s.contextPct).toBeCloseTo(25)
    expect(s.costUsd).toBeNull()
  })
})

const line = (o: object) => JSON.stringify(o)
const assistant = (ts: string, content: object[], usage = { input_tokens: 10, cache_read_input_tokens: 90 }) =>
  line({ type: 'assistant', timestamp: ts, cwd: '/w', gitBranch: 'feat/x', message: { model: 'claude-opus-5-5', usage, content } })

describe('parseTranscriptTail', () => {
  it('picks the newest tool use, skipping a partial first line and garbage lines', () => {
    const text = [
      '{"type":"assistant","trunc',
      assistant('2026-09-24T10:00:00Z', [{ type: 'tool_use', name: 'Read' }]),
      'not json at all',
      line({ type: 'permission-mode', permissionMode: 'plan' }),
      assistant('2026-09-24T10:05:00Z', [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Edit' }]),
      line({ type: 'user', timestamp: '2026-09-24T10:06:00Z', cwd: '/w' }),
      '',
    ].join('\n')
    const t = parseTranscriptTail(text, false)
    expect(t.lastTool).toBe('Edit')
    expect(t.lastToolAt).toBe(Date.parse('2026-09-24T10:05:00Z'))
    expect(t.lastActivityAt).toBe(Date.parse('2026-09-24T10:06:00Z'))
    expect(t.model).toBe('claude-opus-5-5')
    expect(t.contextTokens).toBe(100)
    expect(t.permissionMode).toBe('plan')
    expect(t.gitBranch).toBe('feat/x')
  })
  it('ignores sidechain (subagent) lines', () => {
    const text = [
      assistant('2026-09-24T10:00:00Z', [{ type: 'tool_use', name: 'Bash' }]),
      line({ type: 'assistant', isSidechain: true, timestamp: '2026-09-24T11:00:00Z', message: { content: [{ type: 'tool_use', name: 'Grep' }] } }),
    ].join('\n')
    expect(parseTranscriptTail(text, true).lastTool).toBe('Bash')
  })
  it('handles an empty tail', () => {
    expect(parseTranscriptTail('', true).lastTool).toBeNull()
  })
})

describe('context window and level', () => {
  it('detects 1M windows', () => {
    expect(contextWindowFor('claude-opus-5-5[1m]', 10)).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-5-5', 300_000)).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-5-5', 100_000)).toBe(200_000)
  })
  it('statsFromTranscript has no cost and a computed context', () => {
    const s = statsFromTranscript(
      { model: 'm', contextTokens: 100_000, lastTool: null, lastToolAt: null, lastActivityAt: 5, cwd: '/w', gitBranch: null, permissionMode: null },
      9,
    )
    expect(s.costUsd).toBeNull()
    expect(s.contextPct).toBe(50)
    expect(s.source).toBe('transcript')
  })
  it('levels at 60 and 85', () => {
    expect(contextLevel(59.9)).toBe('ok')
    expect(contextLevel(60)).toBe('warn')
    expect(contextLevel(85)).toBe('high')
    expect(contextLevel(null)).toBe('ok')
  })
})

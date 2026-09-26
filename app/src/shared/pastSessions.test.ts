import { describe, expect, it } from 'vitest'
import { pastByIssue, type TranscriptInfo } from './pastSessions'

const A1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const A2 = 'aaaaaaaa-0000-4000-8000-000000000002' // A resumed: same background id aaaaaaaa
const B = 'bbbbbbbb-0000-4000-8000-000000000001'
const C = 'cccccccc-0000-4000-8000-000000000001' // transcript gone
const D = 'dddddddd-0000-4000-8000-000000000001' // running now

const info = (m: Record<string, TranscriptInfo>) => (id: string) => m[id] ?? null

describe('pastByIssue', () => {
  it('one entry per session (resumes merged), newest id with a transcript, newest first, running ones left out', () => {
    const links = new Map([
      [A1, { issue: 5, linkedAt: 1 }],
      [A2, { issue: 5, linkedAt: 2 }],
      [B, { issue: 5, linkedAt: 3 }],
      [C, { issue: 6, linkedAt: 1 }],
      [D, { issue: 7, linkedAt: 1 }],
    ])
    const got = pastByIssue(links, { aaaaaaaa: [A1, A2] }, new Set([D]), info({
      [A1]: { mtime: 100, title: 'old', cwd: '/w' },
      [A2]: { mtime: 300, title: 'fix it', cwd: '/w/wt' },
      [B]: { mtime: 200, title: null, cwd: null },
      [D]: { mtime: 400, title: 'live', cwd: '/w' },
    }))
    expect(got[5].map((p) => [p.sessionId, p.name, p.cwd])).toEqual([[A2, 'fix it', '/w/wt'], [B, '#5 bbbbbbbb', null]])
    expect(got[6]).toBeUndefined()
    expect(got[7]).toBeUndefined()
  })
  it('a running resume hides the whole session', () => {
    const links = new Map([[A1, { issue: 5, linkedAt: 1 }]])
    expect(pastByIssue(links, { aaaaaaaa: [A1, A2] }, new Set([A2]), info({ [A1]: { mtime: 1, title: 'x', cwd: null } }))).toEqual({})
  })
})

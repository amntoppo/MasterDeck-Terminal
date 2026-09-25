import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tokenSum, totalOf } from '@shared/tokens'
import { TranscriptIndex } from './files'
import { TokenIndex } from './tokens'

const SID = '4f2a9c1e-1234-4abc-9def-0123456789ab'
const line = (id: string, out: number) => JSON.stringify({ timestamp: '2026-09-25T10:00:00Z', message: { id, usage: { input_tokens: 1, output_tokens: out } } }) + '\n'

describe('TokenIndex', () => {
  it('adds subagents, reads only new lines, and resumes from its cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tok-'))
    const proj = join(root, 'projects', '-w')
    mkdirSync(join(proj, SID, 'subagents'), { recursive: true })
    const main = join(proj, `${SID}.jsonl`)
    writeFileSync(main, line('a', 10) + line('a', 10) + line('b', 20))
    writeFileSync(join(proj, SID, 'subagents', 'agent-x.jsonl'), line('s', 100))
    const cache = join(root, 'tokens.json')
    const idx = new TokenIndex(new TranscriptIndex(join(root, 'projects')), cache)
    expect(tokenSum(totalOf((await idx.refresh([SID]))[SID]))).toBe(1 + 10 + 1 + 20 + 1 + 100)
    appendFileSync(main, line('c', 5) + '{"half":')
    expect(tokenSum(totalOf((await idx.refresh([SID]))[SID]))).toBe(133 + 6)
    idx.save()
    // A new process picks up from the saved offsets: the finished half line counts once.
    appendFileSync(main, '1}\n' + line('d', 1))
    const again = new TokenIndex(new TranscriptIndex(join(root, 'projects')), cache)
    expect(tokenSum(totalOf((await again.refresh([SID]))[SID]))).toBe(139 + 2)
    expect(await again.refresh(['00000000-0000-4000-8000-000000000000'])).toEqual({})
  })
})

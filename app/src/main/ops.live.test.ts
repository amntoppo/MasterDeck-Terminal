import { describe, expect, it } from 'vitest'
import { cleanEnv } from './env'
import { Ops } from './ops'
import { resolvePaths } from './paths'
import { makeRunner } from './run'

// Read-only checks against the real machine; run with LIVE=1.
describe.runIf(process.env.LIVE === '1')('ops (live, read-only)', () => {
  const paths = resolvePaths(process.cwd(), '', false)
  const ops = new Ops(makeRunner(() => cleanEnv(process.env)), paths, () => 'claude')
  it('janitor inventory', async () => {
    const rows = await ops.janitor([])
    console.log(rows.map((r) => `${r.cls.padEnd(8)} ${r.path.replace(/.*\/acme\//, '')} ${r.branch ?? '(detached)'} — ${r.reason}`).join('\n'))
    expect(rows.length).toBeGreaterThan(0)
  }, 120_000)
  it('history search', async () => {
    const t = Date.now()
    const hits = await ops.searchHistory('paywall_sheet.dart')
    console.log(`${hits.length} hits in ${Date.now() - t} ms`, hits.slice(0, 3).map((h) => `${h.title} [${h.matches}] ${h.files.join(', ')}`))
    expect(Array.isArray(hits)).toBe(true)
  }, 180_000)
  it('standup commits', async () => {
    const c = await ops.standupCommits(Date.now() - 2 * 86_400_000, ops.repos())
    console.log(`${c.length} commits`, c.slice(0, 3))
  }, 120_000)
})

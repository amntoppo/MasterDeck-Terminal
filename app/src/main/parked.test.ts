import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ParkedStore } from './parked'

const at = Date.parse('2026-10-05T10:00:00Z')

describe('ParkedStore', () => {
  it('(in a temp folder) reads parked-sessions.json, again when master spawn changed it; missing or broken is none', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'parked-')), 'parked-sessions.json')
    const s = new ParkedStore(f)
    expect(s.get({ key: '4f2a9c1e', name: 'api-7-x', cwd: '/code/acme/api', startedAt: at })).toBeNull()
    writeFileSync(f, JSON.stringify({ '4f2a9c1e': { dir: '/code/acme/api', branch: 'feat/x', review: false } }))
    expect(s.get({ key: '4f2a9c1e', name: 'api-7-x', cwd: '/code/acme/api', startedAt: at })).toEqual({ dir: '/code/acme/api', branch: 'feat/x', review: false })
    writeFileSync(f, JSON.stringify({ 'name:review-api-5': { dir: '/code/acme/api', branch: 'feat/x', review: true, at: '2026-10-05T10:00:00Z' } }))
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect(s.get({ key: '4f2a9c1e', name: 'api-7-x', cwd: '/code/acme/api', startedAt: at })).toBeNull()
    expect(s.get({ key: 'x', name: 'review-api-5', cwd: '/code/acme/api', startedAt: at })?.review).toBe(true)
    writeFileSync(f, 'not json')
    utimesSync(f, new Date(), new Date(Date.now() + 9000))
    expect(s.get({ key: 'x', name: 'review-api-5', cwd: '/code/acme/api', startedAt: at })).toBeNull()
  })
})

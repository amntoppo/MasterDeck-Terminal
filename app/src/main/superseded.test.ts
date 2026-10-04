import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hideSuperseded } from '@shared/superseded'
import { Superseded } from './superseded'

const file = () => join(mkdtempSync(join(tmpdir(), 'sup-')), 'superseded-sessions.json')
const SID = 'e168c2bf-1111-4111-8111-111111111111'
const row = (sessionId: string, bgId: string | null, pid: number | null) => ({ sessionId, bgId, pid })

describe('superseded sessions (the old side of a copy)', () => {
  it('hides a superseded background session that is not running, by its background id only; shows it when it runs again', () => {
    const ids = new Set(['e168c2bf', 's-old'])
    const rows = [row('s1', 'e168c2bf', null), row('s-old', 'x1', null), row('s2', 'e168c2bf', 77), row('s3', '6d996951', null), row('s-old', null, null), row('s4', null, 5)]
    // A session id in the list hides nothing by itself: the copy may share ids with what it was made from.
    expect(hideSuperseded(rows, ids).map((r) => `${r.sessionId}/${r.bgId}`)).toEqual(['s-old/x1', 's2/e168c2bf', 's3/6d996951', 's-old/null', 's4/null'])
    expect(hideSuperseded(rows, new Set())).toEqual(rows)
  })
  it('keeps its list in a file, merged with what was written there meanwhile (`master spawn`)', () => {
    const f = file()
    const a = new Superseded(f)
    expect([...a.ids()]).toEqual([])
    a.add(['e168c2bf', SID, '', 'e168c2bf'])
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual(['e168c2bf', SID])
    writeFileSync(f, JSON.stringify(['e168c2bf', SID, 'aaaa1111']))
    a.add(['bbbb2222'])
    expect([...new Superseded(f).ids()].sort()).toEqual(['aaaa1111', 'bbbb2222', 'e168c2bf', SID])
    // Anything that is not an id is dropped.
    writeFileSync(f, JSON.stringify(['e168c2bf', 'rm -rf', 7]))
    expect([...new Superseded(f).ids()]).toEqual(['e168c2bf'])
    writeFileSync(f, '{nope')
    expect([...new Superseded(f).ids()]).toEqual([])
  })
})

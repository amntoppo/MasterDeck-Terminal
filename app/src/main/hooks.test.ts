import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guardedBuiltin } from '@shared/flow'
import { hookStatus, installDeckHooks, LEGACY_COMMANDS, migrateLegacyHooks } from './hooks'

const TT = '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook'
const entry = (command: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] })

describe.skipIf(process.platform === 'win32')('migrateLegacyHooks', () => {
  it("removes exactly what MasterDeck installed for the skills and keeps the user's own", () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({
      model: 'x',
      hooks: {
        PostToolUse: [entry(guardedBuiltin('ticket', TT, d), 'Bash'), entry(guardedBuiltin('pr-watch', LEGACY_COMMANDS.prPost, d), 'Bash'), entry('my-own.sh', 'Bash')],
        SessionStart: [entry(TT)],
        UserPromptSubmit: [entry('"$HOME/.claude/skills/queue/scripts/queue-submit.sh"'), entry('$HOME/.claude/hooks/queue-submit.sh')],
        Stop: [entry('"$HOME/.claude/skills/queue/scripts/queue-drain.sh"')],
      },
    }))
    const r = migrateLegacyHooks(p, d)
    expect(r.removed.sort()).toEqual(['pr (PostToolUse)', 'queue (Stop)', 'queue (UserPromptSubmit)', 'ticket (PostToolUse)', 'ticket (SessionStart)'])
    const s = JSON.parse(readFileSync(p, 'utf8'))
    expect(s.model).toBe('x')
    expect(JSON.stringify(s.hooks)).toContain('my-own.sh')
    expect(JSON.stringify(s.hooks)).toContain('$HOME/.claude/hooks/queue-submit.sh')
    expect(JSON.stringify(s.hooks)).not.toContain('babysit-ticket')
    expect(s.hooks.Stop).toBeUndefined()
    expect(readdirSync(d).some((n) => n.startsWith('settings.backup.'))).toBe(true)
    // The hand-installed queue hook left behind switches MasterDeck's queue off.
    expect(hookStatus(p).foreignQueue).toBe(true)
  })
  it('keeps a hand-edited tt.sh call and an unrelated masterdeck-builtin wrapper', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'))
    const p = join(d, 'settings.json')
    const mine = '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook --verbose'
    writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [entry(mine), entry(guardedBuiltin('ticket', 'my-board.sh', d))] } }))
    expect(migrateLegacyHooks(p, d)).toEqual({ removed: [] })
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.SessionStart).toHaveLength(2)
  })
  it('is a no-op on a clean file (no write, no backup)', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, '{"hooks":{}}')
    expect(migrateLegacyHooks(p, d)).toEqual({ removed: [] })
    expect(readdirSync(d)).toEqual(['settings.json'])
  })
})

describe.skipIf(process.platform === 'win32')('hookStatus', () => {
  it('sees queue hooks installed by hand', () => {
    const d = mkdtempSync(join(tmpdir(), 'hs-'))
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({ hooks: { UserPromptSubmit: [entry('$HOME/.claude/hooks/queue-submit.sh')], Stop: [entry('$HOME/.claude/hooks/queue-drain.sh')] } }))
    expect(hookStatus(p)).toEqual({ queue: true, foreignQueue: true, reviewGate: false })
    expect(hookStatus(join(d, 'missing.json'))).toEqual({ queue: false, foreignQueue: false, reviewGate: false })
  })
  it("MasterDeck's hook runs /queue unless a half-installed skill hook switched it off", () => {
    const d = mkdtempSync(join(tmpdir(), 'hs-'))
    const p = join(d, 'settings.json')
    installDeckHooks(p, d, join(d, 'deck/hook.sh'))
    expect(hookStatus(p)).toEqual({ queue: true, foreignQueue: false, reviewGate: false })
    const s = JSON.parse(readFileSync(p, 'utf8'))
    s.hooks.Stop.push(entry('$HOME/.claude/hooks/queue-drain.sh'))
    writeFileSync(p, JSON.stringify(s))
    expect(hookStatus(p)).toEqual({ queue: false, foreignQueue: true, reviewGate: false })
  })
})

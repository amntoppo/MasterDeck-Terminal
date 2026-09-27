import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeckHooks, hookScript } from './deckHooks'
import { deckHooksInstalled, installDeckHooks } from './hooks'

const SID = '4d1bc2b2-2edb-4304-91fd-6633dc9bd935'

describe.skipIf(process.platform === 'win32')('the hook script', () => {
  it('is valid bash, logs events and prints the ticket context at SessionStart', () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-'))
    const d = new DeckHooks(home)
    d.setup()
    execFileSync('bash', ['-n', d.script])
    const run = (ev: string, input: object) => execFileSync(d.script, [ev], { input: JSON.stringify(input) }).toString()
    expect(run('Notification', { session_id: SID, notification_type: 'idle_prompt', message: "it's 100% idle" })).toBe('')
    d.setContext(SID, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } })
    expect(JSON.parse(run('SessionStart', { session_id: SID, source: 'compact' }))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } })
    expect(d.readEvents()).toEqual(new Set([SID]))
    expect(d.sessions[SID].notice?.message).toBe("it's 100% idle")
    expect(d.sessions[SID].compactedAt).not.toBeNull()
  })
  it('hands a permission request to MasterDeck and prints its answer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-'))
    const d = new DeckHooks(home)
    d.setup()
    const { spawn } = await import('node:child_process')
    const p = spawn(d.script, ['PermissionRequest'])
    let out = ''
    p.stdout.on('data', (b) => (out += b))
    p.stdin.end(JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' } }))
    let reqs = d.pending()
    for (let i = 0; i < 40 && !reqs.length; i++) {
      await new Promise((r) => setTimeout(r, 100))
      reqs = d.pending()
    }
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({ sessionId: SID, tool: 'Bash', input: { command: 'ls' } })
    expect(d.answer(reqs[0].id, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })).toBe(true)
    await new Promise((r) => p.on('exit', r))
    expect(JSON.parse(out).hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(d.pending()).toEqual([])
  })
  it('lets the terminal answer alone when MasterDeck is not running', () => {
    const home = mkdtempSync(join(tmpdir(), 'deck-'))
    writeFileSync(join(home, 'x'), '')
    const script = join(home, 'hook.sh')
    writeFileSync(script, hookScript(join(home, 'deck')), { mode: 0o755 })
    const t = Date.now()
    expect(execFileSync(script, ['PermissionRequest'], { input: JSON.stringify({ session_id: SID, tool_name: 'Bash' }) }).toString()).toBe('')
    expect(Date.now() - t).toBeLessThan(3000)
  })
})

describe.skipIf(process.platform === 'win32')('installDeckHooks', () => {
  it('adds one entry per event, keeps the rest, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'))
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] } }))
    expect(installDeckHooks(p, dir, '/h/deck/hook.sh').ok).toBe(true)
    expect(deckHooksInstalled(p)).toBe(true)
    const s = JSON.parse(readFileSync(p, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.Stop).toHaveLength(2)
    expect(s.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'command', command: '"/h/deck/hook.sh" PermissionRequest', timeout: 600 })
    expect(installDeckHooks(p, dir, '/h/deck/hook.sh').message).toBe('already installed')
    installDeckHooks(p, dir, '/other/deck/hook.sh')
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.PermissionRequest).toHaveLength(1)
  })
})

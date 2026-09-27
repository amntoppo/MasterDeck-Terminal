import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectHooks, listSkills } from './workflow'

describe('collectHooks', () => {
  it('reads user, project (each repo once) and enabled plugin hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'wfc-'))
    const claude = join(root, 'claude')
    const repo = join(root, 'repo')
    const plugin = join(root, 'plug')
    mkdirSync(join(claude, 'plugins'), { recursive: true })
    mkdirSync(join(repo, '.claude'), { recursive: true })
    mkdirSync(join(plugin, 'hooks'), { recursive: true })
    const hook = (command: string) => [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }]
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook' }] }] },
      statusLine: { type: 'command', command: 'python3 statusline_tee.py' },
      enabledPlugins: { 'on@m': true, 'off@m': false },
    }))
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: hook('guard.sh') } }))
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'on@m': [{ installPath: plugin }], 'off@m': [{ installPath: plugin }] } }))
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: hook('plug-stop.sh') } }))
    const got = collectHooks(claude, [repo, join(repo, '.'), repo])
    expect(got.map((h) => [h.source, h.where, h.event, h.owner ?? h.command])).toEqual([
      ['user', null, 'SessionStart', 'babysit-ticket'],
      ['user', null, 'StatusLine', 'MasterDeck status line (costs)'],
      ['project', 'repo', 'PreToolUse', 'guard.sh'],
      ['plugin', 'on', 'Stop', 'plug-stop.sh'],
    ])
  })
  it('lists skills with their descriptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfs-'))
    mkdirSync(join(dir, 'mine'))
    writeFileSync(join(dir, 'mine', 'SKILL.md'), '---\nname: mine\ndescription: "Deploys it"\n---\n')
    mkdirSync(join(dir, 'no-skill-file'))
    expect(listSkills(dir)).toEqual([{ name: 'mine', description: 'Deploys it' }])
  })
})

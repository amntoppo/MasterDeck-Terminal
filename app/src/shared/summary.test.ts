import { describe, expect, it } from 'vitest'
import { outline, summaryPrompt } from './summary'

const u = (text: string, extra: object = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra })
const a = (content: object[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } })

describe('outline', () => {
  it('keeps what the user asked, what Claude said, files it changed and commands that matter', () => {
    const lines = [
      u('Add a dark mode toggle to settings'),
      u('<system-reminder>ignore me</system-reminder>'),
      u('<command-name>/clear</command-name>'),
      u('side question', { isSidechain: true }),
      a([{ type: 'text', text: 'I will add it to SettingsScreen.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/Settings.tsx' } }]),
      a([{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/Settings.tsx' } }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }]),
      a([{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "dark mode"' } }, { type: 'tool_use', name: 'Bash', input: { command: 'gh pr create --fill' } }]),
      'not json',
    ]
    expect(outline(lines).split('\n')).toEqual([
      'USER: Add a dark mode toggle to settings',
      'CLAUDE: I will add it to SettingsScreen.',
      'EDIT src/Settings.tsx',
      'RAN git commit -m "dark mode"',
      'RAN gh pr create --fill',
    ])
  })
  it('keeps the start and the end of a long session', () => {
    const lines = [u('THE GOAL'), ...Array.from({ length: 400 }, (_, i) => a([{ type: 'text', text: `step ${i} ${'x'.repeat(400)}` }])), a([{ type: 'text', text: 'THE END' }])]
    const o = outline(lines)
    expect(o.length).toBeLessThanOrEqual(60_000)
    expect(o).toContain('THE GOAL')
    expect(o).toContain('THE END')
    expect(o).toContain('earlier work left out')
  })
  it('asks for the five sections, in plain English', () => {
    const p = summaryPrompt('s', 'o/r#1', ['o/r#2'], ' a.ts | 2 +-', 'USER: hi')
    for (const h of ['**Goal**', '**Done**', '**Decisions**', '**Open**', '**State**', 'normal, complete English', 'o/r#1', 'a.ts']) expect(p).toContain(h)
  })
})

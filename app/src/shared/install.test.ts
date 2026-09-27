import { describe, expect, it } from 'vitest'
import { claudeInstall, installable, installPrompt } from './install'

describe('install', () => {
  it('gives the Claude Code install command per platform', () => {
    expect(claudeInstall('darwin').command).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(claudeInstall('win32')).toEqual({ shell: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' })
  })

  it('keeps only known tools, once each', () => {
    expect(installable(['jq', 'gh', 'jq', 'claude', 'rm -rf /', 3])).toEqual(['jq', 'gh'])
    expect(installable('gh')).toEqual([])
  })

  it('asks for exactly the missing tools, with the platform installer', () => {
    const mac = installPrompt(['gh', 'jq'], 'darwin')
    expect(mac).toContain('GitHub CLI (gh), jq')
    expect(mac).toContain('brew install gh jq')
    expect(mac).toContain('`gh --version`, `jq --version`')
    expect(mac).not.toContain('Python')
    expect(installPrompt(['python'], 'win32')).toContain('Python 3 → Python.Python.3.12')
  })
})

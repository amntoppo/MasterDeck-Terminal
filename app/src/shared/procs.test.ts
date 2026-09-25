import { describe, expect, it } from 'vitest'
import { isClaudeCommand, tasklistImage } from './procs'

describe('isClaudeCommand', () => {
  it('accepts claude by path or name, and nothing else', () => {
    expect(isClaudeCommand('/Users/a/.local/bin/claude\n')).toBe(true)
    expect(isClaudeCommand('claude')).toBe(true)
    expect(isClaudeCommand('claude.exe')).toBe(true)
    expect(isClaudeCommand('zsh')).toBe(false)
    expect(isClaudeCommand('node')).toBe(false)
    expect(isClaudeCommand('')).toBe(false)
  })
  it('reads the image name from tasklist CSV', () => {
    expect(tasklistImage('"claude.exe","4242","Console","1","250,000 K"\r\n')).toBe('claude.exe')
    expect(tasklistImage('INFO: No tasks are running which match the specified criteria.')).toBeNull()
  })
})

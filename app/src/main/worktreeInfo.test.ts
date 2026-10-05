import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inLinkedWorktree, takesBranchPr } from './worktreeInfo'

function tree() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')))
  const main = join(d, 'api')
  mkdirSync(join(main, '.git'), { recursive: true })
  mkdirSync(join(main, 'src'), { recursive: true })
  const wt = join(main, '.claude', 'worktrees', '12-x')
  mkdirSync(join(wt, 'src'), { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', '12-x')}\n`)
  mkdirSync(join(d, 'plain'))
  return { d, main, wt }
}

describe('inLinkedWorktree', () => {
  it('a linked worktree (its .git is a file), also from a folder inside it', () => {
    const t = tree()
    expect(inLinkedWorktree(t.wt)).toBe(true)
    expect(inLinkedWorktree(join(t.wt, 'src'))).toBe(true)
  })
  it('never a main checkout, a folder inside one, a plain folder or a missing one', () => {
    const t = tree()
    expect(inLinkedWorktree(t.main)).toBe(false)
    expect(inLinkedWorktree(join(t.main, 'src'))).toBe(false)
    expect(inLinkedWorktree(join(t.d, 'plain'))).toBe(false)
    expect(inLinkedWorktree(t.d)).toBe(false)
    expect(inLinkedWorktree(join(t.d, 'gone'))).toBe(false)
  })
})

describe('takesBranchPr (the PR of the branch a session\'s folder is on)', () => {
  it('only a session working in a linked worktree gets it', () => {
    const t = tree()
    expect(takesBranchPr(t.wt, t.d)).toBe(true)
    expect(takesBranchPr(join(t.wt, 'src'), t.d)).toBe(true)
  })
  it('a session parked in a main checkout (a new ticket session, a PR review) or in a workspace does not', () => {
    const t = tree()
    expect(takesBranchPr(t.main, t.d)).toBe(false)
    expect(takesBranchPr(join(t.main, 'src'), t.d)).toBe(false)
    expect(takesBranchPr(t.d, t.d)).toBe(false)
    expect(takesBranchPr(join(t.d, 'plain'), t.d)).toBe(false)
    expect(takesBranchPr(undefined, t.d)).toBe(false)
    expect(takesBranchPr(join(t.d, 'gone'), t.d)).toBe(false)
  })
  it('master\'s workspace is shared even when it is a worktree itself', () => {
    const t = tree()
    expect(takesBranchPr(t.wt, t.wt)).toBe(false)
    expect(takesBranchPr(t.wt, `${t.wt}/`)).toBe(false)
  })
})

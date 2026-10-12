import { describe, expect, it } from 'vitest'
import { findPaths, insideRoot } from './filePath'

describe('insideRoot', () => {
  it('accepts relative paths and normalises them', () => {
    expect(insideRoot('src/a.ts')).toBe('src/a.ts')
    expect(insideRoot('./a.md')).toBe('a.md')
    expect(insideRoot('a/../b')).toBe('b')
    expect(insideRoot('a//b/')).toBe('a/b')
  })
  it('refuses anything that leaves the root or is not a path', () => {
    for (const p of ['../x', '/etc/passwd', 'a/../../x', '', '.', 'a\0b', 'C:\\x', 'C:/x', 'a\\..\\..\\x', '~/x'])
      expect(insideRoot(p)).toBeNull()
    expect(insideRoot(3)).toBeNull()
    expect(insideRoot(null)).toBeNull()
    expect(insideRoot('x'.repeat(5000))).toBeNull()
  })
})

describe('findPaths', () => {
  it('finds paths with an optional line and column', () => {
    expect(findPaths('see src/a.ts for it')).toEqual([{ path: 'src/a.ts', start: 4, end: 12 }])
    expect(findPaths('src/a.ts:12')).toEqual([{ path: 'src/a.ts', line: 12, start: 0, end: 11 }])
    expect(findPaths('at src/a.ts:12:3.')).toEqual([{ path: 'src/a.ts', line: 12, start: 3, end: 16 }])
    expect(findPaths('./x.md')).toEqual([{ path: './x.md', start: 0, end: 6 }])
    expect(findPaths('app/src/main/index.ts(40)')).toEqual([{ path: 'app/src/main/index.ts', line: 40, start: 0, end: 25 }])
    expect(findPaths('README.md and docs/GUIDE.md')).toEqual([
      { path: 'README.md', start: 0, end: 9 },
      { path: 'docs/GUIDE.md', start: 14, end: 27 },
    ])
  })
  it('skips URLs, bare words and version numbers', () => {
    expect(findPaths('https://github.com/a/b.ts and www.x.com')).toEqual([])
    expect(findPaths('hello world')).toEqual([])
    expect(findPaths('v1.2.3 and 0.9.0')).toEqual([])
  })
  it('finds paths in quotes and brackets', () => {
    expect(findPaths('"src/a.ts"').map((p) => p.path)).toEqual(['src/a.ts'])
    expect(findPaths('(src/a.ts)').map((p) => p.path)).toEqual(['src/a.ts'])
  })
})

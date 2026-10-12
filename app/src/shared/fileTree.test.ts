import { describe, expect, it } from 'vitest'
import { buildTree, filterPaths, TREE_FILTER_MAX } from './fileTree'

describe('buildTree', () => {
  it('nests files under folders, folders first, each sorted', () => {
    expect(buildTree(['src/b.ts', 'README.md', 'src/a/x.ts', 'a.txt', 'src/c.ts'])).toEqual([
      {
        name: 'src',
        path: 'src',
        children: [
          { name: 'a', path: 'src/a', children: [{ name: 'x.ts', path: 'src/a/x.ts' }] },
          { name: 'b.ts', path: 'src/b.ts' },
          { name: 'c.ts', path: 'src/c.ts' },
        ],
      },
      { name: 'a.txt', path: 'a.txt' },
      { name: 'README.md', path: 'README.md' },
    ])
  })
  it('gives nothing for nothing', () => {
    expect(buildTree([])).toEqual([])
  })
})

describe('filterPaths', () => {
  const paths = ['src/main/index.ts', 'src/shared/diff.ts', 'docs/GUIDE.md', 'README.md']
  it('keeps every path for an empty query', () => {
    expect(filterPaths(paths, '  ')).toEqual(paths)
  })
  it('ranks fuzzy matches, best first', () => {
    expect(filterPaths(paths, 'diff')).toEqual(['src/shared/diff.ts'])
    expect(filterPaths(paths, 'md')[0]).toBe('README.md')
    expect(filterPaths(paths, 'zzz')).toEqual([])
  })
  it('stops at a limit', () => {
    const many = Array.from({ length: TREE_FILTER_MAX + 50 }, (_, i) => `f/x${i}.ts`)
    expect(filterPaths(many, 'x')).toHaveLength(TREE_FILTER_MAX)
  })
})

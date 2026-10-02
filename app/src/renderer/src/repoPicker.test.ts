import { expect, it } from 'vitest'
import { expandHome, filterRepos } from './repoPicker'

it('filters by name or path, case-insensitive', () => {
  const repos = [{ name: 'Api', path: '/w/api' }, { name: 'web', path: '/w/web' }]
  expect(filterRepos(repos, 'API')).toEqual([{ name: 'Api', path: '/w/api' }])
  expect(filterRepos(repos, '/W/WE')).toEqual([{ name: 'web', path: '/w/web' }])
  expect(filterRepos(repos, '  ')).toEqual(repos)
})

it('expands a leading ~ with the Mac home; other paths unchanged', () => {
  expect(expandHome('~', '/Users/me')).toBe('/Users/me')
  expect(expandHome('~/code/x', '/Users/me')).toBe('/Users/me/code/x')
  expect(expandHome('/abs/~/x', '/Users/me')).toBe('/abs/~/x')
  expect(expandHome('~other/x', '/Users/me')).toBe('~other/x')
})

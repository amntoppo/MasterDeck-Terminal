import { expect, it } from 'vitest'
import { filterRepos } from './repoPicker'

it('filters by name or path, case-insensitive', () => {
  const repos = [{ name: 'Api', path: '/w/api' }, { name: 'web', path: '/w/web' }]
  expect(filterRepos(repos, 'API')).toEqual([{ name: 'Api', path: '/w/api' }])
  expect(filterRepos(repos, '/W/WE')).toEqual([{ name: 'web', path: '/w/web' }])
  expect(filterRepos(repos, '  ')).toEqual(repos)
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_PR_FILTERS } from '@shared/teamPrs'
import { defaultPrTabs, presetFilters, presetOf, prTabFor } from './prPresets'

const one = { logins: ['octo'], primary: 'octo', account: 'octo' }
const two = { logins: ['octo', 'acme-bot'], primary: 'octo', account: 'octo' }

describe('presetOf', () => {
  it('names the preset, whatever the sort', () => {
    expect(presetOf(presetFilters('Needs my review'))?.label).toBe('Needs my review')
    expect(presetOf({ ...presetFilters('Mine'), sort: 'oldest' })?.label).toBe('Mine')
  })
  it('any other filter makes it no preset', () => {
    expect(presetOf({ ...presetFilters('Mine'), repo: 'acme/api' })).toBeUndefined()
    expect(presetOf({ ...DEFAULT_PR_FILTERS, ci: 'passing' })).toBeUndefined()
  })
})

describe('prTabFor', () => {
  it('nothing saved: Mine is the default tab', () => {
    expect(prTabFor(null, 'Mine', one)).toEqual({ id: 'prs-mine', tabs: null })
  })

  it('nothing saved and no tab on the preset: a new one after the defaults', () => {
    const r = prTabFor(null, 'Recently merged', one)
    expect(r.id).toBe('prs-recently-merged')
    expect(r.tabs?.map((t) => t.id)).toEqual(['prs-mine', 'prs-everyone', 'prs-recently-merged'])
    expect(r.tabs?.[2]).toMatchObject({ name: 'Recently merged', filters: presetFilters('Recently merged') })
  })

  it('matches by filters, not by name', () => {
    const saved = [
      { id: 'a', name: 'Needs my review', filters: { ...presetFilters('Needs my review'), repo: 'acme/api' } },
      { id: 'b', name: 'Reviews', filters: presetFilters('Needs my review') },
    ]
    expect(prTabFor(saved, 'Needs my review', one)).toEqual({ id: 'b', tabs: null })
  })

  it('with two or more accounts, only a tab of that account', () => {
    const saved = [
      { id: 'x', name: 'Mine', account: 'acme-bot', filters: presetFilters('Mine') },
      { id: 'y', name: 'Mine', filters: presetFilters('Mine') },
    ]
    expect(prTabFor(saved, 'Mine', two).id).toBe('y')
    const other = prTabFor(saved.slice(0, 1), 'Mine', two)
    expect(other.id).toBe('prs-mine')
    expect(other.tabs?.at(-1)).toMatchObject({ id: 'prs-mine', name: 'Mine' })
    expect(other.tabs?.at(-1)).not.toHaveProperty('account')
    // With one account, the tab's account does not matter.
    expect(prTabFor(saved.slice(0, 1), 'Mine', one).id).toBe('x')
  })

  it('a new tab never takes an id in use', () => {
    const saved = [{ id: 'prs-mine', name: 'Mine', filters: { ...presetFilters('Mine'), repo: 'acme/api' } }]
    expect(prTabFor(saved, 'Mine', one).id).toBe('prs-mine-2')
  })

  it('the default tabs are Mine and Everyone', () => {
    expect(defaultPrTabs().map((t) => presetOf(t.filters)?.label)).toEqual(['Mine', 'Everyone'])
  })
})

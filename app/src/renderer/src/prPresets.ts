import { tabAccount } from '@shared/boardFilter'
import { DEFAULT_PR_FILTERS, parseSavedPrTabs, type PrFilters } from '@shared/teamPrs'

/** The PRs view's presets: the filter row's buttons, and what the Dashboard's PR counts open. */
export const PR_PRESETS: { label: string; title: string; f: Partial<PrFilters> }[] = [
  { label: 'Everyone', title: 'All open PRs in the org', f: { state: 'open', author: '', review: 'any', ci: 'any' } },
  { label: 'Mine', title: 'Open PRs I created', f: { state: 'open', author: '@me', review: 'any', ci: 'any' } },
  { label: 'Needs my review', title: 'Open PRs where my review is requested', f: { state: 'open', author: '', review: 'needs-me', ci: 'any' } },
  { label: 'Failing CI', title: 'Open PRs with failing checks', f: { state: 'open', author: '', review: 'any', ci: 'failing' } },
  { label: 'Recently merged', title: 'Merged in the last 7 days', f: { state: 'merged', author: '', review: 'any', ci: 'any', updated: 7 } },
]

export const presetFilters = (label: string): PrFilters => ({ ...DEFAULT_PR_FILTERS, ...(PR_PRESETS.find((p) => p.label === label)?.f ?? {}) })

/** The preset these filters are, by every filter but the sort; undefined when they are no preset. */
export function presetOf(f: PrFilters): (typeof PR_PRESETS)[number] | undefined {
  return PR_PRESETS.find((p) => {
    const want = { ...DEFAULT_PR_FILTERS, ...p.f }
    return (Object.keys(DEFAULT_PR_FILTERS) as (keyof PrFilters)[]).every((k) => k === 'sort' || f[k] === want[k])
  })
}

export type SavedPrTab = NonNullable<ReturnType<typeof parseSavedPrTabs>>[number]

/** The tabs before any are saved: Mine (selected) and Everyone. */
export const defaultPrTabs = (): SavedPrTab[] => [
  { id: 'prs-mine', name: 'Mine', filters: presetFilters('Mine') },
  { id: 'prs-everyone', name: 'Everyone', filters: presetFilters('Everyone') },
]

/**
 * The PR tab that shows a preset, for a link from elsewhere (the Dashboard's PR counts): the first
 * saved tab whose filters are that preset (whatever it is called) and, with two or more accounts,
 * that shows `account`. None: a new tab on the preset is added after the others. `tabs` is what
 * to save when it changed (null: unchanged), `id` the tab to select.
 */
export function prTabFor(saved: unknown, label: string, accounts: { logins: string[]; primary: string | null; account: string | null }): { id: string; tabs: SavedPrTab[] | null } {
  const tabs = parseSavedPrTabs(saved) ?? defaultPrTabs()
  const { logins, primary, account } = accounts
  const multi = logins.length >= 2
  const hit = tabs.find((t) => presetOf(t.filters)?.label === label && (!multi || (tabAccount(t, logins) ?? primary) === account))
  if (hit) return { id: hit.id, tabs: null }
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const acct = multi && account && account !== primary ? account : undefined
  let id = `prs-${slug}${acct ? `-${acct}` : ''}`
  for (let n = 2; tabs.some((t) => t.id === id); n++) id = `prs-${slug}${acct ? `-${acct}` : ''}-${n}`
  return { id, tabs: [...tabs, { id, name: label, filters: presetFilters(label), ...(acct ? { account: acct } : {}) }] }
}

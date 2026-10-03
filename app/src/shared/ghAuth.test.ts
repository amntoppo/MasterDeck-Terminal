import { describe, expect, it } from 'vitest'
import { hasProjectScope, parseGhAccounts, setupScopes } from './ghAuth'

const TWO = `github.com
  ✓ Logged in to github.com account alice-work (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account alice (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'
`

describe('gh accounts', () => {
  it('reads every account with its own active flag and scopes', () => {
    const a = parseGhAccounts(TWO)
    expect(a.map((x) => [x.login, x.active, x.ok])).toEqual([['alice-work', true, true], ['alice', false, true]])
    expect(hasProjectScope(a[0])).toBe(true)
    expect(hasProjectScope(a[1])).toBe(false)
  })
  it('marks an account whose token failed, and reads nothing from no login', () => {
    const a = parseGhAccounts('github.com\n  X Failed to log in to github.com account bob (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n')
    expect(a).toEqual([{ login: 'bob', active: true, ok: false, scopes: [] }])
    expect(parseGhAccounts('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toEqual([])
  })
})

describe('setupScopes', () => {
  it("one account: gh's active account's scopes, as before", () => {
    expect(setupScopes(parseGhAccounts(TWO), null)).toEqual(['gist', 'project', 'read:org', 'repo', 'workflow'])
  })
  it("several: only the scopes every connected account's token has (one lacking project shows it missing)", () => {
    const a = parseGhAccounts(TWO)
    expect(setupScopes(a, ['alice-work', 'alice'])).toEqual(['gist', 'read:org', 'repo'])
    expect(setupScopes(a, ['ALICE-WORK'])).toContain('project')
    expect(setupScopes(a, ['alice-work', 'carol'])).toEqual([]) // gh has no token for carol
  })
})

/** One github.com account `gh` is logged in to (`gh auth status`). */
export interface GhAccount {
  login: string
  active: boolean
  /** False when gh says the token no longer works. */
  ok: boolean
  scopes: string[]
}

/**
 * Accounts from `gh auth status --hostname github.com`. Each account is its own block, with its
 * own `Active account` and `Token scopes` lines.
 */
export function parseGhAccounts(text: string): GhAccount[] {
  const out: GhAccount[] = []
  const blocks = text.split(/\n(?=\s*[✓✗X!]\s+(?:Logged in|Failed to log in) to github\.com account )/)
  for (const b of blocks) {
    const head = /(Logged in|Failed to log in) to github\.com account ([A-Za-z0-9-]{1,39})/.exec(b)
    if (!head) continue
    const scopes = /Token scopes:\s*(.*)/.exec(b)?.[1] ?? ''
    out.push({
      login: head[2],
      active: /Active account:\s*true/.test(b),
      ok: head[1] === 'Logged in',
      scopes: scopes.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    })
  }
  return out
}

/** Whether the token can read and move project boards. */
export function hasProjectScope(a: GhAccount): boolean {
  return a.scopes.includes('project') || a.scopes.includes('read:project')
}

/**
 * The scopes Setup reports. `connected` null (one account): gh's active account's, as before.
 * Several: only those every connected account's own token has (gh auth status lists each), so one
 * account without `project` shows the scope missing; a login gh has no token for has none.
 */
export function setupScopes(accounts: GhAccount[], connected: string[] | null): string[] {
  if (!connected) return (accounts.find((a) => a.active) ?? accounts[0])?.scopes ?? []
  const of = (l: string) => accounts.find((a) => a.login.toLowerCase() === l.toLowerCase())?.scopes ?? []
  return connected.reduce<string[] | null>((acc, l) => (acc ? acc.filter((s) => of(l).includes(s)) : of(l)), null) ?? []
}

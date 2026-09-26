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

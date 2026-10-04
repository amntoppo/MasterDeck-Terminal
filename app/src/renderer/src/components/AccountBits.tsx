import { accountChoices, isMulti } from '@shared/accounts'
import type { AppState } from '@shared/types'

/** "@login": the GitHub account of a session, tab or proposal; nothing when there is none to show. */
export function AccountBadge({ login, ghActive }: { login?: string | null; ghActive?: boolean }) {
  // Started without an account (two or more connected): never a login, it would be a guess.
  if (ghActive)
    return (
      <span className="acct-badge muted" title="Started without an account: it works as gh's active account (gh auth status). To give it one, stop it and resume it with an account picked.">
        gh&apos;s active account
      </span>
    )
  return login ? (
    <span className="acct-badge" title={`GitHub account ${login}`}>
      @{login}
    </span>
  ) : null
}

/** "as @login" at the top of a session (or a Board tab's ticket session); nothing at all without a login. */
export function SessionAccount({ login, ghActive }: { login?: string | null; ghActive?: boolean }) {
  if (ghActive)
    return (
      <span className="session-acct">
        as <AccountBadge ghActive /> (started without an account)
      </span>
    )
  return login ? (
    <span className="session-acct">
      as <AccountBadge login={login} />
    </span>
  ) : null
}

/** A start or resume dialog's Account field: only with two or more connected accounts; unhealthy ones can't be picked. */
export function AccountSelect({ state, value, onChange }: { state: AppState; value: string | null; onChange: (login: string) => void }) {
  if (!isMulti(state.config)) return null
  const choices = accountChoices(state.config, state.ghAccounts)
  const v = value ?? ''
  return (
    <>
      <label>Account</label>
      <select className="fsel full" value={v} onChange={(e) => onChange(e.target.value)} title="The GitHub account this session works as: its commits, PRs and gh calls">
        {!v && (
          <option value="" disabled>
            Loading…
          </option>
        )}
        {v && !choices.includes(v) && (
          <option value={v} disabled>
            {v} (needs to log in again)
          </option>
        )}
        {choices.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    </>
  )
}

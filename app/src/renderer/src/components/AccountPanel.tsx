import { useEffect, useState, type ReactNode } from 'react'
import { PROVIDERS } from '@shared/account'
import type { AppState } from '@shared/types'
import { deck, useNow } from '../deck'
import { can } from '../web'

/** Settings → Account: sign in (browser or email), the pending code, and the signed-in summary. */
export function AccountPanel({ account }: { account: AppState['account'] }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [create, setCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [ids, setIds] = useState<string[]>(['google', 'github'])
  const now = useNow(1_000)
  useEffect(() => {
    if (can('accountProviders')) void deck().accountProviders().then(setIds, () => {})
  }, [])
  const a = account ?? { kind: 'signedOut' as const, message: null }
  // Who the Mac is signed in as changes only at the Mac (account calls are blocked on the web).
  if (!can('accountSignIn'))
    return (
      <Field label="Account" hint="Sign in, sign out and account settings are on your Mac.">
        <span className="muted">{a.kind === 'signedIn' ? `${a.email} · ` : ''}Manage your account on your Mac</span>
      </Field>
    )

  if (a.kind === 'pending') {
    const left = Math.max(0, Math.round((a.expiresAt - now) / 1000))
    if (a.mode === 'browser')
      return (
        <>
          <Field label="Finish signing in in your browser" hint="Approve this Mac in the browser page that just opened; it comes back here by itself.">
            <span className="muted">
              Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </span>
          </Field>
          <Field label="Not seeing the page?">
            <button className="btn" onClick={() => void deck().accountReopen()}>
              Open the page again
            </button>
            <button className="btn" onClick={() => void deck().accountUseCode()}>
              Use a code instead
            </button>
            <button className="btn" onClick={() => void deck().accountCancel()}>
              Cancel
            </button>
          </Field>
        </>
      )
    return (
      <>
        <Field label="Finish signing in in your browser" hint="Type this code in the browser page that just opened. Only approve it if you started this sign-in.">
          <div className="f-col">
            <code className="user-code" aria-label="Sign-in code">
              {a.userCode}
            </code>
            <span className="muted">
              Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </span>
          </div>
        </Field>
        <Field label="Not seeing the page?">
          <button className="btn" onClick={() => void deck().accountReopen()}>
            Open the page again
          </button>
          <button className="btn" onClick={() => void deck().accountCancel()}>
            Cancel
          </button>
        </Field>
      </>
    )
  }

  if (a.kind === 'signedIn') {
    const via = a.provider === 'email' ? 'email' : (PROVIDERS.find((p) => p.id === a.provider)?.label ?? a.provider)
    return (
      <>
        <Field label="Signed in" hint={`Signed in as ${a.email} (${via}).`}>
          <span>{a.email}</span>
        </Field>
        <Field label="Manage account" hint="Devices, password and deleting the account (opens the browser).">
          <button className="btn" onClick={() => void deck().accountManage()}>
            Manage account
          </button>
        </Field>
        <Field label="Sign out" hint="Remote stops until you sign in again.">
          <button
            className="btn danger"
            onClick={() => {
              if (window.confirm('Sign this Mac out? Remote will stop.')) void deck().accountSignOut()
            }}
          >
            Sign out
          </button>
        </Field>
      </>
    )
  }

  const submit = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await deck().accountEmail({ email: email.trim(), password, create, ...(create && name.trim() ? { name: name.trim() } : {}) })
      setMsg(r.message)
      if (r.ok) setPassword('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {a.message && (
        <p className="set-hint" style={{ padding: '12px 0 0', color: 'var(--red)' }} role="alert">
          {a.message}
        </p>
      )}
      <Field label="Continue with" hint="Opens your browser to approve this Mac.">
        <div className="add-row">
          {PROVIDERS.filter((p) => ids.includes(p.id)).map((p) => (
            <button key={p.id} className="btn" onClick={() => void deck().accountSignIn(p.id)}>
              Continue with {p.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label={create ? 'Create account' : 'Sign in with email'}>
        <form
          className="f-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy) void submit()
          }}
        >
          {create && <input className="input" placeholder="Name (optional)" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />}
          <input className="input" type="email" placeholder="Email" aria-label="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <input
            className="input"
            type="password"
            placeholder="Password"
            aria-label="Password"
            autoComplete={create ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <div className="f-row">
            <button className="btn primary" type="submit" disabled={busy || !email.trim() || !password}>
              {busy ? 'Working…' : create ? 'Create account' : 'Sign in'}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => (setCreate(!create), setMsg(null))}>
              {create ? 'I have an account' : 'Create account'}
            </button>
          </div>
          {msg && <span className="muted">{msg}</span>}
        </form>
      </Field>
    </>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-field">
      <div>
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  )
}

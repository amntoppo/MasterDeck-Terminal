import { useState, type ReactNode } from 'react'
import { PROVIDERS } from '@shared/account'
import type { AppState } from '@shared/types'
import { deck, useNow } from '../deck'

/** Settings → Account: sign in (browser or email), the pending code, and the signed-in summary. */
export function AccountPanel({ account }: { account: AppState['account'] }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [create, setCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const now = useNow(1_000)
  const a = account ?? { kind: 'signedOut' as const, message: null }

  if (a.kind === 'pending') {
    const left = Math.max(0, Math.round((a.expiresAt - now) / 1000))
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
      <Field label="Continue with" hint="Opens your browser; you type a code shown here to approve this Mac.">
        <div className="add-row">
          {PROVIDERS.map((p) => (
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

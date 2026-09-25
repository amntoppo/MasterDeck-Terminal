import { useEffect, useRef, useState } from 'react'
import { pendingAssign } from '@shared/derive'
import type { AssignRequest, Template } from '@shared/ipc'
import { composePrompt } from '@shared/prompt'
import type { AppState, DraftAssign, Issue } from '@shared/types'
import { deck } from '../deck'

interface Props {
  issue: Issue
  state: AppState
  onClose: () => void
  /** Start is fire-and-forget: the caller switches to the terminal and tracks the spawn. */
  onStart: (req: AssignRequest) => void
  /** Opens the Link dialog for this issue instead of starting a new session. */
  onLink: () => void
  /** Pre-filled first instructions (e.g. "fix CI" routed from My PRs). */
  initialInstructions?: string
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function AssignDialog({ issue, state, onClose, onStart, onLink, initialInstructions }: Props) {
  const pending = pendingAssign(state.proposals, issue.number)
  const approved = pending?.status === 'approved' && pending.target.spawn ? pending : null
  const [draft, setDraft] = useState<DraftAssign | null>(null)
  const [name, setName] = useState('')
  const [system, setSystem] = useState('')
  const [instructions, setInstructions] = useState(initialInstructions ?? '')
  const [templates, setTemplates] = useState<Template[]>([])
  const [savingAs, setSavingAs] = useState<string | null>(null)
  useEffect(() => {
    void deck().templates().then(setTemplates)
  }, [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const instructionsRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    const fromProposal = pending && pending.target.spawn ? pending : null
    const use = (d: DraftAssign) => {
      setDraft(d)
      setName(d.name)
      setSystem(d.prompt)
      setLoading(false)
      setTimeout(() => instructionsRef.current?.focus(), 0)
    }
    if (fromProposal) {
      const sp = fromProposal.target.spawn!
      use({
        issue: issue.number,
        name: sp.name,
        cwd: sp.cwd ?? state.masterWorkspace,
        prompt: sp.prompt ?? fromProposal.message,
        summary: fromProposal.summary,
        title: issue.title,
        url: issue.url,
        proposalId: fromProposal.id,
      })
      return
    }
    void deck()
      .draftAssign(issue.number, issue.title, issue.url)
      .then((r) => {
        if (!alive) return
        if (r.ok) use(r.draft)
        else {
          setLoading(false)
          setError(r.message)
        }
      })
    return () => {
      alive = false
    }
    // Load once per dialog; later ledger updates must not overwrite the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const nameOk = NAME_RE.test(name)
  const prompt = composePrompt(system, instructions)
  const promptOk = prompt.length > 0 && !prompt.startsWith('-')

  const start = () => {
    if (!draft || !nameOk || !promptOk) return
    const unchanged = name === draft.name && prompt === draft.prompt.trim()
    onStart({
      issue: issue.number,
      name,
      cwd: draft.cwd,
      prompt,
      proposalId: draft.proposalId,
      edited: !unchanged,
      approved: unchanged && draft.proposalId !== null && draft.proposalId === approved?.id,
    })
    onClose()
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={`Start a session for #${issue.number}`}>
        <h3>
          <span className="kind" style={{ ['--kind' as string]: 'var(--purple)' }}>
            START
          </span>
          #{issue.number} {issue.title}
        </h3>
        <div className="meta">
          {issue.status ?? 'No board status'}
          {issue.currentSprint ? ' · current sprint' : ''} ·{' '}
          <button className="link-btn" onClick={() => deck().openExternal(issue.url)}>
            open on GitHub ↗
          </button>
          {draft?.proposalId != null && <> · from master's proposal {draft.proposalId}{approved ? ' (approved, not started yet)' : ''}</>}
        </div>

        {loading ? (
          <p className="meta">Drafting…</p>
        ) : draft ? (
          <>
            <label>Session name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            {!nameOk && <div className="error" style={{ fontSize: 11, marginTop: 3 }}>Letters, digits, dot, dash and underscore; up to 64 characters.</div>}
            <label>System prompt</label>
            <textarea className="system" value={system} onChange={(e) => setSystem(e.target.value)} spellCheck={false} />
            <div className="label-row">
              <label>Your first instructions (optional)</label>
              <span style={{ flex: 1 }} />
              <select
                className="fsel"
                value=""
                onChange={(e) => {
                  const t = templates.find((x) => x.name === e.target.value)
                  if (t) setInstructions((cur) => (cur.trim() ? `${cur.trim()}\n\n${t.text}` : t.text))
                }}
                title="Insert a saved instruction snippet"
              >
                <option value="">Template…</option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.builtin ? '' : '★ '}
                    {t.name}
                  </option>
                ))}
              </select>
              {savingAs === null ? (
                <button className="link-btn" disabled={!instructions.trim()} onClick={() => setSavingAs('')}>
                  Save as template
                </button>
              ) : (
                <>
                  <input className="tpl-name" autoFocus placeholder="Template name" value={savingAs} onChange={(e) => setSavingAs(e.target.value)} />
                  <button
                    className="link-btn"
                    disabled={!savingAs.trim()}
                    onClick={async () => {
                      setTemplates(await deck().saveTemplate({ name: savingAs.trim(), text: instructions.trim() }))
                      setSavingAs(null)
                    }}
                  >
                    Save
                  </button>
                </>
              )}
            </div>
            <textarea
              ref={instructionsRef}
              className="instructions"
              value={instructions}
              placeholder="e.g. Fix the web half only; keep native as is. Use the existing NotificationBell component."
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
              }}
            />
            <div className="meta" style={{ marginTop: 6 }}>
              {instructions.trim()
                ? 'Sent after the system prompt; the session follows these instead of stopping to ask.'
                : 'Empty: the session sets up, then asks you for instructions.'}{' '}
              Starts in <code className="mono">{draft.cwd}</code>.
            </div>
            <div className="foot">
              <button className="btn" onClick={onLink} title="Link a session that already exists to this ticket">
                Link session…
              </button>
              <span className="grow">{error && <span className="error">{error}</span>}</span>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!nameOk || !promptOk} onClick={start} title="⌘↵">
                Start
              </button>
            </div>
          </>
        ) : (
          <div className="foot">
            <button className="btn" onClick={onLink}>
              Link session…
            </button>
            <span className="grow error">{error ?? 'Could not draft this issue.'}</span>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

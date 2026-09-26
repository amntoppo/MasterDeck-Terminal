import { useEffect, useState } from 'react'
import type { AppConfig, StatusMap } from '@shared/appConfig'
import { hasProjectScope, type GhAccount } from '@shared/ghAuth'
import type { SetupTool } from '@shared/ipc'
import type { AppState } from '@shared/types'
import { deck } from '../deck'

interface Detected {
  owner: string
  ownerType?: 'organization' | 'user'
  repos?: string[]
  projects?: { number: number; title: string; id: string }[]
  projectsError?: string
  error?: string
  board?: {
    project: number
    projectId: string
    statusFieldId: string
    statusOptions: Record<string, string>
    columns: string[]
    statuses: StatusMap
    sprintField: string
    error?: string
  }
}

const STEPS = ['Tools', 'GitHub account', 'Organization', 'Workspace'] as const

const TOOLS: { id: SetupTool; name: string; hint: string }[] = [
  { id: 'claude', name: 'Claude Code (claude)', hint: 'install Claude Code and log in' },
  { id: 'gh', name: 'GitHub CLI (gh)', hint: 'brew install gh / winget install GitHub.cli' },
  { id: 'python', name: 'Python 3', hint: 'needed by the master CLI' },
  { id: 'git', name: 'git', hint: 'needed for worktrees and standups' },
  { id: 'jq', name: 'jq', hint: 'needed by the babysit-ticket and babysit-pr hooks' },
]

/**
 * First-run setup (and Settings → GitHub & board), in four steps: tools, the gh account, the
 * owner / issue repository / board with its statuses, then workspace, master-agent and hooks.
 * Everything lands in ~/.claude/master/config.json, which master, babysit-ticket and MasterDeck share.
 */
export function SetupDialog({ state, onClose, firstRun }: { state: AppState; onClose: () => void; firstRun: boolean }) {
  const cfg = state.config
  const [step, setStep] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Step 1: tools, each checked on its own.
  const [tools, setTools] = useState<Partial<Record<SetupTool, { ok: boolean; detail: string }>>>({})
  const checkTools = () => {
    setTools({})
    for (const t of TOOLS) void deck().setupTool(t.id).then((r) => setTools((cur) => ({ ...cur, [t.id]: r })))
  }
  const toolsDone = TOOLS.every((t) => tools[t.id])

  // Step 2: the gh account.
  const [accounts, setAccounts] = useState<GhAccount[] | null>(null)
  const [accountsErr, setAccountsErr] = useState<string | null>(null)
  const [login, setLogin] = useState('')
  const loadAccounts = async () => {
    setAccounts(null)
    setAccountsErr(null)
    const r = await deck().ghAccounts()
    setAccounts(r.accounts)
    setAccountsErr(r.error ?? null)
    setLogin((cur) => (cur && r.accounts.some((a) => a.login === cur) ? cur : (r.accounts.find((a) => a.active) ?? r.accounts[0])?.login ?? ''))
  }
  const account = accounts?.find((a) => a.login === login) ?? null

  // Step 3: owner, issue repository, board and what its statuses mean.
  const [owners, setOwners] = useState<string[] | null>(null)
  const [owner, setOwner] = useState(cfg.owner)
  const [det, setDet] = useState<Detected | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [issueRepo, setIssueRepo] = useState(cfg.issueRepo)
  const [project, setProject] = useState<number>(cfg.project)
  const [board, setBoard] = useState<Detected['board'] | null>(
    cfg.project ? { project: cfg.project, projectId: cfg.projectId, statusFieldId: cfg.statusFieldId, statusOptions: cfg.statusOptions, columns: cfg.columns, statuses: cfg.statuses, sprintField: cfg.sprintField } : null,
  )

  // Step 4.
  // A fresh install starts from the folder master would use anyway.
  const [workspace, setWorkspace] = useState(cfg.workspace || state.masterWorkspace || '')
  const [useMaster, setUseMaster] = useState(cfg.masterEnabled)
  const [hooks, setHooks] = useState({ ticket: state.hooks.ticket || firstRun, pr: state.hooks.pr || firstRun, queue: state.hooks.queue || firstRun })

  useEffect(() => {
    checkTools()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !firstRun && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const detect = async (o: string, p?: number): Promise<Detected | null> => {
    if (!o) return null
    setDetecting(true)
    setMsg(null)
    const r = await deck().configDetect(o, p)
    setDetecting(false)
    if (!r.ok) {
      setMsg(r.message)
      return null
    }
    const d = r.data as Detected
    if (d.error) {
      setMsg(d.error)
      return null
    }
    setDet(d)
    if (p) {
      setBoard(d.board ?? null)
      if (d.board?.error) setMsg(d.board.error)
    }
    return d
  }

  const resetBelowOwner = () => {
    setIssueRepo('')
    setProject(0)
    setBoard(null)
    setDet(null)
  }

  const loadOwners = async () => {
    setOwners(null)
    const r = await deck().ghOwners()
    const list = r.user ? [r.user, ...r.orgs] : r.orgs
    setOwners(list)
    if (r.error && !r.user) setMsg(r.error)
    // Keep the saved owner when this account can see it; otherwise start from the account itself.
    const o = list.includes(owner) ? owner : (r.user ?? list[0] ?? '')
    if (o !== owner) resetBelowOwner()
    setOwner(o)
    if (!o) return
    const d = await detect(o)
    // An account often owns no repositories itself (they live in its organizations): then start
    // from the first organization that has some, unless an owner was saved before.
    if (d && !d.repos?.length && o === r.user && !list.includes(cfg.owner)) {
      for (const org of r.orgs) {
        const od = await detect(org)
        if (od?.repos?.length) {
          setOwner(org)
          return
        }
      }
      setOwner(o)
      void detect(o)
    }
  }

  const pickOwner = (o: string) => {
    setOwner(o)
    resetBelowOwner()
    void detect(o)
  }
  const pickProject = (n: number) => {
    setProject(n)
    setBoard(null)
    if (n) void detect(owner, n)
  }

  const go = async (to: number) => {
    setMsg(null)
    if (to === 1 && accounts === null) void loadAccounts()
    if (to === 2) {
      // The chosen account becomes gh's active one: MasterDeck, master and the sessions all use it.
      if (account && !account.active) {
        setBusy(true)
        const r = await deck().ghSwitch(account.login)
        setBusy(false)
        if (!r.ok) return setMsg(r.message)
        setAccounts((cur) => cur?.map((a) => ({ ...a, active: a.login === account.login })) ?? cur)
        void loadOwners()
      } else if (owners === null) void loadOwners()
    }
    setStep(to)
  }

  const st = board?.statuses
  const setSt = (patch: Partial<StatusMap>) => board && setBoard({ ...board, statuses: { ...board.statuses, ...patch } })
  const toggle = (k: 'done' | 'finished' | 'assignable' | 'resumable' | 'blocked', col: string) =>
    st && setSt({ [k]: st[k].includes(col) ? st[k].filter((c) => c !== col) : [...st[k], col] })

  const save = async () => {
    if (!owner.trim() || !issueRepo.trim()) return setMsg('Go back and pick the organization and the repository that holds your issues.')
    setBusy(true)
    setMsg(null)
    const patch: Partial<AppConfig> & Record<string, unknown> = {
      owner: owner.trim(),
      ownerType: det?.ownerType ?? cfg.ownerType,
      issueRepo: issueRepo.trim(),
      project: board ? project : 0,
      ...(board
        ? { projectId: board.projectId, statusFieldId: board.statusFieldId, statusOptions: board.statusOptions, columns: board.columns, statuses: board.statuses, sprintField: board.sprintField }
        : {}),
      ...(workspace ? { workspace } : {}),
      masterEnabled: useMaster,
    }
    const r = await deck().configSave(patch)
    if (!r.ok) {
      setBusy(false)
      return setMsg(r.message)
    }
    if (hooks.ticket !== state.hooks.ticket || hooks.pr !== state.hooks.pr || hooks.queue !== state.hooks.queue) {
      const h = await deck().hooksInstall(hooks)
      if (!h.ok) {
        setBusy(false)
        return setMsg(`Saved, but hooks: ${h.message}`)
      }
    }
    setBusy(false)
    onClose()
  }

  const repos = det?.owner === owner ? (det.repos ?? []) : []
  const canNext = step === 0 ? toolsDone : step === 1 ? !!account && account.ok : step === 2 ? !!owner && !!issueRepo && !detecting : true
  const Spin = ({ text }: { text: string }) => (
    <div className="tool-row wait">
      <span className="tool-mark">
        <span className="spin" />
      </span>
      {text}
    </div>
  )

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !firstRun && onClose()}>
      <div className="dialog setup" role="dialog" aria-label="Set up MasterDeck">
        <h3>{firstRun ? 'Welcome to MasterDeck' : 'GitHub & board'}</h3>
        <ol className="steps">
          {STEPS.map((name, i) => (
            <li key={name} className={i === step ? 'on' : i < step ? 'done' : ''}>
              <span className="n">{i < step ? '✓' : i + 1}</span> {name}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <div className="meta">{toolsDone ? 'MasterDeck uses these tools.' : 'Checking the tools MasterDeck uses…'}</div>
            <div className="tool-list">
              {TOOLS.map((t) => {
                const r = tools[t.id]
                return (
                  <div key={t.id} className={`tool-row ${r ? (r.ok ? 'ok' : 'bad') : 'wait'}`}>
                    <span className="tool-mark">{r ? r.ok ? <span className="tick">✓</span> : <span className="cross">✗</span> : <span className="spin" />}</span>
                    <span className="tool-name">{t.name}</span>
                    <span className="muted tool-detail">{r ? (r.ok ? r.detail : t.hint) : 'checking…'}</span>
                  </div>
                )
              })}
            </div>
            {toolsDone && TOOLS.some((t) => !tools[t.id]?.ok) && (
              <div className="meta">
                Install what's missing, then{' '}
                <button className="link-btn" onClick={checkTools}>
                  check again
                </button>
                . You can go on without it; the features that need it won't work.
              </div>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <div className="meta">
              The GitHub account MasterDeck, master and your sessions use: gh's active account. Choosing another one here switches it.
            </div>
            {accounts === null ? (
              <Spin text="Looking for the accounts gh is logged in to…" />
            ) : accounts.length === 0 ? (
              <div className="meta">
                gh is not logged in to GitHub{accountsErr ? ` (${accountsErr})` : ''}. Run <code>gh auth login</code> in a terminal, then{' '}
                <button className="link-btn" onClick={() => void loadAccounts()}>
                  look again
                </button>
                .
              </div>
            ) : (
              <>
                <label>GitHub account</label>
                <select className="fsel full" value={login} onChange={(e) => setLogin(e.target.value)} disabled={accounts.length === 1}>
                  {accounts.map((a) => (
                    <option key={a.login} value={a.login}>
                      {a.login}
                      {a.active ? ' (active now)' : ''}
                      {a.ok ? '' : ' (token no longer works)'}
                    </option>
                  ))}
                </select>
                {accounts.length === 1 && (
                  <div className="meta">
                    The only account gh is logged in to. Add another with <code>gh auth login</code>.
                  </div>
                )}
                {account && !account.ok && (
                  <div className="meta bad">
                    This account's token no longer works: run <code>gh auth login</code> again.
                  </div>
                )}
                {account && account.ok && !hasProjectScope(account) && (
                  <div className="meta">
                    To use a project board, this account needs the <code>project</code> scope: run <code>gh auth refresh -h github.com -s project</code>, then{' '}
                    <button className="link-btn" onClick={() => void loadAccounts()}>
                      look again
                    </button>
                    . Issues and PRs work without it.
                  </div>
                )}
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <label>Organization or user</label>
            {owners === null ? (
              <Spin text={`Loading ${login || 'your account'}'s organizations…`} />
            ) : (
              <select className="fsel full" value={owner} onChange={(e) => pickOwner(e.target.value)}>
                {!owners.includes(owner) && <option value="">Choose…</option>}
                {owners.map((o, i) => (
                  <option key={o} value={o}>
                    {o}
                    {i === 0 ? ' (you)' : ''}
                  </option>
                ))}
              </select>
            )}

            {owner && owners !== null && (
              <>
                <label>Repository that holds your issues</label>
                {detecting && !repos.length ? (
                  <Spin text={`Loading ${owner}'s repositories…`} />
                ) : det?.owner === owner && !repos.length ? (
                  <div className="meta">
                    {owner} has no repositories of its own{owners && owners.length > 1 ? ': your issues are probably in one of your organizations above.' : '.'}
                  </div>
                ) : (
                  <select className="fsel full" value={issueRepo} onChange={(e) => setIssueRepo(e.target.value)}>
                    {!issueRepo && <option value="">Choose a repository…</option>}
                    {issueRepo && !repos.includes(issueRepo) && <option value={issueRepo}>{issueRepo}</option>}
                    {repos.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                )}
              </>
            )}

            {issueRepo && owners !== null && (
              <>
                <label>Project board (GitHub Projects)</label>
                <select className="fsel full" value={project} onChange={(e) => pickProject(Number(e.target.value))}>
                  <option value={0}>No board (issues and PRs only)</option>
                  {project > 0 && !(det?.projects ?? []).some((p) => p.number === project) && <option value={project}>#{project}</option>}
                  {(det?.projects ?? []).map((p) => (
                    <option key={p.number} value={p.number}>
                      #{p.number} {p.title}
                    </option>
                  ))}
                </select>
                {det?.projectsError && <div className="meta">{det.projectsError}</div>}
                {detecting && project > 0 && !board && <Spin text="Reading the board's statuses…" />}
                {board && st && (
                  <>
                    <label>What each status means</label>
                    <div className="status-map">
                      {(
                        [
                          ['ready', 'Ready to pick up'],
                          ['inProgress', 'Session starts work'],
                          ['prRaised', 'PR opened'],
                          ['devDone', 'PRs merged'],
                        ] as [keyof StatusMap, string][]
                      ).map(([k, label]) => (
                        <div key={k} className="status-row">
                          <span>{label}</span>
                          <select className="fsel" value={st[k] as string} onChange={(e) => setSt({ [k]: e.target.value })}>
                            {board.columns.map((c) => (
                              <option key={c}>{c}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                    <details className="status-more">
                      <summary>More: which statuses count as done, assignable, resumable, blocked</summary>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Status</th>
                            <th title="Not offered as new work">Done</th>
                            <th title="Hidden from a session's pick list">Finished</th>
                            <th title="master may assign it">Assignable</th>
                            <th title="A session may resume it">Resumable</th>
                            <th>Blocked</th>
                          </tr>
                        </thead>
                        <tbody>
                          {board.columns.map((c) => (
                            <tr key={c}>
                              <td>{c}</td>
                              {(['done', 'finished', 'assignable', 'resumable', 'blocked'] as const).map((k) => (
                                <td key={k}>
                                  <input type="checkbox" checked={st[k].includes(c)} onChange={() => toggle(k, c)} />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  </>
                )}
              </>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <label>Workspace (master and new shells start here; your repos live in or next to it)</label>
            <div className="row-inputs">
              <input value={workspace} placeholder="~/code" onChange={(e) => setWorkspace(e.target.value)} />
              <button className="btn" onClick={async () => { const p = await deck().pickFolder(workspace); if (p) setWorkspace(p) }}>
                Choose…
              </button>
            </div>

            <label>Master agent</label>
            <label className="mpick-row">
              <input type="checkbox" checked={useMaster} onChange={(e) => setUseMaster(e.target.checked)} />
              <span>
                Use a master-agent session: it sweeps issues, PRs and meetings for work to hand out, collects what sessions report
                (done, blocked, questions) and relays to sessions in other terminals. Off: everything else works, and sessions ask
                you directly.
              </span>
            </label>

            <label>Hooks (added to ~/.claude/settings.json; a backup is kept)</label>
            <label className="mpick-row">
              <input type="checkbox" checked={hooks.ticket} onChange={(e) => setHooks({ ...hooks, ticket: e.target.checked })} />
              <span>babysit-ticket: move the board as sessions link, open PRs and merge</span>
            </label>
            <label className="mpick-row">
              <input type="checkbox" checked={hooks.pr} onChange={(e) => setHooks({ ...hooks, pr: e.target.checked })} />
              <span>babysit-pr: self-review before `gh pr create`, then babysit the PR</span>
            </label>
            <label className="mpick-row">
              <input type="checkbox" checked={hooks.queue} onChange={(e) => setHooks({ ...hooks, queue: e.target.checked })} />
              <span>queue: `/queue &lt;prompt&gt;` runs the prompt after the current response (and the Queue panel)</span>
            </label>
            <div className="meta">
              Saved to <code>{cfg.path || '~/.claude/master/config.json'}</code>, shared with the master and babysit skills.
            </div>
          </>
        )}

        <div className="foot">
          <span className="grow meta">{msg && <span className="bad">{msg}</span>}</span>
          {firstRun ? (
            <button className="btn" onClick={onClose} title="Sessions work without GitHub; connect it later from the Board, PRs or Settings">
              Skip for now
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          {step > 0 && (
            <button className="btn" disabled={busy} onClick={() => void go(step - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn primary" disabled={busy || !canNext} onClick={() => void go(step + 1)}>
              {busy ? 'Switching account…' : 'Next'}
            </button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Finish'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

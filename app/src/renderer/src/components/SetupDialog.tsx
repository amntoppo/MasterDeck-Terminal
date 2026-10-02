import { useEffect, useState } from 'react'
import { claudeInstall } from '@shared/install'
import { projectKey, type AppConfig, type ProjectConfig, type StatusMap } from '@shared/appConfig'
import { parseDetectAll, type DetectAll } from '@shared/detect'
import { hasProjectScope, type GhAccount } from '@shared/ghAuth'
import type { SetupTool } from '@shared/ipc'
import type { AppState } from '@shared/types'
import { deck } from '../deck'
import { TerminalView } from './TerminalView'
import { AccountPanel } from './AccountPanel'
import { canAdvance } from './stepRules'


const STEPS = ['Account', 'Tools', 'GitHub account', 'Repos & boards', 'Preferences'] as const

const INSTALLER_PANE = 'setup:installer'

/** Claude's mark, for the button that starts a Claude session. */
function ClaudeMark() {
  return (
    <svg className="claude-mark" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      {[0, 30, 60, 90, 120, 150].map((a) => (
        <rect key={a} x="11" y="1.5" width="2" height="21" rx="1" fill="#d97757" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  )
}

const TOOLS: { id: SetupTool; name: string; hint: string }[] = [
  { id: 'claude', name: 'Claude Code (claude)', hint: 'install Claude Code and log in' },
  { id: 'gh', name: 'GitHub CLI (gh)', hint: 'brew install gh / winget install GitHub.cli' },
  { id: 'python', name: 'Python 3', hint: 'needed by the master CLI' },
  { id: 'git', name: 'git', hint: 'needed for worktrees and standups' },
  { id: 'jq', name: 'jq', hint: 'needed by the babysit-ticket and babysit-pr hooks' },
]

/**
 * First-run setup (a five-step wizard: the optional account, then; from Settings → Set up MasterDeck, the same sections as one page): tools, the gh account, the
 * owner / issue repository / board with its statuses, then workspace and master-agent. Skills and
 * their hooks have their own popup (it opens after a first-run setup).
 * Everything lands in ~/.claude/master/config.json, which master, babysit-ticket and MasterDeck share.
 */
export function SetupDialog({ state, onClose, firstRun }: { state: AppState; onClose: () => void; firstRun: boolean }) {
  const cfg = state.config
  const [step, setStep] = useState(0)
  const signedIn = state.account?.kind === 'signedIn'
  const [remoteOn, setRemoteOn] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Step 2: tools, each checked on its own.
  const [tools, setTools] = useState<Partial<Record<SetupTool, { ok: boolean; detail: string }>>>({})
  const checkTools = () => {
    setTools({})
    for (const t of TOOLS) void deck().setupTool(t.id).then((r) => setTools((cur) => ({ ...cur, [t.id]: r })))
  }
  const toolsDone = TOOLS.every((t) => tools[t.id])
  const claudeMissing = tools.claude?.ok === false
  // What a Claude session can install for you (not Claude Code itself: it runs the session).
  const missing = TOOLS.filter((t) => t.id !== 'claude' && tools[t.id]?.ok === false).map((t) => t.id)
  // The installer session: the tools it was started for (fixed while it runs).
  const [installing, setInstalling] = useState<SetupTool[] | null>(null)
  const [copied, setCopied] = useState(false)
  // While something is missing, check it again every few seconds: it turns green once installed.
  const waiting = toolsDone && (claudeMissing || missing.length > 0)
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => {
      for (const x of TOOLS) if (tools[x.id]?.ok === false) void deck().setupTool(x.id).then((r) => setTools((cur) => ({ ...cur, [x.id]: r })))
    }, 4000)
    return () => clearInterval(t)
  }, [waiting, tools])
  const closeInstaller = () => {
    deck().ptyClose(INSTALLER_PANE)
    setInstalling(null)
  }
  // The session goes when the dialog does, or when the user leaves the tools step.
  useEffect(() => () => deck().ptyClose(INSTALLER_PANE), [])

  // Step 3: the gh account.
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

  // Step 4: the repos and boards to follow (every org gh can reach), which repo is primary, and
  // what each board's statuses mean.
  const [found, setFound] = useState<DetectAll | null>(null)
  const [finding, setFinding] = useState(false)
  const [repos, setRepos] = useState<string[]>(() => cfg.repos)
  const [allRepos, setAllRepos] = useState(cfg.allRepos)
  const [primary, setPrimary] = useState(() => (cfg.owner && cfg.issueRepo ? `${cfg.owner}/${cfg.issueRepo}` : ''))
  const [boards, setBoards] = useState<Record<string, ProjectConfig>>(() => Object.fromEntries(cfg.projects.map((p) => [projectKey(p), p])))
  const [allBoards, setAllBoards] = useState(cfg.allProjects)
  const [repoSearch, setRepoSearch] = useState('')

  const loadFound = async () => {
    setFinding(true)
    setMsg(null)
    const r = await deck().configDetectAll()
    setFinding(false)
    if (!r.ok) return setMsg(r.message)
    const d = parseDetectAll(r.data)
    setFound(d)
    if (d.error) setMsg(d.error)
    const every = d.owners.flatMap((o) => o.repos.map((x) => x.repo))
    const everyBoard = d.owners.flatMap((o) => o.projects)
    // Boards already chosen take GitHub's current title, ids and columns, keeping what the user
    // said their statuses mean.
    const fresh = (p: ProjectConfig): ProjectConfig => {
      const had = boards[projectKey(p)]
      return had ? { ...p, statuses: had.statuses } : p
    }
    setBoards((cur) => Object.fromEntries(Object.entries(cur).map(([k, b]) => [k, everyBoard.find((p) => projectKey(p) === k) ? fresh(everyBoard.find((p) => projectKey(p) === k)!) : b])))
    // "Select all" last time: everything there is now, including repos and boards added since.
    if (allRepos) setRepos(every)
    if (allBoards) setBoards(Object.fromEntries(everyBoard.map((p) => [projectKey(p), fresh(p)])))
    // First setup: start from the repo with the most open issues (usually the tracker) and its owner's boards.
    if (!repos.length && !allRepos) {
      const top = d.owners.flatMap((o) => o.repos).sort((a, b) => b.openIssues - a.openIssues)[0]
      if (top) {
        setRepos([top.repo])
        setPrimary(top.repo)
        const own = everyBoard.filter((p) => p.owner === top.repo.split('/')[0])
        if (own.length === 1 && !Object.keys(boards).length) setBoards({ [projectKey(own[0])]: own[0] })
      }
    }
  }

  // Step 5.
  // A fresh install starts from the folder master would use anyway.
  const [workspace, setWorkspace] = useState(cfg.workspace || state.masterWorkspace || '')
  const [useMaster, setUseMaster] = useState(cfg.masterEnabled)
  const [notify, setNotify] = useState(state.settings.notifyNeedsYou)

  useEffect(() => {
    checkTools()
    // From Settings every section is one click away: know the account up front.
    if (!firstRun) void loadAccounts()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !firstRun && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const go = async (to: number) => {
    setMsg(null)
    if (to === 2 && accounts === null) void loadAccounts()
    // Leaving Account for the next step (not Skip): apply the Remote switch.
    if (firstRun && step === 0 && to === 1 && signedIn && remoteOn) await deck().setSettings({ ...(await deck().getSettings()), remoteEnabled: true })
    if (to === 3) {
      // The chosen account becomes gh's active one: MasterDeck, master and the sessions all use it.
      if (account && !account.active) {
        setBusy(true)
        const r = await deck().ghSwitch(account.login)
        setBusy(false)
        if (!r.ok) return setMsg(r.message)
        setAccounts((cur) => cur?.map((a) => ({ ...a, active: a.login === account.login })) ?? cur)
        void loadFound()
      } else if (found === null) void loadFound()
    }
    setStep(to)
  }

  const selectedRepos = allRepos ? (found ? found.owners.flatMap((o) => o.repos.map((x) => x.repo)) : repos) : repos
  const primaryRepo = selectedRepos.includes(primary) ? primary : (selectedRepos[0] ?? '')
  const toggleRepo = (r: string) => {
    setAllRepos(false)
    setRepos(repos.includes(r) ? repos.filter((x) => x !== r) : [...repos, r])
  }
  const toggleBoard = (p: ProjectConfig) => {
    setAllBoards(false)
    const k = projectKey(p)
    const next = { ...boards }
    if (next[k]) delete next[k]
    else next[k] = p
    setBoards(next)
  }
  const setStatuses = (k: string, st: StatusMap) => setBoards((b) => (b[k] ? { ...b, [k]: { ...b[k], statuses: st } } : b))

  const save = async () => {
    if (!primaryRepo) return setMsg('Go back and pick at least one repository.')
    setBusy(true)
    setMsg(null)
    // The chosen account becomes gh's active one (from Settings, Save may come straight from its section).
    if (account && !account.active) {
      const sw = await deck().ghSwitch(account.login)
      if (!sw.ok) {
        setBusy(false)
        return setMsg(sw.message)
      }
    }
    if (notify !== state.settings.notifyNeedsYou) await deck().setSettings({ ...(await deck().getSettings()), notifyNeedsYou: notify })
    const [owner, issueRepo] = primaryRepo.split('/')
    const ownerType = found?.owners.find((o) => o.login === owner)?.type ?? (owner === cfg.owner ? cfg.ownerType : 'organization')
    const list = Object.values(boards)
    const patch: Partial<AppConfig> & Record<string, unknown> = {
      owner,
      ownerType,
      issueRepo,
      repos: [primaryRepo, ...selectedRepos.filter((r) => r !== primaryRepo)],
      allRepos,
      projects: list.map((p) => ({
        owner: p.owner,
        ownerType: p.ownerType,
        number: p.number,
        id: p.id,
        title: p.title,
        statusField: p.statusField,
        statusFieldId: p.statusFieldId,
        statusOptions: p.statusOptions,
        columns: p.columns,
        statuses: p.statuses,
        sprintField: p.sprintField,
      })),
      allProjects: allBoards,
      // No board: issues and PRs only (the first board otherwise fills these, see master config save).
      ...(list.length ? {} : { project: 0 }),
      ...(workspace ? { workspace } : {}),
      masterEnabled: useMaster,
    }
    const r = await deck().configSave(patch)
    if (!r.ok) {
      setBusy(false)
      return setMsg(r.message)
    }
    setBusy(false)
    onClose()
  }

  // Settings view: one line under each section's name.
  const bad = TOOLS.filter((t) => tools[t.id]?.ok === false).length
  const sectionSummary = [
    signedIn && state.account?.kind === 'signedIn' ? state.account.email : 'not signed in',
    !toolsDone ? 'checking…' : bad ? `${bad} missing` : 'all installed',
    login || (accounts === null ? '—' : 'not logged in'),
    primaryRepo ? `${allRepos ? 'all repos' : `${selectedRepos.length} repo${selectedRepos.length === 1 ? '' : 's'}`} · ${allBoards ? 'all boards' : `${Object.keys(boards).length} board${Object.keys(boards).length === 1 ? '' : 's'}`}` : 'none chosen',
    `${useMaster ? 'master on' : 'master off'} · ${notify ? 'notifications on' : 'notifications off'}`,
  ]
  const canNext = canAdvance(step, { signedIn, toolsDone, ghOk: !!account && account.ok, hasPrimaryRepo: !!primaryRepo, finding })
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
      <div className={`dialog setup ${firstRun ? '' : 'setup-page'}`} role="dialog" aria-label="Set up MasterDeck">
        <h3>{firstRun ? 'Welcome to MasterDeck' : 'Set up MasterDeck'}</h3>
        {firstRun ? (
          <ol className="steps">
            {STEPS.map((name, i) => (
              <li key={name} className={i === step ? 'on' : i < step ? 'done' : ''}>
                <span className="n">{i < step ? '✓' : i + 1}</span> {name}
              </li>
            ))}
          </ol>
        ) : (
          <div className="meta">Change any part, then Save. Nothing changes until you do.</div>
        )}
        <div className={firstRun ? '' : 'setup-body'}>
        {!firstRun && (
          <nav className="setup-nav" aria-label="Setup sections">
            {STEPS.map((name, i) => (
              <button key={name} className={i === step ? 'on' : ''} disabled={busy} onClick={() => void go(i)}>
                <span>{name}</span>
                <span className="setup-nav-sub">{sectionSummary[i]}</span>
              </button>
            ))}
          </nav>
        )}
        <div className={firstRun ? '' : 'setup-section'}>

        {step === 0 && (
          <>
            <div className="meta">Sign in to use MasterDeck from your phone — see and answer your sessions anywhere. Optional; everything else works without it.</div>
            <AccountPanel account={state.account} />
            {firstRun && signedIn && (
              <label className="mpick-row">
                <input type="checkbox" checked={remoteOn} onChange={(e) => setRemoteOn(e.target.checked)} /> Turn on Remote
              </label>
            )}
          </>
        )}

        {step === 1 && (
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
            {toolsDone && missing.length > 0 && !claudeMissing && !installing && (
              <div className="install-row">
                <button className="btn primary install-now" onClick={() => setInstalling(missing)}>
                  <ClaudeMark /> Install now
                </button>
                <span className="meta">Opens a Claude session here that installs {missing.length === 1 ? 'it' : 'them'}; approve its steps as it asks.</span>
              </div>
            )}
            {installing && (
              <div className="installer">
                <div className="installer-head">
                  <ClaudeMark /> <b>Installing {installing.length === 1 ? 'the missing tool' : `${installing.length} missing tools`}</b>
                  <span className="meta grow">
                    {missing.length === 0 ? 'All installed. You can close this and continue.' : 'The list above turns green as each one is installed.'}
                  </span>
                  <button className="btn" onClick={closeInstaller}>
                    Close
                  </button>
                </div>
                <div className="installer-term">
                  <TerminalView paneId={INSTALLER_PANE} spec={{ kind: 'installer', tools: installing }} visible focusOnShow />
                </div>
              </div>
            )}
            {toolsDone && TOOLS.some((t) => !tools[t.id]?.ok) && (
              <div className="meta">
                MasterDeck checks again every few seconds{' '}
                <button className="link-btn" onClick={checkTools}>
                  (check now)
                </button>
                . You can go on without {TOOLS.filter((t) => !tools[t.id]?.ok).length === 1 ? 'it' : 'them'}; the features that need {TOOLS.filter((t) => !tools[t.id]?.ok).length === 1 ? 'it' : 'them'} won't work.
              </div>
            )}
            {claudeMissing && (
              <div className="claude-install">
                <div>
                  <b>Install Claude Code</b>: run this in {claudeInstall(deck().platform).shell}, then run <code>claude</code> once to log in.
                  {missing.length > 0 && ' After that, MasterDeck can install the rest for you.'}
                </div>
                <div className="cmd-row">
                  <code className="cmd">{claudeInstall(deck().platform).command}</code>
                  <button
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(claudeInstall(deck().platform).command)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {step === 2 && (
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

        {step === 3 && (
          <>
            <div className="meta">
              The repositories whose issues you work on, and the project boards that track them. Tickets from all of them show on
              the Board and can start sessions; each board keeps its own statuses.{' '}
              <button className="link-btn" onClick={() => void loadFound()} disabled={finding}>
                Look again
              </button>
            </div>
            {finding && !found ? (
              <Spin text="Reading your organizations, repositories and boards from GitHub…" />
            ) : found ? (
              <>
                <div className="pick-head">
                  <label>Repositories</label>
                  <label className="mpick-row pick-all">
                    <input
                      type="checkbox"
                      checked={allRepos}
                      onChange={(e) => {
                        setAllRepos(e.target.checked)
                        setRepos(e.target.checked ? found.owners.flatMap((o) => o.repos.map((x) => x.repo)) : primaryRepo ? [primaryRepo] : [])
                      }}
                    />
                    <span>Select all</span>
                  </label>
                  <span className="grow" />
                  <input className="pick-search" placeholder="Filter repositories" value={repoSearch} onChange={(e) => setRepoSearch(e.target.value)} />
                </div>
                <div className="pick-list">
                  {found.owners.map((o) => {
                    // Chosen ones first, then the ones with the most open issues.
                    const rs = o.repos
                      .filter((x) => !repoSearch || x.repo.toLowerCase().includes(repoSearch.toLowerCase()))
                      .sort((a, b) => Number(selectedRepos.includes(b.repo)) - Number(selectedRepos.includes(a.repo)) || b.openIssues - a.openIssues || a.repo.localeCompare(b.repo))
                    if (!rs.length) return null
                    return (
                      <div key={o.login} className="pick-group">
                        <div className="pick-owner">
                          {o.login}
                          <span className="muted"> · {o.type === 'user' ? 'you' : 'organization'}</span>
                        </div>
                        {rs.map((x) => (
                          <label key={x.repo} className="mpick-row pick-row">
                            <input type="checkbox" checked={selectedRepos.includes(x.repo)} onChange={() => toggleRepo(x.repo)} />
                            <span className="grow">{x.repo.split('/')[1]}</span>
                            <span className="muted">{x.openIssues ? `${x.openIssues} open issue${x.openIssues === 1 ? '' : 's'}` : 'no open issues'}</span>
                          </label>
                        ))}
                      </div>
                    )
                  })}
                  {!found.owners.some((o) => o.repos.length) && <div className="meta">No repositories found for this account.</div>}
                </div>
                {selectedRepos.length > 1 && (
                  <>
                    <label>Primary repository (where a plain #12 points)</label>
                    <select className="fsel full" value={primaryRepo} onChange={(e) => setPrimary(e.target.value)}>
                      {selectedRepos.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </>
                )}

                <div className="pick-head">
                  <label>Project boards</label>
                  <label className="mpick-row pick-all">
                    <input
                      type="checkbox"
                      checked={allBoards}
                      onChange={(e) => {
                        setAllBoards(e.target.checked)
                        setBoards(e.target.checked ? Object.fromEntries(found.owners.flatMap((o) => o.projects).map((p) => [projectKey(p), boards[projectKey(p)] ?? p])) : {})
                      }}
                    />
                    <span>Select all</span>
                  </label>
                </div>
                <div className="pick-list">
                  {found.owners.flatMap((o) => o.projects).length === 0 && (
                    <div className="meta">No project boards found (gh needs the project scope: <code>gh auth refresh -s project</code>). Issues and PRs still work.</div>
                  )}
                  {found.owners
                    .filter((o) => o.projects.length)
                    .map((o) => (
                      <div key={o.login} className="pick-group">
                        <div className="pick-owner">{o.login}</div>
                        {o.projects.map((p) => (
                          <label key={projectKey(p)} className="mpick-row pick-row">
                            <input type="checkbox" checked={!!boards[projectKey(p)]} onChange={() => toggleBoard(p)} />
                            <span className="grow">
                              #{p.number} {p.title}
                            </span>
                            <span className="muted">
                              {p.items} item{p.items === 1 ? '' : 's'}
                              {p.sprintField ? ` · sprints (${p.sprintField})` : ''}
                              {p.error ? ` · ${p.error}` : ''}
                            </span>
                          </label>
                        ))}
                      </div>
                    ))}
                </div>
                {Object.values(boards).map((p) => (
                  <details key={projectKey(p)} className="status-more">
                    <summary>What the statuses on {p.title} mean</summary>
                    <StatusEditor columns={p.columns} statuses={p.statuses} onChange={(st) => setStatuses(projectKey(p), st)} />
                  </details>
                ))}
              </>
            ) : null}
          </>
        )}

        {step === 4 && (
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

            <label>Notifications</label>
            <label className="mpick-row">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              <span>
                Notify me when something new needs me: a question, a session waiting on a prompt, a proposal, failing CI… (macOS asks
                once for permission). Also in Settings.
              </span>
            </label>

            <div className="meta">
              Saved to <code>{cfg.path || '~/.claude/master/config.json'}</code>, shared with the master and babysit skills.
            </div>
          </>
        )}

        </div>
        </div>
        <div className="foot">
          <span className="grow meta">{msg && <span className="bad">{msg}</span>}</span>
          {firstRun && step === 0 ? null : firstRun ? (
            <button className="btn" onClick={onClose} title="Sessions work without GitHub; connect it later from the Board, PRs or Settings">
              Skip for now
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          {!firstRun ? (
            <button className="btn primary" disabled={busy || finding || !primaryRepo} onClick={save} title={primaryRepo ? '' : 'Pick at least one repository'}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          ) : null}
          {firstRun && step > 0 && (
            <button className="btn" disabled={busy} onClick={() => void go(step - 1)}>
              Back
            </button>
          )}
          {firstRun && step === 0 && (
            <button className="btn" disabled={busy} onClick={() => void go(1)}>
              Skip for now
            </button>
          )}
          {!firstRun ? null : step < STEPS.length - 1 ? (
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

/** What each of a board's statuses means: the four moves, and which count as done, assignable... */
function StatusEditor({ columns, statuses: st, onChange }: { columns: string[]; statuses: StatusMap; onChange: (s: StatusMap) => void }) {
  const set = (patch: Partial<StatusMap>) => onChange({ ...st, ...patch })
  const toggle = (k: 'done' | 'finished' | 'assignable' | 'resumable' | 'blocked', col: string) =>
    set({ [k]: st[k].includes(col) ? st[k].filter((c) => c !== col) : [...st[k], col] })
  return (
    <>
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
            <select className="fsel" value={st[k] as string} onChange={(e) => set({ [k]: e.target.value })}>
              {columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
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
          {columns.map((c) => (
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
    </>
  )
}

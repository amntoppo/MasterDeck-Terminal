import { useEffect, useRef, useState } from 'react'
import { claudeInstall } from '@shared/install'
import { projectKey, type AppConfig, type CodeRepo, type ProjectConfig, type StatusMap } from '@shared/appConfig'
import { parseDetectAll, type DetectAll } from '@shared/detect'
import { hasProjectScope, type GhAccount } from '@shared/ghAuth'
import type { SetupTool } from '@shared/ipc'
import type { AppState } from '@shared/types'
import { deck } from '../deck'
import { can } from '../web'
import { webConfirm } from '../webConfirm'
import { RepoPicker } from './RepoPicker'
import { TerminalView } from './TerminalView'
import { AccountPanel } from './AccountPanel'
import { MODS_ABOUT, ModsPanel } from './ModsPanel'
import { canAdvance } from './stepRules'
import { accountsFromSetup, boardTakenBy, codeReposToSave, markMade, selFromConfig, switchSel, swapPrimaryWorkspace, takenBy, withFound, workspacesFromConfig, type AccountSel, type Connected } from './setupAccounts'


const STEPS = ['Account', 'Tools', 'GitHub accounts', 'Repos & boards', 'Mods', 'Preferences'] as const

const INSTALLER_PANE = 'setup:installer'
const GH_LOGIN_PANE = 'setup:gh-login'

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
  { id: 'jq', name: 'jq', hint: "needed by MasterDeck's hooks (/queue, workflow steps, self-review)" },
]

/**
 * First-run setup (a six-step wizard: the optional account, then; from Settings → Set up MasterDeck, the same sections as one page): tools, the GitHub accounts, the
 * owner / issue repository / board with its statuses, MasterDeck's mods (installed at once, not at Save), then workspace and master-agent. Skills and
 * their hooks have their own popup (it opens after a first-run setup).
 * Everything lands in ~/.claude/master/config.json, which master and MasterDeck share.
 */
export function SetupDialog({ state, onClose, firstRun }: { state: AppState; onClose: () => void; firstRun: boolean }) {
  const cfg = state.config
  const [step, setStep] = useState(0)
  const signedIn = state.account?.kind === 'signedIn'
  const [remoteOn, setRemoteOn] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The web: gh accounts and the folder window are the Mac's (blocked); a repo picker stands in for the latter.
  const ghHere = can('ghAccounts')
  const [picking, setPicking] = useState(false)

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
  // The sessions go when the dialog does.
  useEffect(
    () => () => {
      deck().ptyClose(INSTALLER_PANE)
      deck().ptyClose(GH_LOGIN_PANE)
    },
    [],
  )

  // Step 3: the GitHub accounts MasterDeck uses: gh's own logins, connected here. MasterDeck never
  // changes gh's active account (gh auth login itself makes a new login active; Setup says so).
  const [accounts, setAccounts] = useState<GhAccount[] | null>(null)
  const [accountsErr, setAccountsErr] = useState<string | null>(null)
  const [connected, setConnected] = useState<Connected[]>(() => cfg.accounts.map((a) => ({ login: a.login, name: a.name, email: a.email })))
  const [primaryLogin, setPrimaryLogin] = useState(() => cfg.accounts.find((a) => a.primary)?.login ?? '')
  // "Add an account" open: gh's active login when it opened (to notice gh switching it).
  const [adding, setAdding] = useState<string | null>(null)
  const [activeNote, setActiveNote] = useState<string | null>(null)
  const connect = async (login: string) => {
    const u = await deck().ghUser(login)
    setConnected((cur) => (cur.some((c) => c.login === login) ? cur : [...cur, { login, name: u.name, email: u.email }]))
    setPrimaryLogin((p) => p || login)
  }
  const disconnect = (login: string) => {
    const rest = connected.filter((c) => c.login !== login)
    setConnected(rest)
    if (primaryLogin === login) makePrimary(rest[0]?.login ?? '', null)
    if (editing === login && rest[0]) switchTo(rest[0].login, login)
    else setSel(({ [login]: _gone, ...others }) => others)
  }
  const loadAccounts = async (): Promise<GhAccount[]> => {
    setAccounts(null)
    setAccountsErr(null)
    const r = await deck().ghAccounts()
    setAccounts(r.accounts)
    setAccountsErr(r.error ?? null)
    // First setup: the account gh uses now is connected.
    const first = r.accounts.find((a) => a.active) ?? r.accounts[0]
    if (!connected.length && first) await connect(first.login)
    return r.accounts
  }
  const closeLogin = async () => {
    deck().ptyClose(GH_LOGIN_PANE)
    const before = adding
    setAdding(null)
    const now = (await loadAccounts()).find((a) => a.active)?.login ?? null
    if (before && now && now !== before)
      setActiveNote(`gh made ${now} its active account (gh auth login does that). With one connected account MasterDeck runs as gh's active account, and so do your own terminals; with several, each session runs as its own account. Run gh auth switch -u ${before} to go back.`)
  }
  // What MasterDeck knows of each connected account (token health; a git rule that may send GitHub over SSH).
  const sshWarning = state.ghAccounts?.find((a) => a.warning)?.warning

  // Step 4: the repos and boards to follow (every org the account can reach), which repo is primary,
  // and what each board's statuses mean; one set per connected account.
  const [found, setFound] = useState<DetectAll | null>(null)
  // Reads of GitHub under way (one per account asked about).
  const [loads, setLoads] = useState(0)
  const finding = loads > 0
  // The primary account's choices first; the others wait in `sel` until shown.
  const firstSel = cfg.accounts[0] ? selFromConfig(cfg.accounts[0]) : null
  const [repos, setRepos] = useState<string[]>(() => firstSel?.repos ?? cfg.repos)
  const [allRepos, setAllRepos] = useState(firstSel?.allRepos ?? cfg.allRepos)
  const [primary, setPrimary] = useState(() => firstSel?.primary ?? (cfg.owner && cfg.issueRepo ? `${cfg.owner}/${cfg.issueRepo}` : ''))
  const [boards, setBoards] = useState<Record<string, ProjectConfig>>(() => firstSel?.boards ?? Object.fromEntries(cfg.projects.map((p) => [projectKey(p), p])))
  const [allBoards, setAllBoards] = useState(firstSel?.allBoards ?? cfg.allProjects)
  const [repoSearch, setRepoSearch] = useState('')
  // Which account's repos and boards are on screen ('' none yet: a config without accounts).
  const [editing, setEditing] = useState(() => cfg.accounts.find((a) => a.primary)?.login ?? '')
  const editingRef = useRef(editing)
  editingRef.current = editing
  const [sel, setSel] = useState<Record<string, AccountSel>>(() => Object.fromEntries(cfg.accounts.map((a) => [a.login, selFromConfig(a)])))
  const selRef = useRef(sel)
  selRef.current = sel
  // What the screen shows (set each render): a finished read applies to it, not to what it showed when asked.
  const onScreenRef = useRef<AccountSel | null>(null)
  const [foundBy, setFoundBy] = useState<Record<string, DetectAll>>({})

  const show = (s: AccountSel) => {
    setRepos(s.repos)
    setAllRepos(s.allRepos)
    setPrimary(s.primary)
    setBoards(s.boards)
    setAllBoards(s.allBoards)
  }
  /**
   * Read `login`'s repos and boards ('' gh's active account). The answer is applied to that
   * account's choices as they are when it arrives (ticks and status edits made meanwhile stay):
   * the screen's if it is still shown, else its entry in `sel`; `s` (its choices when asked) only
   * when it has neither.
   */
  const loadFound = async (login: string, s: AccountSel) => {
    setLoads((n) => n + 1)
    setMsg(null)
    const r = await deck().configDetectAll(login || undefined)
    setLoads((n) => n - 1)
    const shown = login === editingRef.current
    if (!r.ok) return shown ? setMsg(r.message) : undefined
    // Boards MasterDeck created keep their mark (no sprint field): GitHub's answer does not carry it.
    const d = markMade(parseDetectAll(r.data), cfg.projects)
    setFoundBy((cur) => ({ ...cur, [login]: d }))
    if (!shown) {
      // Switched to another account meanwhile: these choices wait in `sel` (its errors are not shown).
      setSel((cur) => (cur[login] ? { ...cur, [login]: withFound(cur[login], d, login, cur) } : cur))
      return
    }
    setFound(d)
    if (d.error) setMsg(d.error)
    show(withFound(onScreenRef.current ?? s, d, login, selRef.current))
  }

  // Step 5.
  // A fresh install starts from the folder master would use anyway.
  const [workspace, setWorkspace] = useState(cfg.workspace || state.masterWorkspace || '')
  // Two or more accounts: each other account's own workspace (blank: the one above). Which row's web picker is open.
  const [workspaces, setWorkspaces] = useState<Record<string, string>>(() => workspacesFromConfig(cfg.accounts))
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const setWorkspaceOf = (login: string, p: string) => setWorkspaces((w) => ({ ...w, [login]: p }))
  /** Another primary: the Workspace field is the primary's, so the two accounts' folders swap (none is dropped). */
  const makePrimary = (to: string, from: string | null) => {
    setPrimaryLogin(to)
    if (!to) return
    const next = swapPrimaryWorkspace(workspace, workspaces, from, to)
    setWorkspace(next.workspace)
    setWorkspaces(next.workspaces)
  }
  const [useMaster, setUseMaster] = useState(cfg.masterEnabled)
  const [notify, setNotify] = useState(state.settings.notifyNeedsYou)

  useEffect(() => {
    checkTools()
    // From Settings every section is one click away: know the account up front.
    if (!firstRun && ghHere) void loadAccounts()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !firstRun && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const go = async (to: number) => {
    setMsg(null)
    if (to === 2 && accounts === null && ghHere) void loadAccounts()
    // Leaving Account for the next step (not Skip): apply the Remote switch.
    if (firstRun && step === 0 && to === 1 && signedIn && remoteOn) await deck().setSettings({ ...(await deck().getSettings()), remoteEnabled: true })
    if (to === 3) {
      if (!editing && primaryLogin) switchTo(primaryLogin)
      else if (found === null && !finding) void loadFound(editing, onScreen())
    }
    setStep(to)
  }

  // Repos and boards under another account never count under this one.
  const selectedBoards = Object.fromEntries(Object.entries(boards).filter(([k]) => !boardTakenBy(k, editing, sel)))
  const selectedRepos = (allRepos ? (found ? found.owners.flatMap((o) => o.repos.map((x) => x.repo)) : repos) : repos).filter((r) => !takenBy(r, editing, sel))
  const primaryRepo = selectedRepos.includes(primary) ? primary : (selectedRepos[0] ?? '')
  const onScreen = (): AccountSel => ({ repos: selectedRepos, allRepos, primary: primaryRepo, boards: selectedBoards, allBoards })
  onScreenRef.current = onScreen()
  /** Show another account's repos and boards; `drop`: an account just disconnected (its choices go). */
  const switchTo = (login: string, drop?: string) => {
    if (login === editing) return
    const r = switchSel(sel, editing, onScreen(), login, drop)
    setSel(r.sel)
    selRef.current = r.sel
    show(r.shown)
    setEditing(login)
    editingRef.current = login
    setFound(foundBy[login] ?? null)
    if (!foundBy[login]) void loadFound(login, r.shown)
  }
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
  // Issues filed in one repository and built in another: their sessions start in the other's checkout.
  const [codeRepos, setCodeRepos] = useState<CodeRepo[]>(() => cfg.codeRepos ?? [])
  // Every account's chosen repositories (an issue repository picks from these).
  const issueRepos = [...new Set([...selectedRepos, ...Object.entries(sel).filter(([l]) => l !== editing).flatMap(([, s]) => s.repos)])]
  const setCodeRow = (i: number, row: Partial<CodeRepo>) => setCodeRepos((cur) => cur.map((r, j) => (j === i ? { ...r, ...row } : r)))
  const setStatuses = (k: string, st: StatusMap) => setBoards((b) => (b[k] ? { ...b, [k]: { ...b[k], statuses: st } } : b))

  const save = async () => {
    // The account on screen ('' before any was shown: the primary) keeps what the screen shows.
    const key = editing || primaryLogin
    const all = key ? { ...sel, [key]: onScreen() } : sel
    const ownerType = (login: string, owner: string) =>
      (foundBy[login] ?? (login === key ? found : null))?.owners.find((o) => o.login === owner)?.type ??
      cfg.accounts.find((a) => a.login === login)?.ownerType ??
      (owner === cfg.owner ? cfg.ownerType : 'organization')
    const list = accountsFromSetup(connected, primaryLogin, all, ownerType, workspaces)
    if (!list.length) return setMsg('Go back and connect a GitHub account.')
    if (!list[0].issueRepo) return setMsg(`Go back and pick at least one repository for ${list[0].login}.`)
    if (list.some((a) => !a.email.includes('@'))) return setMsg('Each connected account needs an email for its commits.')
    const code = codeReposToSave(codeRepos)
    if (!code.ok) return setMsg(code.message)
    if (!(await webConfirm('Save this setup to your Mac?', { confirmLabel: 'Save' }))) return
    setBusy(true)
    setMsg(null)
    if (notify !== state.settings.notifyNeedsYou) await deck().setSettings({ ...(await deck().getSettings()), notifyNeedsYou: notify })
    const patch: Record<string, unknown> = {
      accounts: list,
      // No board on the primary account: issues and PRs only (master config save mirrors the rest from it).
      ...(list[0].projects.length ? {} : { project: 0 }),
      ...(workspace ? { workspace } : {}),
      masterEnabled: useMaster,
      codeRepos: code.list,
    }
    const r = await deck().configSave(patch)
    setBusy(false)
    if (!r.ok) return setMsg(r.message)
    onClose()
  }

  // Settings view: one line under each section's name.
  const bad = TOOLS.filter((t) => tools[t.id]?.ok === false).length
  const sectionSummary = [
    signedIn && state.account?.kind === 'signedIn' ? state.account.email : 'not signed in',
    !toolsDone ? 'checking…' : bad ? `${bad} missing` : 'all installed',
    !ghHere ? 'on your Mac' : connected.length ? connected.map((c) => c.login).join(', ') : accounts === null ? '—' : 'none connected',
    primaryRepo ? `${allRepos ? 'all repos' : `${selectedRepos.length} repo${selectedRepos.length === 1 ? '' : 's'}`} · ${allBoards ? 'all boards' : `${Object.keys(selectedBoards).length} board${Object.keys(selectedBoards).length === 1 ? '' : 's'}`}` : 'none chosen',
    state.mods?.state === 'installed' ? 'installed' : state.mods?.state === 'partial' ? 'partly installed' : 'not installed',
    `${useMaster ? 'master on' : 'master off'} · ${notify ? 'notifications on' : 'notifications off'}`,
  ]
  // Next from Repos & boards needs a repository under the primary account (on screen or not).
  const hasPrimaryRepo = !editing || editing === primaryLogin ? !!primaryRepo : !!sel[primaryLogin]?.repos.length
  const ghOk = connected.length > 0 && connected.every((c) => accounts?.find((a) => a.login === c.login)?.ok !== false)
  const canNext = canAdvance(step, { signedIn, toolsDone, ghOk, hasPrimaryRepo, finding })
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
              The GitHub accounts MasterDeck and your sessions use. A session works as one of them: its commits, PRs and gh calls. MasterDeck never changes gh's active account.
            </div>
            {!ghHere ? (
              <div className="meta">
                Connect GitHub accounts on your Mac (Settings → Set up MasterDeck).{connected.length ? ` Connected: ${connected.map((c) => c.login).join(', ')}.` : ''}
              </div>
            ) : accounts === null ? (
              <Spin text="Looking for the accounts gh is logged in to…" />
            ) : (
              <>
                {accounts.length === 0 && <div className="meta">gh is not logged in to GitHub{accountsErr ? ` (${accountsErr})` : ''}. Add an account below.</div>}
                <div className="pick-list">
                  {[
                    ...accounts,
                    // Connected before, but gh is no longer logged in to it: still listed, so it can be disconnected.
                    ...connected.filter((c) => !accounts.some((a) => a.login === c.login)).map((c): GhAccount => ({ login: c.login, active: false, ok: false, scopes: [] })),
                  ].map((a) => {
                    const c = connected.find((x) => x.login === a.login)
                    const inGh = accounts.some((x) => x.login === a.login)
                    const health = state.ghAccounts?.find((x) => x.login === a.login)
                    const setC = (patch: Partial<Connected>) => setConnected((cur) => cur.map((x) => (x.login === a.login ? { ...x, ...patch } : x)))
                    return (
                      <div key={a.login} className="pick-group">
                        <div className="mpick-row pick-row">
                          <label className="mpick-row grow">
                            <input type="checkbox" checked={!!c} disabled={busy || (!!c && connected.length === 1)} onChange={() => (c ? disconnect(a.login) : void connect(a.login))} />
                            <span>
                              {a.login}
                              {!inGh ? ' (gh is not logged in to it)' : a.ok ? '' : ' (token no longer works)'}
                            </span>
                          </label>
                          {c && connected.length > 1 && (
                            <label className="mpick-row">
                              <input type="radio" name="primary-account" checked={primaryLogin === a.login} onChange={() => makePrimary(a.login, primaryLogin || null)} /> Primary
                            </label>
                          )}
                        </div>
                        {c && (
                          <div className="row-inputs">
                            <input value={c.name} placeholder="Name on commits" aria-label={`Commit name for ${a.login}`} onChange={(e) => setC({ name: e.target.value })} />
                            <input value={c.email} placeholder="Email on commits" aria-label={`Commit email for ${a.login}`} onChange={(e) => setC({ email: e.target.value })} />
                          </div>
                        )}
                        {c && !a.ok && <div className="meta bad">MasterDeck can't use this account until it logs in again: use Add an account.</div>}
                        {c && a.ok && health && !health.healthy && (
                          <div className="meta bad">MasterDeck can't use this account{health.error ? `: ${health.error}` : ''}. Log in again with Add an account.</div>
                        )}
                        {c && a.ok && !hasProjectScope(a) && (
                          <div className="meta">
                            To use project boards, this account needs the <code>project</code> scope: run <code>gh auth refresh -h github.com -s project -u {a.login}</code>, then{' '}
                            <button className="link-btn" onClick={() => void loadAccounts()}>
                              look again
                            </button>
                            .
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                {sshWarning && <div className="meta bad">{sshWarning}</div>}
                {connected.length > 1 && (
                  <div className="meta">Primary: master-agent, plain shells and sessions outside every account's repos use it. Unticking an account stops MasterDeck using it; gh stays logged in.</div>
                )}
                {activeNote && <div className="meta">{activeNote}</div>}
                {adding !== null ? (
                  <div className="installer">
                    <div className="installer-head">
                      <b>Add a GitHub account</b>
                      <span className="meta grow">gh opens GitHub in your browser: log in there as the other account. gh then makes it its active account; MasterDeck never switches it back (run gh auth switch yourself). With one account MasterDeck runs as gh's active account.</span>
                      <button className="btn" onClick={() => void closeLogin()}>
                        Close
                      </button>
                    </div>
                    <div className="installer-term">
                      <TerminalView paneId={GH_LOGIN_PANE} spec={{ kind: 'gh-login' }} visible focusOnShow onExit={() => void closeLogin()} />
                    </div>
                  </div>
                ) : (
                  <button className="btn" onClick={() => setAdding(accounts.find((a) => a.active)?.login ?? '')}>
                    Add an account…
                  </button>
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
              <button className="link-btn" onClick={() => void loadFound(editing, onScreen())} disabled={finding}>
                Look again
              </button>
            </div>
            {connected.length > 1 && (
              <div className="pick-head">
                <label>Account</label>
                <select className="fsel" value={editing} disabled={finding} onChange={(e) => switchTo(e.target.value)}>
                  {!editing && <option value="">—</option>}
                  {connected.map((c) => (
                    <option key={c.login} value={c.login}>
                      {c.login}
                      {c.login === primaryLogin ? ' (primary)' : ''}
                    </option>
                  ))}
                </select>
                <span className="meta">Each account has its own repositories and boards; a repository belongs to one account.</span>
              </div>
            )}
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
                        setRepos(e.target.checked ? found.owners.flatMap((o) => o.repos.map((x) => x.repo)).filter((r) => !takenBy(r, editing, sel)) : primaryRepo ? [primaryRepo] : [])
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
                        {rs.map((x) => {
                          const other = takenBy(x.repo, editing, sel)
                          return (
                            <label key={x.repo} className="mpick-row pick-row">
                              <input type="checkbox" checked={selectedRepos.includes(x.repo)} disabled={!!other} onChange={() => toggleRepo(x.repo)} />
                              <span className="grow">{x.repo.split('/')[1]}</span>
                              <span className="muted">{other ? `in ${other}` : x.openIssues ? `${x.openIssues} open issue${x.openIssues === 1 ? '' : 's'}` : 'no open issues'}</span>
                            </label>
                          )
                        })}
                      </div>
                    )
                  })}
                  {!found.owners.some((o) => o.repos.length) && <div className="meta">No repositories found for this account.</div>}
                </div>
                {selectedRepos.length > 1 && (
                  <>
                    <label>{editing && editing !== primaryLogin ? `Main repository of ${editing}` : 'Primary repository (where a plain #12 points)'}</label>
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
                        setBoards(
                          e.target.checked
                            ? Object.fromEntries(
                                found.owners
                                  .flatMap((o) => o.projects)
                                  .filter((p) => !boardTakenBy(projectKey(p), editing, sel))
                                  .map((p) => [projectKey(p), boards[projectKey(p)] ?? p]),
                              )
                            : {},
                        )
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
                        {o.projects.map((p) => {
                          const other = boardTakenBy(projectKey(p), editing, sel)
                          return (
                            <label key={projectKey(p)} className="mpick-row pick-row">
                              <input type="checkbox" checked={!other && !!boards[projectKey(p)]} disabled={!!other} onChange={() => toggleBoard(p)} />
                              <span className="grow">
                                #{p.number} {p.title}
                              </span>
                              <span className="muted">
                                {other ? `in ${other}` : `${p.items} item${p.items === 1 ? '' : 's'}`}
                                {!other && p.sprintField ? ` · sprints (${p.sprintField})` : ''}
                                {!other && p.error ? ` · ${p.error}` : ''}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    ))}
                </div>
                {Object.values(selectedBoards).map((p) => (
                  <details key={projectKey(p)} className="status-more">
                    <summary>What the statuses on {p.title} mean</summary>
                    <StatusEditor columns={p.columns} statuses={p.statuses} onChange={(st) => setStatuses(projectKey(p), st)} />
                  </details>
                ))}
                <details className="status-more code-repos" open={codeRepos.length > 0}>
                  <summary>Issues whose code is in another repository</summary>
                  <div className="meta">
                    A ticket&apos;s session starts in the code&apos;s checkout, as the account of that repository (an issue tracker and the
                    repository it is built in). That account must be able to read the issues: a private tracker under another account
                    is not readable from the session.
                  </div>
                  {codeRepos.map((r, i) => (
                    <div key={i} className="row-inputs code-repo-row">
                      <select className="fsel" aria-label="Issues filed in" value={r.issues} onChange={(e) => setCodeRow(i, { issues: e.target.value })}>
                        {[...new Set([r.issues, ...issueRepos])].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      <span className="muted">code in</span>
                      <input
                        aria-label="Code in"
                        placeholder="owner/name"
                        list="setup-code-repos"
                        value={r.code}
                        spellCheck={false}
                        onChange={(e) => setCodeRow(i, { code: e.target.value })}
                      />
                      <button className="link-btn" onClick={() => setCodeRepos((cur) => cur.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <datalist id="setup-code-repos">
                    {found.owners.flatMap((o) => o.repos).map((x) => (
                      <option key={x.repo} value={x.repo} />
                    ))}
                  </datalist>
                  {issueRepos.length > 0 && (
                    <button
                      className="link-btn"
                      onClick={() =>
                        setCodeRepos((cur) => [...cur, { issues: issueRepos.find((x) => !cur.some((r) => r.issues === x)) ?? issueRepos[0], code: '' }])
                      }
                    >
                      Add
                    </button>
                  )}
                </details>
              </>
            ) : null}
          </>
        )}

        {step === 4 && (
          <>
            <div className="meta">{MODS_ABOUT}</div>
            <div className="meta">
              Optional. Installing adds MasterDeck's folder of mods to Claude Code and turns them on for your user; Remove (here or in
              Settings) takes them out again. New sessions load them; running ones at a reload.
            </div>
            <ModsPanel state={state} />
          </>
        )}

        {step === 5 && (
          <>
            <label>Workspace (master and new shells start here; your repos live in or next to it)</label>
            <div className="row-inputs">
              <input value={workspace} placeholder="~/code" onChange={(e) => setWorkspace(e.target.value)} />
              <button className="btn" onClick={async () => { if (!can('pickFolder')) return setPicking(true); const p = await deck().pickFolder(workspace); if (p) setWorkspace(p) }}>
                Choose…
              </button>
            </div>
            {picking && <RepoPicker start={workspace} onDone={(p) => { setPicking(false); if (p) setWorkspace(p) }} />}
            {connected.length > 1 &&
              connected
                .filter((c) => c.login !== primaryLogin)
                .map((c) => (
                  <div key={c.login}>
                    <label>
                      Workspace for {c.login} (its repos are cloned here; empty: the workspace above)
                    </label>
                    <div className="row-inputs">
                      <input value={workspaces[c.login] ?? ''} placeholder={workspace || '~/code'} onChange={(e) => setWorkspaceOf(c.login, e.target.value)} />
                      <button
                        className="btn"
                        onClick={async () => {
                          if (!can('pickFolder')) return setPickingFor(c.login)
                          const p = await deck().pickFolder(workspaces[c.login] || workspace)
                          if (p) setWorkspaceOf(c.login, p)
                        }}
                      >
                        Choose…
                      </button>
                    </div>
                    {pickingFor === c.login && (
                      <RepoPicker start={workspaces[c.login] || workspace} onDone={(p) => { setPickingFor(null); if (p) setWorkspaceOf(c.login, p) }} />
                    )}
                  </div>
                ))}

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
              Saved to <code>{cfg.path || '~/.claude/master/config.json'}</code>, shared with the master skill.
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
            <button className="btn primary" disabled={busy || finding} onClick={save}>
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
              Next
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

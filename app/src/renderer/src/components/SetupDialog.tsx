import { useEffect, useState } from 'react'
import type { AppConfig, StatusMap } from '@shared/appConfig'
import type { AppState, SetupCheck } from '@shared/types'
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

/**
 * First-run setup (and Settings → GitHub & board): check the tools, pick the GitHub owner, issue
 * repo and project board, map the board's statuses, choose the workspace, install hooks.
 * Everything lands in ~/.claude/master/config.json, which master, babysit-ticket and MasterDeck share.
 */
export function SetupDialog({ state, onClose, firstRun }: { state: AppState; onClose: () => void; firstRun: boolean }) {
  const cfg = state.config
  const [check, setCheck] = useState<SetupCheck | null>(null)
  const [owner, setOwner] = useState(cfg.owner)
  const [det, setDet] = useState<Detected | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [issueRepo, setIssueRepo] = useState(cfg.issueRepo)
  const [project, setProject] = useState<number>(cfg.project)
  const [board, setBoard] = useState<Detected['board'] | null>(
    cfg.project ? { project: cfg.project, projectId: cfg.projectId, statusFieldId: cfg.statusFieldId, statusOptions: cfg.statusOptions, columns: cfg.columns, statuses: cfg.statuses, sprintField: cfg.sprintField } : null,
  )
  const [workspace, setWorkspace] = useState(cfg.workspace || '')
  const [hooks, setHooks] = useState({ ticket: state.hooks.ticket || firstRun, pr: state.hooks.pr || firstRun, queue: state.hooks.queue || firstRun })
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void deck()
      .setupCheck()
      .then((c) => {
        setCheck(c)
        if (!owner && c.ghUser) setOwner(c.ghUser)
      })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !firstRun && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const detect = async (o = owner, p?: number) => {
    if (!o.trim()) return
    setDetecting(true)
    setMsg(null)
    const r = await deck().configDetect(o.trim(), p)
    setDetecting(false)
    if (!r.ok) return setMsg(r.message)
    const d = r.data as Detected
    if (d.error) return setMsg(d.error)
    setDet(d)
    if (p) {
      setBoard(d.board ?? null)
      if (d.board?.error) setMsg(d.board.error)
    } else if (!project && d.projects?.length === 1) {
      setProject(d.projects[0].number)
      void detect(o, d.projects[0].number)
    }
  }

  const pickProject = (n: number) => {
    setProject(n)
    setBoard(null)
    if (n) void detect(owner, n)
  }

  const st = board?.statuses
  const setSt = (patch: Partial<StatusMap>) => board && setBoard({ ...board, statuses: { ...board.statuses, ...patch } })
  const toggle = (k: 'done' | 'finished' | 'assignable' | 'resumable' | 'blocked', col: string) =>
    st && setSt({ [k]: st[k].includes(col) ? st[k].filter((c) => c !== col) : [...st[k], col] })

  const save = async () => {
    if (!owner.trim() || !issueRepo.trim()) return setMsg('Pick the GitHub owner and the repository that holds your issues.')
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

  const Tool = ({ ok, name, hint }: { ok: boolean | null; name: string; hint: string }) => (
    <div className="setup-tool">
      <span className={ok === null ? 'wait' : ok ? 'ok' : 'bad'}>{ok === null ? '…' : ok ? '✓' : '✗'}</span> {name}
      {ok === false && <span className="muted"> — {hint}</span>}
    </div>
  )
  const scopesOk = !check || check.ghScopes.length === 0 || (check.ghScopes.includes('project') || check.ghScopes.includes('read:project'))

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !firstRun && onClose()}>
      <div className="dialog setup" role="dialog" aria-label="Set up MasterDeck">
        <h3>{firstRun ? 'Welcome to MasterDeck' : 'GitHub & board'}</h3>
        <div className="meta">
          {firstRun ? 'Point MasterDeck at your GitHub. ' : ''}Saved to <code>{cfg.path || '~/.claude/master/config.json'}</code>, shared with the master
          and babysit skills.
        </div>

        <label>Tools</label>
        <div className="setup-tools">
          <Tool ok={check ? !!check.claude : null} name="Claude Code (claude)" hint="install Claude Code and log in" />
          <Tool ok={check ? check.gh : null} name="GitHub CLI (gh)" hint="brew install gh / winget install GitHub.cli" />
          <Tool ok={check ? !!check.ghUser : null} name={check?.ghUser ? `gh logged in as ${check.ghUser}` : 'gh logged in'} hint="run: gh auth login" />
          <Tool ok={check ? scopesOk : null} name="gh project scope" hint="run: gh auth refresh -s project" />
          <Tool ok={check ? check.python : null} name="Python 3" hint="needed by the master CLI" />
          <Tool ok={check ? check.git : null} name="git" hint="needed for worktrees and standups" />
          <Tool ok={check ? check.jq : null} name="jq" hint="needed by the babysit-ticket and babysit-pr hooks" />
        </div>

        <label>GitHub owner (organization or user)</label>
        <div className="row-inputs">
          <input value={owner} placeholder="acme" onChange={(e) => setOwner(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && detect()} />
          <button className="btn" disabled={detecting || !owner.trim()} onClick={() => detect()}>
            {detecting ? 'Looking…' : 'Look up'}
          </button>
        </div>

        <label>Repository that holds your issues</label>
        {det?.repos?.length ? (
          <select className="fsel full" value={issueRepo} onChange={(e) => setIssueRepo(e.target.value)}>
            {!issueRepo && <option value="">Choose a repository…</option>}
            {!det.repos.includes(issueRepo) && issueRepo && <option value={issueRepo}>{issueRepo}</option>}
            {det.repos.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        ) : (
          <input value={issueRepo} placeholder="tracker" onChange={(e) => setIssueRepo(e.target.value)} />
        )}

        <label>Project board (GitHub Projects)</label>
        {det?.projects ? (
          <select className="fsel full" value={project} onChange={(e) => pickProject(Number(e.target.value))}>
            <option value={0}>No board (issues and PRs only)</option>
            {det.projects.map((p) => (
              <option key={p.number} value={p.number}>
                #{p.number} {p.title}
              </option>
            ))}
          </select>
        ) : (
          <div className="muted small">{cfg.project ? `Project #${cfg.project}. ` : ''}Look up the owner to choose a board.</div>
        )}
        {det?.projectsError && <div className="bad small">{det.projectsError}</div>}

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

        <label>Workspace (master runs here; your repos live in or next to it)</label>
        <div className="row-inputs">
          <input value={workspace} placeholder="~/code" onChange={(e) => setWorkspace(e.target.value)} />
          <button className="btn" onClick={async () => { const p = await deck().pickFolder(workspace); if (p) setWorkspace(p) }}>
            Choose…
          </button>
        </div>

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
          <span>queue: `/queue &lt;prompt&gt;` runs the prompt after the current response (and the Queue tab)</span>
        </label>

        <div className="foot">
          <span className="grow meta">{msg && <span className="bad">{msg}</span>}</span>
          {!firstRun && (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          {firstRun && (
            <button className="btn" onClick={onClose} title="Sessions work without GitHub; set it up later in Settings">
              Skip for now
            </button>
          )}
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

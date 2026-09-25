import type { PrSummary } from './prSummary'
import type { Settings } from './settings'
import type { HistoryHit } from './history'
import type { StandupCommit } from './standup'
import type { WorktreeClass, WorktreeInfo } from './janitor'

export interface JanitorRow extends WorktreeInfo {
  cls: WorktreeClass
  reason: string
}

export interface Template {
  name: string
  text: string
  builtin?: boolean
}
import type { AppState, CliResult, DraftAssign, HookStatus, PaneSpec, SetupCheck } from './types'

export const CH = {
  state: 'state:update',
  focusSession: 'app:focusSession',
  showNeedsYou: 'app:showNeedsYou',
  getState: 'state:get',
  approve: 'cli:approve',
  reject: 'cli:reject',
  draftAssign: 'cli:draftAssign',
  assign: 'cli:assign',
  refresh: 'cli:refresh',
  setFocus: 'app:setFocus',
  setVisible: 'app:setVisible',
  openExternal: 'app:openExternal',
  openEditor: 'app:openEditor',
  copy: 'app:copy',
  stopSession: 'session:stop',
  statuslineInstall: 'statusline:install',
  statuslineUninstall: 'statusline:uninstall',
  masterStart: 'master:start',
  ptyOpen: 'pty:open',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyClose: 'pty:close',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  confirm: 'app:confirm',
  boardRefresh: 'board:refresh',
  teamPrsRefresh: 'prs:refresh',
  setupCheck: 'setup:check',
  configDetect: 'config:detect',
  configSave: 'config:save',
  pickFolder: 'app:pickFolder',
  hooksInstall: 'hooks:install',
  skillReinstall: 'skills:reinstall',
  linkSession: 'session:link',
  setSprint: 'board:sprint',
  prSummary: 'pr:summary',
  assignIssue: 'issue:assign',
  defaultModel: 'models:default',
  startHere: 'session:startHere',
  sendText: 'session:sendText',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  autoOpen: 'app:autoOpen',
  setStatus: 'board:setStatus',
  standupCommits: 'standup:commits',
  janitor: 'janitor:list',
  removeWorktree: 'janitor:removeWorktree',
  removeSession: 'janitor:removeSession',
  searchHistory: 'history:search',
  templates: 'templates:list',
  saveTemplate: 'templates:save',
  deleteTemplate: 'templates:delete',
  resumeSession: 'session:resume',
  boardOpen: 'board:open',
} as const

export interface AssignRequest {
  issue: number
  name: string
  cwd: string
  prompt: string
  /** The existing proposal the draft came from, if any. */
  proposalId: number | null
  /** True when the user changed the name or text of an existing proposal. */
  edited: boolean
  /** The existing proposal is already approved (waiting for a spawn); just spawn it. */
  approved: boolean
  /** ASSIGN (default) or PRREVIEW. */
  kind?: 'ASSIGN' | 'PRREVIEW'
  /** `claude --model` for the new session; absent: the default model. */
  model?: string
}

export interface PtyOpenResult {
  ok: boolean
  /** Output produced before this view mounted (replayed into xterm). */
  replay: string
  /** Sequence number at the end of `replay`. */
  seq: number
  exited: boolean
  message?: string
}

/** The API the preload script exposes as `window.deck`. */
export interface DeckApi {
  platform: string
  home: string
  getState(): Promise<AppState | null>
  onState(cb: (s: AppState) => void): () => void
  onFocusSession(cb: (sessionKey: string) => void): () => void
  onShowNeedsYou(cb: () => void): () => void
  approve(id: number): Promise<CliResult>
  reject(id: number): Promise<CliResult>
  draftAssign(issue: number, title?: string, url?: string): Promise<{ ok: true; draft: DraftAssign } | { ok: false; message: string }>
  setSprint(sprint: string): void
  prSummary(url: string): Promise<{ ok: true; pr: PrSummary } | { ok: false; message: string }>
  /** Resume a session that runs in another terminal as a background session here. */
  startHere(o: { sessionId: string; name: string; cwd: string; pid: number | null; stopOther: boolean }): Promise<CliResult>
  /** Type text into a session as if the user typed it (open tab, hidden attach, or via master). */
  sendText(sessionKey: string, text: string): Promise<CliResult>
  getSettings(): Promise<Settings>
  setSettings(s: Settings): Promise<Settings>
  onAutoOpen(cb: (sessionKey: string) => void): () => void
  /** Move a ticket to a board column (babysit-ticket). */
  setStatus(issue: number, status: string): Promise<CliResult>
  standupCommits(sinceMs: number, dirs: string[], untilMs?: number): Promise<StandupCommit[]>
  /** `force` skips the shared gh cache for PR status (the Refresh button). */
  janitor(liveDirs: string[], force?: boolean): Promise<JanitorRow[]>
  removeWorktree(repo: string, path: string, force: boolean): Promise<CliResult>
  removeSession(bgId: string): Promise<CliResult>
  searchHistory(query: string): Promise<HistoryHit[]>
  templates(): Promise<Template[]>
  saveTemplate(t: Template): Promise<Template[]>
  deleteTemplate(name: string): Promise<Template[]>
  /** Resume an ended session's conversation in the background (history search). */
  resumeSession(sessionId: string, name: string, cwd: string | null): Promise<CliResult>
  /** Make `login` the only assignee (GitHub REST). */
  assignIssue(issue: number, login: string, current: string[]): Promise<CliResult>
  assign(req: AssignRequest): Promise<CliResult & { proposalId?: number }>
  /** The model set in ~/.claude/settings.json (what "Default" starts), or null. */
  defaultModel(): Promise<string | null>
  refresh(): Promise<CliResult>
  refreshBoard(): Promise<CliResult>
  /** Fetch every PR in the org; with `maxAgeMs`, only when the list is older than that. */
  refreshTeamPrs(maxAgeMs?: number): Promise<CliResult>
  /** Setup: which tools are installed and whether gh is logged in. */
  setupCheck(): Promise<SetupCheck>
  /** Setup: repos, projects and (for a project) statuses GitHub has for an owner. */
  configDetect(owner: string, project?: number): Promise<{ ok: true; data: unknown } | { ok: false; message: string }>
  /** Setup: save settings (merged into the config file), then reload everything. */
  configSave(patch: unknown): Promise<CliResult>
  pickFolder(start?: string): Promise<string | null>
  hooksInstall(which: HookStatus): Promise<CliResult>
  skillReinstall(name: string): Promise<CliResult>
  /** Link a session to an issue with babysit-ticket (`tt.sh link`). */
  linkSession(issue: number, sessionId: string, cwd: string | null): Promise<CliResult>
  setBoardOpen(open: boolean): void
  setFocus(sessionId: string | null): void
  setVisible(sessionIds: string[]): void
  openExternal(url: string): void
  openEditor(dir: string): Promise<CliResult>
  copy(text: string): void
  stopSession(bgId: string, name: string): Promise<CliResult>
  statuslineInstall(): Promise<CliResult>
  statuslineUninstall(): Promise<CliResult>
  masterStart(): Promise<CliResult>
  ptyOpen(id: string, spec: PaneSpec, cols: number, rows: number): Promise<PtyOpenResult>
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyClose(id: string): void
  onPtyData(id: string, cb: (data: string, seq: number) => void): () => void
  onPtyExit(id: string, cb: (code: number) => void): () => void
}

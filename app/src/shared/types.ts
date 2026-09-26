import type { Tokens } from './tokens'
import type { RestoreEntry } from './restore'
import type { AppConfig } from './appConfig'
import type { TeamPr } from './teamPrs'
import type { BurnPoint } from './sprintSummary'
import type { CostBook } from './costs'
import type { Settings } from './settings'
// Types shared by the main process and the renderer. No electron or node imports here.

export type SessionState = 'working' | 'idle' | 'needs-input' | 'suspended' | 'done'

export interface Session {
  /** Stable identity: the background id when there is one (it survives resume), else the sessionId. */
  key: string
  sessionId: string
  name: string
  kind: 'background' | 'interactive'
  /** `claude attach <bgId>` target; background sessions only. */
  bgId: string | null
  pid: number | null
  cwd: string
  state: SessionState
  /** The raw `state` / `status` value from `claude agents --json`, for display. */
  rawState: string
  startedAt: number
  issue: number | null
}

export interface Issue {
  number: number
  title: string
  url: string
  status: string | null
  currentSprint: boolean
  assignedToMe: boolean
}

export interface Pr {
  url: string
  repo: string
  number: number
  title: string
  unresolvedThreads: number
  ci: string | null
  headRef: string
  refsIssue: number | null
  authorIsMe?: boolean
  reviewRequested?: boolean
  updatedAt?: string | null
}

export interface SpawnTarget {
  name: string
  cwd?: string
  prompt?: string
  resume?: string
}

export interface Proposal {
  id: number
  kind: string
  issue: number
  status: string
  summary: string
  message: string
  note: string | null
  target: { session?: string; spawn?: SpawnTarget }
  closedAt?: string | null
}

export type MasterState =
  | { kind: 'attached'; session: Session }
  | { kind: 'elsewhere'; session: Session }
  | { kind: 'duplicate'; count: number }
  | { kind: 'absent' }

export type NeedsItem =
  | { kind: 'proposal'; proposal: Proposal }
  | { kind: 'attention'; proposal: Proposal }
  | { kind: 'session'; session: Session }

export interface SessionStats {
  costUsd: number | null
  contextPct: number | null
  model: string | null
  permissionMode: string | null
  currentDir: string | null
  linesAdded: number | null
  linesRemoved: number | null
  source: 'statusline' | 'transcript'
  updatedAt: number
}

export interface TranscriptTail {
  model: string | null
  contextTokens: number | null
  lastTool: string | null
  lastToolAt: number | null
  lastActivityAt: number | null
  cwd: string | null
  gitBranch: string | null
  permissionMode: string | null
}

export interface GitInfo {
  dir: string
  branch: string | null
  ahead: number
  behind: number
  added: number
  removed: number
  files: number
}

export interface PrLive {
  number: number
  title: string | null
  url: string
  state: string
  reviewDecision: string | null
  ci: 'success' | 'failure' | 'pending' | null
}

export type SourceHealth = 'ok' | 'error' | 'pending'

export interface AppState {
  sessions: Session[]
  issues: Issue[]
  prs: Pr[]
  proposals: Proposal[]
  master: MasterState
  needsYou: NeedsItem[]
  stats: Record<string, SessionStats>
  tails: Record<string, TranscriptTail>
  git: Record<string, GitInfo>
  /** Live details (state, CI, review) of the PRs of followed sessions, by PR URL. */
  prLive: Record<string, PrLive>
  /** PR URLs linked to each session (sessionId): babysit-ticket's list, then PRs it created. Oldest first. */
  sessionPrs: Record<string, string[]>
  sources: Record<string, SourceHealth>
  errors: string[]
  lastSnapshotAt: string | null
  statuslineInstalled: boolean
  missingBinaries: string[]
  masterWorkspace: string
  board: Board | null
  boardError: string | null
  boardLoading: boolean
  /** When issues and the board were last refreshed from GitHub (epoch ms), cache included. */
  githubRefreshedAt: number | null
  githubRefreshing: boolean
  sprints: Sprint[]
  selectedSprint: string
  users: string[]
  me: string | null
  settings: Settings
  /** Cost and context of every session with a status line file (not just open tabs). */
  allStats: Record<string, { costUsd: number | null; contextPct: number | null; updatedAt: number }>
  costBook: CostBook
  /** Last transcript write per session id (epoch ms). */
  lastActivity: Record<string, number>
  boardHistory: Record<string, BurnPoint[]>
  /** The shared GitHub cache (ghc) every GitHub caller on this machine goes through. */
  ghCache: GhCacheStatus | null
  /** Every open PR in the org and those closed in the last 90 days (the PRs view). */
  teamPrs: TeamPr[]
  teamPrsAt: number | null
  teamPrsLoading: boolean
  teamPrsError: string | null
  /** The user's GitHub and board settings (Setup writes them). */
  config: AppConfig
  /** The bundled Claude Code skills and whether each is installed. */
  skills: SkillStatus[]
  hooks: HookStatus
  /** Background sessions the last restart stopped, not resumed or dismissed yet (Settings: afterRestart). */
  stoppedByRestart: RestoreEntry[]
  /** Resuming them now. */
  restoring: boolean
  /** Tokens used so far (input, output, cache) by the sessions in open tabs, from their transcripts. */
  tokens: Record<string, Tokens>
}

export interface SkillStatus {
  name: string
  /**
   * installed: the bundled version · outdated: an older unmodified copy (updated at launch) ·
   * modified: changed by the user · custom: not installed by MasterDeck · linked: a symlink ·
   * missing: not installed
   */
  state: 'installed' | 'outdated' | 'modified' | 'custom' | 'linked' | 'missing'
  version?: string
}

export interface HookStatus {
  /** babysit-ticket's tt.sh hook (board moves). */
  ticket: boolean
  /** babysit-pr's gh pr create hooks (self-review gate, babysit reminder). */
  pr: boolean
  /** The queue skill's hooks: /queue stores a prompt, the next one runs when a response ends. */
  queue: boolean
}

/** What Setup checks before GitHub can work. */
export interface SetupCheck {
  claude: string | null
  gh: boolean
  ghUser: string | null
  ghScopes: string[]
  python: boolean
  jq: boolean
  git: boolean
}

export interface GhCacheStatus {
  /** Every GitHub caller is backing off until then (epoch ms), after a rate-limit error. */
  pausedUntil: number | null
  pauseReason: string | null
  /** Today's counters: hits and stale answers saved a call; misses and writes made one. */
  hit: number
  miss: number
  stale: number
  write: number
  blocked: number
}

export interface BoardPr {
  url: string
  repo: string
  number: number
  /** OPEN, DRAFT, MERGED, CLOSED, or null when GitHub couldn't resolve it. */
  state: string | null
  ci: 'success' | 'failure' | 'pending' | null
  unresolved: number
}

export interface BoardCard {
  number: number
  title: string
  url: string
  status: string | null
  prs: BoardPr[]
  assignees: string[]
  labels: string[]
  milestone: string | null
  type: string | null
}

export interface Sprint {
  id: string
  title: string
  startDate: string
  duration: number
  completed: boolean
}

export interface Board {
  takenAt: string | null
  sprint: string | null
  columns: string[]
  cards: BoardCard[]
}

export type BadgeKind = 'question' | 'blocked' | 'needs-input' | 'onboarding' | 'working' | 'done' | 'idle' | 'none'

export interface Badge {
  kind: BadgeKind
  label: string
  /** Why, when there is more to say (a proposal's note). */
  detail?: string
}

export interface DraftAssign {
  issue: number
  name: string
  cwd: string
  prompt: string
  summary: string
  title: string
  url: string
  /** Set when the draft came from an existing ledger proposal rather than `draft-assign`. */
  proposalId: number | null
}

export interface CliResult {
  ok: boolean
  message: string
}

export interface NotifyEvent {
  title: string
  body: string
  target: { sessionKey?: string; needsYou?: true }
}

export type PaneSpec =
  | { kind: 'attach'; bgId: string }
  | { kind: 'shell'; cwd: string }

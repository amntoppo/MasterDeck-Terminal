import type { WatchInfo } from "./watches";
import type { ScheduleInfo } from "./schedules";
import type { ScreenMenu, SessionAsk } from "./ask";
import type { InboxView } from "./inbox";
import type { PrStage, StatusKey } from "./review";
import type { PastSession } from "./pastSessions";
import type { Tokens } from "./tokens";
import type { RestoreEntry } from "./restore";
import type { AppConfig } from "./appConfig";
import type { TeamPr } from "./teamPrs";
import type { BurnPoint } from "./sprintSummary";
import type { CostBook } from "./costs";
import type { Settings } from "./settings";
// Types shared by the main process and the renderer. No electron or node imports here.

export type SessionState =
  "working" | "idle" | "needs-input" | "suspended" | "done";

export interface Session {
  /** Stable identity: the background id when there is one (it survives resume), else the sessionId. */
  key: string;
  sessionId: string;
  name: string;
  kind: "background" | "interactive";
  /** `claude attach <bgId>` target; background sessions only. */
  bgId: string | null;
  pid: number | null;
  cwd: string;
  state: SessionState;
  /** The raw `state` / `status` value from `claude agents --json`, for display. */
  rawState: string;
  startedAt: number;
  issue: number | null;
  /** The issue's repo (owner/name); null: the primary issue repo. */
  issueRepo?: string | null;
  /** Idle but waiting on something it set up to wake it (a Monitor, a scheduled wakeup). */
  waitingOn?: string | null;
  /** Its turn is over but background work it started is running (an agent, a command): working. */
  busyWith?: string | null;
  /** Idle and its last message asks the user something. */
  asking?: string | null;
  /** The GitHub account the session works as (two or more connected accounts only; see shared/accounts.ts sessionAccount). */
  account?: string;
  /** Two or more accounts, and the session was started without one: it works as gh's active account (no `account` then). */
  ghActive?: boolean;
}

export interface Issue {
  number: number;
  /** owner/name; null or missing: the primary issue repo. */
  repo?: string | null;
  /** The board it came from (owner/number), when known. */
  project?: string | null;
  title: string;
  url: string;
  status: string | null;
  currentSprint: boolean;
  assignedToMe: boolean;
}

export interface Pr {
  url: string;
  repo: string;
  number: number;
  title: string;
  unresolvedThreads: number;
  /** PR comments and review summaries from others since my last comment or review (master's sweep). */
  prComments?: number;
  lastPrCommentAt?: string | null;
  ci: string | null;
  headRef: string;
  refsIssue: number | null;
  /** The repo of refsIssue (owner/name); null: the primary issue repo. */
  refsRepo?: string | null;
  /** The PR's own repo, owner/name. */
  repoFull?: string | null;
  authorIsMe?: boolean;
  reviewRequested?: boolean;
  updatedAt?: string | null;
}

export interface SpawnTarget {
  name: string;
  cwd?: string;
  prompt?: string;
  resume?: string;
  /** The GitHub account the session works as (two or more connected). */
  account?: string;
  /** `claude --model` the proposal names; absent: the default model. */
  model?: string;
}

export interface Proposal {
  id: number;
  kind: string;
  issue: number;
  /** The issue's repo (owner/name); null or missing: the primary issue repo. */
  repo?: string | null;
  status: string;
  summary: string;
  message: string;
  note: string | null;
  target: { session?: string; spawn?: SpawnTarget };
  closedAt?: string | null;
}

export type MasterState =
  | { kind: "attached"; session: Session }
  | { kind: "elsewhere"; session: Session }
  | { kind: "duplicate"; count: number }
  | { kind: "absent" };

export type NeedsItem =
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "attention"; proposal: Proposal }
  | { kind: "session"; session: Session };

export interface SessionStats {
  costUsd: number | null;
  contextPct: number | null;
  model: string | null;
  permissionMode: string | null;
  currentDir: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  source: "statusline" | "transcript";
  updatedAt: number;
}

export interface TranscriptTail {
  model: string | null;
  contextTokens: number | null;
  lastTool: string | null;
  lastToolAt: number | null;
  lastActivityAt: number | null;
  cwd: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
}

export interface GitInfo {
  dir: string;
  branch: string | null;
  ahead: number;
  behind: number;
  added: number;
  removed: number;
  files: number;
}

export interface PrLive {
  number: number;
  title: string | null;
  url: string;
  state: string;
  reviewDecision: string | null;
  ci: "success" | "failure" | "pending" | null;
  /** The automated review check(s) alone, and every other check (build, tests). */
  reviewCheck: "success" | "failure" | "pending" | null;
  buildCi: "success" | "failure" | "pending" | null;
  isDraft: boolean;
  /** Its head branch (absent from older reads). */
  headRef?: string;
  /** When it was opened, and its latest comment or review (ms); for "Ready for Review". */
  createdAt: number | null;
  mergedAt: number | null;
  lastCommentAt: number | null;
}

export type SourceHealth = "ok" | "error" | "pending";

export interface AppState {
  sessions: Session[];
  issues: Issue[];
  prs: Pr[];
  proposals: Proposal[];
  master: MasterState;
  /** Needs you: open items by priority, snoozed ones, and the last day's resolved ones (shared/inbox.ts). */
  inbox: InboxView;
  /** The line to the remote backend (Settings → Remote); absent before the first status. */
  remote?: import("./remoteSnapshot").RemoteStatus & { hasToken: boolean; warning?: string };
  /** Browsers approved on this Mac (app.masterdeck.dev), and approval prompts waiting for an answer. */
  browsers?: { id: string; name: string; approvedAt: number; connected: boolean; connectedAt?: number; device?: string | null }[];
  /** Remote clients the backend says are connected (phone app, API), newest first. */
  remoteClients?: { id: string; kind: 'live' | 'api'; name: string; device: string | null; since: number }[];
  browserRequests?: BrowserRequestView[];
  /** The MasterDeck account this Mac is signed in with. */
  account?: import("./account").AccountState;
  /** Connected GitHub accounts and their health; never a token. */
  ghAccounts?: import("./accounts").GhAccountStatus[];
  stats: Record<string, SessionStats>;
  tails: Record<string, TranscriptTail>;
  git: Record<string, GitInfo>;
  /** Live details (state, CI, review) of the PRs of followed sessions, by PR URL. */
  prLive: Record<string, PrLive>;
  /** What MasterDeck's hook reported per Session.key: compaction, and an API error that stopped it. */
  hookInfo: Record<
    string,
    {
      compacting: boolean;
      compactedAt: number | null;
      failure: { type: string; message: string; at: number } | null;
      stoppedAt?: number | null;
    }
  >;
  /** Git worktrees each session created or worked in that still exist, by Session.key; oldest first. */
  sessionWorktrees: Record<string, import("./worktrees").SessionWorktree[]>;
  /** PR URLs linked to each session (sessionId): MasterDeck's links, then PRs it created. Oldest first. */
  sessionPrs: Record<string, string[]>;
  /** Monitors MasterDeck runs for sessions (Settings → Monitors run by). */
  watches: WatchInfo[];
  /** Scheduled jobs (CronCreate) by session id. */
  schedules: Record<string, ScheduleInfo[]>;
  sources: Record<string, SourceHealth>;
  errors: string[];
  lastSnapshotAt: string | null;
  statuslineInstalled: boolean;
  missingBinaries: string[];
  masterWorkspace: string;
  board: Board | null;
  boardError: string | null;
  boardLoading: boolean;
  /** The Board's repository view; absent until a tab picks a repository. */
  repoView?: RepoView;
  /** When issues and the board were last refreshed from GitHub (epoch ms), cache included. */
  githubRefreshedAt: number | null;
  githubRefreshing: boolean;
  sprints: Sprint[];
  selectedSprint: string;
  users: string[];
  me: string | null;
  settings: Settings;
  /** Cost and context of every session with a status line file (not just open tabs). */
  allStats: Record<
    string,
    { costUsd: number | null; contextPct: number | null; updatedAt: number }
  >;
  costBook: CostBook;
  /** Last transcript write per session id (epoch ms). */
  lastActivity: Record<string, number>;
  boardHistory: Record<string, BurnPoint[]>;
  /** The shared GitHub cache (ghc) every GitHub caller on this machine goes through. */
  ghCache: GhCacheStatus | null;
  /** Every open PR in the org and those closed in the last 90 days (the PRs view). */
  teamPrs: TeamPr[];
  teamPrsAt: number | null;
  teamPrsLoading: boolean;
  teamPrsError: string | null;
  /** The user's GitHub and board settings (Setup writes them). */
  config: AppConfig;
  /** The bundled Claude Code skills and whether each is installed. */
  skills: SkillStatus[];
  hooks: HookStatus;
  /** Background sessions the last restart stopped, not resumed or dismissed yet (Settings: afterRestart). */
  stoppedByRestart: RestoreEntry[];
  /** Resuming them now. */
  restoring: boolean;
  /** Tokens used so far (input, output, cache) by the sessions in open tabs, from their transcripts. */
  tokens: Record<string, Tokens>;
  /** Per issue: stopped sessions that worked on it and can be resumed, newest first. */
  /** By ticketKey (shared/ticket.ts). */
  pastSessions: Record<string, PastSession[]>;
  /** What sessions on the Needs-you list are asking (a menu, or a question in words), by Session.key. */
  asks: Record<string, SessionAsk>;
  /** AskUserQuestion menus on the screens of sessions waiting on input, by Session.key. */
  menus: Record<string, ScreenMenu>;
  /** Where each session's PRs stand (merged, approved, ready for review…), by Session.key. */
  prStage: Record<string, PrStage>;
  /** Statuses set by hand in a session's status popup, by Session.key. */
  manualStatus: Record<string, StatusKey>;
}

export interface SkillStatus {
  name: string;
  /**
   * installed: the bundled version · outdated: an older unmodified copy (updated at launch) ·
   * modified: changed by the user · custom: not installed by MasterDeck · linked: a symlink ·
   * missing: not installed
   */
  state:
    "installed" | "outdated" | "modified" | "custom" | "linked" | "missing";
  version?: string;
}

export interface HookStatus {
  /** Something stores /queue prompts and runs the next one at the end of a turn: MasterDeck's hook, or queue hooks installed by hand. */
  queue: boolean;
  /** The queue skill's hooks are in settings.json (put there by hand): MasterDeck's hook leaves /queue to them. */
  foreignQueue: boolean;
  /** MasterDeck's self-review gate before `gh pr create`. */
  reviewGate: boolean;
  /** MasterDeck's guard on SendMessage: a report like `#12: done` goes only to the master session. */
  masterGuard: boolean;
}

/** What Setup checks before GitHub can work. */
export interface SetupCheck {
  claude: string | null;
  gh: boolean;
  ghUser: string | null;
  ghScopes: string[];
  python: boolean;
  jq: boolean;
  git: boolean;
}

export interface GhCacheStatus {
  /** Every GitHub caller is backing off until then (epoch ms), after a rate-limit error. */
  pausedUntil: number | null;
  pauseReason: string | null;
  /** Today's counters: hits and stale answers saved a call; misses and writes made one. */
  hit: number;
  miss: number;
  stale: number;
  write: number;
  blocked: number;
}

export interface BoardPr {
  url: string;
  /** The PR repo's owner; repo is its name. */
  owner?: string;
  repo: string;
  number: number;
  /** OPEN, DRAFT, MERGED, CLOSED, or null when GitHub couldn't resolve it. */
  state: string | null;
  ci: "success" | "failure" | "pending" | null;
  unresolved: number;
}

export interface BoardCard {
  number: number;
  /** owner/name; null or missing: the primary issue repo. */
  repo?: string | null;
  /** The board (owner/number) it is on. */
  project?: string | null;
  title: string;
  url: string;
  status: string | null;
  prs: BoardPr[];
  assignees: string[];
  labels: string[];
  milestone: string | null;
  type: string | null;
  /** An issue of an account with no GitHub board: MasterDeck works out its column (shared/derivedBoard.ts). */
  derived?: true;
  /** Derived cards only: the issue's state on GitHub, and when it was closed. */
  state?: "OPEN" | "CLOSED";
  closedAt?: string | null;
  /** Repository view only: the selected boards (owner/number) that hold this issue, and its column on each. */
  onBoards?: { key: string; status: string | null }[];
}

export interface Sprint {
  id: string;
  title: string;
  startDate: string;
  duration: number;
  completed: boolean;
  /** The boards (owner/number) that have a sprint of this title. */
  projects?: string[];
}

/** What `master board` read for an account with no board (its repositories' issues). */
export interface DerivedPart {
  /** The account; null with one account. */
  account: string | null;
  /** The repositories read. */
  repos: string[];
  /** Open issues GitHub counts in them, and how many of those are cards. */
  total: number;
  shown: number;
  /** Ticked repositories past the limit, and ones GitHub answered nothing for. */
  skipped: string[];
  missing: string[];
  /** What the read could not do, as `master board` says it ("acme/api not read: RATE_LIMITED"). */
  notes?: string[];
}

/** Repository view: one repository whose issues a Board tab asked for (`master repo-issues`). */
export interface RepoPart {
  /** owner/name, as selected in Setup. */
  repo: string;
  /** The account that read it; null with one account. */
  account: string | null;
  /** The last read gave its issues. False: `note` says why not; cards of an earlier read stay. */
  ok: boolean;
  /** Open issues GitHub counts in it, and how many of those are cards. */
  total: number;
  shown: number;
  /** What the read could not do ("Not found: acme/old", "acme/api not read: RATE_LIMITED"). */
  note?: string;
  /** When its cards were read (epoch ms); null: never. */
  takenAt: number | null;
  /** A read of it is running. */
  loading?: true;
  /** The state carries only the first of its cards (the view's card and size budget); `note` says how many. */
  cut?: true;
}

/** Repository view: the issues of every repository read so far, each in its column (shared/repoView.ts). */
export interface RepoView {
  cards: BoardCard[];
  repos: RepoPart[];
}

export interface Board {
  takenAt: string | null;
  sprint: string | null;
  columns: string[];
  cards: BoardCard[];
  /** Each board in it, with its own columns (a view of some boards shows theirs). */
  projects?: { key: string; title: string; columns: string[] }[];
  /** One entry per account with no board whose repository issues are among the cards. */
  derived?: DerivedPart[];
}

export type BadgeKind =
  | "question"
  | "blocked"
  | "needs-input"
  | "onboarding"
  | "working"
  | "merged"
  | "rework"
  | "approved"
  | "changes"
  | "ci-failing"
  | "ready"
  | "in-review"
  | "done"
  | "waiting"
  | "idle"
  | "stopped"
  | "none";

export interface Badge {
  kind: BadgeKind;
  label: string;
  /** Why, when there is more to say (a proposal's note). */
  detail?: string;
}

export interface DraftAssign {
  issue: number;
  repo?: string | null;
  name: string;
  cwd: string;
  prompt: string;
  summary: string;
  title: string;
  url: string;
  /** Set when the draft came from an existing ledger proposal rather than `draft-assign`. */
  proposalId: number | null;
  /** The workspace `master draft-assign` looked in: the ticket's account's. */
  workspace?: string;
  /** `cwd` is a checkout of `checkoutOf`; false: none was found and `cwd` is the workspace (or a folder the user chose that is not one). */
  found?: boolean;
  /** owner/name of the ticket's repository. */
  checkoutOf?: string;
  /** The prompt as it is without a checkout: a system prompt equal to it (or to `prompt`) is MasterDeck's own text. */
  genericPrompt?: string;
  /** Not found, and the search stopped at a limit after `searched` folders. */
  partial?: boolean;
  searched?: number;
}

export interface CliResult {
  ok: boolean;
  message: string;
}

/** A browser asking to control this Mac, shown once it revealed its key (three words to compare). */
export interface BrowserRequestView {
  id: string;
  name: string;
  email: string;
  words: [string, string, string];
  expiresAt: number;
}

export interface NotifyEvent {
  title: string;
  body: string;
  target: { sessionKey?: string; needsYou?: true; itemId?: string };
}

export type PaneSpec =
  | { kind: "attach"; bgId: string }
  | { kind: "shell"; cwd: string }
  /** Onboarding: a Claude session that installs the missing tools (ids from shared/install.ts). */
  | { kind: "installer"; tools: string[] }
  /** The workflow builder (Workflow window): a Claude session in its own folder; `resume` continues its last chat. */
  | { kind: "builder"; resume: boolean }
  /**
   * The Board's ticket session (Create with Claude); `prompt`: its first message, if any. Two or more
   * accounts: one per Board tab (`tab`, its id), running as the tab's `account`; main ignores both with one.
   */
  | { kind: "ticket-builder"; resume: boolean; prompt?: string; tab?: string; account?: string }
  /** Setup's "Add an account": gh's own browser login. */
  | { kind: "gh-login" };

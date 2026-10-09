import type { WatchInfo } from "@shared/watches";
import { hideSuperseded } from "@shared/superseded";
import { accountNotices, isMulti, keepLastGood, primaryLogin, type GhAccountStatus } from "@shared/accounts";
import {
  liveSchedules,
  newScheduleScan,
  scanScheduleLines,
  type ScheduleInfo,
  type ScheduleScan,
} from "@shared/schedules";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  watchFile,
  unwatchFile,
  writeFileSync,
} from "node:fs";
import { homedir, uptime } from "node:os";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import { applyFreshness, normalizeAgents } from "@shared/agents";
import {
  attachIssues,
  deriveMaster,
  proposalTicket,
  MASTER_NAME,
  sessionForProposal,
  parseLedger,
  parseSnapshot,
  type ParsedSnapshot,
} from "@shared/derive";
import {
  parseBranchStatus,
  parseNumstat,
  parsePrView,
  PR_VIEW_ARGS,
} from "@shared/git";
import { collectItems } from "@shared/inbox";
import type { ExternalItem } from "@shared/remote";
import { Inbox } from "./inbox";
import {
  isStatusKey,
  MANUAL_STATUSES,
  prStage,
  STATUS_TEXT,
  type PrStage,
  type StatusKey,
} from "@shared/review";
import {
  sameTicket,
  ticketKey,
  ticketLabel,
  type Ticket,
} from "@shared/ticket";
import {
  addPrUrls,
  newPrScanState,
  scanLines,
  type PrScanState,
} from "@shared/prscan";
import { BUILDER_NAME } from "@shared/flowBuilder";
import { isTicketBuilderSession } from "./ticketDirs";
import {
  newFlowTrack,
  scanFlowLines,
  type FlowTrackState,
} from "@shared/flowTrack";
import type { FlowTrigger } from "@shared/flow";
import {
  parseStatusline,
  parseTranscriptTail,
  statsFromTranscript,
} from "@shared/stats";
import { parseBoard } from "@shared/board";
import {
  carryCopy,
  linksToCarry,
  recordHistory,
  type LinkInfo,
  type SessionHistory,
} from "@shared/carry";
import {
  dayOf,
  pruneBook,
  recordCosts,
  validBook,
  type CostBook,
  type CostEntry,
} from "@shared/costs";
import { addBurnPoint, summarize, type BurnPoint } from "@shared/sprintSummary";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type Settings,
} from "@shared/settings";
import type {
  AppState,
  Board,
  BoardCard,
  CliResult,
  Sprint,
  GitInfo,
  PrLive,
  Proposal,
  Session,
  SessionStats,
  SourceHealth,
  TranscriptTail,
  GhCacheStatus,
  HookStatus,
  SkillStatus,
} from "@shared/types";
import {
  DEFAULT_CONFIG,
  getConfig,
  parseConfig,
  projectByKey,
  setConfig,
  type AppConfig,
} from "@shared/appConfig";
import { mergeTeamPages, parseTeamPrs, type TeamPr } from "@shared/teamPrs";
import {
  nextRestore,
  resumeEntries,
  parseRestoreFile,
  type RestoreEntry,
  type RestoreFile,
} from "@shared/restore";
import { totalOf, type Tokens, type TokensByDay } from "@shared/tokens";
import type { HoursSource } from "@shared/hours";
import {
  pastByIssue,
  type PastSession,
  type TranscriptInfo,
} from "@shared/pastSessions";
import {
  answeredInSession,
  parseMenuScreen,
  parsePermissionScreen,
  permissionMenu,
  sessionAsk,
  type ScreenMenu,
  type SessionAsk,
} from "@shared/ask";
import { sessionScreen } from "./screen";
import { TokenIndex } from "./tokens";
import { loadCache, saveCache } from "./cache";
import { RepoIssues } from "./repoIssues";
import { repoViewDeriver } from "@shared/repoView";
import { ghErrorText, type GhRunner } from "./ghc";
import { GitHub } from "./github";
import {
  mtime,
  readHead,
  readNewLines,
  readTail,
  TranscriptIndex,
  type FollowState,
} from "./files";
import {
  asksQuestion,
  describePending,
  isBusyWork,
  openTasks,
  stillPending,
  turnEnded,
  type PendingTask,
} from "@shared/activity";
import {
  newWorktreeScan,
  scanWorktreeLines,
  type SessionWorktree,
  type WorktreeScan,
} from "@shared/worktrees";
import { inLinkedWorktree, linkedWorktree } from "./worktreeInfo";
import { ownsFolderBranch, type Parked } from "@shared/parked";

/** What a parked record is looked up by (a Session has all of it). */
type ParkedKey = { key: string; name: string; cwd: string; startedAt: number };
import { expandHome } from "./checkouts";
import type { DeckHooks } from "./deckHooks";
import {
  answersDecision,
  decisionFor,
  requestMenu,
  requestOver,
  requestPrompt,
  ticketContext,
  type HookRequest,
  type PeerFact,
} from "@shared/deckHooks";
import type { MasterCli } from "./masterCli";
import type { Paths } from "./paths";
import { LinkStore } from "./ticketLinks";
import type { PeerStore } from "./peers";
import { adjacency } from "@shared/peers";
import { linkInfoMap, ticketPrMap } from "@shared/ticketLinks";
import {
  boardDeriver,
  boardToShow,
  boardWanted,
  withoutDerived,
} from "@shared/derivedBoard";
import type { Runner } from "./run";

const AGENTS_MS = 3_000;
const DETAIL_MS = 3_000;
/** How often the screens of sessions waiting on input are read for a question menu. */
const MENUS_MS = 4_000;
// GitHub allows 5,000 API requests an hour, shared with gh in every session and master's sweeps.
// A snapshot is the heavy call (board + PR GraphQL); a PR check is one light request.
/** Issues, PRs and the sprint board come from GitHub at startup, then once an hour (or on Refresh). */
const GITHUB_MS = 3_600_000;
const GH_MS = 120_000;
const GH_BACKGROUND_MS = 600_000;
/** Sessions with an open PR, open in a tab or not: their comments, for the Ready-for-Review timer. */
const REVIEW_MS = 120_000;
const RATE_LIMIT_PAUSE_MS = 600_000;
/** gh's own words, and the repository view's note ("acme/api not read: RATE_LIMITED"). */
export const RATE_LIMITED = /rate[ _-]?limit|secondary rate|abuse detection/i;

function writeJsonAtomic(path: string, data: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  } catch {
    // best effort
  }
}

const EMPTY_SNAPSHOT: ParsedSnapshot = {
  issues: [],
  prs: [],
  sessionIssue: new Map(),
  sessionPrs: new Map(),
  sources: {},
  takenAt: null,
};

/**
 * Owns every poll. Keeps the latest good value of each source (a failed or corrupt read keeps the
 * previous one) and emits a merged AppState, at most every 250 ms.
 */
export class Sources {
  private rawSessions: Session[] = [];
  private peerStore: PeerStore | null = null;
  private snapshot: ParsedSnapshot = EMPTY_SNAPSHOT;
  private proposals: Proposal[] = [];
  /** Needs you: every item waiting on the user, what they did about it, and its history. */
  readonly inbox: Inbox;
  /** The first builds after starting announce nothing: those items may be old. */
  private inboxPrimed = false;
  /** What a session is asking, re-read only when its transcript changed. */
  private askCache = new Map<
    string,
    { path: string; mtime: number; ask: SessionAsk }
  >();
  private taskCache = new Map<
    string,
    { path: string; mtime: number; tasks: PendingTask[]; ended: boolean }
  >();
  /** AskUserQuestion menus on the screens of sessions waiting on input, by Session.key. */
  private menus = new Map<string, ScreenMenu>();
  private menusRunning = false;
  private reviewRunning = false;
  private lastSessions: Session[] = [];
  private stopListeners: ((sessionId: string) => void)[] = [];
  /** Sessions that gained linked peers they were started with (PeerStore.claim). */
  private claimListeners: ((keys: string[]) => void)[] = [];
  /** The last Stop seen per session id: a Stop is reported once. */
  private lastStopAt: Record<string, number> = {};
  /** Questions already marked answered from here, by proposal id and question time (once each). */
  private answered = new Set<string>();
  private stats: Record<string, SessionStats> = {};
  private tails: Record<string, TranscriptTail> = {};
  private lastWrite: Record<string, number> = {};
  private git: Record<string, GitInfo> = {};
  /** Live details of every PR a followed session has, by PR URL. */
  private prLive: Record<string, PrLive> = {};
  private prFetchedAt: Record<string, number> = {};
  /** Transcript followers for PR detection, by transcript path. */
  private follows: Record<
    string,
    {
      st: FollowState;
      scan: PrScanState;
      wt: WorktreeScan;
      flow: FlowTrackState;
      sched: ScheduleScan;
    }
  > = {};
  /** Worktree candidates per Session.key, from all its transcripts (a resume adds one). */
  private worktreeScans: Record<string, WorktreeScan> = {};
  /** MasterDeck's own hook (permission requests, notifications, errors, compactions). */
  private deck: DeckHooks | null = null;
  private hookRequests: HookRequest[] = [];
  /** Requests whose session was seen waiting on a prompt since they came. */
  private seenBlocked = new Set<string>();
  private deckTouchedAt = 0;
  /** A saved summary of a session (Summary panel), for the ticket context. */
  private summaryOf: (
    sessionId: string,
  ) => { text: string; at: number } | null = () => null;
  /** PRs each session created, by session key (survives a resume's new sessionId). */
  private createdPrs: Record<string, string[]> = {};
  /** Of those, the ones its transcripts show it opened (the rest came from its checkout's branch). Rebuilt each launch: transcripts are read from the start. */
  private openedPrs: Record<string, string[]> = {};
  private ghPausedUntil = 0;
  private ghCache: GhCacheStatus | null = null;
  private teamPrs: TeamPr[] = [];
  private teamPrPages: unknown[] = [];
  private teamPrsAt: number | null = null;
  private teamPrsLoading = false;
  private teamPrsError: string | null = null;
  private config: AppConfig = DEFAULT_CONFIG;
  private skills: SkillStatus[] = [];
  private hooks: HookStatus = {
    queue: false,
    foreignQueue: false,
    reviewGate: false,
    masterGuard: false,
  };
  private ghAccounts: GhAccountStatus[] = [];
  /** gh's active login (gh config get user), for the "not the primary" notice; null: not known. */
  private ghActive: string | null = null;
  /** The account master-agent was started as (session-accounts.json); null: not recorded. */
  private masterAccountOf: (s: Session) => string | null = () => null;
  private settings: Settings = DEFAULT_SETTINGS;
  private externalItems: ExternalItem[] = [];
  private remote: AppState["remote"] = undefined;
  private remoteClients: AppState["remoteClients"] = [];
  private browsers: Pick<AppState, "browsers" | "browserRequests"> & { warning?: string } = {};
  private account: AppState["account"] = undefined;
  private allStats: AppState["allStats"] = {};
  private costBook: CostBook = {};
  private costDirty = false;
  /** MasterDeck's ticket links (sessionId → issue and when). */
  private links = new Map<string, LinkInfo>();
  /** PRs recorded for each ticket's sessions, by ticketKey: what puts a board-less issue in PR Raised or Done. */
  private linkPrs: Record<string, string[]> = {};
  /** Gives the board of the last state build back while no card changed column. */
  private derive = boardDeriver();
  /** The Board's repository view: issues of the repositories a tab picked, read only when asked for. */
  private repoIssues = new RepoIssues({
    // Test aid: MASTERDECK_REPO_FIXTURE=<json> replaces the GitHub call (as MASTERDECK_BOARD_FIXTURE does for the board).
    read: async (repos, force) =>
      process.env.MASTERDECK_REPO_FIXTURE
        ? { ok: true, data: JSON.parse(readFileSync(process.env.MASTERDECK_REPO_FIXTURE, "utf8")) }
        : this.cli.repoIssues(repos, force),
    config: () => this.config,
    paused: (output) => !process.env.MASTERDECK_REPO_FIXTURE && this.githubPaused(output),
    changed: (read) => {
      if (read) this.saveGithubCache();
      this.emit();
    },
  });
  private deriveRepo = repoViewDeriver();
  private linkStore: LinkStore;
  /** Session ids each background session has had (persisted), to carry links across a resume. */
  private history: SessionHistory = {};
  private carryTried: Record<string, number> = {};
  private accountOf: ((s: Session) => string | null) | null = null;
  private ghActiveOf: (s: Session) => boolean = () => false;
  private superseded: () => Set<string> = () => new Set();
  private linker:
    | ((t: Ticket, sessionId: string, cwd: string | null) => Promise<CliResult>)
    | null = null;
  /** Which background sessions were running, so a restart can be undone (see @shared/restore). */
  private restore: RestoreFile | null = null;
  private tokenIndex: TokenIndex;
  /** Tokens used so far by the sessions whose details are followed (open tabs, focused). */
  private tokens: Record<string, Tokens> = {};
  private tokenPending = new Set<string>();
  /** Stopped sessions that worked on each issue and can be resumed. */
  private past: Record<string, PastSession[]> = {};
  private transcriptInfos = new Map<
    string,
    TranscriptInfo & { path: string }
  >();
  private restoreSeen = false;
  private restoring = false;
  private resumer: ((e: RestoreEntry) => Promise<CliResult>) | null = null;
  /** Boards by sprint key (@current, a sprint title, or none), and which one is on screen. */
  private boards: Record<string, Board> = {};
  private rawBoards: Record<string, unknown> = {};
  private selectedSprint = "@current";
  private sprints: Sprint[] = [];
  /** Burndown points per sprint title, one per day. */
  private boardHistory: Record<string, BurnPoint[]> = {};
  private users: string[] = [];
  private me: string | null = null;
  private boardError: string | null = null;
  /** Raw GitHub data as last fetched (or loaded from the cache), for writing the cache. */
  private rawSnapshot: Record<string, unknown> | null = null;
  private githubRefreshedAt: number | null = null;
  private githubRefreshing = false;
  private boardRunning = false;
  private health: Record<string, SourceHealth> = {
    agents: "pending",
    ledger: "pending",
    snapshot: "pending",
  };
  private errors: Record<string, string> = {};
  private missing = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;
  private focused: string | null = null;
  private visible = new Set<string>();
  private transcripts: TranscriptIndex;
  private snapshotRunning = false;
  private detailRunning = false;
  statuslineInstalled = false;

  constructor(
    private paths: Paths,
    private run: Runner,
    private cli: MasterCli,
    private onState: (s: AppState) => void,
    private claude: () => string = () => "claude",
    private github: GitHub = new GitHub(run),
    private gh: GhRunner = (args, opts) => run("gh", args, opts),
    private readGhCache: () => GhCacheStatus | null = () => null,
  ) {
    this.linkStore = new LinkStore(paths.ticketLinks, paths.babysitState);
    this.transcripts = new TranscriptIndex(paths.projectsDir);
    this.inbox = new Inbox(
      join(paths.home, "inbox.json"),
      join(paths.home, "inbox-events.jsonl"),
    );
    this.tokenIndex = new TokenIndex(
      this.transcripts,
      join(paths.home, "tokens.json"),
    );
  }

  /** Title and folder of a session's transcript, re-read only when the file changed. */
  private transcriptInfo(sessionId: string): TranscriptInfo | null {
    const path = this.transcripts.find(sessionId);
    const mt = path ? mtime(path) : null;
    if (!path || mt === null) return null;
    const hit = this.transcriptInfos.get(sessionId);
    if (hit && hit.path === path && hit.mtime === mt) return hit;
    let cwd: string | null = null;
    let custom: string | null = null;
    let ai: string | null = null;
    // The folder is in the first lines; titles are rewritten as the session goes, so the last wins.
    for (const text of [
      readHead(path) ?? "",
      readTail(path, 256 * 1024)?.text ?? "",
    ]) {
      for (const line of text.split("\n")) {
        if (!line.includes('"cwd"') && !line.includes('-title"')) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue; // a line cut at the edge of the read
        }
        if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
        if (o.type === "custom-title" && typeof o.customTitle === "string")
          custom = o.customTitle;
        if (o.type === "ai-title" && typeof o.aiTitle === "string")
          ai = o.aiTitle;
      }
    }
    // No conversation line (they all carry cwd): a stub with only a title, nothing to resume.
    if (!cwd) return null;
    const info = { path, mtime: mt, title: custom ?? ai, cwd };
    this.transcriptInfos.set(sessionId, info);
    return info;
  }

  private refreshPast(): void {
    const live = new Set(
      this.rawSessions
        .filter((s) => s.pid !== null && s.state !== "done")
        .map((s) => s.sessionId),
    );
    this.past = pastByIssue(this.links, this.history, live, (id) =>
      this.transcriptInfo(id),
    );
  }

  /** A session's transcript file and PR URLs (for its summary). */
  sessionFacts(
    sessionId: string,
    key: string,
  ): { transcript: string | null; prs: string[]; cwd: string | null } {
    return {
      transcript: this.transcripts.find(sessionId),
      prs: this.prUrlsFor(sessionId, key),
      cwd:
        this.stats[sessionId]?.currentDir ?? this.tails[sessionId]?.cwd ?? null,
    };
  }

  /** Tokens per day for these sessions (the Costs view): the first call reads their history. */
  tokensByDay(sessionIds: string[]): Promise<Record<string, TokensByDay>> {
    return this.tokenIndex.refresh(
      sessionIds.filter(
        (x) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x),
      ),
    );
  }

  /**
   * When these sessions were active since `since` (the Costs view's Hours), with what finds each
   * one's account: its key, folder and ticket. A session with nothing since then is left out.
   */
  async hoursActivity(
    sessionIds: string[],
    since: number,
  ): Promise<Record<string, HoursSource>> {
    const ids = sessionIds.filter(
      (x) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x),
    );
    const spans = await this.tokenIndex.activity(ids);
    const out: Record<string, HoursSource> = {};
    for (const [id, all] of Object.entries(spans)) {
      const s = all.filter(([, end]) => end >= since);
      if (!s.length) continue;
      const rec = this.costBook[id];
      out[id] = {
        spans: s,
        ticket:
          rec && rec.issue !== null ? { repo: rec.issueRepo ?? null } : null,
        key:
          rec?.key ??
          this.rawSessions.find((x) => x.sessionId === id)?.key ??
          id.slice(0, 8),
        cwd:
          this.stats[id]?.currentDir ??
          this.tails[id]?.cwd ??
          this.transcriptInfo(id)?.cwd ??
          null,
      };
    }
    return out;
  }

  /** The sessions of the last `claude agents` scan; null until one succeeded. */
  sessionsNow(): Session[] | null {
    return this.isHealthy("agents") ? this.rawSessions : null;
  }

  /** How to resume a stopped background session (`claude --bg --resume`). */
  setResumer(fn: (e: RestoreEntry) => Promise<CliResult>): void {
    this.resumer = fn;
  }

  private get restorePath(): string {
    return join(this.paths.home, "running-sessions.json");
  }

  /**
   * After each `claude agents` scan: record what runs now and, on a new boot, what the restart
   * stopped. With afterRestart = resume, the first scan after a restart resumes them.
   */
  private observeRestore(): void {
    if (!this.restoreSeen) {
      try {
        this.restore = parseRestoreFile(
          JSON.parse(readFileSync(this.restorePath, "utf8")),
        );
      } catch {
        this.restore = null;
      }
    }
    const first = !this.restoreSeen;
    this.restoreSeen = true;
    const next = nextRestore(
      this.restore,
      Date.now() - uptime() * 1000,
      this.withIssues(this.rawSessions),
      getConfig().masterName,
      Date.now(),
    );
    if (this.settings.afterRestart === "off") next.stopped = [];
    const changed =
      JSON.stringify([next.running, next.stopped]) !==
        JSON.stringify([this.restore?.running, this.restore?.stopped]) ||
      !this.restore ||
      next.bootAt !== this.restore.bootAt;
    this.restore = next;
    if (changed) {
      try {
        mkdirSync(this.paths.home, { recursive: true });
        writeFileSync(`${this.restorePath}.tmp`, JSON.stringify(next, null, 2));
        renameSync(`${this.restorePath}.tmp`, this.restorePath);
      } catch {
        // best effort: the next scan tries again
      }
    }
    if (first && next.stopped.length && this.settings.afterRestart === "resume")
      void this.resumeStopped();
  }

  /** Resume every session the restart stopped, one at a time; the ones that fail stay listed. */
  async resumeStopped(): Promise<CliResult> {
    if (this.restoring) return { ok: true, message: "already resuming" };
    if (!this.resumer || !this.restore?.stopped.length)
      return { ok: true, message: "nothing to resume" };
    this.restoring = true;
    this.emit();
    let failed: string[] = [];
    let resumed = 0;
    try {
      // One that runs again (by session id or background id) is skipped: never resumed twice.
      const r = await resumeEntries(
        [...this.restore.stopped],
        () => this.rawSessions,
        async (e) => {
          const x = await this.resumer!(e);
          // Off the list now; the next scan also drops it once its process shows up.
          if (x.ok && this.restore)
            this.restore.stopped = this.restore.stopped.filter(
              (y) => y.sessionId !== e.sessionId,
            );
          return x;
        },
        // Awaited: the decision is made on the list as it is now, not on the last poll.
        () => this.pollAgents(),
      );
      ({ failed, resumed } = r);
      if (this.restore) {
        const keep = new Set(r.left.map((e) => e.sessionId));
        this.restore.stopped = this.restore.stopped.filter((e) =>
          keep.has(e.sessionId),
        );
      }
    } finally {
      this.restoring = false;
      void this.pollAgents();
    }
    const msg = `Resumed ${resumed} session${resumed === 1 ? "" : "s"}${failed.length ? `; not resumed: ${failed.join("; ")}` : ""}`;
    return { ok: failed.length === 0, message: msg };
  }

  /** Forget the sessions the restart stopped (they stay resumable from History). */
  dismissStopped(): void {
    if (!this.restore) return;
    this.restore.stopped = [];
    try {
      writeFileSync(this.restorePath, JSON.stringify(this.restore, null, 2));
    } catch {
      // the list shows again next launch at worst
    }
    this.emit();
  }

  /** Each session's ticket: the snapshot's, then MasterDeck's fresher links (ticket-links.json). */
  private issueOf(): Map<string, Ticket> {
    return new Map([
      ...this.snapshot.sessionIssue,
      ...[...this.links].map(
        ([k, v]) =>
          [k, { repo: v.repo ?? null, number: v.issue }] as [string, Ticket],
      ),
    ]);
  }

  private withIssues(sessions: Session[]): Session[] {
    return attachIssues(sessions, this.issueOf());
  }

  /** The sessions MasterDeck parked in a checkout (`parked-sessions.json`). */
  setParked(fn: (s: ParkedKey) => Parked | null): void {
    this.parkedOf = fn;
  }
  private parkedOf: ((s: ParkedKey) => Parked | null) | null =
    null;

  /** master's workspace and every account's own: shared by all sessions. */
  workspaces(): string[] {
    return [
      this.paths.masterWorkspace,
      ...getConfig().accounts.flatMap((a) =>
        a.workspace?.trim() ? [expandHome(a.workspace.trim())] : [],
      ),
    ].map((w) => resolve(w));
  }

  /**
   * Does the branch of this folder belong to the session (`ownsFolderBranch`)? Not in a
   * workspace, and not for a session MasterDeck parked in a main checkout on that branch.
   */
  ownsBranch(
    dir: string,
    s: ParkedKey | null,
    /** null: a detached HEAD; undefined: not known (git failed). */
    branch: string | null | undefined,
    /** False for a ticket link: linking in a workspace records its branch, as it always did. */
    workspacesShared = true,
  ): boolean {
    return ownsFolderBranch({
      dir: resolve(dir),
      workspaces: workspacesShared ? this.workspaces() : [],
      linked: inLinkedWorktree(dir),
      branch,
      parked: s ? (this.parkedOf?.(s) ?? null) : null,
    });
  }

  /** The folder whose branch PR the session takes; undefined: none. */
  private branchDir(
    dir: string | undefined,
    s: ParkedKey | null,
    branch: string | null | undefined,
  ): string | undefined {
    return dir && this.ownsBranch(dir, s, branch) ? dir : undefined;
  }

  /** How to link a session to an issue (babysit-ticket); used to carry links across a resume. */
  setLinker(
    fn: (
      t: Ticket,
      sessionId: string,
      cwd: string | null,
    ) => Promise<CliResult>,
  ): void {
    this.linker = fn;
  }

  /** Which GitHub account a session works as (main's SessionAccounts + origin); used with two or more accounts. */
  setSessionAccount(
    f: (s: Session) => string | null,
    ghActive: (s: Session) => boolean = () => false,
  ): void {
    this.accountOf = f;
    this.ghActiveOf = ghActive;
  }

  /** Ids of sessions a copy replaced (shared/superseded.ts): hidden while they do not run. */
  setSuperseded(f: () => Set<string>): void {
    this.superseded = f;
  }

  private withAccounts(ss: Session[]): Session[] {
    const f = this.accountOf;
    if (!f || !isMulti(this.config)) return ss;
    return ss.map((s) => {
      // Woken without --settings: gh's active account, so no login is shown for it.
      if (this.ghActiveOf(s)) return { ...s, ghActive: true };
      const a = f(s);
      return a ? { ...s, account: a } : s;
    });
  }

  private get historyPath(): string {
    return join(this.paths.home, "session-history.json");
  }

  private get manualStatusPath(): string {
    return join(this.paths.home, "session-status.json");
  }

  /** Statuses set by hand, by Session.key (persisted). */
  private manualStatus: Record<string, StatusKey> = {};

  private loadManualStatus(): void {
    try {
      const raw = JSON.parse(
        readFileSync(this.manualStatusPath, "utf8"),
      ) as Record<string, unknown>;
      this.manualStatus = Object.fromEntries(
        Object.entries(raw).filter((e): e is [string, StatusKey] =>
          isStatusKey(e[1]),
        ),
      );
    } catch {
      this.manualStatus = {};
    }
  }

  /** Set a session's status by hand; null goes back to the automatic one. */
  setManualStatus(key: string, status: unknown): CliResult {
    if (status === null) delete this.manualStatus[key];
    else if (isStatusKey(status) && MANUAL_STATUSES.includes(status))
      this.manualStatus[key] = status;
    else return { ok: false, message: "not a status" };
    writeJsonAtomic(this.manualStatusPath, this.manualStatus);
    this.emit();
    return {
      ok: true,
      message: status === null ? "automatic" : STATUS_TEXT[status as StatusKey],
    };
  }

  /** Needs-you items asked through the remote API (the backend's open list). */
  setExternalItems(items: ExternalItem[]): void {
    this.externalItems = items;
    this.emit();
  }

  setAccount(a: AppState["account"]): void {
    this.account = a;
    this.emit();
  }

  setRemote(r: AppState["remote"]): void {
    this.remote = r;
    this.emit();
  }

  /** Approved browsers, approval prompts and the tampering warning (from the browser bridge). */
  setBrowsers(
    browsers: AppState["browsers"],
    browserRequests: AppState["browserRequests"],
    warning: string | null,
  ): void {
    this.browsers = { browsers, browserRequests, warning: warning ?? undefined };
    this.emit();
  }

  setRemoteClients(c: AppState["remoteClients"]): void {
    if (!c?.length && !this.remoteClients?.length) return;
    this.remoteClients = c;
    this.emit();
  }

  /** Send the state again now (after an inbox action). */
  changed(): void {
    this.emit();
  }

  /**
   * The PR watch saw this PR merged or closed: read it again now, past the gh cache, so its
   * session's lane moves at once instead of on the next review poll (up to minutes later).
   */
  async prEnded(url: string): Promise<void> {
    if (this.prLive[url] && this.prLive[url].state !== "OPEN") return;
    const r = await this.gh(["pr", "view", url, ...PR_VIEW_ARGS], { timeoutMs: 20_000, force: true });
    this.noteBinary("gh", r.code);
    if (this.githubPaused(ghErrorText(r))) return;
    const pr = r.code === 0 ? parsePrView(r.stdout) : null;
    if (!pr) return;
    this.prLive[url] = pr;
    this.emit();
  }

  /** Read `claude agents` now (after stopping a session, so it leaves the list at once). */
  refreshAgents(): Promise<void> {
    return this.pollAgents();
  }

  private get sessionPrsPath(): string {
    return join(this.paths.home, "session-prs.json");
  }

  /** The PRs each session has (by session key), kept across launches. */
  private loadSessionPrs(): void {
    try {
      const raw = JSON.parse(readFileSync(this.sessionPrsPath, "utf8"));
      if (raw && typeof raw === "object")
        for (const [k, v] of Object.entries(raw))
          if (Array.isArray(v))
            this.createdPrs[k] = v.filter(
              (u): u is string =>
                typeof u === "string" && /\/pull\/\d+$/.test(u),
            );
    } catch {
      // none yet
    }
  }

  private saveSessionPrs(): void {
    try {
      mkdirSync(this.paths.home, { recursive: true });
      writeFileSync(
        `${this.sessionPrsPath}.tmp`,
        JSON.stringify(this.createdPrs, null, 2),
      );
      renameSync(`${this.sessionPrsPath}.tmp`, this.sessionPrsPath);
    } catch {
      // tried again on the next new PR
    }
  }

  /** Add PR URLs to a session's list (most recent last); saved when it changed. */
  private notePrs(key: string, urls: string[]): void {
    if (!urls.length) return;
    const list = (this.createdPrs[key] ??= []);
    if (addPrUrls(list, urls)) this.saveSessionPrs();
  }

  private loadHistory(): void {
    try {
      const raw = JSON.parse(readFileSync(this.historyPath, "utf8"));
      if (raw && typeof raw === "object") this.history = raw as SessionHistory;
    } catch {
      // first run, or unreadable: start fresh
    }
  }

  private saveHistory(): void {
    try {
      mkdirSync(this.paths.home, { recursive: true });
      const tmp = `${this.historyPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.history, null, 1));
      renameSync(tmp, this.historyPath);
    } catch {
      // best effort; the next change tries again
    }
  }

  /** Called once for each Stop a session reports (deck events). */
  onSessionStop(cb: (sessionId: string) => void): void {
    this.stopListeners.push(cb);
  }

  onPeersClaimed(cb: (keys: string[]) => void): void {
    this.claimListeners.push(cb);
  }

  /** Rewrite every live session's context file now (a peer's summary or link changed). */
  rewriteSessionContext(): void {
    this.writeTicketContext(this.lastSessions);
  }

  setPeerStore(store: PeerStore): void {
    this.peerStore = store;
    store.onChange(() => {
      this.writeTicketContext(this.lastSessions);
      this.emit();
    });
  }

  /** A resume started a copy (see resumeAs): it keeps the old session's ticket link and PRs. */
  noteCopy(old: { bgId: string; sessionId: string }, copyBg: string): void {
    if (copyBg && copyBg !== old.bgId) this.peerStore?.carry(old.bgId, copyBg);
    if (!carryCopy(this.history, this.createdPrs, old, copyBg)) return;
    this.saveHistory();
    this.saveSessionPrs();
  }

  /** Re-link resumed background sessions to the ticket their earlier session id had. */
  private carryLinks(): void {
    if (recordHistory(this.history, this.rawSessions, this.links.keys()))
      this.saveHistory();
    if (!this.linker) return;
    const now = Date.now();
    for (const c of linksToCarry(this.history, this.rawSessions, this.links)) {
      const key = `${c.sessionId}:${ticketKey(c.repo, c.issue)}`;
      if (now - (this.carryTried[key] ?? 0) < 600_000) continue;
      this.carryTried[key] = now;
      void this.linker(
        { repo: c.repo, number: c.issue },
        c.sessionId,
        c.cwd || null,
      ).then((r) => {
        if (r.ok) delete this.errors[`carry:${c.bgId}`];
        else
          this.errors[`carry:${c.bgId}`] =
            `could not keep ${ticketLabel(c.repo, c.issue)} linked after a resume: ${r.message}`;
        this.reloadLinks();
      });
    }
  }

  private get cachePath(): string {
    return join(this.paths.home, "cache.json");
  }

  private get settingsPath(): string {
    return join(this.paths.home, "settings.json");
  }

  private get costsPath(): string {
    return join(this.paths.home, "costs.json");
  }

  getSettings(): Settings {
    return this.settings;
  }

  /** Monitors MasterDeck runs (main/watches), for the state and the sessions' status. */
  private watchInfo: () => WatchInfo[] = () => [];
  private watchedPrs: () => Set<string> = () => new Set();
  setWatchedPrs(f: () => Set<string>): void {
    this.watchedPrs = f;
  }
  setWatchInfo(f: () => WatchInfo[]): void {
    this.watchInfo = f;
  }
  /** Told of every settings change (the hook's monitors-by file follows it). */
  onSettings: (s: Settings) => void = () => {};

  setSettings(raw: unknown): Settings {
    this.settings = normalizeSettings(raw);
    writeJsonAtomic(this.settingsPath, this.settings);
    this.onSettings(this.settings);
    this.emit();
    return this.settings;
  }

  /**
   * Every session's status line file, not just open tabs: cost history, context warnings and
   * ticket budgets need them all.
   */
  private scanAllStats(): void {
    // Start times come from `claude agents`; without them every session would count as a baseline.
    if (!this.isHealthy("agents")) return;
    let files: string[] = [];
    try {
      files = readdirSync(this.paths.statsDir).filter((f) =>
        f.endsWith(".json"),
      );
    } catch {
      return;
    }
    const now = Date.now();
    const next: AppState["allStats"] = {};
    const entries: CostEntry[] = [];
    const bySession = new Map(this.rawSessions.map((s) => [s.sessionId, s]));
    const issueOf = this.issueOf();
    for (const f of files) {
      const id = f.slice(0, -5);
      const t = readTail(join(this.paths.statsDir, f), 256 * 1024);
      if (!t || now - t.mtimeMs > 30 * 86_400_000) continue;
      const st = parseStatusline(t.text, t.mtimeMs);
      if (!st) continue;
      next[id] = {
        costUsd: st.costUsd,
        contextPct: st.contextPct,
        updatedAt: st.updatedAt,
      };
      const s = bySession.get(id);
      if (st.costUsd !== null && now - t.mtimeMs < 36 * 3_600_000)
        entries.push({
          sessionId: id,
          name: s?.name ?? this.costBook[id]?.name ?? id.slice(0, 8),
          key: s?.key ?? this.costBook[id]?.key ?? id,
          issue: issueOf.get(id)?.number ?? this.costBook[id]?.issue ?? null,
          issueRepo: issueOf.get(id)
            ? issueOf.get(id)!.repo
            : (this.costBook[id]?.issueRepo ?? null),
          cost: st.costUsd,
          startedAt: s?.startedAt ?? null,
        });
    }
    this.allStats = next;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    if (recordCosts(this.costBook, entries, dayOf(now), midnight.getTime()))
      this.costDirty = true;
    if (this.costDirty) {
      pruneBook(this.costBook, dayOf(now));
      writeJsonAtomic(this.costsPath, this.costBook);
      this.costDirty = false;
    }
    this.emit();
  }

  /** Read the shared config file (fast, no Python) and apply it. */
  loadConfig(): AppConfig {
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.paths.config, "utf8"));
    } catch {
      // missing or broken: defaults, not configured
    }
    const cfg = { ...parseConfig(raw), path: this.paths.config };
    const was = this.config.configured;
    this.config = cfg;
    setConfig(cfg);
    if (!process.env.MASTER_WORKSPACE && cfg.workspace)
      this.paths.masterWorkspace = cfg.workspace;
    // Repositories unticked since (or an account whose board went) leave the repository view.
    this.repoIssues.prune();
    this.emit();
    // Just set up: fetch GitHub now rather than waiting for the hourly refresh.
    if (cfg.configured && !was && this.started) void this.refreshGithub();
    return cfg;
  }

  setSkills(skills: SkillStatus[]): void {
    this.skills = skills;
    this.emit();
  }

  setHooks(h: HookStatus): void {
    this.hooks = h;
    this.emit();
  }

  setGhAccounts(a: GhAccountStatus[]): void {
    this.ghAccounts = a;
    this.emit();
  }

  setGhActive(login: string | null): void {
    if (login === this.ghActive) return;
    this.ghActive = login;
    this.emit();
  }

  setMasterAccount(f: (s: Session) => string | null): void {
    this.masterAccountOf = f;
  }

  private githubFor: ((login: string) => GitHub) | null = null;
  private ghForDir: ((dir: string) => GhRunner) | null = null;
  /** Per-account clients (two or more accounts): team PRs per account, the current branch's PR as its folder's account. */
  setAccountRunners(r: {
    github: (login: string) => GitHub;
    ghForDir: (dir: string) => GhRunner;
  }): void {
    this.githubFor = r.github;
    this.ghForDir = r.ghForDir;
  }

  private started = false;

  start(): void {
    this.loadConfig();
    watchFile(this.paths.config, { interval: 2000 }, () => this.loadConfig());
    this.started = true;
    try {
      this.settings = normalizeSettings(
        JSON.parse(readFileSync(this.settingsPath, "utf8")),
      );
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
    try {
      const raw = JSON.parse(readFileSync(this.costsPath, "utf8"));
      this.costBook = validBook(raw);
    } catch {
      // no history yet
    }
    this.loadHistory();
    this.loadSessionPrs();
    // Last run's tickets first, so the sidebar and board fill at once; GitHub updates them next.
    const cache = loadCache(this.cachePath);
    if (cache.snapshot && typeof cache.snapshot === "object") {
      this.rawSnapshot = cache.snapshot as Record<string, unknown>;
      this.snapshot = parseSnapshot(cache.snapshot);
    }
    const rawBoards: Record<string, unknown> = { ...(cache.boards ?? {}) };
    if (!rawBoards["@current"] && cache.board)
      rawBoards["@current"] = cache.board; // cache from before sprints
    for (const [k, raw] of Object.entries(rawBoards)) {
      const b = parseBoard(raw);
      if (b) {
        this.boards[k] = b;
        this.rawBoards[k] = raw;
      }
    }
    this.repoIssues.load(cache.repoIssues);
    if (Array.isArray(cache.sprints)) this.sprints = cache.sprints as Sprint[];
    if (cache.boardHistory && typeof cache.boardHistory === "object")
      for (const [k, v] of Object.entries(cache.boardHistory))
        if (Array.isArray(v))
          this.boardHistory[k] = v.filter(
            (p): p is BurnPoint =>
              !!p &&
              typeof p.date === "string" &&
              typeof p.total === "number" &&
              typeof p.done === "number",
          );
    if (Array.isArray(cache.users))
      this.users = cache.users.filter(
        (u): u is string => typeof u === "string",
      );
    if (typeof cache.me === "string") this.me = cache.me;
    if (typeof cache.selectedSprint === "string")
      this.selectedSprint = cache.selectedSprint;
    if (typeof cache.refreshedAt === "number")
      this.githubRefreshedAt = cache.refreshedAt;
    if (Array.isArray(cache.teamPrPages)) {
      this.teamPrPages = cache.teamPrPages;
      this.teamPrs = parseTeamPrs(cache.teamPrPages);
      if (typeof cache.teamPrsAt === "number") this.teamPrsAt = cache.teamPrsAt;
    }
    this.loadManualStatus();
    this.readLedger();
    watchFile(this.paths.ledger, { interval: 1000 }, () => this.readLedger());
    void this.pollAgents();
    void this.refreshGithub();
    this.timers.push(setInterval(() => void this.pollAgents(), AGENTS_MS));
    this.timers.push(setInterval(() => void this.pollDetails(), DETAIL_MS));
    this.timers.push(setInterval(() => void this.pollMenus(), MENUS_MS));
    this.timers.push(setInterval(() => this.pollDeck(), 1_000));
    this.timers.push(
      setInterval(() => this.writeTicketContext(this.lastSessions), 60_000),
    );
    setTimeout(() => this.writeTicketContext(this.lastSessions), 15_000);
    this.timers.push(setInterval(() => void this.pollReview(), 30_000));
    this.timers.push(setInterval(() => void this.refreshGithub(), GITHUB_MS));
    this.timers.push(setInterval(() => this.readLedger(), 5_000));
    setTimeout(() => this.scanAllStats(), 2_000);
    this.timers.push(setInterval(() => this.scanAllStats(), 30_000));
  }

  /** Board View opened: fetch only when there is nothing to show yet (the hourly refresh covers it). */
  setBoardOpen(open: boolean): void {
    if (open && !this.boards[this.selectedSprint] && !this.githubRefreshing)
      void this.refreshBoard();
  }

  /** After a drag: move the card at once; the next refresh confirms it. */
  noteStatus(t: Ticket, status: string): void {
    for (const b of Object.values(this.boards))
      for (const c of b.cards) if (sameTicket(c, t)) c.status = status;
    this.emit();
  }

  /** After an assign: update the card at once; the next refresh confirms it. */
  noteAssigned(t: Ticket, login: string): void {
    for (const b of Object.values(this.boards))
      for (const c of b.cards) if (sameTicket(c, t)) c.assignees = [login];
    this.repoIssues.noteAssigned(t, login);
    this.emit();
  }

  /** A Board tab in repository view shows these repositories: read the ones not held yet, or held for over an hour. */
  askRepos(repos: unknown): void {
    this.repoIssues.ask(repos);
  }

  /**
   * The repositories (owner/name, each once) of the cards on the boards loaded so far, any sprint.
   * A board can hold issues of a repository Setup does not tick: the Assign popup may read who can
   * be assigned there, because the name comes from GitHub's board, not from whoever asks.
   */
  boardRepos(): string[] {
    const out = new Map<string, string>();
    for (const c of this.boardCards())
      if (!out.has(c.repo!.toLowerCase())) out.set(c.repo!.toLowerCase(), c.repo!);
    return [...out.values()];
  }

  /** Changes whenever a board read lands (every loaded board's `takenAt`). */
  boardStamp(): string {
    return Object.entries(this.boards).map(([k, b]) => `${k}=${b.takenAt ?? ""}`).join("|");
  }

  /**
   * The cards of the loaded boards that name a repository and sit on a board Setup still selects
   * (a board removed in Setup can linger in memory and in the cache: its cards do not count). A
   * card with no repository is of the primary issue repo, which the config selects anyway.
   */
  private boardCards(): BoardCard[] {
    return Object.values(this.boards).flatMap((b) =>
      b.cards.filter((c) => !!c.repo && !!c.project && !!projectByKey(c.project, this.config)),
    );
  }

  /**
   * The key of the selected board whose loaded cards hold this issue; with no number, or when no
   * card is that issue, a board that holds an issue of the repository. Null when none does. The
   * account of that board is who a card of a repository no account lists is read and written as.
   */
  boardOf(repo: string | null | undefined, number?: number): string | null {
    if (!repo) return null;
    const cards = this.boardCards().filter((c) => c.repo!.toLowerCase() === repo.toLowerCase());
    return (cards.find((c) => c.number === number) ?? cards[0])?.project ?? null;
  }

  /** Show another sprint: from the cache at once, fetched when never seen before. */
  setSprint(sprint: string): void {
    if (!sprint || sprint === this.selectedSprint) return;
    this.selectedSprint = sprint;
    this.boardError = null;
    this.saveGithubCache();
    this.emit();
    if (!this.boards[sprint]) void this.refreshBoard();
  }

  private saveGithubCache(): void {
    saveCache(this.cachePath, {
      snapshot: this.rawSnapshot ?? undefined,
      boards: this.rawBoards,
      repoIssues: this.repoIssues.dump(),
      sprints: this.sprints,
      users: this.users,
      me: this.me ?? undefined,
      selectedSprint: this.selectedSprint,
      boardHistory: this.boardHistory,
      teamPrPages: this.teamPrPages.length ? this.teamPrPages : undefined,
      teamPrsAt: this.teamPrsAt ?? undefined,
      refreshedAt: this.githubRefreshedAt ?? undefined,
    });
  }

  /** Sprints, assignable users and my login: small calls, refreshed with everything else. */
  private async refreshPeople(
    force = false,
  ): Promise<{ ok: boolean; message: string }> {
    // The primary issue repo's assignees and my login: the primary's (two or more accounts), as before with one.
    const gh =
      isMulti(this.config) && this.githubFor
        ? this.githubFor(primaryLogin(this.config)!)
        : this.github;
    const [sp, users, me] = await Promise.all([
      this.cli.sprints(force),
      gh.assignableUsers(force),
      this.me ? Promise.resolve(this.me) : gh.me(),
    ]);
    if (sp.ok) this.sprints = sp.sprints;
    if (users) this.users = users;
    if (me) this.me = me;
    return sp.ok
      ? { ok: true, message: "ok" }
      : { ok: false, message: sp.message };
  }

  /** Issues/PRs (snapshot) and the sprint board together; then the cache is saved. `force` (the Refresh button) skips the shared gh cache. */
  async refreshGithub(
    force = false,
    /** The user pressed the Board's Refresh/Retry: the repository view re-reads past the gh cache too. Not after a ticket, an assign or a Setup refresh. */
    repoForce = false,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.githubRefreshing)
      return { ok: true, message: "already refreshing" };
    this.githubRefreshing = true;
    this.emit();
    try {
      // Each part reports its own failure; one throwing must not lose the other's result.
      const settle = (p: Promise<{ ok: boolean; message: string }>) =>
        p.catch((e: unknown) => ({ ok: false, message: String(e) }));
      // Before Setup there is no org or board to ask GitHub about; sessions still come from the snapshot.
      const gh = this.config.configured;
      const skip = Promise.resolve({ ok: true, message: "not set up" });
      const [s, b] = await Promise.all([
        settle(this.refreshSnapshot(force)),
        // Also without a project board: the Board then shows the repositories' issues.
        settle(gh ? this.refreshBoard(force) : skip),
        settle(gh ? this.refreshPeople(force) : skip),
        settle(gh ? this.refreshTeamPrs(0, force) : skip),
        // The repository view: only the repositories a tab asked for in the last hour; none, no call.
        // Its failures show in the view itself, not in this result.
        settle(gh ? this.repoIssues.refresh(repoForce) : skip),
      ]);
      if (s.ok || b.ok) this.githubRefreshedAt = Date.now();
      this.saveGithubCache();
      const failed = [s, b].filter((r) => !r.ok).map((r) => r.message);
      return failed.length
        ? { ok: false, message: failed.join("; ") }
        : { ok: true, message: "refreshed" };
    } finally {
      this.githubRefreshing = false;
      this.emit();
    }
  }

  /** Every PR in the org (the PRs view). `maxAgeMs` skips the call when the list is that fresh. */
  async refreshTeamPrs(
    maxAgeMs = 0,
    force = false,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.teamPrsLoading) return { ok: true, message: "already refreshing" };
    if (maxAgeMs && this.teamPrsAt && Date.now() - this.teamPrsAt < maxAgeMs)
      return { ok: true, message: "fresh" };
    if (this.githubPaused()) {
      this.teamPrsError = this.errors.github ?? "GitHub calls paused";
      this.emit();
      return { ok: false, message: this.teamPrsError };
    }
    this.teamPrsLoading = true;
    this.emit();
    try {
      // One search per account (each owner's PRs with that account's token); one account: as before.
      const accts =
        isMulti(this.config) && this.githubFor ? this.config.accounts : null;
      const got = accts
        ? await Promise.all(
            accts.map(async (a) => ({
              login: a.login as string | null,
              r: await this.githubFor!(a.login).teamPrPages(
                a.owner,
                undefined,
                force,
                a.ownerType,
              ),
            })),
          )
        : [
            {
              login: null as string | null,
              r: await this.github.teamPrPages(undefined, undefined, force),
            },
          ];
      const msgs = got.flatMap((g) =>
        g.r.ok
          ? g.r.partial
            ? [g.r.partial]
            : []
          : [`${g.login ? `${g.login}: ` : ""}${g.r.message}`],
      );
      if (got.some((g) => g.r.ok)) {
        this.teamPrPages = mergeTeamPages(
          got.map((g) => ({
            login: g.login,
            pages: g.r.ok ? g.r.pages : null,
          })),
          this.teamPrPages,
        );
        this.teamPrs = parseTeamPrs(this.teamPrPages);
        this.teamPrsAt = Date.now();
        this.teamPrsError = msgs.join("; ") || null;
        this.saveGithubCache();
        return { ok: true, message: "refreshed" };
      }
      // Keep the last good list on screen; say why it didn't update.
      const msg = msgs.join("; ");
      this.githubPaused(msg);
      this.teamPrsError = msg;
      return { ok: false, message: msg };
    } catch (e) {
      this.teamPrsError = String(e);
      return { ok: false, message: this.teamPrsError };
    } finally {
      this.teamPrsLoading = false;
      this.emit();
    }
  }

  async refreshBoard(force = false): Promise<{ ok: boolean; message: string }> {
    if (this.boardRunning) return { ok: true, message: "already refreshing" };
    // No board and no repository selected: nothing to ask `master board` for.
    if (!process.env.MASTERDECK_BOARD_FIXTURE && !boardWanted(this.config)) {
      // What was read before is of repositories and boards no longer selected: forget it.
      if (Object.keys(this.boards).length) {
        this.boards = {};
        this.rawBoards = {};
        this.boardError = null;
        this.saveGithubCache();
        this.emit();
      }
      return { ok: true, message: "nothing selected" };
    }
    const sprint = this.selectedSprint;
    if (!process.env.MASTERDECK_BOARD_FIXTURE && this.githubPaused()) {
      this.boardError = this.errors.github ?? "GitHub calls paused";
      this.emit();
      return { ok: false, message: this.boardError };
    }
    this.boardRunning = true;
    this.emit();
    try {
      // Test aid: MASTERDECK_BOARD_FIXTURE=<json> replaces the GitHub call.
      const fx = process.env.MASTERDECK_BOARD_FIXTURE;
      let r: { ok: true; data: unknown } | { ok: false; message: string };
      try {
        r = fx
          ? { ok: true, data: JSON.parse(readFileSync(fx, "utf8")) }
          : await this.cli.board(sprint, force);
      } catch (e) {
        r = { ok: false, message: String(e) };
      }
      const b = r.ok ? parseBoard(r.data) : null;
      if (b) {
        this.boards[sprint] = b;
        if (r.ok) this.rawBoards[sprint] = r.data;
        // Two or more accounts: the board still shows when some (not all) accounts' reads failed.
        const partial = r.ok ? (r.data as { errors?: unknown })?.errors : null;
        this.boardError =
          Array.isArray(partial) && partial.length ? partial.join("; ") : null;
        if (b.sprint) {
          // The sprint's own cards: repository issues of an account with no board are in no sprint.
          const sprintBoard = withoutDerived(b);
          this.boardHistory[b.sprint] = addBurnPoint(
            this.boardHistory[b.sprint] ?? [],
            {
              date: dayOf(Date.now()),
              total: sprintBoard.cards.length,
              done: summarize(sprintBoard).counts.done,
            },
          );
        }
        this.saveGithubCache();
      } else {
        // Keep the last good board on screen; say why it didn't update.
        const msg = r.ok ? "board printed an unexpected shape" : r.message;
        this.githubPaused(msg);
        this.boardError = msg;
      }
      return { ok: !!b, message: this.boardError ?? "refreshed" };
    } finally {
      this.boardRunning = false;
      this.emit();
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.tokenIndex.save();
    unwatchFile(this.paths.ledger);
  }

  setFocus(sessionId: string | null): void {
    this.focused = sessionId;
    if (sessionId) this.prFetchedAt[sessionId] = 0;
    void this.pollDetails();
  }

  setVisible(ids: string[]): void {
    this.visible = new Set(ids);
    void this.pollDetails();
  }

  private setHealth(name: string, ok: boolean, error?: string): void {
    this.health[name] = ok ? "ok" : "error";
    if (ok) delete this.errors[name];
    else this.errors[name] = error ?? `${name} failed`;
  }

  private noteBinary(name: string, code: number): void {
    if (code === -1) this.missing.add(name);
    else this.missing.delete(name);
  }

  private async pollAgents(): Promise<void> {
    const r = await this.run(this.claude(), ["agents", "--json"], {
      timeoutMs: 15_000,
    });
    this.noteBinary("claude", r.code);
    if (r.code !== 0) {
      this.setHealth(
        "agents",
        false,
        `claude agents: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
      );
      this.emit();
      return;
    }
    try {
      this.rawSessions = normalizeAgents(JSON.parse(r.stdout));
      this.setHealth("agents", true);
      this.observeRestore();
      this.refreshPast();
    } catch {
      this.setHealth("agents", false, "claude agents printed invalid JSON");
    }
    this.reloadLinks();
    this.carryLinks();
    let claimed: string[] = [];
    if (this.peerStore) {
      const live = new Set(
        this.rawSessions.filter((s) => s.state !== "done").map((s) => s.key),
      );
      if (this.rawSessions.length > 0) this.peerStore.prune(live);
      claimed = this.peerStore.claim(this.rawSessions);
    }
    const now = Date.now();
    for (const s of this.rawSessions) {
      const p = this.transcripts.find(s.sessionId, now);
      const m = p ? mtime(p) : null;
      if (m !== null) this.lastWrite[s.sessionId] = m;
    }
    this.emit();
    // PeerSync refreshes the new session's peers: their deltas and every context file.
    if (claimed.length) for (const cb of this.claimListeners) cb(claimed);
  }

  /** A trigger point was reached by something other than a transcript (the app's own link). */
  markReached(sessionId: string, trigger: FlowTrigger): void {
    const key = this.rawSessions.find((x) => x.sessionId === sessionId)?.key;
    if (!key) return;
    const track = (this.flowTracks[key] ??= newFlowTrack());
    track.reached[trigger] = Date.now();
  }

  /** Re-read MasterDeck's ticket links. Called every agents poll and right after a link. */
  reloadLinks(): void {
    const file = this.linkStore.read();
    this.links = linkInfoMap(file);
    this.linkPrs = ticketPrMap(file);
    this.emit();
  }

  private readLedger(): void {
    let text: string;
    try {
      text = readFileSync(this.paths.ledger, "utf8");
    } catch {
      this.setHealth("ledger", false, `no ledger at ${this.paths.ledger}`);
      this.emit();
      return;
    }
    try {
      const led = parseLedger(JSON.parse(text));
      this.proposals = led.proposals;
      // Master's last sweep fills what we lack: at startup, or when our own (cached or live) data
      // has no issues or PRs because GitHub failed. A working list is never replaced.
      const ls = led.lastSnapshot as Record<string, unknown> | null;
      if (ls && typeof ls === "object") {
        const mine = this.rawSnapshot ?? {};
        const lacks = (k: "issues" | "prs") =>
          !Array.isArray(mine[k]) || (mine[k] as unknown[]).length === 0;
        const has = (k: "issues" | "prs") =>
          Array.isArray(ls[k]) && (ls[k] as unknown[]).length > 0;
        if (
          this.snapshot === EMPTY_SNAPSHOT ||
          (lacks("issues") && has("issues")) ||
          (lacks("prs") && has("prs"))
        ) {
          const merged: Record<string, unknown> = { ...ls, ...mine };
          if (lacks("issues") && has("issues")) merged.issues = ls.issues;
          if (lacks("prs") && has("prs")) merged.prs = ls.prs;
          this.rawSnapshot = merged;
          this.snapshot = parseSnapshot(merged);
        }
      }
      this.setHealth("ledger", true);
    } catch {
      // Mid-write or corrupt: keep the last good proposals.
    }
    this.emit();
  }

  /** For the PR watch: the same pause every GitHub caller here obeys. */
  isGithubPaused(output?: string): boolean {
    return this.githubPaused(output);
  }

  /** Pause every GitHub call for a while when gh reports the rate limit. True when paused. */
  private githubPaused(output?: string): boolean {
    const now = Date.now();
    if (output && RATE_LIMITED.test(output))
      this.ghPausedUntil = now + RATE_LIMIT_PAUSE_MS;
    // The shared pause (ghc): a rate limit hit by master's sweep or a babysit loop stops us too.
    this.ghCache = this.readGhCache();
    const until = Math.max(this.ghPausedUntil, this.ghCache?.pausedUntil ?? 0);
    if (now >= until) {
      delete this.errors.github;
      return false;
    }
    const at = new Date(until).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    this.errors.github = `GitHub API rate limit reached; PR and issue refresh paused until ${at}`;
    return true;
  }

  async refreshSnapshot(
    force = false,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.snapshotRunning)
      return { ok: true, message: "already refreshing" };
    if (this.githubPaused())
      return {
        ok: false,
        message: this.errors.github ?? "GitHub calls paused",
      };
    this.snapshotRunning = true;
    try {
      const r = await this.cli.snapshot(force);
      if (r.ok) {
        // A source that failed (board, prs) comes back empty: keep the last good list (per account).
        const raw = keepLastGood(
          { ...(r.data as Record<string, unknown>) },
          this.rawSnapshot,
          this.config,
        );
        this.rawSnapshot = raw;
        this.snapshot = parseSnapshot(raw);
        this.setHealth("snapshot", true);
        // A snapshot can succeed with some sources failed; a rate-limit failure (any account's) still pauses GitHub calls.
        const errs =
          (r.data as { errors?: { message?: string }[] })?.errors ?? [];
        for (const e of errs) this.githubPaused(e?.message);
        const parts = (raw.accounts ?? []) as {
          login?: string;
          sources?: Record<string, boolean>;
        }[];
        for (const [k, v] of Object.entries(this.snapshot.sources)) {
          // Two or more accounts: name whose read failed.
          const whose = parts
            .filter((a) => a.sources?.[k] === false)
            .map((a) => a.login);
          if (!v)
            this.errors[`snapshot:${k}`] =
              `snapshot source missing: ${k}${whose.length ? ` (${whose.join(", ")})` : ""}`;
          else delete this.errors[`snapshot:${k}`];
        }
        this.emit();
        return { ok: true, message: "refreshed" };
      }
      this.githubPaused(r.message);
      this.setHealth("snapshot", false, `master snapshot: ${r.message}`);
      if (/No module named|not found|ENOENT/.test(r.message))
        this.missing.add("python3");
      this.emit();
      return { ok: false, message: r.message };
    } finally {
      this.snapshotRunning = false;
    }
  }

  /** Stats, transcript tail, git and gh for the sessions on screen (open tabs + master). */
  private async pollDetails(): Promise<void> {
    if (this.detailRunning) return;
    this.detailRunning = true;
    try {
      const ids = new Set(this.visible);
      if (this.focused) ids.add(this.focused);
      const now = Date.now();
      for (const id of ids) {
        const s = this.rawSessions.find((x) => x.sessionId === id);
        const statsPath = join(this.paths.statsDir, `${id}.json`);
        const st = readTail(statsPath, 256 * 1024);
        const parsed = st ? parseStatusline(st.text, st.mtimeMs) : null;
        if (parsed) this.stats[id] = parsed;
        const tp = this.transcripts.find(id, now);
        const tail = tp ? readTail(tp) : null;
        if (tail) {
          this.tails[id] = parseTranscriptTail(tail.text, tail.fromStart);
          this.lastWrite[id] = tail.mtimeMs;
          if (!this.stats[id] || this.stats[id].source === "transcript")
            this.stats[id] = statsFromTranscript(this.tails[id], now);
        }
        // Not awaited: a first read of a long history (or the Costs view's) must not hold up the details.
        if (!this.tokenPending.has(id)) {
          this.tokenPending.add(id);
          void this.tokenIndex
            .refresh([id])
            .then((r) => {
              if (!r[id]) return;
              this.tokens[id] = totalOf(r[id]);
              this.emit();
            })
            .finally(() => this.tokenPending.delete(id));
        }
        const key = s?.key ?? id;
        const created = tp ? this.followPrs(tp, key) : false;
        const dir = this.stats[id]?.currentDir ?? this.tails[id]?.cwd ?? s?.cwd;
        if (dir) await this.pollGit(id, dir);
        // A PR the session just created is fetched at once; otherwise the focused tab every
        // minute and other open tabs every five.
        const every = id === this.focused ? GH_MS : GH_BACKGROUND_MS;
        if (
          (created || now - (this.prFetchedAt[id] ?? 0) > every) &&
          !this.githubPaused()
        ) {
          this.prFetchedAt[id] = now;
          await this.pollPrs(
            key,
            this.prUrlsFor(id, key),
            // No git status for the folder: the branch is not known (never null, which is a detached HEAD).
            this.branchDir(dir, s ?? null, this.git[id] ? this.git[id].branch : undefined),
          );
        }
      }
      this.emit();
    } finally {
      this.detailRunning = false;
    }
  }

  private async pollGit(id: string, dir: string): Promise<void> {
    // A missing cwd also makes spawn fail with ENOENT, which would look like "git not installed".
    if (!existsSync(dir)) {
      delete this.git[id];
      return;
    }
    const st = await this.run("git", ["status", "--porcelain=v2", "--branch"], {
      cwd: dir,
      timeoutMs: 10_000,
    });
    this.noteBinary("git", st.code);
    if (st.code !== 0) {
      delete this.git[id];
      return;
    }
    const b = parseBranchStatus(st.stdout);
    const base = await this.run("git", ["merge-base", "HEAD", "origin/HEAD"], {
      cwd: dir,
      timeoutMs: 10_000,
    });
    const against =
      base.code === 0 && base.stdout.trim() ? base.stdout.trim() : "HEAD";
    const diff = await this.run("git", ["diff", "--numstat", against], {
      cwd: dir,
      timeoutMs: 10_000,
    });
    const d =
      diff.code === 0
        ? parseNumstat(diff.stdout)
        : { added: 0, removed: 0, files: 0 };
    this.git[id] = { dir, ...b, ...d };
  }

  /** Read what the transcript gained since last time; true when it shows a newly created PR. */
  private followPrs(path: string, key: string): boolean {
    const f = (this.follows[path] ??= {
      st: { path, offset: 0, rest: "" },
      scan: newPrScanState(),
      wt: newWorktreeScan(),
      flow: newFlowTrack(),
      sched: newScheduleScan(),
    });
    // From the start of the transcript: a PR opened early in a long session counts too.
    const lines = readNewLines(f.st, Infinity);
    const found = scanLines(lines, f.scan);
    scanWorktreeLines(lines, f.wt, homedir());
    // Where it is in its workflow: a resumed session's transcripts add up under one key.
    scanFlowLines(lines, f.flow);
    // Scheduled jobs (CronCreate): from this transcript only, since session-only ones end with it.
    scanScheduleLines(lines, f.sched);
    const track = (this.flowTracks[key] ??= newFlowTrack());
    for (const [t, at] of Object.entries(f.flow.reached))
      if (at && (track.reached[t as FlowTrigger] ?? 0) < at)
        track.reached[t as FlowTrigger] = at;
    if (lines.length) {
      track.commands = [
        ...track.commands,
        ...f.flow.commands.filter((c) => !track.commands.includes(c)),
      ].slice(-60);
    }
    const all = (this.worktreeScans[key] ??= newWorktreeScan());
    for (const p of f.wt.paths) if (!all.paths.includes(p)) all.paths.push(p);
    // Most recent last; a resumed session adds a second transcript to the same key.
    this.notePrs(key, f.scan.urls);
    addPrUrls((this.openedPrs[key] ??= []), f.scan.urls);
    return found;
  }

  /** Scheduled jobs the session's current transcript shows (see shared/schedules). */
  private schedulesOf(sessionId: string, now: number): ScheduleInfo[] {
    const tp = this.transcripts.find(sessionId, now);
    const f = tp ? this.follows[tp] : undefined;
    return f ? liveSchedules(f.sched, now) : [];
  }

  private flowTracks: Record<string, FlowTrackState> = {};
  /** What a session's transcripts show of its workflow (see shared/flowTrack). */
  flowTrackOf(key: string): FlowTrackState | null {
    return this.flowTracks[key] ?? null;
  }

  /** The session's worktrees that still exist, each with its repo and branch (read from .git files). */
  private worktreesOf(key: string): SessionWorktree[] {
    const out: SessionWorktree[] = [];
    for (const p of this.worktreeScans[key]?.paths ?? []) {
      const w = linkedWorktree(p);
      if (w) out.push(w);
    }
    return out;
  }

  /** PRs the session opened, from its transcripts (board moves link only these, or its linked branch's). */
  prsOpenedBy(sessionId: string): string[] {
    const s = this.lastSessions.find((x) => x.sessionId === sessionId);
    return s ? (this.openedPrs[s.key] ?? []) : [];
  }

  private prUrlsFor(sessionId: string, key: string): string[] {
    const out = [...(this.snapshot.sessionPrs.get(sessionId) ?? [])];
    for (const u of this.createdPrs[key] ?? []) {
      const i = out.indexOf(u);
      if (i >= 0) out.splice(i, 1);
      out.push(u);
    }
    return out;
  }

  /**
   * Live details for every PR the session has. Open ones are fetched each time; a merged or
   * closed PR only until it is known. The PR of the session's current branch joins its list.
   */
  private async pollPrs(
    key: string,
    urls: string[],
    dir: string | undefined,
  ): Promise<void> {
    for (const url of urls) {
      const known = this.prLive[url];
      if (known && known.state !== "OPEN") continue;
      const r = await this.gh(["pr", "view", url, ...PR_VIEW_ARGS], {
        timeoutMs: 20_000,
        ttl: 45,
      });
      this.noteBinary("gh", r.code);
      if (this.githubPaused(ghErrorText(r))) return;
      // Keep the last good value through a network blip.
      const pr = r.code === 0 ? parsePrView(r.stdout) : null;
      if (pr) this.prLive[url] = pr;
    }
    // The caller passes no folder when its branch is not the session's (`branchDir`).
    if (!dir || !existsSync(dir)) return;
    const r = await (this.ghForDir?.(dir) ?? this.gh)(["pr", "view", ...PR_VIEW_ARGS], {
      cwd: dir,
      timeoutMs: 20_000,
      ttl: 45,
    });
    this.noteBinary("gh", r.code);
    if (this.githubPaused(ghErrorText(r))) return;
    const pr = r.code === 0 ? parsePrView(r.stdout) : null;
    if (pr?.url) {
      this.prLive[pr.url] = pr;
      this.notePrs(key, [pr.url]);
    }
  }

  private emit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.onState(this.build());
    }, 250);
  }

  /** The menu on a background session's screen now (`claude logs`, rendered). */
  async readMenu(s: Session): Promise<ScreenMenu | null> {
    if (s.kind !== "background" || !s.bgId) return null;
    const screen = await sessionScreen(this.run, this.claude(), s.bgId);
    if (!screen) return null;
    const menu = parseMenuScreen(screen);
    if (menu) return menu;
    const perm = parsePermissionScreen(screen);
    return perm ? permissionMenu(perm) : null;
  }

  /** Read the menus of the sessions waiting on input; the others have none. */
  async pollMenus(): Promise<void> {
    if (this.menusRunning) return;
    this.menusRunning = true;
    try {
      // A permission MasterDeck's hook holds needs no screen read.
      const waiting = this.lastSessions.filter(
        (s) =>
          s.state === "needs-input" &&
          s.kind === "background" &&
          s.bgId &&
          !this.hookRequests.some((r) => r.sessionId === s.sessionId),
      );
      let changed = false;
      for (const key of [...this.menus.keys()])
        if (!waiting.some((s) => s.key === key)) {
          this.menus.delete(key);
          changed = true;
        }
      for (const s of waiting) {
        const menu = await this.readMenu(s);
        const before = JSON.stringify(this.menus.get(s.key) ?? null);
        if (menu) this.menus.set(s.key, menu);
        else this.menus.delete(s.key);
        if (JSON.stringify(menu) !== before) changed = true;
      }
      if (changed) this.emit();
    } finally {
      this.menusRunning = false;
    }
  }

  /**
   * PRs of every live session, open in a tab or not, every two minutes while open: new comments
   * restart its Ready-for-Review timer. Merged and closed PRs are not fetched again. Each pass
   * also reads what every live session's transcript gained, so a PR it just opened is found (and
   * fetched) now, not at the next hourly GitHub snapshot.
   */
  private async pollReview(): Promise<void> {
    if (this.reviewRunning || this.githubPaused()) return;
    this.reviewRunning = true;
    try {
      const now = Date.now();
      for (const s of this.lastSessions) {
        if (s.state === "done" || s.name === MASTER_NAME) continue;
        const tp = this.transcripts.find(s.sessionId, now);
        const created = tp ? this.followPrs(tp, s.key) : false;
        if (!created && now - (this.prFetchedAt[s.sessionId] ?? 0) < REVIEW_MS)
          continue;
        const urls = this.prUrlsFor(s.sessionId, s.key);
        if (
          !urls.some((u) => !this.prLive[u] || this.prLive[u].state === "OPEN")
        )
          continue;
        this.prFetchedAt[s.sessionId] = now;
        await this.pollPrs(s.key, urls, undefined);
      }
      this.emit();
    } finally {
      this.reviewRunning = false;
    }
  }

  /**
   * When the user last wrote to a session whose PRs are all merged or closed (for Rework): read
   * from its transcript only then, since it is a file read.
   */
  private instructedAt(s: Session): number | null {
    const prs = this.prUrlsFor(s.sessionId, s.key).map((u) => this.prLive[u]);
    if (
      !prs.some((p) => p?.state === "MERGED") ||
      prs.some((p) => !p || p.state === "OPEN")
    )
      return null;
    return this.askOf(s.sessionId)?.userAt ?? null;
  }

  /** Use MasterDeck's hook: read its events and permission requests every second. */
  setDeckHooks(
    deck: DeckHooks,
    summaryOf: (sessionId: string) => { text: string; at: number } | null,
  ): void {
    this.deck = deck;
    this.summaryOf = summaryOf;
  }

  private pollDeck(): void {
    const deck = this.deck;
    if (!deck) return;
    const now = Date.now();
    if (now - this.deckTouchedAt > 5_000) {
      deck.touch();
      this.deckTouchedAt = now;
    }
    let changed = false;
    for (const sid of deck.readEvents()) {
      changed = true;
      const st = deck.sessions[sid]?.stoppedAt ?? null;
      if (st && st !== this.lastStopAt[sid]) {
        this.lastStopAt[sid] = st;
        for (const cb of this.stopListeners)
          try {
            cb(sid);
          } catch (e) {
            console.error(`session stop: ${String(e)}`);
          }
      }
      // A session that moved into a worktree (EnterWorktree, cd): it works there.
      const cwd = deck.sessions[sid]?.cwd;
      const key = this.rawSessions.find((x) => x.sessionId === sid)?.key;
      if (cwd && key && linkedWorktree(cwd)) {
        const scan = (this.worktreeScans[key] ??= newWorktreeScan());
        if (!scan.paths.includes(cwd)) scan.paths.push(cwd);
      }
    }
    const before = this.hookRequests.map((r) => r.id).join();
    const live: HookRequest[] = [];
    for (const r of deck.pending()) {
      const s = this.rawSessions.find((x) => x.sessionId === r.sessionId);
      const blocked = s?.state === "needs-input";
      if (blocked) this.seenBlocked.add(r.id);
      // Answered in the terminal (the hook keeps waiting then): let it go.
      if (
        requestOver(
          r,
          now,
          blocked,
          this.seenBlocked.has(r.id),
          deck.sessions[r.sessionId]?.stoppedAt ?? null,
        )
      ) {
        deck.withdraw(r.id);
        continue;
      }
      live.push(r);
    }
    for (const id of [...this.seenBlocked])
      if (!live.some((r) => r.id === id)) this.seenBlocked.delete(id);
    this.hookRequests = live;
    if (changed || live.map((r) => r.id).join() !== before) this.emit();
  }

  /** What earlier (stopped) sessions on a ticket did, from their saved summaries, newest first. */
  ticketMemory(t: Ticket): { name: string; at: number; text: string }[] {
    return (this.past[ticketKey(t.repo, t.number)] ?? [])
      .map((p) => {
        const sum = this.summaryOf(p.sessionId);
        return sum
          ? { name: p.name, at: p.lastActivity, text: sum.text }
          : null;
      })
      .filter((x): x is { name: string; at: number; text: string } => !!x)
      .sort((a, b) => b.at - a.at);
  }

  /** Answer a permission request held by MasterDeck's hook: option `n` of its prompt. */
  answerHookRequest(id: string, n: number, note?: string): CliResult {
    const r = this.hookRequests.find((x) => x.id === id);
    if (!r || !this.deck)
      return {
        ok: false,
        message: "that permission request is gone; look again",
      };
    const decision = decisionFor(r, n, note);
    if (!decision) return { ok: false, message: "no such option" };
    if (!this.deck.answer(id, decision))
      return {
        ok: false,
        message: "that permission request is gone; look again",
      };
    this.hookRequests = this.hookRequests.filter((x) => x.id !== id);
    this.emit();
    return { ok: true, message: requestPrompt(r).options[n] };
  }

  /** Answer an AskUserQuestion held by MasterDeck's hook (answers by question text). */
  answerHookQuestions(id: string, answers: Record<string, string>): CliResult {
    const r = this.hookRequests.find((x) => x.id === id);
    if (!r || !this.deck)
      return { ok: false, message: "that question is gone; look again" };
    const decision = answersDecision(r, answers);
    if (!decision) return { ok: false, message: "answer every question first" };
    if (!this.deck.answer(id, decision))
      return { ok: false, message: "that question is gone; look again" };
    this.hookRequests = this.hookRequests.filter((x) => x.id !== id);
    this.emit();
    return { ok: true, message: "answered" };
  }

  /**
   * What SessionStart tells each live session on a ticket or with linked sessions (after a resume,
   * a compaction, /clear): the ticket, what earlier sessions on it did, and what its peers are doing.
   * It never marks a peer summary as seen: a running session does not re-read this file, so only
   * the per-prompt delta (PeerSync) advances that.
   */
  private writeTicketContext(sessions: Session[]): void {
    const deck = this.deck;
    // No sessions (e.g. before the first poll after a restart): nothing to write, and pruning against
    // an empty set would delete every delta still waiting for a session's next prompt.
    if (!deck || sessions.length === 0) return;
    const live = new Set<string>();
    for (const s of sessions) {
      if (s.state === "done") continue;
      const peers = this.peerFacts(s.key);
      if (s.issue === null && !peers.length) continue;
      live.add(s.sessionId);
      let ticket: { label: string; title: string | null; url: string | null } | null = null;
      let earlier: { name: string; at: number; text: string }[] = [];
      if (s.issue !== null) {
        const key = ticketKey(s.issueRepo, s.issue);
        const issue = this.snapshot.issues.find((i) =>
          sameTicket(i, { repo: s.issueRepo ?? null, number: s.issue! }),
        );
        ticket = {
          label: ticketLabel(s.issueRepo, s.issue),
          title: issue?.title ?? null,
          url: issue?.url ?? null,
        };
        earlier = (this.past[key] ?? [])
          .filter((p) => p.sessionId !== s.sessionId)
          .map((p) => {
            const sum = this.summaryOf(p.sessionId);
            return sum
              ? { name: p.name, at: p.lastActivity, text: sum.text }
              : null;
          })
          .filter((x): x is { name: string; at: number; text: string } => !!x);
      }
      deck.setContext(s.sessionId, ticketContext(ticket, earlier, peers));
    }
    deck.pruneDeltas(live);
    deck.pruneContext(live);
  }

  /** What this session's linked sessions are doing (facts + saved summary), by Session.key. */
  peerFacts(key: string): PeerFact[] {
    if (!this.peerStore) return [];
    const out: PeerFact[] = [];
    for (const pk of this.peerStore.of(key)) {
      const s = this.lastSessions.find((x) => x.key === pk);
      if (!s || s.state === "done") continue;
      out.push({
        key: pk,
        name: s.name,
        cwd: this.stats[s.sessionId]?.currentDir ?? s.cwd,
        branch: this.git[s.sessionId]?.branch ?? null,
        ticket: s.issue !== null ? ticketLabel(s.issueRepo, s.issue) : null,
        state: s.state,
        summary: this.summaryOf(s.sessionId),
      });
    }
    return out;
  }

  /** Background work a session started and is still waiting on (the last 256 KB of its transcript). */
  private tasksOf(sessionId: string): { tasks: PendingTask[]; ended: boolean } {
    const none = { tasks: [], ended: false };
    const path = this.transcripts.find(sessionId);
    const mt = path ? mtime(path) : null;
    if (!path || mt === null) return none;
    const hit = this.taskCache.get(sessionId);
    if (hit && hit.path === path && hit.mtime === mt) return hit;
    const tail = readTail(path, 256 * 1024);
    if (!tail) return none;
    const lines = tail.text.split("\n");
    if (!tail.fromStart) lines.shift();
    const out = {
      path,
      mtime: mt,
      tasks: openTasks(lines),
      ended: turnEnded(lines),
    };
    this.taskCache.set(sessionId, out);
    return out;
  }

  /**
   * Idle sessions: what they still wait on (background work they started) and whether their last
   * message asks the user something. Only an idle session with neither is waiting on the user's
   * next instruction.
   */
  private withActivity(sessions: Session[], now: number): Session[] {
    const watches = this.watchInfo();
    return sessions.map((raw) => {
      const s = this.activityOf(raw, now);
      // Monitors MasterDeck runs for it count like its own, once its turn is over.
      const mine = watches.filter((w) => w.sessionId === s.sessionId);
      const withW =
        mine.length && (s.state === "idle" || s.waitingOn || s.busyWith)
          ? withMdWatches(s, mine)
          : s;
      // Scheduled jobs (CronCreate) will wake it: waiting on those, not on you.
      const jobs = s.state === "idle" ? this.schedulesOf(s.sessionId, now) : [];
      return jobs.length ? withSchedules(withW, jobs) : withW;
    });
  }

  private activityOf(s: Session, now: number): Session {
    {
      if (s.state !== "idle" && s.state !== "working") return s;
      const t = this.tasksOf(s.sessionId);
      // "busy" with its turn over: only its background work keeps it so (a live Monitor).
      if (s.state === "working" && !t.ended) return s;
      const pending = stillPending(t.tasks, now);
      if (s.state === "working" && !pending.length) return s;
      const busy = pending.filter(isBusyWork);
      const wait = pending.filter((x) => !isBusyWork(x));
      const asking = asksQuestion(this.askOf(s.sessionId)?.said ?? null);
      return pending.length || asking
        ? {
            ...s,
            waitingOn: wait.length ? describePending(wait) : null,
            busyWith: busy.length ? describePending(busy) : null,
            asking,
          }
        : s;
    }
  }

  /**
   * What MasterDeck's hook knows beats what `claude agents` says a moment later: a session with a
   * permission request waits on it now; one Claude Code reported idle since its last output is idle.
   */
  private withHookState(sessions: Session[]): Session[] {
    if (!this.deck) return sessions;
    return sessions.map((s) => {
      if (s.state === "done" || s.state === "suspended") return s;
      if (this.hookRequests.some((r) => r.sessionId === s.sessionId))
        return s.state === "needs-input" ? s : { ...s, state: "needs-input" };
      const n = this.deck!.sessions[s.sessionId]?.notice;
      if (
        s.state === "working" &&
        !s.waitingOn &&
        !s.busyWith &&
        n?.type === "idle_prompt" &&
        n.at > (this.lastWrite[s.sessionId] ?? 0)
      )
        return { ...s, state: "idle" };
      return s;
    });
  }

  /** What a session's transcript says it is asking (the last 256 KB). */
  private askOf(sessionId: string): SessionAsk | null {
    const path = this.transcripts.find(sessionId);
    const mt = path ? mtime(path) : null;
    if (!path || mt === null) return null;
    const hit = this.askCache.get(sessionId);
    if (hit && hit.path === path && hit.mtime === mt) return hit.ask;
    const tail = readTail(path, 256 * 1024);
    if (!tail) return null;
    const lines = tail.text.split("\n");
    if (!tail.fromStart) lines.shift();
    const ask = sessionAsk(lines);
    this.askCache.set(sessionId, { path, mtime: mt, ask });
    return ask;
  }

  /**
   * Asks of the sessions that need the user (waiting on a prompt, or with a question or blocker for
   * master), and the question proposals the user has since answered in the session itself: those
   * leave Needs you, and the ledger is told, as master-agent would on "#N: answered".
   */
  private collectAsks(sessions: Session[]): {
    asks: Record<string, SessionAsk>;
    answered: Set<number>;
  } {
    const asks: Record<string, SessionAsk> = {};
    const answered = new Set<number>();
    const add = (s: Session | null): SessionAsk | null => {
      if (!s) return null;
      if (!asks[s.key]) {
        const a = this.askOf(s.sessionId);
        if (a) asks[s.key] = a;
      }
      return asks[s.key] ?? null;
    };
    // Waiting on a prompt, or its last message asks the user something (the Tasks view answers both).
    for (const s of sessions) if (s.state === "needs-input" || s.asking) add(s);
    for (const p of this.proposals) {
      if (p.status !== "question" && p.status !== "blocked") continue;
      const ask = add(sessionForProposal(p, sessions));
      if (
        p.status === "question" &&
        ask &&
        answeredInSession(ask, proposalTicket(p))
      ) {
        answered.add(p.id);
        const once = `${p.id}:${ask.report?.at}`;
        if (!this.answered.has(once)) {
          this.answered.add(once);
          void this.cli.mark(p.id, "sent", "answered in the session");
        }
      }
    }
    return { asks, answered };
  }

  build(): AppState {
    const now = Date.now();
    const sessions = this.withAccounts(this.withHookState(
      this.withActivity(
        applyFreshness(
          attachIssues(
            // The Workflow window's builder is MasterDeck's own, not the user's work.
            hideSuperseded(this.rawSessions, this.superseded()).filter(
              (s) =>
                s.name !== BUILDER_NAME &&
                !isTicketBuilderSession(s, this.paths.home) &&
                resolve(s.cwd || "/") !==
                  resolve(join(this.paths.home, "workflow-builder")),
            ),
            this.issueOf(),
          ),
          this.lastWrite,
          now,
        ),
        now,
      ),
    ));
    const { asks, answered } = this.collectAsks(sessions);
    const menus = Object.fromEntries(
      sessions
        .filter((s) => s.state === "needs-input" && this.menus.has(s.key))
        .map((s) => [s.key, this.menus.get(s.key)!]),
    );
    // A permission MasterDeck's hook holds: exact, and answered through the hook (any terminal).
    for (const r of this.hookRequests) {
      const s = sessions.find((x) => x.sessionId === r.sessionId);
      if (s) menus[s.key] = requestMenu(r);
    }
    const failures: Record<
      string,
      { type: string; message: string; at: number }
    > = {};
    const hookInfo: AppState["hookInfo"] = {};
    for (const s of sessions) {
      const h = this.deck?.sessions[s.sessionId];
      if (!h) continue;
      // An API error stands until the session works again (a Stop clears it; so does new output).
      const f =
        h.failure && (this.lastWrite[s.sessionId] ?? 0) < h.failure.at + 10_000
          ? h.failure
          : null;
      if (f) failures[s.key] = f;
      hookInfo[s.key] = {
        compacting: h.compacting,
        compactedAt: h.compactedAt,
        failure: f,
        stoppedAt: h.stoppedAt,
      };
    }
    const sessionPrs = Object.fromEntries(
      sessions
        .map((x) => [x.sessionId, this.prUrlsFor(x.sessionId, x.key)])
        .filter(([, v]) => v.length),
    );
    const m = deriveMaster(sessions);
    const masterAs = "session" in m ? this.masterAccountOf(m.session) : undefined;
    const items = collectItems({
      sessions,
      proposals: this.proposals.filter((p) => !answered.has(p.id)),
      menus,
      lastActivity: this.lastWrite,
      settings: this.settings,
      allStats: this.allStats,
      costBook: this.costBook,
      prs: this.snapshot.prs.filter((p) => p.authorIsMe),
      sessionPrs,
      failures,
      external: this.externalItems,
      watchedPrs: this.watchedPrs(),
      // Only accounts MasterDeck uses, and only with two or more (one account is as before).
      ghAccounts: isMulti(this.config)
        ? this.ghAccounts.filter((a) => this.config.accounts.some((c) => c.login === a.login))
        : undefined,
      accountNotices: accountNotices({ ghActive: this.ghActive, master: masterAs }, this.config),
      now,
    });
    this.inbox.update(items, !this.inboxPrimed);
    // Primed once sessions are loaded and the ledger was read (there may be none: no master-agent).
    if (
      this.health.agents === "ok" &&
      this.health.ledger !== undefined &&
      this.health.ledger !== "pending"
    )
      this.inboxPrimed = true;
    this.lastSessions = sessions;
    return {
      sessions,
      issues: this.snapshot.issues,
      prs: this.snapshot.prs,
      proposals: this.proposals,
      master: deriveMaster(sessions),
      inbox: this.inbox.view(),
      remote:
        this.remote && this.browsers.warning
          ? { ...this.remote, warning: this.browsers.warning }
          : this.remote,
      browsers: this.browsers.browsers,
      remoteClients: this.remoteClients,
      browserRequests: this.browsers.browserRequests,
      account: this.account,
      ghAccounts: this.ghAccounts,
      stats: { ...this.stats },
      tails: { ...this.tails },
      git: { ...this.git },
      prLive: { ...this.prLive },
      sessionPrs,
      peers: this.peerStore ? adjacency(this.peerStore.data()) : {},
      watches: this.watchInfo(),
      schedules: Object.fromEntries(
        sessions
          .filter((s) => s.state !== "done")
          .map((s) => [s.sessionId, this.schedulesOf(s.sessionId, now)] as const)
          .filter((e) => e[1].length > 0),
      ),
      hookInfo,
      sessionWorktrees: Object.fromEntries(
        sessions
          .map((x) => [x.key, this.worktreesOf(x.key)])
          .filter(([, v]) => v.length),
      ),
      sources: { ...this.health },
      errors: Object.values(this.errors),
      lastSnapshotAt: this.snapshot.takenAt,
      githubRefreshedAt: this.githubRefreshedAt,
      githubRefreshing: this.githubRefreshing,
      statuslineInstalled: this.statuslineInstalled,
      missingBinaries: [...this.missing],
      masterWorkspace: this.paths.masterWorkspace,
      settings: this.settings,
      allStats: this.allStats,
      // A copy per state: notifications compare the previous state's book with the next one.
      costBook: structuredClone(this.costBook),
      lastActivity: { ...this.lastWrite },
      boardHistory: this.boardHistory,
      ghCache: (this.ghCache = this.readGhCache()),
      teamPrs: this.teamPrs,
      teamPrsAt: this.teamPrsAt,
      teamPrsLoading: this.teamPrsLoading,
      teamPrsError: this.teamPrsError,
      stoppedByRestart: this.restore?.stopped ?? [],
      tokens: { ...this.tokens },
      pastSessions: this.past,
      asks,
      manualStatus: { ...this.manualStatus },
      prStage: Object.fromEntries(
        sessions
          .filter((s) => s.state !== "done" && s.name !== MASTER_NAME)
          .map(
            (s) =>
              [
                s.key,
                prStage(
                  this.prUrlsFor(s.sessionId, s.key),
                  this.prLive,
                  now,
                  this.settings.reviewQuietMinutes,
                  this.instructedAt(s),
                ),
              ] as const,
          )
          .filter((e): e is readonly [string, PrStage] => e[1] !== null),
      ),
      menus,
      restoring: this.restoring,
      config: this.config,
      skills: this.skills,
      hooks: this.hooks,
      // Cards of an account with no board get their column here, from what MasterDeck knows now.
      // (A board without such cards comes back as the same object; one with them, as the object of
      // the build before while no card changed column.)
      // Nothing selected any more: the cached board goes (no read replaces it).
      // (MASTERDECK_BOARD_FIXTURE, the test aid, shows its board whatever the config.)
      board: this.derive(
        process.env.MASTERDECK_BOARD_FIXTURE
          ? (this.boards[this.selectedSprint] ?? null)
          : boardToShow(this.boards[this.selectedSprint] ?? null, this.config),
        {
          sessions,
          past: this.past,
          linkPrs: this.linkPrs,
          prLive: this.prLive,
          now,
        },
      ),
      // The repository view's cards get their columns the same way; absent until a tab asks.
      repoView: this.deriveRepo(this.repoIssues.view(), {
        sessions,
        past: this.past,
        linkPrs: this.linkPrs,
        prLive: this.prLive,
        now,
      }),
      sprints: this.sprints,
      selectedSprint: this.selectedSprint,
      users: this.users,
      me: this.me,
      boardError: this.boardError,
      boardLoading: this.boardRunning,
    };
  }

  isHealthy(name: string): boolean {
    return this.health[name] === "ok";
  }

  /** A source's health and, when it failed, why. */
  sourceHealth(name: string): { health: SourceHealth | undefined; error: string | undefined } {
    return { health: this.health[name], error: this.errors[name] };
  }
}

/** A session that MasterDeck runs monitors for waits on them (shown like a monitor of its own). */
function withMdWatches(s: Session, mine: WatchInfo[]): Session {
  const what = mine.map((w) => `MasterDeck monitor: ${w.description}`).join(" · ");
  return { ...s, waitingOn: s.waitingOn ? `${s.waitingOn} · ${what}` : what };
}

/** An idle session with scheduled jobs waits on them (the next one first). */
function withSchedules(s: Session, jobs: ScheduleInfo[]): Session {
  const what = `scheduled: ${jobs.map((j) => j.when).join(" · ")}`;
  return { ...s, waitingOn: s.waitingOn ? `${s.waitingOn} · ${what}` : what };
}

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
  storedRepo,
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
import { TICKET_BUILDER_NAME } from "@shared/ticketBuilder";
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
  setConfig,
  type AppConfig,
} from "@shared/appConfig";
import { parseTeamPrs, type TeamPr } from "@shared/teamPrs";
import {
  nextRestore,
  parseRestoreFile,
  type RestoreEntry,
  type RestoreFile,
} from "@shared/restore";
import { totalOf, type Tokens, type TokensByDay } from "@shared/tokens";
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
import type { GhRunner } from "./ghc";
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
import { linkedWorktree } from "./worktreeInfo";
import type { DeckHooks } from "./deckHooks";
import {
  answersDecision,
  decisionFor,
  requestMenu,
  requestOver,
  requestPrompt,
  ticketContext,
  type HookRequest,
} from "@shared/deckHooks";
import type { MasterCli } from "./masterCli";
import type { Paths } from "./paths";
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
const RATE_LIMITED = /rate limit|secondary rate|abuse detection/i;

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
  private ghPausedUntil = 0;
  private ghCache: GhCacheStatus | null = null;
  private teamPrs: TeamPr[] = [];
  private teamPrPages: unknown[] = [];
  private teamPrsAt: number | null = null;
  private teamPrsLoading = false;
  private teamPrsError: string | null = null;
  private config: AppConfig = DEFAULT_CONFIG;
  private skills: SkillStatus[] = [];
  private hooks: HookStatus = { ticket: false, pr: false, queue: false };
  private settings: Settings = DEFAULT_SETTINGS;
  private allStats: AppState["allStats"] = {};
  private costBook: CostBook = {};
  private costDirty = false;
  /** babysit-ticket's links (sessionId → issue and when), read from its state file; fresher than the snapshot. */
  private links = new Map<string, LinkInfo>();
  /** Session ids each background session has had (persisted), to carry links across a resume. */
  private history: SessionHistory = {};
  private carryTried: Record<string, number> = {};
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
    const failed: string[] = [];
    let resumed = 0;
    try {
      for (const e of [...this.restore.stopped]) {
        // Resumed meanwhile (master's ORPHAN, or by hand): resuming again would start a copy.
        const live = this.rawSessions.some(
          (s) =>
            s.pid !== null && s.state !== "done" && s.sessionId === e.sessionId,
        );
        const r = live
          ? { ok: true, message: "already running" }
          : await this.resumer(e);
        if (r.ok) {
          resumed++;
          // Off the list now; the next scan also drops it once its process shows up.
          if (this.restore)
            this.restore.stopped = this.restore.stopped.filter(
              (x) => x.sessionId !== e.sessionId,
            );
        } else failed.push(`${e.name}: ${r.message}`);
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

  /** Each session's ticket: the snapshot's, then babysit-ticket's fresher links. */
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

  /** Send the state again now (after an inbox action). */
  changed(): void {
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

  setSettings(raw: unknown): Settings {
    this.settings = normalizeSettings(raw);
    writeJsonAtomic(this.settingsPath, this.settings);
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
    this.emit();
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
    const [sp, users, me] = await Promise.all([
      this.cli.sprints(force),
      this.github.assignableUsers(force),
      this.me ? Promise.resolve(this.me) : this.github.me(),
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
        settle(gh && this.config.project ? this.refreshBoard(force) : skip),
        settle(gh ? this.refreshPeople(force) : skip),
        settle(gh ? this.refreshTeamPrs(0, force) : skip),
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
      const r = await this.github.teamPrPages(undefined, undefined, force);
      if (r.ok) {
        this.teamPrPages = r.pages;
        this.teamPrs = parseTeamPrs(r.pages);
        this.teamPrsAt = Date.now();
        this.teamPrsError = r.partial ?? null;
        this.saveGithubCache();
        return { ok: true, message: "refreshed" };
      }
      // Keep the last good list on screen; say why it didn't update.
      this.githubPaused(r.message);
      this.teamPrsError = r.message;
      return { ok: false, message: r.message };
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
        this.boardError = null;
        if (b.sprint)
          this.boardHistory[b.sprint] = addBurnPoint(
            this.boardHistory[b.sprint] ?? [],
            {
              date: dayOf(Date.now()),
              total: b.cards.length,
              done: summarize(b).counts.done,
            },
          );
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
    const now = Date.now();
    for (const s of this.rawSessions) {
      const p = this.transcripts.find(s.sessionId, now);
      const m = p ? mtime(p) : null;
      if (m !== null) this.lastWrite[s.sessionId] = m;
    }
    this.emit();
  }

  /** Re-read babysit-ticket's state file. Called every agents poll and right after a link. */
  reloadLinks(): void {
    try {
      const raw = JSON.parse(readFileSync(this.paths.babysitState, "utf8")) as {
        sessions?: Record<
          string,
          {
            issue?: unknown;
            repo?: unknown;
            linked_at?: unknown;
            adopted?: unknown;
          }
        >;
      };
      const next = new Map<string, LinkInfo>();
      for (const [sid, v] of Object.entries(raw.sessions ?? {})) {
        if (typeof v?.issue !== "number") continue;
        // Adopted from the checkout's branch by older babysit-ticket versions, never asked for.
        if (v.adopted === true) continue;
        const at =
          typeof v.linked_at === "string" ? Date.parse(v.linked_at) : NaN;
        next.set(sid, {
          issue: v.issue,
          repo: storedRepo(typeof v.repo === "string" ? v.repo : null),
          linkedAt: Number.isFinite(at) ? at : null,
        });
      }
      this.links = next;
    } catch {
      // missing or mid-write: keep the last good links
    }
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
        // A source that failed (board, prs) comes back empty: keep the last good list instead.
        const raw = { ...(r.data as Record<string, unknown>) };
        const ok = (raw.sources ?? {}) as Record<string, boolean>;
        if (!ok.board && this.rawSnapshot?.issues)
          raw.issues = this.rawSnapshot.issues;
        if (!ok.prs && this.rawSnapshot?.prs) raw.prs = this.rawSnapshot.prs;
        this.rawSnapshot = raw;
        this.snapshot = parseSnapshot(raw);
        this.setHealth("snapshot", true);
        // A snapshot can succeed with some sources failed; a rate-limit failure still pauses GitHub calls.
        const errs =
          (r.data as { errors?: { message?: string }[] })?.errors ?? [];
        for (const e of errs) this.githubPaused(e?.message);
        for (const [k, v] of Object.entries(this.snapshot.sources)) {
          if (!v)
            this.errors[`snapshot:${k}`] = `snapshot source missing: ${k}`;
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
          await this.pollPrs(key, this.prUrlsFor(id, key), dir);
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
    });
    // From the start of the transcript: a PR opened early in a long session counts too.
    const lines = readNewLines(f.st, Infinity);
    const found = scanLines(lines, f.scan);
    scanWorktreeLines(lines, f.wt, homedir());
    // Where it is in its workflow: a resumed session's transcripts add up under one key.
    scanFlowLines(lines, f.flow);
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
    return found;
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
      if (this.githubPaused(r.stderr + r.stdout)) return;
      // Keep the last good value through a network blip.
      const pr = r.code === 0 ? parsePrView(r.stdout) : null;
      if (pr) this.prLive[url] = pr;
    }
    // master's workspace is shared by every session; its branch's PR belongs to none of them.
    if (
      !dir ||
      !existsSync(dir) ||
      resolve(dir) === resolve(this.paths.masterWorkspace)
    )
      return;
    const r = await this.gh(["pr", "view", ...PR_VIEW_ARGS], {
      cwd: dir,
      timeoutMs: 20_000,
      ttl: 45,
    });
    this.noteBinary("gh", r.code);
    if (this.githubPaused(r.stderr + r.stdout)) return;
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
   * What SessionStart tells each live session on a ticket (after a resume, a compaction, /clear):
   * the ticket and what earlier sessions on it did, from their saved summaries.
   */
  private writeTicketContext(sessions: Session[]): void {
    const deck = this.deck;
    if (!deck) return;
    const live = new Set<string>();
    for (const s of sessions) {
      if (s.issue === null || s.state === "done") continue;
      live.add(s.sessionId);
      const key = ticketKey(s.issueRepo, s.issue);
      const issue = this.snapshot.issues.find((i) =>
        sameTicket(i, { repo: s.issueRepo ?? null, number: s.issue! }),
      );
      const earlier = (this.past[key] ?? [])
        .filter((p) => p.sessionId !== s.sessionId)
        .map((p) => {
          const sum = this.summaryOf(p.sessionId);
          return sum
            ? { name: p.name, at: p.lastActivity, text: sum.text }
            : null;
        })
        .filter((x): x is { name: string; at: number; text: string } => !!x);
      deck.setContext(
        s.sessionId,
        ticketContext(
          {
            label: ticketLabel(s.issueRepo, s.issue),
            title: issue?.title ?? null,
            url: issue?.url ?? null,
          },
          earlier,
        ),
      );
    }
    deck.pruneContext(live);
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
    return sessions.map((s) => {
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
    });
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
    const sessions = this.withHookState(
      this.withActivity(
        applyFreshness(
          attachIssues(
            // The Workflow window's builder is MasterDeck's own, not the user's work.
            this.rawSessions.filter(
              (s) =>
                s.name !== BUILDER_NAME &&
                s.name !== TICKET_BUILDER_NAME &&
                resolve(s.cwd || "/") !==
                  resolve(join(this.paths.home, "ticket-builder")) &&
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
    );
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
      stats: { ...this.stats },
      tails: { ...this.tails },
      git: { ...this.git },
      prLive: { ...this.prLive },
      sessionPrs,
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
      board: this.boards[this.selectedSprint] ?? null,
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
}

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watchFile, unwatchFile, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { dirname } from 'node:path'
import { join, resolve } from 'node:path'
import { applyFreshness, normalizeAgents } from '@shared/agents'
import {
  attachIssues,
  deriveMaster,
  deriveNeedsYou,
  parseLedger,
  parseSnapshot,
  type ParsedSnapshot,
} from '@shared/derive'
import { parseBranchStatus, parseNumstat, parsePrView } from '@shared/git'
import { newPrScanState, scanLines, type PrScanState } from '@shared/prscan'
import { parseStatusline, parseTranscriptTail, statsFromTranscript } from '@shared/stats'
import { parseBoard } from '@shared/board'
import { linksToCarry, recordHistory, type LinkInfo, type SessionHistory } from '@shared/carry'
import { dayOf, pruneBook, recordCosts, validBook, type CostBook, type CostEntry } from '@shared/costs'
import { addBurnPoint, summarize, type BurnPoint } from '@shared/sprintSummary'
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '@shared/settings'
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
} from '@shared/types'
import { DEFAULT_CONFIG, getConfig, parseConfig, setConfig, type AppConfig } from '@shared/appConfig'
import { parseTeamPrs, type TeamPr } from '@shared/teamPrs'
import { nextRestore, parseRestoreFile, type RestoreEntry, type RestoreFile } from '@shared/restore'
import { totalOf, type Tokens, type TokensByDay } from '@shared/tokens'
import { TokenIndex } from './tokens'
import { loadCache, saveCache } from './cache'
import type { GhRunner } from './ghc'
import { GitHub } from './github'
import { mtime, readNewLines, readTail, TranscriptIndex, type FollowState } from './files'
import type { MasterCli } from './masterCli'
import type { Paths } from './paths'
import type { Runner } from './run'

const AGENTS_MS = 3_000
const DETAIL_MS = 3_000
// GitHub allows 5,000 API requests an hour, shared with gh in every session and master's sweeps.
// A snapshot is the heavy call (board + PR GraphQL); a PR check is one light request.
/** Issues, PRs and the sprint board come from GitHub at startup, then once an hour (or on Refresh). */
const GITHUB_MS = 3_600_000
const GH_MS = 120_000
const GH_BACKGROUND_MS = 600_000
const RATE_LIMIT_PAUSE_MS = 600_000
const RATE_LIMITED = /rate limit|secondary rate|abuse detection/i

function writeJsonAtomic(path: string, data: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, path)
  } catch {
    // best effort
  }
}

const EMPTY_SNAPSHOT: ParsedSnapshot = { issues: [], prs: [], sessionIssue: new Map(), sessionPrs: new Map(), sources: {}, takenAt: null }

/**
 * Owns every poll. Keeps the latest good value of each source (a failed or corrupt read keeps the
 * previous one) and emits a merged AppState, at most every 250 ms.
 */
export class Sources {
  private rawSessions: Session[] = []
  private snapshot: ParsedSnapshot = EMPTY_SNAPSHOT
  private proposals: Proposal[] = []
  private stats: Record<string, SessionStats> = {}
  private tails: Record<string, TranscriptTail> = {}
  private lastWrite: Record<string, number> = {}
  private git: Record<string, GitInfo> = {}
  private prLive: Record<string, PrLive | null> = {}
  private prFetchedAt: Record<string, number> = {}
  /** Transcript followers for PR detection, by transcript path. */
  private follows: Record<string, { st: FollowState; scan: PrScanState }> = {}
  /** PRs each session created, by session key (survives a resume's new sessionId). */
  private createdPrs: Record<string, string[]> = {}
  private ghPausedUntil = 0
  private ghCache: GhCacheStatus | null = null
  private teamPrs: TeamPr[] = []
  private teamPrPages: unknown[] = []
  private teamPrsAt: number | null = null
  private teamPrsLoading = false
  private teamPrsError: string | null = null
  private config: AppConfig = DEFAULT_CONFIG
  private skills: SkillStatus[] = []
  private hooks: HookStatus = { ticket: false, pr: false, queue: false }
  private settings: Settings = DEFAULT_SETTINGS
  private allStats: AppState['allStats'] = {}
  private costBook: CostBook = {}
  private costDirty = false
  /** babysit-ticket's links (sessionId → issue and when), read from its state file; fresher than the snapshot. */
  private links = new Map<string, LinkInfo>()
  /** Session ids each background session has had (persisted), to carry links across a resume. */
  private history: SessionHistory = {}
  private carryTried: Record<string, number> = {}
  private linker: ((issue: number, sessionId: string, cwd: string | null) => Promise<CliResult>) | null = null
  /** Which background sessions were running, so a restart can be undone (see @shared/restore). */
  private restore: RestoreFile | null = null
  private tokenIndex: TokenIndex
  /** Tokens used so far by the sessions whose details are followed (open tabs, focused). */
  private tokens: Record<string, Tokens> = {}
  private tokenPending = new Set<string>()
  private restoreSeen = false
  private restoring = false
  private resumer: ((e: RestoreEntry) => Promise<CliResult>) | null = null
  /** Boards by sprint key (@current, a sprint title, or none), and which one is on screen. */
  private boards: Record<string, Board> = {}
  private rawBoards: Record<string, unknown> = {}
  private selectedSprint = '@current'
  private sprints: Sprint[] = []
  /** Burndown points per sprint title, one per day. */
  private boardHistory: Record<string, BurnPoint[]> = {}
  private users: string[] = []
  private me: string | null = null
  private boardError: string | null = null
  /** Raw GitHub data as last fetched (or loaded from the cache), for writing the cache. */
  private rawSnapshot: Record<string, unknown> | null = null
  private githubRefreshedAt: number | null = null
  private githubRefreshing = false
  private boardRunning = false
  private health: Record<string, SourceHealth> = { agents: 'pending', ledger: 'pending', snapshot: 'pending' }
  private errors: Record<string, string> = {}
  private missing = new Set<string>()
  private timers: NodeJS.Timeout[] = []
  private emitTimer: NodeJS.Timeout | null = null
  private focused: string | null = null
  private visible = new Set<string>()
  private transcripts: TranscriptIndex
  private snapshotRunning = false
  private detailRunning = false
  statuslineInstalled = false

  constructor(
    private paths: Paths,
    private run: Runner,
    private cli: MasterCli,
    private onState: (s: AppState) => void,
    private claude: () => string = () => 'claude',
    private github: GitHub = new GitHub(run),
    private gh: GhRunner = (args, opts) => run('gh', args, opts),
    private readGhCache: () => GhCacheStatus | null = () => null,
  ) {
    this.transcripts = new TranscriptIndex(paths.projectsDir)
    this.tokenIndex = new TokenIndex(this.transcripts, join(paths.home, 'tokens.json'))
  }

  /** Tokens per day for these sessions (the Costs view): the first call reads their history. */
  tokensByDay(sessionIds: string[]): Promise<Record<string, TokensByDay>> {
    return this.tokenIndex.refresh(sessionIds.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))
  }

  /** How to resume a stopped background session (`claude --bg --resume`). */
  setResumer(fn: (e: RestoreEntry) => Promise<CliResult>): void {
    this.resumer = fn
  }

  private get restorePath(): string {
    return join(this.paths.home, 'running-sessions.json')
  }

  /**
   * After each `claude agents` scan: record what runs now and, on a new boot, what the restart
   * stopped. With afterRestart = resume, the first scan after a restart resumes them.
   */
  private observeRestore(): void {
    if (!this.restoreSeen) {
      try {
        this.restore = parseRestoreFile(JSON.parse(readFileSync(this.restorePath, 'utf8')))
      } catch {
        this.restore = null
      }
    }
    const first = !this.restoreSeen
    this.restoreSeen = true
    const next = nextRestore(this.restore, Date.now() - uptime() * 1000, this.withIssues(this.rawSessions), getConfig().masterName, Date.now())
    if (this.settings.afterRestart === 'off') next.stopped = []
    const changed = JSON.stringify([next.running, next.stopped]) !== JSON.stringify([this.restore?.running, this.restore?.stopped]) || !this.restore || next.bootAt !== this.restore.bootAt
    this.restore = next
    if (changed) {
      try {
        mkdirSync(this.paths.home, { recursive: true })
        writeFileSync(`${this.restorePath}.tmp`, JSON.stringify(next, null, 2))
        renameSync(`${this.restorePath}.tmp`, this.restorePath)
      } catch {
        // best effort: the next scan tries again
      }
    }
    if (first && next.stopped.length && this.settings.afterRestart === 'resume') void this.resumeStopped()
  }

  /** Resume every session the restart stopped, one at a time; the ones that fail stay listed. */
  async resumeStopped(): Promise<CliResult> {
    if (this.restoring) return { ok: true, message: 'already resuming' }
    if (!this.resumer || !this.restore?.stopped.length) return { ok: true, message: 'nothing to resume' }
    this.restoring = true
    this.emit()
    const failed: string[] = []
    let resumed = 0
    try {
      for (const e of [...this.restore.stopped]) {
        // Resumed meanwhile (master's ORPHAN, or by hand): resuming again would start a copy.
        const live = this.rawSessions.some((s) => s.pid !== null && s.state !== 'done' && s.sessionId === e.sessionId)
        const r = live ? { ok: true, message: 'already running' } : await this.resumer(e)
        if (r.ok) {
          resumed++
          // Off the list now; the next scan also drops it once its process shows up.
          if (this.restore) this.restore.stopped = this.restore.stopped.filter((x) => x.sessionId !== e.sessionId)
        } else failed.push(`${e.name}: ${r.message}`)
      }
    } finally {
      this.restoring = false
      void this.pollAgents()
    }
    const msg = `Resumed ${resumed} session${resumed === 1 ? '' : 's'}${failed.length ? `; not resumed: ${failed.join('; ')}` : ''}`
    return { ok: failed.length === 0, message: msg }
  }

  /** Forget the sessions the restart stopped (they stay resumable from History). */
  dismissStopped(): void {
    if (!this.restore) return
    this.restore.stopped = []
    try {
      writeFileSync(this.restorePath, JSON.stringify(this.restore, null, 2))
    } catch {
      // the list shows again next launch at worst
    }
    this.emit()
  }

  private withIssues(sessions: Session[]): Session[] {
    const issueOf = new Map([...this.snapshot.sessionIssue, ...[...this.links].map(([k, v]) => [k, v.issue] as [string, number])])
    return attachIssues(sessions, issueOf)
  }

  /** How to link a session to an issue (babysit-ticket); used to carry links across a resume. */
  setLinker(fn: (issue: number, sessionId: string, cwd: string | null) => Promise<CliResult>): void {
    this.linker = fn
  }

  private get historyPath(): string {
    return join(this.paths.home, 'session-history.json')
  }

  private loadHistory(): void {
    try {
      const raw = JSON.parse(readFileSync(this.historyPath, 'utf8'))
      if (raw && typeof raw === 'object') this.history = raw as SessionHistory
    } catch {
      // first run, or unreadable: start fresh
    }
  }

  private saveHistory(): void {
    try {
      mkdirSync(this.paths.home, { recursive: true })
      const tmp = `${this.historyPath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.history, null, 1))
      renameSync(tmp, this.historyPath)
    } catch {
      // best effort; the next change tries again
    }
  }

  /** Re-link resumed background sessions to the ticket their earlier session id had. */
  private carryLinks(): void {
    if (recordHistory(this.history, this.rawSessions, this.links.keys())) this.saveHistory()
    if (!this.linker) return
    const now = Date.now()
    for (const c of linksToCarry(this.history, this.rawSessions, this.links)) {
      const key = `${c.sessionId}:${c.issue}`
      if (now - (this.carryTried[key] ?? 0) < 600_000) continue
      this.carryTried[key] = now
      void this.linker(c.issue, c.sessionId, c.cwd || null).then((r) => {
        if (r.ok) delete this.errors[`carry:${c.bgId}`]
        else this.errors[`carry:${c.bgId}`] = `could not keep #${c.issue} linked after a resume: ${r.message}`
        this.reloadLinks()
      })
    }
  }

  private get cachePath(): string {
    return join(this.paths.home, 'cache.json')
  }

  private get settingsPath(): string {
    return join(this.paths.home, 'settings.json')
  }

  private get costsPath(): string {
    return join(this.paths.home, 'costs.json')
  }

  getSettings(): Settings {
    return this.settings
  }

  setSettings(raw: unknown): Settings {
    this.settings = normalizeSettings(raw)
    writeJsonAtomic(this.settingsPath, this.settings)
    this.emit()
    return this.settings
  }

  /**
   * Every session's status line file, not just open tabs: cost history, context warnings and
   * ticket budgets need them all.
   */
  private scanAllStats(): void {
    // Start times come from `claude agents`; without them every session would count as a baseline.
    if (!this.isHealthy('agents')) return
    let files: string[] = []
    try {
      files = readdirSync(this.paths.statsDir).filter((f) => f.endsWith('.json'))
    } catch {
      return
    }
    const now = Date.now()
    const next: AppState['allStats'] = {}
    const entries: CostEntry[] = []
    const bySession = new Map(this.rawSessions.map((s) => [s.sessionId, s]))
    const issueOf = new Map([...this.snapshot.sessionIssue, ...[...this.links].map(([k, v]) => [k, v.issue] as [string, number])])
    for (const f of files) {
      const id = f.slice(0, -5)
      const t = readTail(join(this.paths.statsDir, f), 256 * 1024)
      if (!t || now - t.mtimeMs > 30 * 86_400_000) continue
      const st = parseStatusline(t.text, t.mtimeMs)
      if (!st) continue
      next[id] = { costUsd: st.costUsd, contextPct: st.contextPct, updatedAt: st.updatedAt }
      const s = bySession.get(id)
      if (st.costUsd !== null && now - t.mtimeMs < 36 * 3_600_000)
        entries.push({ sessionId: id, name: s?.name ?? this.costBook[id]?.name ?? id.slice(0, 8), key: s?.key ?? this.costBook[id]?.key ?? id, issue: issueOf.get(id) ?? this.costBook[id]?.issue ?? null, cost: st.costUsd, startedAt: s?.startedAt ?? null })
    }
    this.allStats = next
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    if (recordCosts(this.costBook, entries, dayOf(now), midnight.getTime())) this.costDirty = true
    if (this.costDirty) {
      pruneBook(this.costBook, dayOf(now))
      writeJsonAtomic(this.costsPath, this.costBook)
      this.costDirty = false
    }
    this.emit()
  }

  /** Read the shared config file (fast, no Python) and apply it. */
  loadConfig(): AppConfig {
    let raw: unknown = {}
    try {
      raw = JSON.parse(readFileSync(this.paths.config, 'utf8'))
    } catch {
      // missing or broken: defaults, not configured
    }
    const cfg = { ...parseConfig(raw), path: this.paths.config }
    const was = this.config.configured
    this.config = cfg
    setConfig(cfg)
    if (!process.env.MASTER_WORKSPACE && cfg.workspace) this.paths.masterWorkspace = cfg.workspace
    this.emit()
    // Just set up: fetch GitHub now rather than waiting for the hourly refresh.
    if (cfg.configured && !was && this.started) void this.refreshGithub()
    return cfg
  }

  setSkills(skills: SkillStatus[]): void {
    this.skills = skills
    this.emit()
  }

  setHooks(h: HookStatus): void {
    this.hooks = h
    this.emit()
  }

  private started = false

  start(): void {
    this.loadConfig()
    watchFile(this.paths.config, { interval: 2000 }, () => this.loadConfig())
    this.started = true
    try {
      this.settings = normalizeSettings(JSON.parse(readFileSync(this.settingsPath, 'utf8')))
    } catch {
      this.settings = DEFAULT_SETTINGS
    }
    try {
      const raw = JSON.parse(readFileSync(this.costsPath, 'utf8'))
      this.costBook = validBook(raw)
    } catch {
      // no history yet
    }
    this.loadHistory()
    // Last run's tickets first, so the sidebar and board fill at once; GitHub updates them next.
    const cache = loadCache(this.cachePath)
    if (cache.snapshot && typeof cache.snapshot === 'object') {
      this.rawSnapshot = cache.snapshot as Record<string, unknown>
      this.snapshot = parseSnapshot(cache.snapshot)
    }
    const rawBoards: Record<string, unknown> = { ...(cache.boards ?? {}) }
    if (!rawBoards['@current'] && cache.board) rawBoards['@current'] = cache.board // cache from before sprints
    for (const [k, raw] of Object.entries(rawBoards)) {
      const b = parseBoard(raw)
      if (b) {
        this.boards[k] = b
        this.rawBoards[k] = raw
      }
    }
    if (Array.isArray(cache.sprints)) this.sprints = cache.sprints as Sprint[]
    if (cache.boardHistory && typeof cache.boardHistory === 'object')
      for (const [k, v] of Object.entries(cache.boardHistory))
        if (Array.isArray(v)) this.boardHistory[k] = v.filter((p): p is BurnPoint => !!p && typeof p.date === 'string' && typeof p.total === 'number' && typeof p.done === 'number')
    if (Array.isArray(cache.users)) this.users = cache.users.filter((u): u is string => typeof u === 'string')
    if (typeof cache.me === 'string') this.me = cache.me
    if (typeof cache.selectedSprint === 'string') this.selectedSprint = cache.selectedSprint
    if (typeof cache.refreshedAt === 'number') this.githubRefreshedAt = cache.refreshedAt
    if (Array.isArray(cache.teamPrPages)) {
      this.teamPrPages = cache.teamPrPages
      this.teamPrs = parseTeamPrs(cache.teamPrPages)
      if (typeof cache.teamPrsAt === 'number') this.teamPrsAt = cache.teamPrsAt
    }
    this.readLedger()
    watchFile(this.paths.ledger, { interval: 1000 }, () => this.readLedger())
    void this.pollAgents()
    void this.refreshGithub()
    this.timers.push(setInterval(() => void this.pollAgents(), AGENTS_MS))
    this.timers.push(setInterval(() => void this.pollDetails(), DETAIL_MS))
    this.timers.push(setInterval(() => void this.refreshGithub(), GITHUB_MS))
    this.timers.push(setInterval(() => this.readLedger(), 5_000))
    setTimeout(() => this.scanAllStats(), 2_000)
    this.timers.push(setInterval(() => this.scanAllStats(), 30_000))
  }

  /** Board View opened: fetch only when there is nothing to show yet (the hourly refresh covers it). */
  setBoardOpen(open: boolean): void {
    if (open && !this.boards[this.selectedSprint] && !this.githubRefreshing) void this.refreshBoard()
  }

  /** After a drag: move the card at once; the next refresh confirms it. */
  noteStatus(issue: number, status: string): void {
    for (const b of Object.values(this.boards)) for (const c of b.cards) if (c.number === issue) c.status = status
    this.emit()
  }

  /** After an assign: update the card at once; the next refresh confirms it. */
  noteAssigned(issue: number, login: string): void {
    for (const b of Object.values(this.boards)) for (const c of b.cards) if (c.number === issue) c.assignees = [login]
    this.emit()
  }

  /** Show another sprint: from the cache at once, fetched when never seen before. */
  setSprint(sprint: string): void {
    if (!sprint || sprint === this.selectedSprint) return
    this.selectedSprint = sprint
    this.boardError = null
    this.saveGithubCache()
    this.emit()
    if (!this.boards[sprint]) void this.refreshBoard()
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
    })
  }

  /** Sprints, assignable users and my login: small calls, refreshed with everything else. */
  private async refreshPeople(force = false): Promise<{ ok: boolean; message: string }> {
    const [sp, users, me] = await Promise.all([this.cli.sprints(force), this.github.assignableUsers(force), this.me ? Promise.resolve(this.me) : this.github.me()])
    if (sp.ok) this.sprints = sp.sprints
    if (users) this.users = users
    if (me) this.me = me
    return sp.ok ? { ok: true, message: 'ok' } : { ok: false, message: sp.message }
  }

  /** Issues/PRs (snapshot) and the sprint board together; then the cache is saved. `force` (the Refresh button) skips the shared gh cache. */
  async refreshGithub(force = false): Promise<{ ok: boolean; message: string }> {
    if (this.githubRefreshing) return { ok: true, message: 'already refreshing' }
    this.githubRefreshing = true
    this.emit()
    try {
      // Each part reports its own failure; one throwing must not lose the other's result.
      const settle = (p: Promise<{ ok: boolean; message: string }>) => p.catch((e: unknown) => ({ ok: false, message: String(e) }))
      // Before Setup there is no org or board to ask GitHub about; sessions still come from the snapshot.
      const gh = this.config.configured
      const skip = Promise.resolve({ ok: true, message: 'not set up' })
      const [s, b] = await Promise.all([
        settle(this.refreshSnapshot(force)),
        settle(gh && this.config.project ? this.refreshBoard(force) : skip),
        settle(gh ? this.refreshPeople(force) : skip),
        settle(gh ? this.refreshTeamPrs(0, force) : skip),
      ])
      if (s.ok || b.ok) this.githubRefreshedAt = Date.now()
      this.saveGithubCache()
      const failed = [s, b].filter((r) => !r.ok).map((r) => r.message)
      return failed.length ? { ok: false, message: failed.join('; ') } : { ok: true, message: 'refreshed' }
    } finally {
      this.githubRefreshing = false
      this.emit()
    }
  }

  /** Every PR in the org (the PRs view). `maxAgeMs` skips the call when the list is that fresh. */
  async refreshTeamPrs(maxAgeMs = 0, force = false): Promise<{ ok: boolean; message: string }> {
    if (this.teamPrsLoading) return { ok: true, message: 'already refreshing' }
    if (maxAgeMs && this.teamPrsAt && Date.now() - this.teamPrsAt < maxAgeMs) return { ok: true, message: 'fresh' }
    if (this.githubPaused()) {
      this.teamPrsError = this.errors.github ?? 'GitHub calls paused'
      this.emit()
      return { ok: false, message: this.teamPrsError }
    }
    this.teamPrsLoading = true
    this.emit()
    try {
      const r = await this.github.teamPrPages(undefined, undefined, force)
      if (r.ok) {
        this.teamPrPages = r.pages
        this.teamPrs = parseTeamPrs(r.pages)
        this.teamPrsAt = Date.now()
        this.teamPrsError = r.partial ?? null
        this.saveGithubCache()
        return { ok: true, message: 'refreshed' }
      }
      // Keep the last good list on screen; say why it didn't update.
      this.githubPaused(r.message)
      this.teamPrsError = r.message
      return { ok: false, message: r.message }
    } catch (e) {
      this.teamPrsError = String(e)
      return { ok: false, message: this.teamPrsError }
    } finally {
      this.teamPrsLoading = false
      this.emit()
    }
  }

  async refreshBoard(force = false): Promise<{ ok: boolean; message: string }> {
    if (this.boardRunning) return { ok: true, message: 'already refreshing' }
    const sprint = this.selectedSprint
    if (!process.env.MASTERDECK_BOARD_FIXTURE && this.githubPaused()) {
      this.boardError = this.errors.github ?? 'GitHub calls paused'
      this.emit()
      return { ok: false, message: this.boardError }
    }
    this.boardRunning = true
    this.emit()
    try {
      // Test aid: MASTERDECK_BOARD_FIXTURE=<json> replaces the GitHub call.
      const fx = process.env.MASTERDECK_BOARD_FIXTURE
      let r: { ok: true; data: unknown } | { ok: false; message: string }
      try {
        r = fx ? { ok: true, data: JSON.parse(readFileSync(fx, 'utf8')) } : await this.cli.board(sprint, force)
      } catch (e) {
        r = { ok: false, message: String(e) }
      }
      const b = r.ok ? parseBoard(r.data) : null
      if (b) {
        this.boards[sprint] = b
        if (r.ok) this.rawBoards[sprint] = r.data
        this.boardError = null
        if (b.sprint) this.boardHistory[b.sprint] = addBurnPoint(this.boardHistory[b.sprint] ?? [], { date: dayOf(Date.now()), total: b.cards.length, done: summarize(b).counts.done })
        this.saveGithubCache()
      } else {
        // Keep the last good board on screen; say why it didn't update.
        const msg = r.ok ? 'board printed an unexpected shape' : r.message
        this.githubPaused(msg)
        this.boardError = msg
      }
      return { ok: !!b, message: this.boardError ?? 'refreshed' }
    } finally {
      this.boardRunning = false
      this.emit()
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.tokenIndex.save()
    unwatchFile(this.paths.ledger)
  }

  setFocus(sessionId: string | null): void {
    this.focused = sessionId
    if (sessionId) this.prFetchedAt[sessionId] = 0
    void this.pollDetails()
  }

  setVisible(ids: string[]): void {
    this.visible = new Set(ids)
    void this.pollDetails()
  }

  private setHealth(name: string, ok: boolean, error?: string): void {
    this.health[name] = ok ? 'ok' : 'error'
    if (ok) delete this.errors[name]
    else this.errors[name] = error ?? `${name} failed`
  }

  private noteBinary(name: string, code: number): void {
    if (code === -1) this.missing.add(name)
    else this.missing.delete(name)
  }

  private async pollAgents(): Promise<void> {
    const r = await this.run(this.claude(), ['agents', '--json'], { timeoutMs: 15_000 })
    this.noteBinary('claude', r.code)
    if (r.code !== 0) {
      this.setHealth('agents', false, `claude agents: ${(r.stderr || r.stdout).trim().slice(0, 200)}`)
      this.emit()
      return
    }
    try {
      this.rawSessions = normalizeAgents(JSON.parse(r.stdout))
      this.setHealth('agents', true)
      this.observeRestore()
    } catch {
      this.setHealth('agents', false, 'claude agents printed invalid JSON')
    }
    this.reloadLinks()
    this.carryLinks()
    const now = Date.now()
    for (const s of this.rawSessions) {
      const p = this.transcripts.find(s.sessionId, now)
      const m = p ? mtime(p) : null
      if (m !== null) this.lastWrite[s.sessionId] = m
    }
    this.emit()
  }

  /** Re-read babysit-ticket's state file. Called every agents poll and right after a link. */
  reloadLinks(): void {
    try {
      const raw = JSON.parse(readFileSync(this.paths.babysitState, 'utf8')) as {
        sessions?: Record<string, { issue?: unknown; linked_at?: unknown }>
      }
      const next = new Map<string, LinkInfo>()
      for (const [sid, v] of Object.entries(raw.sessions ?? {})) {
        if (typeof v?.issue !== 'number') continue
        const at = typeof v.linked_at === 'string' ? Date.parse(v.linked_at) : NaN
        next.set(sid, { issue: v.issue, linkedAt: Number.isFinite(at) ? at : null })
      }
      this.links = next
    } catch {
      // missing or mid-write: keep the last good links
    }
    this.emit()
  }

  private readLedger(): void {
    let text: string
    try {
      text = readFileSync(this.paths.ledger, 'utf8')
    } catch {
      this.setHealth('ledger', false, `no ledger at ${this.paths.ledger}`)
      this.emit()
      return
    }
    try {
      const led = parseLedger(JSON.parse(text))
      this.proposals = led.proposals
      // Master's last sweep fills what we lack: at startup, or when our own (cached or live) data
      // has no issues or PRs because GitHub failed. A working list is never replaced.
      const ls = led.lastSnapshot as Record<string, unknown> | null
      if (ls && typeof ls === 'object') {
        const mine = this.rawSnapshot ?? {}
        const lacks = (k: 'issues' | 'prs') => !Array.isArray(mine[k]) || (mine[k] as unknown[]).length === 0
        const has = (k: 'issues' | 'prs') => Array.isArray(ls[k]) && (ls[k] as unknown[]).length > 0
        if (this.snapshot === EMPTY_SNAPSHOT || (lacks('issues') && has('issues')) || (lacks('prs') && has('prs'))) {
          const merged: Record<string, unknown> = { ...ls, ...mine }
          if (lacks('issues') && has('issues')) merged.issues = ls.issues
          if (lacks('prs') && has('prs')) merged.prs = ls.prs
          this.rawSnapshot = merged
          this.snapshot = parseSnapshot(merged)
        }
      }
      this.setHealth('ledger', true)
    } catch {
      // Mid-write or corrupt: keep the last good proposals.
    }
    this.emit()
  }

  /** Pause every GitHub call for a while when gh reports the rate limit. True when paused. */
  private githubPaused(output?: string): boolean {
    const now = Date.now()
    if (output && RATE_LIMITED.test(output)) this.ghPausedUntil = now + RATE_LIMIT_PAUSE_MS
    // The shared pause (ghc): a rate limit hit by master's sweep or a babysit loop stops us too.
    this.ghCache = this.readGhCache()
    const until = Math.max(this.ghPausedUntil, this.ghCache?.pausedUntil ?? 0)
    if (now >= until) {
      delete this.errors.github
      return false
    }
    const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    this.errors.github = `GitHub API rate limit reached; PR and issue refresh paused until ${at}`
    return true
  }

  async refreshSnapshot(force = false): Promise<{ ok: boolean; message: string }> {
    if (this.snapshotRunning) return { ok: true, message: 'already refreshing' }
    if (this.githubPaused()) return { ok: false, message: this.errors.github ?? 'GitHub calls paused' }
    this.snapshotRunning = true
    try {
      const r = await this.cli.snapshot(force)
      if (r.ok) {
        // A source that failed (board, prs) comes back empty: keep the last good list instead.
        const raw = { ...(r.data as Record<string, unknown>) }
        const ok = (raw.sources ?? {}) as Record<string, boolean>
        if (!ok.board && this.rawSnapshot?.issues) raw.issues = this.rawSnapshot.issues
        if (!ok.prs && this.rawSnapshot?.prs) raw.prs = this.rawSnapshot.prs
        this.rawSnapshot = raw
        this.snapshot = parseSnapshot(raw)
        this.setHealth('snapshot', true)
        // A snapshot can succeed with some sources failed; a rate-limit failure still pauses GitHub calls.
        const errs = (r.data as { errors?: { message?: string }[] })?.errors ?? []
        for (const e of errs) this.githubPaused(e?.message)
        for (const [k, v] of Object.entries(this.snapshot.sources)) {
          if (!v) this.errors[`snapshot:${k}`] = `snapshot source missing: ${k}`
          else delete this.errors[`snapshot:${k}`]
        }
        this.emit()
        return { ok: true, message: 'refreshed' }
      }
      this.githubPaused(r.message)
      this.setHealth('snapshot', false, `master snapshot: ${r.message}`)
      if (/No module named|not found|ENOENT/.test(r.message)) this.missing.add('python3')
      this.emit()
      return { ok: false, message: r.message }
    } finally {
      this.snapshotRunning = false
    }
  }

  /** Stats, transcript tail, git and gh for the sessions on screen (open tabs + master). */
  private async pollDetails(): Promise<void> {
    if (this.detailRunning) return
    this.detailRunning = true
    try {
      const ids = new Set(this.visible)
      if (this.focused) ids.add(this.focused)
      const now = Date.now()
      for (const id of ids) {
        const s = this.rawSessions.find((x) => x.sessionId === id)
        const statsPath = join(this.paths.statsDir, `${id}.json`)
        const st = readTail(statsPath, 256 * 1024)
        const parsed = st ? parseStatusline(st.text, st.mtimeMs) : null
        if (parsed) this.stats[id] = parsed
        const tp = this.transcripts.find(id, now)
        const tail = tp ? readTail(tp) : null
        if (tail) {
          this.tails[id] = parseTranscriptTail(tail.text, tail.fromStart)
          this.lastWrite[id] = tail.mtimeMs
          if (!this.stats[id] || this.stats[id].source === 'transcript') this.stats[id] = statsFromTranscript(this.tails[id], now)
        }
        // Not awaited: a first read of a long history (or the Costs view's) must not hold up the details.
        if (!this.tokenPending.has(id)) {
          this.tokenPending.add(id)
          void this.tokenIndex
            .refresh([id])
            .then((r) => {
              if (!r[id]) return
              this.tokens[id] = totalOf(r[id])
              this.emit()
            })
            .finally(() => this.tokenPending.delete(id))
        }
        const key = s?.key ?? id
        const created = tp ? this.followPrs(tp, key) : false
        const dir = this.stats[id]?.currentDir ?? this.tails[id]?.cwd ?? s?.cwd
        if (dir) await this.pollGit(id, dir)
        // A PR the session just created is fetched at once; otherwise the focused tab every
        // minute and other open tabs every five.
        const every = id === this.focused ? GH_MS : GH_BACKGROUND_MS
        if ((created || now - (this.prFetchedAt[id] ?? 0) > every) && !this.githubPaused()) {
          this.prFetchedAt[id] = now
          await this.pollPr(id, this.prUrlsFor(id, key).at(-1) ?? null, dir)
        }
      }
      this.emit()
    } finally {
      this.detailRunning = false
    }
  }

  private async pollGit(id: string, dir: string): Promise<void> {
    // A missing cwd also makes spawn fail with ENOENT, which would look like "git not installed".
    if (!existsSync(dir)) {
      delete this.git[id]
      return
    }
    const st = await this.run('git', ['status', '--porcelain=v2', '--branch'], { cwd: dir, timeoutMs: 10_000 })
    this.noteBinary('git', st.code)
    if (st.code !== 0) {
      delete this.git[id]
      return
    }
    const b = parseBranchStatus(st.stdout)
    const base = await this.run('git', ['merge-base', 'HEAD', 'origin/HEAD'], { cwd: dir, timeoutMs: 10_000 })
    const against = base.code === 0 && base.stdout.trim() ? base.stdout.trim() : 'HEAD'
    const diff = await this.run('git', ['diff', '--numstat', against], { cwd: dir, timeoutMs: 10_000 })
    const d = diff.code === 0 ? parseNumstat(diff.stdout) : { added: 0, removed: 0, files: 0 }
    this.git[id] = { dir, ...b, ...d }
  }

  /** Read what the transcript gained since last time; true when it shows a newly created PR. */
  private followPrs(path: string, key: string): boolean {
    const f = (this.follows[path] ??= { st: { path, offset: 0, rest: '' }, scan: newPrScanState() })
    const found = scanLines(readNewLines(f.st), f.scan)
    // Keep the most recently linked PR last; a resumed session adds a second transcript to the key.
    const list = (this.createdPrs[key] ??= [])
    for (const u of f.scan.urls) {
      const i = list.indexOf(u)
      if (i >= 0) list.splice(i, 1)
      list.push(u)
    }
    return found
  }

  private prUrlsFor(sessionId: string, key: string): string[] {
    const out = [...(this.snapshot.sessionPrs.get(sessionId) ?? [])]
    for (const u of this.createdPrs[key] ?? []) {
      const i = out.indexOf(u)
      if (i >= 0) out.splice(i, 1)
      out.push(u)
    }
    return out
  }

  /** The session's latest known PR by URL; with none known, whatever PR its current branch has. */
  private async pollPr(id: string, url: string | null, dir: string | undefined): Promise<void> {
    const fields = 'number,title,url,state,reviewDecision,statusCheckRollup'
    if (url) {
      const r = await this.gh(['pr', 'view', url, '--json', fields], { timeoutMs: 20_000, ttl: 45 })
      this.noteBinary('gh', r.code)
      this.githubPaused(r.stderr + r.stdout)
      // Keep the last good value through a network blip.
      if (r.code === 0) this.prLive[id] = parsePrView(r.stdout)
      return
    }
    // master's workspace is shared by every session; its branch's PR belongs to none of them.
    if (!dir || !existsSync(dir) || resolve(dir) === resolve(this.paths.masterWorkspace)) {
      this.prLive[id] = null
      return
    }
    const r = await this.gh(['pr', 'view', '--json', fields], { cwd: dir, timeoutMs: 20_000, ttl: 45 })
    this.noteBinary('gh', r.code)
    if (this.githubPaused(r.stderr + r.stdout)) return
    this.prLive[id] = r.code === 0 ? parsePrView(r.stdout) : null
  }

  private emit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.onState(this.build())
    }, 250)
  }

  build(): AppState {
    const now = Date.now()
    const issueOf = new Map([...this.snapshot.sessionIssue, ...[...this.links].map(([k, v]) => [k, v.issue] as [string, number])])
    const sessions = applyFreshness(attachIssues(this.rawSessions, issueOf), this.lastWrite, now)
    return {
      sessions,
      issues: this.snapshot.issues,
      prs: this.snapshot.prs,
      proposals: this.proposals,
      master: deriveMaster(sessions),
      needsYou: deriveNeedsYou(this.proposals, sessions),
      stats: { ...this.stats },
      tails: { ...this.tails },
      git: { ...this.git },
      prLive: { ...this.prLive },
      sessionPrs: Object.fromEntries(sessions.map((x) => [x.sessionId, this.prUrlsFor(x.sessionId, x.key)]).filter(([, v]) => v.length)),
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
    }
  }

  isHealthy(name: string): boolean {
    return this.health[name] === 'ok'
  }
}

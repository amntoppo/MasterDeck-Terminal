import type { Ticket } from "./ticket";
import type {
  BoardCreateResult,
  BoardPlanResult,
  BoardProgress,
} from "./boardCreate";
import type { MenuAnswer } from "./ask";
import type { PrSummary } from "./prSummary";
import type { Settings } from "./settings";
import type { HistoryHit, TranscriptWindow } from "./history";
import type { StandupCommit } from "./standup";
import type { WorktreeClass, WorktreeInfo } from "./janitor";
import type { TokensByDay } from "./tokens";
import type { SessionActivity } from "./hours";
import type { GhAccount } from "./ghAuth";
import type { Note, NoteChange, NoteInput, NoteMeta, SaveResult } from "./notes";
import type { HookEntry } from "./workflow";
import type {
  CustomTrigger,
  Flow,
  WorkflowDoc,
  WorkflowTemplate,
  MonitorDef,
} from "./flow";
import type { FlowProgress } from "./flowTrack";
import type { DraftCheck, DraftMonitor, DraftSkill } from "./flowBuilder";

/** A workflow the builder session wrote, as MasterDeck read and checked it. */
/** A ticket to create from the Board. */
export interface NewTicket {
  repo: string;
  title: string;
  body: string;
  /** The board (owner/number) and the status (column) it goes in. */
  project: string;
  status: string;
  assignees: string[];
  labels: string[];
  milestone: string;
  /** A sprint title, "@current", or "" for none; `sprintField` is the board's iteration field. */
  sprint: string;
  sprintField: string;
  /** The GitHub account it is created as (two or more accounts). */
  account?: string;
}

export interface WorkflowDraft {
  name: string | null;
  flow: Flow;
  /** New triggers and skills the builder made for it (installed only when it is applied). */
  triggers: CustomTrigger[];
  skills: DraftSkill[];
  monitors: DraftMonitor[];
  check: DraftCheck;
  at: number;
}

export interface WorkflowStatus extends FlowProgress {
  /** The template its copy came from; null: it follows the Default. */
  from: string | null;
}
import type { SessionSummary } from "./summary";

export type SetupTool = "claude" | "gh" | "python" | "git" | "jq";

/** A change to a session's queue; remove and move name the item by index and text. */
export type QueueEdit =
  | { op: "add"; text: string }
  | { op: "remove"; index: number; text: string }
  | { op: "move"; index: number; text: string; to: number }
  | { op: "clear" };

export interface JanitorRow extends WorktreeInfo {
  cls: WorktreeClass;
  reason: string;
}

export interface Template {
  name: string;
  text: string;
  builtin?: boolean;
}
import type {
  AppState,
  CliResult,
  DraftAssign,
  PaneSpec,
  SetupCheck,
} from "./types";

export const CH = {
  state: "state:update",
  focusSession: "app:focusSession",
  showNeedsYou: "app:showNeedsYou",
  showInboxItem: "app:showInboxItem",
  getState: "state:get",
  watchStop: "watch:stop",
  accountSignIn: "account:signIn",
  accountCancel: "account:cancel",
  accountReopen: "account:reopen",
  accountUseCode: "account:useCode",
  accountProviders: "account:providers",
  accountEmail: "account:email",
  accountSignOut: "account:signOut",
  accountManage: "account:manage",
  browserDecide: "browser:decide",
  browserRevoke: "browser:revoke",
  approve: "cli:approve",
  reject: "cli:reject",
  draftAssign: "cli:draftAssign",
  assign: "cli:assign",
  refresh: "cli:refresh",
  setFocus: "app:setFocus",
  setVisible: "app:setVisible",
  openExternal: "app:openExternal",
  openEditor: "app:openEditor",
  copy: "app:copy",
  stopSession: "session:stop",
  stopOtherSession: "session:stopOther",
  stopSessions: "session:stopMany",
  setManualStatus: "session:setManualStatus",
  statuslineInstall: "statusline:install",
  statuslineUninstall: "statusline:uninstall",
  masterStart: "master:start",
  ptyOpen: "pty:open",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyClose: "pty:close",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  confirm: "app:confirm",
  boardRefresh: "board:refresh",
  teamPrsRefresh: "prs:refresh",
  setupCheck: "setup:check",
  setupTool: "setup:tool",
  ghAccounts: "setup:ghAccounts",
  ghUser: "setup:ghUser",
  ghOwners: "setup:ghOwners",
  configDetect: "config:detect",
  configDetectAll: "config:detectAll",
  configSave: "config:save",
  pickFolder: "app:pickFolder",
  worktreeInfo: "start:worktreeInfo",
  worktreeCreate: "start:worktreeCreate",
  skillReinstall: "skills:reinstall",
  skillRemove: "skills:remove",
  workflowGet: "workflow:get",
  summaryGet: "summary:get",
  summaryMake: "summary:make",
  summaryPost: "summary:post",
  workflowSave: "workflow:save",
  workflowTemplateSave: "workflow:templateSave",
  workflowTemplateDelete: "workflow:templateDelete",
  sessionWorkflowGet: "workflow:sessionGet",
  workflowStatus: "workflow:status",
  workflowBuilderPrepare: "workflow:builderPrepare",
  workflowDraft: "workflow:draft",
  workflowDraftGet: "workflow:draftGet",
  workflowDraftDiscard: "workflow:draftDiscard",
  workflowDraftApply: "workflow:draftApply",
  workflowTriggerDelete: "workflow:triggerDelete",
  sessionWorkflowSave: "workflow:sessionSave",
  linkSession: "session:link",
  peersSet: "peers:set",
  peersSync: "peers:sync",
  setSprint: "board:sprint",
  prSummary: "pr:summary",
  issueBody: "issue:body",
  shellPrepare: "shell:prepare",
  ticketMemory: "ticket:memory",
  assignIssue: "issue:assign",
  assignableUsers: "issue:assignable",
  defaultModel: "models:default",
  startHere: "session:startHere",
  sendText: "session:sendText",
  answerMenu: "session:answerMenu",
  inboxAct: "inbox:act",
  queueList: "queue:list",
  queueEdit: "queue:edit",
  queueSendNext: "queue:sendNext",
  getSettings: "settings:get",
  setSettings: "settings:set",
  ghLogin: "accounts:login",
  trust: "claude:trust",
  openClaudeIn: "claude:openIn",
  openClaude: "claude:open",
  autoOpen: "app:autoOpen",
  setStatus: "board:setStatus",
  standupCommits: "standup:commits",
  janitor: "janitor:list",
  removeWorktree: "janitor:removeWorktree",
  removeSession: "janitor:removeSession",
  searchHistory: "history:search",
  historyTranscript: "history:transcript",
  templates: "templates:list",
  saveTemplate: "templates:save",
  deleteTemplate: "templates:delete",
  notesList: "notes:list",
  notesGet: "notes:get",
  notesSearch: "notes:search",
  notesSave: "notes:save",
  notesDelete: "notes:delete",
  notesChanged: "notes:changed",
  resumeSession: "session:resume",
  workspaceRepos: "app:workspaceRepos",
  ticketCreate: "ticket:create",
  ticketBuilderPrepare: "ticket:builderPrepare",
  ticketsCreated: "ticket:created",
  ticketRepoMeta: "ticket:repoMeta",
  startClaude: "session:startClaude",
  accountFor: "accounts:for",
  resumeStopped: "session:resumeStopped",
  tokensByDay: "costs:tokensByDay",
  hoursActivity: "costs:hoursActivity",
  hoursExport: "costs:hoursExport",
  dismissStopped: "session:dismissStopped",
  boardOpen: "board:open",
  boardRepos: "board:repos",
  boardCreatePlan: "board:createPlan",
  boardCreate: "board:create",
  boardCreateRetry: "board:createRetry",
  boardCreateProgress: "board:createProgress",
} as const;

export interface AssignRequest {
  issue: number;
  /** The issue's repo (owner/name); null or missing: the primary issue repo. */
  repo?: string | null;
  name: string;
  cwd: string;
  prompt: string;
  /** The existing proposal the draft came from, if any. */
  proposalId: number | null;
  /** True when the user changed the name or text of an existing proposal. */
  edited: boolean;
  /** The existing proposal is already approved (waiting for a spawn); just spawn it. */
  approved: boolean;
  /** ASSIGN (default) or PRREVIEW. */
  kind?: "ASSIGN" | "PRREVIEW";
  /** `claude --model` for the new session; absent: the default model. */
  model?: string;
  /** `claude --permission-mode` for the new session (plan, acceptEdits, auto); absent: Claude Code's default. */
  permissionMode?: string;
  /** The workflow template the session starts with; absent: the default. */
  workflow?: string;
  /** Another GitHub account than the issue's default (the Start dialog's Account field). */
  account?: string;
  /** owner/name: main picks the folder (this repository's checkout, else its account's workspace)
   * and `cwd` is only the fallback. A PR review names its PR's repository. */
  cwdRepo?: string;
  /** Try again: `proposalId` is the proposal a failed start left held. It is spawned again as it
   * is (its own name, folder, model and account), never replaced by a new one. */
  retry?: boolean;
  /** Session keys to link the new session to (two-way). */
  peers?: string[];
}

export interface PtyOpenResult {
  ok: boolean;
  /** Output produced before this view mounted (replayed into xterm). */
  replay: string;
  /** Sequence number at the end of `replay`. */
  seq: number;
  exited: boolean;
  message?: string;
}

/** The API the preload script exposes as `window.deck`. */
export interface DeckApi {
  platform: string;
  home: string;
  getState(): Promise<AppState | null>;
  /** Stop a monitor MasterDeck runs (its session is told). */
  watchStop(id: string): Promise<boolean>;
  /** Start the browser sign-in with this provider (progress arrives as AppState.account). */
  accountSignIn(provider: "google" | "github" | "apple"): Promise<void>;
  accountCancel(): Promise<void>;
  /** Reopen the pending sign-in page (the URL stays in main). */
  accountReopen(): Promise<void>;
  accountUseCode(): Promise<void>;
  accountProviders(): Promise<string[]>;
  accountEmail(a: { email: string; password: string; create: boolean; name?: string }): Promise<{ ok: boolean; message: string }>;
  accountSignOut(): Promise<void>;
  accountManage(): Promise<void>;
  /** Answer a browser's approval prompt (AppState.browserRequests). */
  browserDecide(id: string, allow: boolean): Promise<void>;
  /** Revoke an approved browser here and on the backend. */
  browserRevoke(id: string): Promise<{ ok: boolean }>;
  onState(cb: (s: AppState) => void): () => void;
  onFocusSession(cb: (sessionKey: string) => void): () => void;
  onShowNeedsYou(cb: () => void): () => void;
  /** A notification for a Needs-you item was clicked: show that item. */
  onShowInboxItem(cb: (id: string) => void): () => void;
  approve(id: number): Promise<CliResult>;
  reject(id: number): Promise<CliResult>;
  /** `cwd`: a folder the user chose (the desktop's folder picker; ignored from the web app). */
  draftAssign(
    issue: Ticket,
    title?: string,
    url?: string,
    cwd?: string,
  ): Promise<{ ok: true; draft: DraftAssign } | { ok: false; message: string }>;
  setSprint(sprint: string): void;
  /** What earlier sessions on a ticket did (their saved summaries), newest first. */
  ticketMemory(
    ticket: Ticket,
  ): Promise<{ name: string; at: number; text: string }[]>;
  /** Before + Shell opens in a git checkout: put it on its default branch (stashing changes). */
  shellPrepare(dir: string): Promise<{ ok: boolean; message: string | null }>;
  /** The GitHub description of an issue, for the Start session dialog. */
  issueBody(
    ticket: Ticket,
  ): Promise<{ ok: true; body: string } | { ok: false; message: string }>;
  prSummary(
    url: string,
  ): Promise<{ ok: true; pr: PrSummary } | { ok: false; message: string }>;
  /** Resume a session that runs in another terminal as a background session here. */
  startHere(o: {
    sessionId: string;
    name: string;
    cwd: string;
    pid: number | null;
    stopOther: boolean;
  }): Promise<CliResult>;
  /** Type text into a session as if the user typed it (open tab, hidden attach, or via master). */
  sendText(sessionKey: string, text: string): Promise<CliResult>;
  /** Answer the question on a session's AskUserQuestion menu (`question` as shown), or 'submit' its review. */
  answerMenu(
    sessionKey: string,
    question: string | null,
    answer: MenuAnswer | "submit",
  ): Promise<CliResult>;
  /** Act on a Needs-you item (shared/inbox.ts): its actions, or dismiss / snooze {minutes} / wake. */
  inboxAct(
    id: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<CliResult>;
  /** A session's /queue (~/.claude/queue/<sessionId>.jsonl, run by MasterDeck's hook), first to run first. */
  queueList(sessionId: string): Promise<string[]>;
  queueEdit(
    sessionId: string,
    edit: QueueEdit,
  ): Promise<CliResult & { items: string[] }>;
  /** Take the first queued prompt and type it into the session now (for an idle session). */
  queueSendNext(sessionKey: string): Promise<CliResult>;
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<Settings>;
  onAutoOpen(cb: (sessionKey: string) => void): () => void;
  /** Needs you → Log in: open a terminal tab running gh auth login for this account. */
  onGhLogin(cb: (login: string) => void): () => void;
  /**
   * Has Claude Code been allowed to work in this folder (its trust prompt was accepted there)?
   * `waitSeconds`: keep looking until it is, that long at most. null: not known. Read only.
   */
  trust(cwd: string, waitSeconds?: number): Promise<boolean | null>;
  /** Open Claude there…: a terminal tab running `claude` in the folder, for the user to answer its trust prompt. */
  openClaudeIn(cwd: string): Promise<CliResult>;
  onOpenClaude(cb: (cwd: string) => void): () => void;
  /** Move a ticket to a board column (BoardOps). */
  setStatus(issue: Ticket, status: string): Promise<CliResult>;
  standupCommits(
    sinceMs: number,
    dirs: string[],
    untilMs?: number,
  ): Promise<StandupCommit[]>;
  /** `force` skips the shared gh cache for PR status (the Refresh button). */
  janitor(liveDirs: string[], force?: boolean): Promise<JanitorRow[]>;
  removeWorktree(
    repo: string,
    path: string,
    force: boolean,
  ): Promise<CliResult>;
  removeSession(bgId: string): Promise<CliResult>;
  searchHistory(query: string): Promise<HistoryHit[]>;
  /** A found session's conversation, for the History reader (only transcripts under ~/.claude/projects). */
  historyTranscript(
    path: string,
    query: string,
    focus: string | null,
  ): Promise<TranscriptWindow | null>;
  templates(): Promise<Template[]>;
  saveTemplate(t: Template): Promise<Template[]>;
  deleteTemplate(name: string): Promise<Template[]>;
  /** The user's notes (MASTERDECK_HOME/notes): titles and previews. A body is read with notesGet. */
  notesList(): Promise<NoteMeta[]>;
  notesGet(id: string): Promise<Note | null>;
  /** Ids of the notes whose title, text or ticket has every word of the query. */
  notesSearch(query: string): Promise<string[]>;
  /** Refused as a conflict when the stored note is not the version `base` names, unless `force` (the user's Keep mine). */
  notesSave(input: NoteInput): Promise<SaveResult>;
  notesDelete(id: string): Promise<{ ok: boolean; message?: string }>;
  onNotesChanged(cb: (c: NoteChange) => void): () => void;
  /** Resume an ended session's conversation in the background (history search). */
  /** Create an issue on a board (tt.sh create); `dryRun` checks it without creating anything. */
  ticketCreate(
    req: NewTicket & { dryRun?: boolean },
  ): Promise<CliResult & { url?: string; number?: number }>;
  /** Set up the Board's ticket session: its briefing and where the + was clicked. */
  ticketBuilderPrepare(
    ctx: unknown,
  ): Promise<CliResult & { canContinue: boolean }>;
  /** Tickets the Board's session created. */
  onTicketsCreated(
    cb: (t: { url: string; number: number }[]) => void,
  ): () => void;
  /** Labels, open milestones and assignable people of a repo. */
  ticketRepoMeta(
    repo: string,
  ): Promise<{ labels: string[]; milestones: string[]; assignees: string[] }>;
  /** The workspace and its repos (the + menu). */
  workspaceRepos(): Promise<{ name: string; path: string }[]>;
  /** Start a Claude session without a ticket, in a folder (the + menu). */
  startClaude(req: {
    name: string;
    cwd: string;
    prompt?: string;
    model?: string;
    workflow?: string;
    mode?: string;
    /** The GitHub account it works as (two or more connected); omitted: the folder's account. */
    account?: string;
    /** Session keys to link the new session to (two-way). */
    peers?: string[];
  }): Promise<CliResult>;
  resumeSession(
    sessionId: string,
    name: string,
    cwd: string | null,
    account?: string,
  ): Promise<CliResult>;
  /** A new session's default GitHub account for this folder; null with one account. */
  accountFor(cwd: string): Promise<string | null>;
  /** Resume every background session the last restart stopped (AppState.stoppedByRestart). */
  resumeStopped(): Promise<CliResult>;
  /** Tokens per day for these sessions, from their transcripts (the Costs view). */
  tokensByDay(sessionIds: string[]): Promise<Record<string, TokensByDay>>;
  /** When each of these sessions was active, and the account its time goes to (the Costs view's Hours; the window only). */
  hoursActivity(sessionIds: string[]): Promise<Record<string, SessionActivity>>;
  /** Save this CSV where the user picks (a save dialog, `name` its suggested file name); the path, or null when cancelled. */
  hoursExport(csv: string, name: string): Promise<string | null>;
  dismissStopped(): Promise<void>;
  /**
   * Who can be assigned an issue of this repository (none: the primary issue repo), read as the
   * repository's account when the Assign popup opens; kept an hour in main. A read.
   */
  assignableUsers(
    repo: string | null,
  ): Promise<{ ok: true; users: string[] } | { ok: false; message: string }>;
  /** Make `login` the only assignee (GitHub REST). */
  assignIssue(
    issue: Ticket,
    login: string,
    current: string[],
  ): Promise<CliResult>;
  assign(req: AssignRequest): Promise<CliResult & { proposalId?: number }>;
  /** The model set in ~/.claude/settings.json (what "Default" starts), or null. */
  defaultModel(): Promise<string | null>;
  refresh(): Promise<CliResult>;
  refreshBoard(): Promise<CliResult>;
  /** Fetch every PR in the org; with `maxAgeMs`, only when the list is older than that. */
  refreshTeamPrs(maxAgeMs?: number): Promise<CliResult>;
  /** Setup: which tools are installed and whether gh is logged in. */
  setupCheck(): Promise<SetupCheck>;
  /** One tool of Setup's first step: installed (and runs)? */
  setupTool(tool: SetupTool): Promise<{ ok: boolean; detail: string }>;
  /** The github.com accounts gh is logged in to. */
  ghAccounts(): Promise<{ accounts: GhAccount[]; error?: string }>;
  /** Setup: the commit name and email a newly connected account starts with (its GitHub name, its noreply email). */
  ghUser(login: string): Promise<{ name: string; email: string }>;
  /** The active account's login and the organizations it belongs to. */
  ghOwners(): Promise<{ user: string | null; orgs: string[]; error?: string }>;
  /** Setup: repos, projects and (for a project) statuses GitHub has for an owner. */
  configDetect(
    owner: string,
    project?: number,
  ): Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;
  /** `master config detect --all`: every owner gh can reach, with repos and boards (statuses guessed); as this account (omitted: gh's active one). */
  configDetectAll(login?: string): Promise<
    { ok: true; data: unknown } | { ok: false; message: string }
  >;
  /** Setup: save settings (merged into the config file), then reload everything. */
  configSave(patch: unknown): Promise<CliResult>;
  pickFolder(start?: string): Promise<string | null>;
  /** The Start dialog's "Create worktree": is this folder a git checkout, and which branches has it (a read). */
  worktreeInfo(
    cwd: string,
  ): Promise<{ ok: true; root: string; base: string; branches: string[] } | { ok: false; message: string }>;
  /** Make the ticket's worktree (a new branch from `base`) under the checkout's `.claude/worktrees/`; the session then starts in `cwd`. */
  worktreeCreate(
    cwd: string,
    branch: string,
    base: string,
  ): Promise<{ ok: true; cwd: string; branch: string; base: string } | { ok: false; message: string }>;
  /** Install a bundled skill (or replace the copy there); a skill removed before is added back. */
  skillReinstall(name: string): Promise<CliResult>;
  /** Take a bundled skill out of ~/.claude/skills (kept in its backup folder) and keep it out. */
  skillRemove(name: string): Promise<CliResult>;
  /** Every hook Claude Code runs, the skills a stage can use, and the custom steps. */
  workflowGet(): Promise<{
    hooks: HookEntry[];
    skills: { name: string; description: string }[];
    /** The default workflow. */
    flow: Flow | null;
    templates: WorkflowTemplate[];
    /** The custom trigger library. */
    triggers: CustomTrigger[];
    /** The monitor library. */
    monitors: MonitorDef[];
  }>;
  /** Save the default workflow (what new sessions copy). */
  workflowSave(flow: Flow): Promise<CliResult>;
  /** Save a template (a new one when `id` is null; 'default' is the default workflow). */
  workflowTemplateSave(
    id: string | null,
    name: string,
    flow: Flow,
  ): Promise<CliResult & { id?: string }>;
  workflowTemplateDelete(id: string): Promise<CliResult>;
  /** Set up the workflow builder's folder for the workflow open on the canvas. */
  workflowBuilderPrepare(
    templateId: string,
  ): Promise<CliResult & { canContinue: boolean }>;
  /** The builder's latest draft (checked), and each new one as it is written. */
  workflowDraftGet(): Promise<WorkflowDraft | null>;
  onWorkflowDraft(cb: (d: WorkflowDraft | null) => void): () => void;
  /** Discard the draft (after asking): the workflow, its new triggers and skills. */
  workflowDraftDiscard(): Promise<CliResult>;
  /** Install the draft's triggers and skills, then save it to a template (or a new one). */
  workflowDraftApply(
    target: { templateId: string } | { newName: string },
  ): Promise<CliResult & { id?: string }>;
  /** Remove a custom trigger from the library. */
  workflowTriggerDelete(id: string): Promise<CliResult>;
  /** What a session's workflow last did (the Workflow line in Details). */
  workflowStatus(sessionId: string): Promise<WorkflowStatus | null>;
  /** A session's own workflow; null while it follows the default. */
  sessionWorkflowGet(sessionId: string): Promise<WorkflowDoc | null>;
  /** Change a session's workflow (`from`: the template it now comes from, if one was applied). */
  sessionWorkflowSave(
    sessionId: string,
    flow: Flow,
    from?: string | null,
  ): Promise<CliResult>;
  /** The saved summary of a session, and whether its transcript grew since. */
  summaryGet(
    sessionKey: string,
  ): Promise<{ summary: SessionSummary | null; stale: boolean }>;
  /** Summarize a session now (a one-off `claude -p`, about 20 s). */
  summaryMake(
    sessionKey: string,
  ): Promise<
    { ok: true; summary: SessionSummary } | { ok: false; message: string }
  >;
  /** Post the saved summary as a comment on the session's issue. */
  summaryPost(sessionKey: string): Promise<CliResult>;
  /** Link a session to an issue (MasterDeck's LinkStore). */
  linkSession(
    issue: Ticket,
    sessionId: string,
    cwd: string | null,
  ): Promise<CliResult>;
  /** Link (on) or unlink (off) two sessions to each other (Session.key); two-way. */
  peersSet(a: string, b: string, on: boolean): Promise<CliResult>;
  /** Linked sessions → Sync now: summarize this session and refresh what its peers see. */
  peersSync(sessionKey: string): Promise<CliResult>;
  setBoardOpen(open: boolean): void;
  /** Repository view: the repositories the Board tab on screen shows. MasterDeck reads the issues of the ones it does not hold yet (or holds for over an hour); it writes nothing. */
  boardRepos(repos: string[]): void;
  /** Create a GitHub board (on the Mac only): what would be created for this account (omitted: the only one). Reads GitHub, writes nothing. */
  boardCreatePlan(account?: string): Promise<BoardPlanResult>;
  /** Create it, after a confirmation on the Mac; progress arrives through onBoardCreateProgress. */
  boardCreate(req: { account?: string; title: string }): Promise<BoardCreateResult>;
  /** Add the issues the last run could not add. */
  boardCreateRetry(account?: string): Promise<BoardCreateResult>;
  onBoardCreateProgress(cb: (p: BoardProgress) => void): () => void;
  setFocus(sessionId: string | null): void;
  setVisible(sessionIds: string[]): void;
  openExternal(url: string): void;
  openEditor(dir: string): Promise<CliResult>;
  copy(text: string): void;
  stopSession(bgId: string, name: string): Promise<CliResult>;
  /** Stop a session running in another terminal (its claude process), after a confirmation. */
  stopOtherSession(pid: number, name: string): Promise<CliResult>;
  /** Cleanup: stop these sessions (by key) after one confirmation; `stopped` lists the keys that stopped. */
  stopSessions(keys: string[]): Promise<CliResult & { stopped?: string[] }>;
  /** Set a session's status by hand (a StatusKey); null goes back to automatic. */
  setManualStatus(key: string, status: string | null): Promise<CliResult>;
  statuslineInstall(): Promise<CliResult>;
  statuslineUninstall(): Promise<CliResult>;
  masterStart(): Promise<CliResult>;
  ptyOpen(
    id: string,
    spec: PaneSpec,
    cols: number,
    rows: number,
  ): Promise<PtyOpenResult>;
  ptyWrite(id: string, data: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  ptyClose(id: string): void;
  onPtyData(id: string, cb: (data: string, seq: number) => void): () => void;
  onPtyExit(id: string, cb: (code: number) => void): () => void;
}

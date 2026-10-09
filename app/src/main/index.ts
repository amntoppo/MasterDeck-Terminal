import { parseIdentity, remoteUrl } from "@shared/account";
import { Account } from "./account";
import { Watches } from "./watches";
import { BoardFlow, LinkedSteps } from "./boardFlow";
import { PrWatch, prStatesFor } from "./prWatch";
import { canSend } from "@shared/send";
import { handedOver, parseWatchRequest } from "@shared/watches";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { canStop } from "@shared/cleanup";
import { readFile, writeFile } from "node:fs/promises";
import { hoursAccount, type SessionActivity } from "@shared/hours";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  shell,
} from "electron";
import {
  CH,
  type AssignRequest,
  type QueueEdit,
  type SetupTool,
} from "@shared/ipc";
import { diffEvents, newlyNeedsInput } from "@shared/notify";
import { inboxNotice, type InboxItem } from "@shared/inbox";
import { isSafeBgId } from "@shared/paneCommand";
import { isClaudeCommand, tasklistImage } from "@shared/procs";
import { MASTER_NAME, sessionForProposal, isMasterSession } from "@shared/derive";
import type {
  AppState,
  CliResult,
  NotifyEvent,
  PaneSpec,
  Session,
  SetupCheck,
} from "@shared/types";
import { getConfig } from "@shared/appConfig";
import { offBoardOk } from "@shared/repoView";
import {
  AccountEnv,
  detectEnv,
  accountsInUse,
  accountsKeyOf,
  migrateLegacyConfig,
} from "./accountEnv";
import { parseGhAccounts, setupScopes, type GhAccount } from "@shared/ghAuth";
import {
  defaultAccount,
  isMulti,
  ticketAccount,
  noreplyEmail,
  parseGhUser,
  prRepo,
  repoFromRemote,
  sessionAccount,
} from "@shared/accounts";
import {
  bgIdFromOutput,
  resumeAs,
  SessionAccounts,
  sessionSettings,
} from "./sessionAccounts";
import { Superseded } from "./superseded";
import { NotesStore } from "./notes";
import { assignNow as assignAs, inRepoFolder, retryHeld } from "./assign";
import { randomUUID } from "node:crypto";
import { RemoteCommands } from "./remoteCommands";
import { CloudSync } from "./cloudSync";
import { IpcRegistry, isRemote } from "./ipcRegistry";
import { chosenFolder, claudeFolder, inboxActCall, knownDirsOnly, MacPanes, remoteSettings, worktreeFolder } from "./remoteGuards";
import { createWorktree, worktreeInfo } from "./startWorktree";
import { isPermissionMode } from "@shared/startOptions";
import { heldForTrust } from "@shared/trust";
import { ParkedStore } from "./parked";
import { accountChange, BrowserBridge, userChanged } from "./browserBridge";
import { BrowserStore } from "./browserStore";
import { loadMacKey } from "./macKey";
import { readToken, writeToken } from "./remoteToken";
import { remoteStatusWhenOff, toRemoteSnapshot } from "@shared/remoteSnapshot";
import {
  externalAnswerAllowed,
  optionMessage,
  remoteTextAllowed,
  sendMasterUp,
} from "@shared/remoteGuard";
import { toDefaultBranch } from "./defaultBranch";
import {
  transcriptMessages,
  transcriptWindow,
  type TranscriptMessage,
} from "@shared/history";
import { openInEditor } from "./editor";
import { configuredModel } from "./models";
import {
  editQueue,
  isQueueEdit,
  readQueue,
  shiftQueue,
  unshiftQueue,
} from "./queue";
import { makeGhRunner, readGhCacheStatus } from "./ghc";
import { GitHub } from "./github";
import { accountClients } from "./accountClients";
import { AssignableUsers } from "./assignUsers";
import { Sender } from "./send";
import { Ops } from "./ops";
import { cleanEnv, loginPath, resolveClaude } from "./env";
import { MasterCli } from "./masterCli";
import { resolvePaths } from "./paths";
import { PtyManager } from "./ptys";
import { makeRunner } from "./run";
import { Sources } from "./sources";
import { BoardOps, linkTicket, ticketBuilderScript } from "./boardOps";
import { cardBoardless, repoBoardless } from "@shared/derivedBoard";
import { accountGh, BoardCreator, columnsOf } from "./boardCreate";
import { folderAccount, pumpTicketDir, ticketBuilderDir, ticketDirOk, ticketDirs, ticketPane } from "./ticketDirs";
import { branchKey, LinkStore } from "./ticketLinks";
import {
  readRemoved,
  reinstallSkill,
  removeSkill,
  syncSkills,
  writeRemoved,
} from "./skills";
import { collectHooks, listSkills, WorkflowStore } from "./workflow";
import { Summaries } from "./summary";
import {
  DEFAULT_TEMPLATE,
  parseFlow,
  setCustomTriggers,
  validSessionId,
  setMonitors,
  type MonitorDef,
} from "@shared/flow";
import { ticketContext } from "@shared/ticketBuilder";
import { shellQuote } from "@shared/workflow";
import { flowActions, type WatchState } from "@shared/flowWatch";
import { commandEvents, flowProgress, type FlowEvent } from "@shared/flowTrack";
import {
  builderContext,
  checkDraft,
  normalizeDraft,
  readDraftSkill,
  type DraftSkill,
  readDraftMonitor,
  type DraftMonitor,
} from "@shared/flowBuilder";
import type { WorkflowDraft } from "@shared/ipc";
import type { FlowTrigger } from "@shared/flow";
import { attentionFor, sessionStatus } from "@shared/review";
import { answerKeys, permissionKey, type MenuAnswer } from "@shared/ask";
import { asTicket, fullRepo, ticketRef } from "@shared/ticket";
import {
  deckHooksInstalled,
  hookStatus,
  installDeckHooks,
  installReviewGate,
  installWorkflowHooks,
  migrateLegacyHooks,
} from "./hooks";
import { DeckHooks } from "./deckHooks";
import { PeerStore } from "./peers";
import { MAX_PEERS } from "@shared/peers";
import { PeerSync } from "./peerSync";
import {
  installStatusline,
  isInstalled,
  refreshTee,
  uninstallStatusline,
} from "./statusline";

const SMOKE = process.env.MASTERDECK_SMOKE === "1";
// Dev aid: a separate profile so a test run never shares storage with the installed app.
if (process.env.MASTERDECK_USER_DATA)
  app.setPath("userData", process.env.MASTERDECK_USER_DATA);

let win: BrowserWindow | null = null;
// The browser bridge (app.masterdeck.dev); every renderer event also goes to it.
let bridge: BrowserBridge | null = null;
/** Panes the Mac's window shows: their size is the Mac's, not a browser's (spec §4). */
const macPanes = new MacPanes();
const reg = new IpcRegistry(ipcMain);
/** Send to the window and to any connected browser. */
function emit(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args);
  try {
    bridge?.event(channel, args);
  } catch (e) {
    // Never let a browser problem break delivery to the Mac's own window.
    console.error(`browser bridge: ${String(e)}`);
  }
}
let latest: AppState | null = null;

/** The keys a Start dialog asked to link to: strings that are live sessions, unique, at most MAX_PEERS. */
function livePeerKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const live = new Set((latest?.sessions ?? []).filter((s) => s.state !== "done").map((s) => s.key));
  const out: string[] = [];
  for (const k of raw) if (typeof k === "string" && live.has(k) && !out.includes(k)) out.push(k);
  return out.slice(0, MAX_PEERS);
}
let focused: string | null = null;
let pathEnv = process.env.PATH ?? "";
let claudeBin = "claude";

const paths = resolvePaths(
  app.getAppPath(),
  process.resourcesPath,
  app.isPackaged,
);
const linkStore = new LinkStore(paths.ticketLinks, paths.babysitState);
const env = () => cleanEnv(process.env, pathEnv);
const run = makeRunner(env);
const cli = new MasterCli(run, paths.libDir, paths.python);
// Each connected GitHub account's token and settings file (two or more accounts; see accountEnv.ts).
const accountEnv = new AccountEnv(join(paths.home, "accounts"), run);
// The account each session was started as (resume, Details, PR watch).
const sessionAccounts = new SessionAccounts(
  join(paths.home, "session-accounts.json"),
);
// The old side of a copy (a resume as another account): hidden while it does not run.
const superseded = new Superseded(join(paths.home, "superseded-sessions.json"));
// The user's notes. They leave this process two ways only: as answers of the notes handlers below,
// and in this change event (a note's title and 120-character preview, to the window and to web
// tabs that subscribed).
const notes = new NotesStore(join(paths.home, "notes"), {
  onChange: (c) => emit(CH.notesChanged, c),
  repoOf: (repo) => fullRepo(repo),
});
/** owner/name of a folder's `origin` remote, by folder (cached for the run; one lookup per folder). */
const ORIGINS_MAX = 200;
const origins = new Map<string, string | null>();
const originLookups = new Map<string, Promise<string | null>>();
function originNow(cwd: string): Promise<string | null> {
  let p = originLookups.get(cwd);
  if (!p) {
    // ponytail: the oldest folder goes past ORIGINS_MAX (remote callers pass any cwd); an LRU if it ever matters.
    if (originLookups.size >= ORIGINS_MAX) {
      const old = originLookups.keys().next().value!;
      originLookups.delete(old);
      origins.delete(old);
    }
    p = run("git", ["remote", "get-url", "origin"], {
      cwd,
      timeoutMs: 5_000,
    }).then((r) => {
      const repo = r.code === 0 ? repoFromRemote(r.stdout) : null;
      origins.set(cwd, repo);
      return repo;
    });
    originLookups.set(cwd, p);
  }
  return p;
}
/** The same for the state build, which can't wait: the answer so far, the state rebuilt once it comes. */
function originOf(cwd: string): string | null {
  if (!originLookups.has(cwd)) void originNow(cwd).then(() => sources.changed());
  return origins.get(cwd) ?? null;
}
/** A session's account: recorded at start, its spawn proposal's, its folder's repo, the primary. */
function accountOfSession(
  s: { sessionId: string; key: string; name: string },
  origin: string | null | undefined,
): string | null {
  return sessionAccount(
    {
      recorded: sessionAccounts.get(s),
      spawned:
        latest?.proposals.find(
          (p) => p.target.spawn?.name === s.name && p.target.spawn.account,
        )?.target.spawn?.account ?? null,
      origin,
    },
    getConfig(),
  );
}
/** `--settings` for a session as `account` (or `fallback()`'s); nothing with one account. */
function settingsFor(
  account: string | null | undefined,
  fallback: () => Promise<string | null>,
): ReturnType<typeof sessionSettings> {
  return sessionSettings(
    isMulti(getConfig()),
    (l) => accountEnv.settingsArgs(l),
    account,
    fallback,
  );
}
/** Start a session for an issue (the Start dialog, a browser, a phone): as its account with two or more. */
async function assignNow(
  given: AssignRequest,
): Promise<CliResult & { proposalId?: number }> {
  // A PR review names its repository, not a folder: the CLI's resolver picks it.
  const req = await inRepoFolder(cli, given);
  return assignAs(cli, req, {
    settings: (account) =>
      settingsFor(account, async () =>
        defaultAccount({ issue: { repo: req.repo ?? null } }, getConfig()),
      ),
    proposalAccount: (id) =>
      latest?.proposals.find((p) => p.id === id)?.target.spawn?.account ??
      null,
    expect: (name, login) => sessionAccounts.expect(name, login),
    owner: (id) => {
      const p = latest?.proposals.find((x) => x.id === id);
      return (p && latest ? sessionForProposal(p, latest.sessions)?.name : null) ?? null;
    },
  });
}
const ptys = new PtyManager(
  env,
  (channel, ...args) => emit(channel, ...args),
  () => claudeBin,
  () => join(paths.home, "installer"),
  () => builderDir(),
  (spec) =>
    ticketPane(paths.home, isMulti(getConfig()), spec, (l) =>
      accountEnv.settingsArgs(l),
    ),
);

function notify(events: NotifyEvent[]): void {
  if (SMOKE || !Notification.isSupported()) return;
  for (const e of events.slice(0, 4)) {
    const n = new Notification({ title: e.title, body: e.body, silent: false });
    n.on("click", () => reveal(e.target));
    n.show();
  }
}

const gh = makeGhRunner(run, paths.libDir, paths.python);
const github = new GitHub(run, gh);
const boardOps = new BoardOps(gh);
// Which account each of MasterDeck's own GitHub calls goes out as (two or more; with one, the three above).
const { forAccount, forRepo, forCard, ghRouted, ghDirect, boardOps: boardOpsByRepo } = accountClients({
  config: getConfig,
  base: { gh, github, ops: boardOps },
  run,
  runEnv: (l) => accountEnv.runEnv(l),
  ghFor: (account) => makeGhRunner(run, paths.libDir, paths.python, process.platform, account),
  // A card of a repository no account lists goes out as the account whose board holds it.
  boardOf: (repo, number) => sources.boardOf(repo, number),
});
// The Assign popup's people: who can be assigned in the card's repository, read as that repository's account.
const assignableUsers = new AssignableUsers({
  // The same account `assignIssue` assigns a card of that repository as (`forCard`).
  read: (repo) => forCard(repo).github.assignableUsers(false, repo),
  config: getConfig,
  boardRepos: () => sources.boardRepos(),
  boardStamp: () => sources.boardStamp(),
});
// "Create a GitHub board" for an account that has none (the Board's hint). Every call goes out as
// that account; the confirmation is the Mac's own dialog, built from main's fresh read.
const boardCreator = new BoardCreator({
  config: getConfig,
  // forAccount answers an unknown login with the primary's runner; here that would create a board
  // as another account, so a login that is not connected (any more) fails the call instead.
  gh: accountGh(getConfig, (login) => forAccount(login).gh),
  ghLogins: async () => (await ghAccounts()).accounts,
  confirm: async (message, lines) => {
    if (!win) return false;
    const choice = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Cancel", "Create board"],
      defaultId: 1,
      cancelId: 0,
      message,
      detail: lines.map((l) => `• ${l}`).join("\n"),
    });
    return choice.response === 1;
  },
  save: (patch) => cli.configSave(patch),
  refresh: () => {
    sources.loadConfig();
    void sources.refreshGithub(true);
  },
  // The column the Board shows now becomes the issue's Status on the new board; null (the run is
  // refused) while the account's issues are not loaded.
  columns: (login) => columnsOf(latest?.board, login),
  // To the Mac's own window only: a browser cannot start this, so it has nothing to follow.
  progress: (p) => win?.webContents.send(CH.boardCreateProgress, p),
});
const sender = new Sender(
  ptys,
  cli,
  env,
  () => claudeBin,
  (key) => latest?.sessions.find((x) => x.key === key),
);
const ops = new Ops(
  run,
  paths,
  () => claudeBin,
  ghRouted,
  () =>
    isMulti(getConfig()) ? getConfig().accounts.map((a) => a.email).filter(Boolean) : [],
  // Sessions also start in the other accounts' workspaces: Janitor, Remove and the + menu reach them.
  () => getConfig().accounts.flatMap((a) => (a.workspace ? [a.workspace] : [])),
);
// Board moves for linked sessions whose workflow keeps the `ticket` built-in (no global switch).
const boardFlow = new BoardFlow({
  ops: boardOpsByRepo,
  links: linkStore,
  // One batched light read per tick (≤ 50 PRs a query, ghc-cached); none while GitHub is paused.
  prStates: async (urls) =>
    sources.isGithubPaused()
      ? {}
      : prStatesFor((l) => forAccount(l || null).gh, getConfig(), urls),
  link: linkSession,
  builtinOn: (sid) => workflows().builtinsFor(sid).includes("ticket"),
  onMoved: (t, status) => sources.noteStatus(t, status),
  log: (m) => console.error(m),
  linkTriedFile: join(paths.home, "board-link-tried.json"),
  createdPrs: (sid) => sources.prsOpenedBy(sid),
  movedFile: join(paths.home, "board-moved.json"),
});
// The `linked` trigger's steps for links MasterDeck makes (no tt.sh link runs, so no hook fires).
const linkedSteps = new LinkedSteps({
  file: join(paths.home, "linked-steps.json"),
  markDir: tmpdir(),
  steps: (sid) => workflows().compiledFor(sid),
  send: (s, text) =>
    sender.send(
      s,
      text,
      latest?.master.kind === "attached" ||
        latest?.master.kind === "elsewhere",
    ),
  logRun: (sid, trigger, ids) => workflows().logRun(sid, trigger, ids),
  log: (m) => console.error(m),
});
// MasterDeck's PR watch: each open PR a session made (Settings → Sessions → Watch new PRs).
const prWatch = new PrWatch(join(paths.home, "pr-watch.json"), {
  gh,
  ghFor: (account) => forAccount(account ?? null).gh,
  paused: (o) => sources.isGithubPaused(o),
  send: (s, text) =>
    sender.send(
      s,
      text,
      latest?.master.kind === "attached" ||
        latest?.master.kind === "elsewhere",
    ),
  onChange: () => sources.changed(),
});
// Monitors MasterDeck runs for sessions (Settings → Monitors run by: MasterDeck).
const watches = new Watches(
  join(paths.home, "watches.json"),
  env,
  (s, text) =>
    sender.send(
      s,
      text,
      latest?.master.kind === "attached" ||
        latest?.master.kind === "elsewhere",
    ),
  () => sources.changed(),
);
function mtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
/** Hook status in the UI, and whether MasterDeck's hook leaves /queue to the skill's hooks. */
function refreshHooks(): void {
  const h = hookStatus(paths.claudeSettings);
  sources.setHooks(h);
  if (process.platform !== "win32") deckHooks.setQueueOff(h.foreignQueue);
}
/** Monitor calls already answered (the hook removes its file once it read the answer). */
const answeredWatches = new Map<string, number>();
/** settings.json's mtime when queue-off was last worked out. */
let settingsSeen = 0;
/** Take over the Monitor calls the hook hands in, then give sessions what their monitors printed. */
function pumpWatches(): void {
  deckHooks.pumpQueue();
  // The queue skill's hooks installed by hand while MasterDeck runs: leave /queue to them now.
  const m = mtimeMs(paths.claudeSettings);
  if (m !== settingsSeen) {
    settingsSeen = m;
    refreshHooks();
  }
  const by = sources.getSettings().monitorsBy;
  const now = Date.now();
  for (const [id, at] of answeredWatches)
    if (now - at > 60_000) answeredWatches.delete(id);
  for (const r of deckHooks.watchRequests()) {
    // The hook gives up after 10s: a file older than that is left over (the hook was killed).
    const age = now - Number(r.id.split("-")[0]) * 1000;
    if (answeredWatches.has(r.id) || !(age < 20_000)) {
      if (!(age < 20_000)) deckHooks.answerWatch(r.id, null);
      continue;
    }
    answeredWatches.set(r.id, now);
    const req = parseWatchRequest(r.text);
    // Not ours to run (setting off, a WebSocket monitor, a bad file): Claude Code runs it.
    if (!req || by !== "masterdeck") {
      deckHooks.answerWatch(r.id, null);
      continue;
    }
    const { already } = watches.add(req);
    deckHooks.answerWatch(r.id, handedOver(req.description, already));
  }
  watches.deliver(latest?.sessions ?? []);
}
const summaries = new Summaries(
  run,
  () => claudeBin,
  join(paths.home, "summaries"),
  paths.projectsDir,
);
const deckHooks = new DeckHooks(paths.home, undefined, paths.config);
const peerStore = new PeerStore(join(paths.home, "session-peers.json"));
peerStore.load();
const sources = new Sources(
  paths,
  run,
  cli,
  (state) => {
    const prev = latest;
    latest = state;
    // Accounts changed (Setup saved, config edited): new tokens and settings files.
    if (accountsKeyOf(state.config) !== accountsKey) void refreshAccounts();
    sessionAccounts.claim(state.sessions);
    // A past session resumes as the account it was started as (shown in the Start dialog).
    if (isMulti(state.config))
      for (const list of Object.values(state.pastSessions))
        for (const p of list)
          p.account = sessionAccounts.get({ sessionId: p.sessionId, key: p.sessionId.slice(0, 8) }) ?? undefined;
    // Each session's own workflow: copied the first time it shows up.
    if (process.platform !== "win32")
      try {
        workflows().snapshot(
          state.sessions.filter(
            (s) => s.name !== MASTER_NAME && s.state !== "done",
          ),
        );
      } catch (e) {
        console.error(`workflow copy: ${String(e)}`);
      }
    try {
      runFlowWatch(state);
    } catch (e) {
      console.error(`workflow watch: ${String(e)}`);
    }
    // The master session may send anything; the reports guard (hook.sh MasterReport) reads this.
    if (process.platform !== "win32" && sources.isHealthy("agents")) {
      const master = getConfig().masterName.trim().toLowerCase();
      deckHooks.setMasterSessions(
        state.sessions
          .filter((s) => s.name.toLowerCase() === master)
          .map((s) => s.sessionId),
      );
    }
    if (process.platform !== "win32" && sources.isHealthy("agents"))
      deckHooks.pruneLegacy(
        new Set(
          state.sessions
            .filter((s) => s.state !== "done")
            .map((s) => s.sessionId),
        ),
      );
    // Both catch their own errors; board moves run at most every 30 s.
    void boardFlow.tick(state);
    try {
      prWatch.sync(
        state,
        (s) =>
          state.settings.watchPrs &&
          workflows().builtinsFor(s.sessionId).includes("pr-watch"),
      );
    } catch (e) {
      console.error(`PR watch: ${String(e)}`);
    }
    void linkedSteps.deliver(state.sessions);
    emit(CH.state, state);
    // The remote line must never break the state callback (notifications, badge, auto-open below).
    try {
      cloud?.push(toRemoteSnapshot(state, app.getVersion()));
    } catch (e) {
      console.error(`remote snapshot: ${String(e)}`);
    }
    try {
      if (!remoteReady && sources.isHealthy("agents")) {
        // The session list is in: commands that waited while MasterDeck was closed can run now.
        remoteReady = true;
        syncRemote();
      } else if (
        state.settings.remoteEnabled !== prev?.settings.remoteEnabled
      )
        syncRemote();
    } catch (e) {
      console.error(`remote sync: ${String(e)}`);
    }
    notify(diffEvents(prev, state, focused));
    // Dock badge: the Needs-you count.
    if (state.settings.dockBadge) app.setBadgeCount(state.inbox.open.length);
    else if (prev?.settings.dockBadge) app.setBadgeCount(0);
    // Auto-open: a session that just blocked on a prompt gets its tab (not focused) and a dock bounce.
    const blocked = newlyNeedsInput(prev, state);
    if (blocked.length && state.settings.autoOpenNeedsInput) {
      for (const key of blocked) emit(CH.autoOpen, key);
      if (process.platform === "darwin" && !win?.isFocused())
        app.dock?.bounce("informational");
    }
    if (SMOKE && sources.isHealthy("agents") && sources.isHealthy("ledger")) {
      console.log(
        `SMOKE OK sessions=${state.sessions.length} issues=${state.issues.length} master=${state.master.kind}`,
      );
      app.exit(0);
    }
  },
  () => claudeBin,
  github,
  ghRouted,
  () => readGhCacheStatus(undefined, undefined, isMulti(getConfig())),
);
sources.setPeerStore(peerStore);
/** Summarize a session from its transcript (the Summary panel's button and PeerSync). */
async function makeSummaryFor(key: string) {
  const s = latest?.sessions.find((x) => x.key === key);
  if (!s) return { ok: false as const, message: "session not found" };
  const f = sources.sessionFacts(s.sessionId, s.key);
  if (!f.transcript)
    return { ok: false as const, message: "no transcript for this session yet" };
  return summaries.make({
    sessionId: s.sessionId,
    name: s.name,
    transcript: f.transcript,
    cwd: f.cwd ?? s.cwd,
    issue: s.issue !== null ? ticketRef(s.issueRepo, s.issue) : null,
    prs: f.prs,
  });
}
// Linked sessions: a fresh summary on Stop, then a delta on each peer's next prompt.
const peerSync = new PeerSync({
  store: peerStore,
  sessions: () => latest?.sessions ?? [],
  facts: (k) => sources.peerFacts(k),
  summaryStale: (key) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return false;
    const summary = summaries.get(s.sessionId);
    const t = sources.sessionFacts(s.sessionId, s.key).transcript;
    const size = t && existsSync(t) ? statSync(t).size : 0;
    return !summary || size > summary.size;
  },
  makeSummary: makeSummaryFor,
  setDelta: (sid, json) => deckHooks.setDelta(sid, json),
  clearDelta: (sid) => deckHooks.clearDelta(sid),
  deltaPending: (sid) => deckHooks.hasDelta(sid),
  rewriteContext: () => sources.rewriteSessionContext(),
  hooksLive: () =>
    process.platform !== "win32" && deckHooksInstalled(paths.claudeSettings),
  deliver: (s, text) =>
    sender.send(s, text, sendMasterUp(true, latest?.master.kind)),
  auto: () => getConfig().peerSync?.auto !== false,
});
sources.onSessionStop((sid) => peerSync.onStop(sid));
// A session started with linked peers appeared: its context file and its peers' deltas follow.
sources.onPeersClaimed((keys) => peerSync.refreshAll(keys));
sources.setMasterAccount((s) => sessionAccounts.get(s));
sources.setAccountRunners({
  github: (login) => forAccount(login).github,
  // The current branch's PR (gh pr view in the folder): the folder's `origin` account, looked up first.
  ghForDir: (dir) =>
    isMulti(getConfig())
      ? async (args, opts) => forRepo(await originNow(dir)).gh(args, opts)
      : gh,
});
sources.setSessionAccount(
  (s) => accountOfSession(s, s.cwd ? originOf(s.cwd) : null),
  (s) => sessionAccounts.ghActive(s),
);
sources.setSuperseded(() => superseded.ids());

/** Bring the window forward, showing a Needs-you item (or a session, or the list). */
function reveal(target: NotifyEvent["target"]): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (target.itemId) emit(CH.showInboxItem, target.itemId);
  else if (target.sessionKey)
    emit(CH.focusSession, target.sessionKey);
  else emit(CH.showNeedsYou);
}

/** Notifications still showing, kept so they are not garbage-collected before a click (macOS). */
const shown = new Set<Notification>();

/**
 * A new Needs-you item's notification (Settings: "Notify me…"). Clicking it opens the item. On
 * macOS it can also act without opening the app: a button for the item's main action, a reply
 * field for a question; both go through the inbox like the cards do.
 */
function notifyItem(entry: Parameters<typeof inboxNotice>[0]): void {
  if (SMOKE || !Notification.isSupported() || !latest?.settings.notifyNeedsYou)
    return;
  const n = inboxNotice(entry);
  if (!n) return;
  const mac = process.platform === "darwin";
  const note = new Notification({
    title: n.title,
    body: n.body,
    silent: false,
    ...(mac && n.action
      ? { actions: [{ type: "button" as const, text: n.action.label }] }
      : {}),
    ...(mac && n.reply ? { hasReply: true, replyPlaceholder: "Reply…" } : {}),
  });
  const id = entry.item.id;
  const done = (r: CliResult) => {
    if (!r.ok)
      notify([
        { title: "Could not do that", body: r.message, target: n.target },
      ]);
  };
  note.on("click", () => reveal(n.target));
  note.on(
    "action",
    () =>
      n.action &&
      void sources.inbox
        .act(id, n.action.type, { by: "notification" }, runInboxAction)
        .then((r) => (sources.changed(), done(r))),
  );
  note.on(
    "reply",
    (_e, text) =>
      void sources.inbox
        .act(id, "reply", { text, by: "notification" }, runInboxAction)
        .then((r) => (sources.changed(), done(r))),
  );
  note.on("close", () => shown.delete(note));
  shown.add(note);
  note.show();
}

// Needs you: a new item announces itself (the inbox's events; items there at startup stay quiet).
sources.inbox.on("event", (e) => {
  if (e.type === "added") notifyItem(e.entry);
});

/** Answer the menu on a session's screen, if it is still the question the user saw. */
async function answerMenuFor(
  key: string,
  question: unknown,
  answer: unknown,
): Promise<CliResult> {
  const s = latest?.sessions.find((x) => x.key === key);
  if (!s) return { ok: false, message: "session not found" };
  // Questions MasterDeck's hook holds (AskUserQuestion): all answered at once, through the hook.
  const asked = latest?.menus[key]?.asked;
  if (asked && question === `asked:${asked.requestId}`) {
    const o = (answer ?? {}) as { answers?: unknown };
    const answers =
      o.answers && typeof o.answers === "object"
        ? (Object.fromEntries(
            Object.entries(o.answers as Record<string, unknown>).filter(
              ([, v]) => typeof v === "string",
            ),
          ) as Record<string, string>)
        : {};
    const r = sources.answerHookQuestions(asked.requestId, answers);
    return r.ok ? { ok: true, message: `${s.name}: answered` } : r;
  }
  // A permission MasterDeck's hook holds: answered through the hook, in any terminal, no keys.
  const held = latest?.menus[key]?.permission;
  if (
    held?.requestId &&
    typeof question === "string" &&
    question === `permission:${permissionKey(held)}`
  ) {
    const o = (answer ?? {}) as { picks?: unknown; text?: unknown };
    const n =
      Array.isArray(o.picks) &&
      o.picks.length === 1 &&
      typeof o.picks[0] === "number"
        ? o.picks[0]
        : -1;
    const r = sources.answerHookRequest(
      held.requestId,
      n,
      typeof o.text === "string" ? o.text.slice(0, 2000) : undefined,
    );
    return r.ok ? { ok: true, message: `${s.name}: ${r.message}` } : r;
  }
  // Read the screen again: answer only the question the user saw.
  const menu = await sources.readMenu(s);
  if (
    menu?.permission ||
    (typeof question === "string" && question.startsWith("permission:"))
  ) {
    if (
      !menu?.permission ||
      `permission:${permissionKey(menu.permission)}` !== question
    ) {
      void sources.pollMenus();
      return {
        ok: false,
        message: `${s.name}: the permission on its screen changed; look again`,
      };
    }
    const pick = (answer as { picks?: unknown } | null)?.picks;
    const n =
      Array.isArray(pick) && pick.length === 1 && typeof pick[0] === "number"
        ? pick[0]
        : -1;
    if (
      !Number.isInteger(n) ||
      n < 0 ||
      n >= menu.permission.options.length ||
      n > 8
    )
      return { ok: false, message: "no such option" };
    const r = await sender.answerMenu(s, [{ keys: String(n + 1), wait: 700 }]);
    void sources.pollMenus();
    return r.ok
      ? { ok: true, message: `${s.name}: ${menu.permission.options[n]}` }
      : r;
  }
  const now = menu?.question?.question ?? null;
  if (!menu || now !== (typeof question === "string" ? question : null)) {
    void sources.pollMenus();
    return {
      ok: false,
      message: `${s.name}: the question on its screen changed; look again`,
    };
  }
  let a: MenuAnswer | "submit" = "submit";
  if (answer !== "submit") {
    const o = (answer ?? {}) as { picks?: unknown; text?: unknown };
    a = {
      picks: Array.isArray(o.picks)
        ? o.picks.filter((p): p is number => typeof p === "number")
        : [],
      text: typeof o.text === "string" ? o.text.slice(0, 2000) : undefined,
    };
  }
  const steps = answerKeys(menu, a);
  if (typeof steps === "string") return { ok: false, message: steps };
  const r = await sender.answerMenu(s, steps);
  void sources.pollMenus();
  return r;
}

const remoteTokenFile = () => join(paths.home, "remote-token");
const REMOTE = remoteUrl(process.env);
const identityFile = () => join(paths.home, "account.json");
const browserStore = new BrowserStore(join(paths.home, "browsers.json"));
/** The Mac's browser key (Keychain); loaded once the app is ready. */
let macKey: Awaited<ReturnType<typeof loadMacKey>> = null;
/** The account the backend says this Mac belongs to (CloudSync welcome). */
let cloudUser: { id: string; email: string } | null = null;
let accountEmail: string | null = null;
/** Sign-out or another account: approved browsers belong to the old one (spec "Same account", RF1). */
function publishBrowsers(): void {
  const b = bridge!;
  sources.setBrowsers(
    b.browsers().map(({ id, name, approvedAt, connected, connectedAt, device }) => ({ id, name, approvedAt, connected, connectedAt, device })),
    b.requests(),
    b.warning(),
  );
}
/** DELETE /v1/browsers/:id with this Mac's device token: the hub then closes that browser with 4003. */
async function revokeBrowserRow(id: string): Promise<boolean> {
  const token = readToken(remoteTokenFile());
  if (!token) return false;
  try {
    const r = await fetch(`${REMOTE}/v1/browsers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    return r.ok;
  } catch {
    return false;
  }
}
function forgetBrowsers(): void {
  browserStore.wipe();
  bridge?.closeAll();
}
const account = new Account({
  baseUrl: REMOTE,
  fetch: (input, init) => fetch(input, init),
  openBrowser: (url) => void shell.openExternal(url),
  deviceName: hostname().replace(/\.local$/, "").slice(0, 80) || "Mac",
  saveToken: (t) => writeToken(remoteTokenFile(), t),
  readIdentity: () => {
    try {
      return parseIdentity(readFileSync(identityFile(), "utf8"));
    } catch {
      return null;
    }
  },
  saveIdentity: (id) => {
    // A failed write must throw so Account can undo the token and the device.
    if (id) writeFileSync(identityFile(), JSON.stringify(id));
    else
      try {
        rmSync(identityFile(), { force: true });
      } catch (e) {
        console.error("account.json", e);
      }
  },
  onChange: (s) => {
    const c = accountChange(accountEmail, s);
    if (c.forget) forgetBrowsers();
    accountEmail = c.email;
    sources.setAccount(s);
    syncRemote();
  },
});
{
  const s = account.state();
  accountEmail = s.kind === "signedIn" ? s.email : null;
}
sources.setAccount(account.state());
bridge = new BrowserBridge({
  store: browserStore,
  key: () => macKey,
  account: () => {
    const s = account.state();
    return cloudUser && s.kind === "signedIn" && s.email === cloudUser.email
      ? { userId: cloudUser.id, email: cloudUser.email }
      : null;
  },
  send: (m) => cloud?.sendBrowser(m) ?? false,
  revokeRemote: (id) => revokeBrowserRow(id),
  call: (ch, a) => reg.call(ch, a),
  onChange: () => publishBrowsers(),
  hello: { appVersion: app.getVersion(), platform: process.platform, home: homedir() },
  log: (l) => console.log(l),
  logins: () => getConfig().accounts.map((a) => a.login),
  ticketAccount: (tab) => folderAccount(paths.home, tab),
});
const remoteCommands = new RemoteCommands(
  {
    state: () => latest,
    // remote = true: a client token is less trusted than the window (see runInboxAction).
    inboxAct: (id, type, payload) => inboxAct(id, type, payload, true),
    draftAssign: (t) => cli.draftAssign(t),
    startAssign: (req) => assignNow(req),
    stopBg,
    resume: (id, name, cwd) => resumeBg(id, name, cwd),
    // Never relayed through master-agent: remote text goes straight to the session or not at all.
    sendNow: (s, text) => sender.send(s, text, sendMasterUp(true, latest?.master.kind)),
    queueEdit: (sessionId, edit) => {
      const { ok, message } = editQueue(sessionId, edit);
      return { ok, message };
    },
    setManualStatus: (key, status) => sources.setManualStatus(key, status),
    isMulti: () => isMulti(getConfig()),
    configLogins: () => getConfig().accounts.map((a) => a.login),
  },
  join(paths.home, "remote-done.json"),
);
let cloud: CloudSync | null = null;
let cloudKey = "";
/** True once the first state with the session list exists; until then the backend is not dialled. */
let remoteReady = false;

function deviceId(): string {
  const f = join(paths.home, "remote-device-id");
  try {
    const v = readFileSync(f, "utf8").trim();
    if (v) return v;
  } catch {
    // first run
  }
  const v = randomUUID();
  try {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(f, v);
  } catch (e) {
    console.error(`remote device id not saved, using one for this run: ${String(e)}`);
  }
  return v;
}

/** Start, restart or stop the line to the backend to match Settings → Remote and the token. */
function syncRemote(): void {
  const s = latest?.settings ?? sources.getSettings();
  const token = readToken(remoteTokenFile());
  const url = REMOTE;
  const key = s.remoteEnabled && token ? `${url}\n${token}` : "";
  if (key && key === cloudKey) return;
  if (key && !remoteReady) {
    // Pending commands arrive on connect; running them before the sessions load would fail them.
    cloud?.stop();
    cloud = null;
    cloudKey = "";
    sources.setRemote({ conn: "connecting", message: "waiting for sessions to load", lastSyncAt: null, hasToken: true });
    return;
  }
  cloud?.stop();
  cloud = null;
  cloudKey = key;
  sources.setExternalItems([]);
  if (!key) {
    sources.setRemote(remoteStatusWhenOff(s, !!token));
    return;
  }
  cloud = new CloudSync({
    url,
    token: token!,
    deviceId: deviceId(),
    appVersion: app.getVersion(),
    run: (cmd) => remoteCommands.run(cmd),
    onItems: (items) => sources.setExternalItems(items),
    onStatus: (st) => sources.setRemote({ ...st, hasToken: true }),
    onSignedOut: (m) => account.signedOutRemotely(m),
    log: (line) => console.log(line),
    macPublicKey: () => macKey?.publicKey ?? null,
    onBrowser: (m) => void bridge!.onServer(m).catch((e) => console.error(`browser bridge: ${String(e)}`)),
    onUser: (u) => {
      if (userChanged(cloudUser, u)) forgetBrowsers();
      cloudUser = u;
      publishBrowsers();
    },
    // Channels only: approval requests survive a blip and complete after the reconnect.
    onDisconnect: () => bridge!.dropChannels(),
    onClients: (c) => sources.setRemoteClients(c),
  });
  cloud.start();
  if (latest) cloud.push(toRemoteSnapshot(latest, app.getVersion()));
}

/** Stop a background session (no confirmation: callers ask first). */
async function stopBg(bgId: string): Promise<CliResult> {
  if (!isSafeBgId(bgId)) return { ok: false, message: "bad background id" };
  const r = await run(claudeBin, ["stop", bgId], { timeoutMs: 30_000 });
  // Read the session list now: a stopped session leaves the sidebar at once.
  await sources.refreshAgents();
  return r.code === 0
    ? { ok: true, message: "stopped" }
    : { ok: false, message: (r.stderr || r.stdout).trim() };
}

/** The inbox's act, shared by the window's IPC and the remote commands (`remote` = true). */
async function inboxAct(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  remote = false,
): Promise<CliResult> {
  const r = await sources.inbox.act(id, type, payload, (item, t, p) =>
    runInboxAction(item, t, p, remote),
  );
  if (r.ok && type === "dismiss" && id.startsWith("ext-"))
    cloud?.dismissItem(id);
  sources.changed();
  return r;
}

/**
 * Open Claude there…: a tab in the Mac's window running `claude` in a folder Claude Code was never
 * allowed to work in, so the user answers its trust prompt. MasterDeck does not answer it, and
 * never writes Claude Code's own config.
 */
function openClaude(folder: unknown, remote: boolean): CliResult {
  const dir = claudeFolder(remote, folder);
  if (!dir.ok) return dir;
  if (!win) return { ok: false, message: "the MasterDeck window is not open" };
  // The window only: a browser has no tab for it.
  win.webContents.send(CH.openClaude, dir.cwd);
  return { ok: true, message: `opened claude in ${dir.cwd}` };
}

/**
 * Carry out an inbox item's action: the one path the Needs-you cards, notifications and (later) a
 * phone all use. The inbox has checked the item is still open; this checks the session is still in
 * a state where the action makes sense, then uses the same code as the rest of the app.
 */
async function runInboxAction(
  item: InboxItem,
  type: string,
  payload: Record<string, unknown>,
  /** From a remote client: never relayed through master-agent, and its text must pass noEscape. */
  remote = false,
): Promise<CliResult> {
  const masterUp = sendMasterUp(remote, latest?.master.kind);
  const d = item.detail;
  const owner = (): Session | undefined => {
    if (item.sessionKey)
      return latest?.sessions.find((x) => x.key === item.sessionKey);
    if (d.type === "proposal")
      return latest
        ? (sessionForProposal(d.proposal, latest.sessions) ?? undefined)
        : undefined;
    return undefined;
  };
  const text =
    typeof payload.text === "string" ? payload.text.slice(0, 20_000) : "";
  switch (type) {
    case "reply":
    case "option": {
      if (d.type === "external") {
        const answer = (
          type === "option" && typeof payload.text === "string"
            ? payload.text
            : text
        )
          .trim()
          .slice(0, 10_000);
        if (!answer) return { ok: false, message: "nothing to answer" };
        if (!externalAnswerAllowed(d.item, answer))
          return { ok: false, message: "answer with one of the options" };
        const by =
          typeof payload.by === "string" && payload.by
            ? payload.by.slice(0, 40)
            : "desktop";
        return cloud?.answerItem(item.id, answer, by)
          ? { ok: true, message: "answered" }
          : { ok: false, message: "not connected to the remote backend" };
      }
      const s = owner();
      if (!s) return { ok: false, message: "no live session to reply to" };
      const msg = type === "option" ? optionMessage(payload.key, text) : text;
      if (msg === null)
        return { ok: false, message: "an option key is 1-3 letters or digits" };
      if (!msg.trim()) return { ok: false, message: "nothing to send" };
      if (remote && !remoteTextAllowed(msg))
        return {
          ok: false,
          message:
            "remote text may not start with / or ! or contain control characters",
        };
      return sender.send(s, msg, masterUp);
    }
    case "menu":
      if (!item.sessionKey) return { ok: false, message: "no session" };
      return answerMenuFor(item.sessionKey, payload.question, payload.answer);
    case "continue":
    case "compact": {
      const s = owner();
      if (!s) return { ok: false, message: "no live session" };
      if (type === "continue" && s.state !== "idle")
        return { ok: false, message: `${s.name} is ${s.state}, not idle` };
      return sender.send(
        s,
        type === "continue" ? "continue" : "/compact",
        masterUp,
      );
    }
    case "approve":
    case "reject":
      if (d.type !== "proposal")
        return { ok: false, message: "not a proposal" };
      // Try again on a start that was held: the same proposal is spawned again (held → sent).
      if (type === "approve" && d.proposal.status === "held")
        return retryHeld(cli, d.proposal, {
          expect: (name, login) => {
            if (isMulti(getConfig())) sessionAccounts.expect(name, login);
          },
          owner: () => owner()?.name ?? null,
        });
      return type === "approve"
        ? cli.approve([d.proposal.id])
        : cli.reject([d.proposal.id]);
    case "trust": {
      const held = d.type === "proposal" ? heldForTrust(d.proposal) : null;
      if (!held) return { ok: false, message: "not a start Claude Code refused" };
      return openClaude(held.folder, remote);
    }
    case "send": {
      if (d.type !== "offer") return { ok: false, message: "not a PR offer" };
      // master's own proposal: approving it lets master send it (and track it).
      if (d.offer.proposal) {
        const r = await cli.approve([d.offer.proposal.id]);
        return r.ok ? { ok: true, message: "approved; master sends it" } : r;
      }
      const s = owner();
      if (!s)
        return { ok: false, message: "no session owns this PR; start one" };
      const r = await sender.send(s, d.offer.message, masterUp);
      return r.ok ? { ok: true, message: `sent to ${s.name}` } : r;
    }
    case "login": {
      if (d.type !== "account")
        return { ok: false, message: "not a GitHub account item" };
      // gh's browser login opens a browser on the Mac: not from a phone or browser.
      if (remote)
        return {
          ok: false,
          message: `log in to GitHub on the Mac: run gh auth login for ${d.login}`,
        };
      emit(CH.ghLogin, d.login);
      return { ok: true, message: `opened gh auth login for ${d.login}` };
    }
    default:
      return { ok: false, message: `${type} is done in the window` };
  }
}

function statuslineOpts() {
  return {
    settingsPath: paths.claudeSettings,
    home: paths.home,
    scriptPath: paths.installedTee,
    python: paths.python,
  };
}

function installHook(): CliResult {
  try {
    mkdirSync(paths.home, { recursive: true });
    copyFileSync(paths.bundledTee, paths.installedTee);
  } catch (e) {
    return {
      ok: false,
      message: `could not copy the status line script: ${String(e)}`,
    };
  }
  const r = installStatusline(statuslineOpts());
  sources.statuslineInstalled = isInstalled(
    paths.claudeSettings,
    paths.installedTee,
  );
  return r;
}

/**
 * Link an existing session to an issue: MasterDeck's own ticket links (see linkTicket), then the
 * ticket moves to In Dev when the session's workflow keeps the `ticket` built-in.
 */
async function linkSession(
  raw: unknown,
  sessionId: string,
  cwd: string | null,
): Promise<CliResult> {
  const t = asTicket(raw);
  if (!t) return { ok: false, message: "bad issue" };
  if (!/^[0-9a-f-]{36}$/i.test(sessionId))
    return { ok: false, message: "bad session id" };
  const r = await linkTicket(
    {
      ops: forCard(t.repo, t.number).ops,
      link: (sid, tk, title, branch) => linkStore.link(sid, tk, title, branch),
      // A session MasterDeck parked in a main checkout is still on the branch it found there:
      // not its own, so not recorded. Any other session: as always.
      branch: async (dir) => {
        const s = latest?.sessions.find((x) => x.sessionId === sessionId) ?? null;
        const head = await run("git", ["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: 10_000 });
        // 0: a branch; 1: a detached HEAD; anything else (no repo, a timeout): not known.
        const now = head.code === 0 ? head.stdout.trim() || undefined : head.code === 1 ? null : undefined;
        return sources.ownsBranch(dir, s, now, false) ? branchKey(run, dir) : "";
      },
      moves: (sid) => workflows().builtinsFor(sid).includes("ticket"),
      mark: (sid, trigger) => sources.markReached(sid, trigger),
      reload: () => sources.reloadLinks(),
      noteStatus: (tk, s) => sources.noteStatus(tk, s),
      boardless: (tk) => repoBoardless(tk.repo, getConfig()),
      // An issue of a selected repository that no board holds (the Board's repository view shows these).
      offBoard: (tk) => offBoardOk(tk.repo, getConfig()),
    },
    t,
    sessionId,
    cwd,
  );
  if (r.ok) linkedSteps.queue(sessionId);
  return r;
}

/** Is `pid` a running claude process? Guards the stop against a pid reused by something else. */
async function isClaudePid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") {
    const r = await run(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { timeoutMs: 10_000 },
    );
    const image = tasklistImage(r.stdout);
    return image !== null && isClaudeCommand(image);
  }
  const r = await run("ps", ["-p", String(pid), "-o", "comm="], {
    timeoutMs: 10_000,
  });
  return r.code === 0 && isClaudeCommand(r.stdout);
}

async function stopPid(pid: number): Promise<void> {
  if (process.platform === "win32")
    await run("taskkill", ["/PID", String(pid)], { timeoutMs: 10_000 });
  else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 20 && (await isClaudePid(pid)); i++)
    await new Promise((r) => setTimeout(r, 250));
}

/**
 * Start a session that is running in another terminal here: resume its conversation as a
 * background session (then the tab attaches it). With `stopOther`, first stop the other copy,
 * but only when its pid really is a claude process.
 */
/** `claude --bg --resume <id>`: continue a stopped session in the background under the same id (resumeAs: no flags, so no copy). */
async function resumeBg(
  id: string,
  name: string,
  cwd: string | null,
  account: string | null = null,
  key: string | null = null,
  grantMaster = false,
): Promise<CliResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return { ok: false, message: "bad session id" };
  // As listed before the resume (see grantMaster below).
  const wasRows = sources.sessionsNow();
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  // Bare (`claude --bg --resume <id>`) unless the account must change: see resumeAs.
  const r = await resumeAs(resumeDeps(dir), {
    id,
    key,
    name,
    cwd: dir,
    account,
  });
  if (r.ok) {
    // master-agent resumed: the reports guard lets it send anything at once. Only for the window
    // (never a remote caller), and only when the session list names this id as the master.
    if (
      grantMaster &&
      process.platform !== "win32" &&
      isMasterSession(wasRows, id, getConfig().masterName)
    )
      deckHooks.addMasterSession(id);
    void sources.refreshAgents();
  }
  return r.ok ? { ok: true, message: name } : r;
}

/** What resumeAs needs: the account resolved as for any session, recorded in sessionAccounts. */
function resumeDeps(dir: string): Parameters<typeof resumeAs>[0] {
  return {
    run,
    claude: claudeBin,
    accounts: sessionAccounts,
    settings: settingsFor,
    accountOf: async (s) => accountOfSession(s, await originNow(dir)),
    multi: () => isMulti(getConfig()),
    live: () => sources.sessionsNow(),
    refresh: () => sources.refreshAgents(),
    copied: (old, copy) => {
      superseded.add([old.bgId, old.sessionId]);
      sources.noteCopy(old, copy);
    },
  };
}

/** The Board's ticket sessions work here (one shared, or one per Board tab with two or more accounts; see ticketDirs.ts). */
const ticketRoot = () => join(paths.home, "ticket-builder");
let ticketPumping = false;
/** Create-with-Claude asks for a ticket: in each ticket folder, claim the request, create it as that folder's account, answer, log it. */
async function pumpTicketRequests(): Promise<void> {
  if (ticketPumping) return;
  ticketPumping = true;
  try {
    const cfg = getConfig();
    for (const dir of ticketDirs(paths.home, isMulti(cfg)))
      await pumpTicketDir(dir, (p, picked) =>
        // `account`: the tab's, so a tab without a board never puts a ticket on another account's.
        forAccount(ticketAccount(picked, p.repo || null, getConfig())).ops.create({ ...p, account: picked }),
      );
  } finally {
    ticketPumping = false;
  }
}
/** created.jsonl lines already seen, per ticket folder; the first read (launch) counts the old ones as seen. */
const ticketsSeen = new Map<string, number>();
let ticketsRead = false;
/** Tickets the Board's sessions created (a created.jsonl grew): refresh the board, and tell the page. */
function readCreatedTickets(): void {
  // Every folder, whatever the mode, so switching modes never re-announces old tickets.
  const fresh: string[] = [];
  for (const dir of [ticketRoot(), ...ticketDirs(paths.home, true)]) {
    const f = join(dir, "created.jsonl");
    let lines: string[];
    try {
      lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    const seen = ticketsSeen.get(f) ?? (ticketsRead ? 0 : lines.length);
    ticketsSeen.set(f, lines.length);
    if (lines.length > seen) fresh.push(...lines.slice(seen));
  }
  ticketsRead = true;
  const made = fresh.flatMap((l) => {
    try {
      const o = JSON.parse(l) as {
        ok?: boolean;
        url?: string;
        number?: number;
      };
      return o.ok && o.url ? [{ url: o.url, number: o.number ?? 0 }] : [];
    } catch {
      return [];
    }
  });
  if (!made.length) return;
  void sources.refreshGithub(true);
  emit(CH.ticketsCreated, made);
}

const repoMetaCache = new Map<
  string,
  {
    at: number;
    meta: { labels: string[]; milestones: string[]; assignees: string[] };
  }
>();

/** The Workflow window's builder session works here: its CLAUDE.md, current.json, drafts. */
const builderDir = () => join(paths.home, "workflow-builder");

/** The builder's latest draft, checked; null when there is none (or it was applied or discarded). */
let builderDraft: WorkflowDraft | null = null;
let draftSig = "";
const draftSkillsDir = () => join(builderDir(), "skills");
const draftMonitorsDir = () => join(builderDir(), "monitors");

/** The monitors a draft defines, each with its script (monitors/<id>.sh) read and syntax-checked. */
function draftMonitors(defs: MonitorDef[]): DraftMonitor[] {
  return defs.map((d) => {
    const path = join(draftMonitorsDir(), `${d.id}.sh`);
    let script: string | null = null;
    try {
      script = readFileSync(path, "utf8");
    } catch {
      /* not written */
    }
    let syntax: string | null = null;
    if (script !== null) {
      const r = spawnSync("bash", ["-n", path], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (r.status !== 0) syntax = (r.stderr || "does not parse").trim();
    }
    return readDraftMonitor({ ...d, path }, script, syntax);
  });
}

/** The skills the builder wrote (skills/<name>/), each read and checked. */
function draftSkills(): DraftSkill[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(draftSkillsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  return dirs.map((name) => {
    const dir = join(draftSkillsDir(), name);
    let text: string | null = null;
    try {
      text = readFileSync(join(dir, "SKILL.md"), "utf8");
    } catch {
      /* none yet */
    }
    let files = 0;
    try {
      files = readdirSync(dir, { recursive: true }).length;
    } catch {
      /* gone */
    }
    return readDraftSkill(name, text, files);
  });
}

/** What changed in the builder's folder: the draft and its skills (names, times). */
function draftSignature(): string {
  const parts: string[] = [];
  try {
    parts.push(String(statSync(join(builderDir(), "draft.json")).mtimeMs));
  } catch {
    return "";
  }
  for (const dir of [draftSkillsDir(), draftMonitorsDir()])
    try {
      for (const e of readdirSync(dir, { recursive: true }).map(String).sort())
        parts.push(`${dir}/${e}:${statSync(join(dir, e)).mtimeMs}`);
    } catch {
      /* none */
    }
  return parts.join("|");
}

function readDraft(force = false): void {
  const f = join(builderDir(), "draft.json");
  const sig = draftSignature();
  if (!sig) {
    if (builderDraft) {
      builderDraft = null;
      emit(CH.workflowDraft, null);
    }
    draftSig = "";
    return;
  }
  if (sig === draftSig && !force) return;
  draftSig = sig;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    // Mid-write, or not JSON: say so, for the builder to fix.
    writeFileSync(
      join(builderDir(), "check.json"),
      JSON.stringify(
        {
          ok: false,
          problems: [`draft.json is not valid JSON: ${String(e)}`],
          dropped: [],
          warnings: [],
          plans: [],
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const skills = draftSkills();
  const installed = listSkills(paths.skillsDir, dirname(paths.claudeSettings), [
    paths.masterWorkspace,
    ...ops.repos(),
  ]).map((x) => x.name);
  const norm = normalizeDraft(raw);
  const monitors = draftMonitors(norm.monitors);
  const check = checkDraft(raw, {
    library: workflows().triggers(),
    installedSkills: installed,
    skills,
    monitorLibrary: workflows().monitors(),
    monitors,
  });
  writeFileSync(
    join(builderDir(), "check.json"),
    JSON.stringify(check, null, 2) + "\n",
  );
  const { name, flow, triggers } = norm;
  builderDraft = {
    name,
    flow,
    triggers,
    skills,
    monitors,
    check,
    at: Date.now(),
  };
  emit(CH.workflowDraft, builderDraft);
}

/** Throw the builder's draft away: the workflow, its triggers and its skills (nothing was installed). */
function clearDraft(): void {
  for (const f of ["draft.json", "check.json"])
    try {
      unlinkSync(join(builderDir(), f));
    } catch {
      /* already gone */
    }
  rmSync(draftSkillsDir(), { recursive: true, force: true });
  rmSync(draftMonitorsDir(), { recursive: true, force: true });
  readDraft(true);
}

/** The workflows: the default, templates, and each session's copy (hooks in ~/.claude/settings.json). */
let workflowStore: WorkflowStore | null = null;
const workflows = () => (workflowStore ??= new WorkflowStore(paths.home));
/** Put the trigger hooks in (or take them out when no workflow has a step). */
/**
 * Put the workflow hooks in: one per built-in trigger, and one per event the custom triggers use.
 * The custom trigger library is registered first, so compiling and the editor know it.
 */
const syncWorkflowHooks = () => {
  const customs = workflows().triggers();
  setCustomTriggers(customs);
  setMonitors(workflows().monitors());
  return installWorkflowHooks(
    paths.claudeSettings,
    paths.home,
    paths.home,
    true,
    customs.map((c) => c.event),
  );
};

/** The needs-you and idle triggers: MasterDeck acts on them itself (notifications, a message). */
let watch: Record<string, WatchState> = {};
function runFlowWatch(state: AppState): void {
  const live = state.sessions.filter(
    (s) =>
      s.name !== MASTER_NAME && s.state !== "done" && s.state !== "suspended",
  );
  const r = flowActions(
    watch,
    live.map((s) => ({
      key: s.key,
      status: sessionStatus(
        s,
        state.prStage[s.key],
        attentionFor(s, state.proposals),
        state.manualStatus[s.key],
      ).key,
    })),
    (key) => {
      const s = live.find((x) => x.key === key);
      return s ? workflows().compiledFor(s.sessionId) : [];
    },
    Date.now(),
  );
  watch = r.next;
  const masterUp =
    state.master.kind === "attached" || state.master.kind === "elsewhere";
  for (const a of r.actions) {
    const s = live.find((x) => x.key === a.key);
    if (!s) continue;
    workflows().logRun(s.sessionId, a.trigger, [a.step]);
    notify(
      a.notify.map((body) => ({
        title: `${s.name}: workflow`,
        body,
        target: { sessionKey: s.key },
      })),
    );
    if (a.message)
      void sender
        .send(s, `Workflow step (idle): ${a.message}`, masterUp)
        .then((res) => {
          if (!res.ok)
            console.error(`workflow message to ${s.name}: ${res.message}`);
        });
  }
}

/** Which skills the user removed in the Skills popup. */
const skillsFile = () => join(paths.home, "skills.json");

function refreshSkills(): void {
  sources.setSkills(
    syncSkills(
      paths.bundledSkills,
      paths.skillsDir,
      app.getVersion(),
      readRemoved(skillsFile()),
    ).skills,
  );
}

async function startHere(o: {
  sessionId: string;
  name: string;
  cwd: string;
  pid: number | null;
  stopOther: boolean;
}): Promise<CliResult> {
  if (!/^[0-9a-f-]{36}$/i.test(o.sessionId))
    return { ok: false, message: "bad session id" };
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(o.name))
    return { ok: false, message: `bad session name: ${o.name}` };
  if (o.stopOther && o.pid !== null) {
    if (!(await isClaudePid(o.pid)))
      return {
        ok: false,
        message: `pid ${o.pid} is not a running claude process; nothing was stopped`,
      };
    await stopPid(o.pid);
    if (await isClaudePid(o.pid))
      return {
        ok: false,
        message: `pid ${o.pid} did not stop; close it in its terminal and try again`,
      };
  }
  const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : homedir();
  const r = await resumeAs(resumeDeps(cwd), {
    id: o.sessionId,
    key: null,
    name: o.name,
    cwd,
    account: null,
  });
  return r.ok
    ? { ok: true, message: r.stdout.trim().split("\n")[0] ?? "started" }
    : r;
}

/** Transcripts read for the History reader, by path and mtime; the last few are kept. */
const transcriptCache = new Map<
  string,
  { mtime: number; messages: TranscriptMessage[] }
>();
async function readTranscript(path: string): Promise<TranscriptMessage[]> {
  const st = statSync(path);
  const hit = transcriptCache.get(path);
  if (hit && hit.mtime === st.mtimeMs) return hit.messages;
  const text = await readFile(path, "utf8");
  const messages = transcriptMessages(text.split("\n"));
  transcriptCache.delete(path);
  transcriptCache.set(path, { mtime: st.mtimeMs, messages });
  while (transcriptCache.size > 3)
    transcriptCache.delete(transcriptCache.keys().next().value!);
  return messages;
}

async function openEditor(dir: string): Promise<CliResult> {
  return openInEditor(run, dir, join(paths.home, "editor-probe"), (p) =>
    shell.openPath(p),
  );
}

let masterStartingUntil = 0;

/**
 * Start master-agent in the background. Refused unless the session list is known to be current and
 * shows no master, and locked for 90 s after a start so a second click cannot start a second master
 * (two sessions named master-agent make the CLI refuse every write).
 */
async function startMaster(): Promise<CliResult> {
  if (!getConfig().masterEnabled)
    return {
      ok: false,
      message:
        "master-agent is turned off (Settings → Set up MasterDeck → Preferences)",
    };
  if (!sources.isHealthy("agents"))
    return {
      ok: false,
      message: "the session list is not loaded yet; try again in a few seconds",
    };
  if (latest && latest.master.kind !== "absent")
    return { ok: false, message: `master is already ${latest.master.kind}` };
  if (Date.now() < masterStartingUntil)
    return { ok: false, message: "master-agent is already starting" };
  masterStartingUntil = Date.now() + 90_000;
  // The primary account; master starts even when it needs to log in again (its sweeps read each
  // account with that account's own token, so its own env matters little).
  const as = isMulti(getConfig()) ? accountEnv.settingsArgs(null) : null;
  const asArgs = as?.ok ? as.args : [];
  const r = await run(claudeBin, ["--bg", ...asArgs, "-n", MASTER_NAME, "/master"], {
    cwd: paths.masterWorkspace,
    timeoutMs: 60_000,
  });
  if (r.code !== 0) masterStartingUntil = 0;
  else if (as?.ok && as.account) {
    // Recorded as the primary, so Needs you can tell a master-agent started without it (by hand,
    // or before a second account) and ask for a restart.
    const bg = bgIdFromOutput(r.stdout);
    if (bg) sessionAccounts.set([bg], as.account);
    sessionAccounts.expect(MASTER_NAME, as.account);
  }
  // The reports guard lets the master send anything: known at once, not at the next poll.
  if (r.code === 0 && process.platform !== "win32") {
    const bg = bgIdFromOutput(r.stdout);
    if (bg) deckHooks.addMasterSession(bg);
  }
  return r.code === 0
    ? { ok: true, message: r.stdout.trim() }
    : { ok: false, message: (r.stderr || r.stdout).trim() };
}

/** Folders live sessions work in (a worktree containing one is IN USE), from the main process's own state. */
function liveDirs(): string[] {
  const s = latest;
  if (!s) return [];
  const dirs: string[] = [];
  for (const x of s.sessions) {
    if (x.state === "done") continue;
    if (x.cwd) dirs.push(x.cwd);
    const cur = s.stats[x.sessionId]?.currentDir ?? s.tails[x.sessionId]?.cwd;
    if (cur) dirs.push(cur);
  }
  for (const g of Object.values(s.git)) dirs.push(g.dir);
  return dirs;
}

function registerIpc(): void {
  reg.handle(CH.getState, () => latest);
  reg.handle(CH.approve, (_e, id: number) => cli.approve([id]));
  reg.handle(CH.reject, (_e, id: number) => cli.reject([id]));
  reg.handle(
    CH.draftAssign,
    (e, issue: unknown, title?: string, url?: string, cwd?: unknown) => {
      const t = asTicket(issue);
      if (!t) return { ok: false, message: "bad issue" };
      // Choosing a folder is the desktop's: a browser's is dropped, the window's must be a real folder.
      const dir = chosenFolder(isRemote(e), cwd);
      return dir.ok ? cli.draftAssign(t, title, url, dir.cwd) : dir;
    },
  );
  reg.on(CH.setSprint, (_e, sprint: string) => sources.setSprint(sprint));
  reg.handle(CH.sendText, async (_e, key: string, text: string) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return { ok: false, message: "session not found" };
    const masterUp =
      latest?.master.kind === "attached" || latest?.master.kind === "elsewhere";
    return sender.send(s, text, !!masterUp);
  });
  reg.handle(
    CH.answerMenu,
    (_e, key: string, question: string | null, answer: unknown) =>
      answerMenuFor(String(key), question, answer),
  );
  reg.handle(
    CH.inboxAct,
    async (e, id: unknown, type: unknown, payload: unknown) => {
      // The web app's actions run as the window's, as always; only opening Claude on the Mac is refused for it.
      const c = inboxActCall(isRemote(e), id, type, payload);
      return c.ok ? inboxAct(c.id, c.type, c.payload) : c;
    },
  );
  reg.handle(CH.queueList, (_e, sessionId: string) =>
    readQueue(String(sessionId)),
  );
  reg.handle(CH.queueEdit, (_e, sessionId: string, edit: QueueEdit) =>
    isQueueEdit(edit)
      ? editQueue(String(sessionId), edit)
      : { ok: false, message: "bad queue edit", items: [] },
  );
  reg.handle(CH.queueSendNext, async (_e, key: string) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return { ok: false, message: "session not found" };
    const next = shiftQueue(s.sessionId);
    if (next === null) return { ok: false, message: "the queue is empty" };
    const masterUp =
      latest?.master.kind === "attached" || latest?.master.kind === "elsewhere";
    const r = await sender.send(s, next, !!masterUp);
    // Not sent: back to the front, so the Stop hook still runs it later.
    if (!r.ok) unshiftQueue(s.sessionId, next);
    return r;
  });
  reg.handle(CH.getSettings, () => sources.getSettings());
  reg.handle(CH.setStatus, async (_e, issue: unknown, status: string) => {
    const t = asTicket(issue);
    if (!t) return { ok: false, message: "bad issue" };
    // No board on its account: the columns are MasterDeck's own, there is nothing to write.
    // Asked of the account the write below goes out as (`accountForCard`), never just of the repository's.
    if (cardBoardless(t.repo, sources.boardOf(t.repo, t.number), getConfig()))
      return { ok: false, message: "this account has no GitHub board; MasterDeck works out its columns" };
    const r = await forCard(t.repo, t.number).ops.setStatus(t, status);
    if (r.ok) sources.noteStatus(t, status);
    return r;
  });
  reg.handle(
    CH.standupCommits,
    (e, since: number, dirs: string[], until?: number) =>
      ops.standupCommits(
        since,
        [
          ...(isRemote(e)
            ? knownDirsOnly(dirs, [
                ...liveDirs(),
                ...(latest?.sessions ?? []).flatMap((x) => (x.cwd ? [x.cwd] : [])),
                ...ops.repos(),
              ])
            : dirs),
          ...ops.repos(),
        ],
        until,
      ),
  );
  reg.handle(CH.janitor, (_e, dirs: string[], force?: boolean) =>
    ops.janitor(dirs, force === true),
  );
  reg.handle(
    CH.removeWorktree,
    (_e, repo: string, path: string, force: boolean) =>
      ops.removeWorktree(repo, path, force, liveDirs()),
  );
  reg.handle(CH.removeSession, (_e, bgId: string) =>
    ops.removeSession(bgId),
  );
  reg.handle(CH.searchHistory, (_e, q: string) => ops.searchHistory(q));
  reg.handle(
    CH.historyTranscript,
    async (_e, p: unknown, query: unknown, focus: unknown) => {
      // A session transcript under ~/.claude/projects only; the renderer names it from a search hit.
      if (typeof p !== "string" || !p.endsWith(".jsonl")) return null;
      const full = resolve(p);
      if (!full.startsWith(resolve(paths.projectsDir) + sep)) return null;
      try {
        const all = await readTranscript(full);
        return transcriptWindow(
          all,
          typeof query === "string" ? query : "",
          typeof focus === "string" ? focus : null,
        );
      } catch {
        return null;
      }
    },
  );
  reg.handle(CH.templates, () => ops.templates());
  reg.handle(CH.saveTemplate, (_e, t: { name: string; text: string }) =>
    ops.saveTemplate(t),
  );
  reg.handle(CH.deleteTemplate, (_e, name: string) =>
    ops.deleteTemplate(name),
  );
  // Notes: the store checks every argument itself (ids, limits, characters).
  reg.handle(CH.notesList, () => notes.list());
  reg.handle(CH.notesGet, (_e, id: unknown) => notes.get(id));
  reg.handle(CH.notesSearch, (_e, query: unknown) => notes.search(query));
  reg.handle(CH.notesSave, (_e, input: unknown) => notes.save(input));
  reg.handle(CH.notesDelete, async (e, id: unknown) => {
    const note = notes.get(id);
    if (!note) return notes.delete(id);
    // From a browser: the web UI asked first; no native dialog on the Mac.
    const choice = isRemote(e) ? { response: 1 } : await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: ["Cancel", "Delete note"],
      defaultId: 0,
      cancelId: 0,
      message: note.ticket
        ? `Delete the note for ${note.ticket.repo}#${note.ticket.number}?`
        : `Delete "${note.title.trim() || "Untitled"}"?`,
      detail: "The note is removed from this Mac. This cannot be undone.",
    });
    if (choice.response !== 1) return { ok: false, message: "cancelled" };
    return notes.delete(id);
  });
  // New ticket (Board): an issue created, put on the board with its status and sprint, by
  // BoardOps.create (the Board's Claude session asks for it through create-ticket.sh).
  reg.handle(CH.ticketCreate, async (_e, raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown, n: number) =>
      typeof v === "string" ? v.slice(0, n) : "";
    const list = (v: unknown) =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string" && !!x.trim())
            .slice(0, 20)
        : [];
    const title = str(o.title, 256).trim();
    if (!title) return { ok: false, message: "give it a title" };
    // The account picked in the dialog creates it (a connected one); else the repo's account.
    const res = await forAccount(
      ticketAccount(str(o.account, 100) || null, str(o.repo, 140) || null, getConfig()),
    ).ops.create({
      title,
      body: str(o.body, 60_000),
      repo: str(o.repo, 140) || undefined,
      project: str(o.project, 140) || undefined,
      status: str(o.status, 100) || undefined,
      assignees: list(o.assignees),
      labels: list(o.labels),
      milestone: str(o.milestone, 200) || undefined,
      sprint: str(o.sprint, 200) || undefined,
      sprintField: str(o.sprintField, 100) || undefined,
      dryRun: o.dryRun === true,
      account: str(o.account, 100) || null,
    });
    if (!res.ok)
      return {
        ok: false,
        message: `${res.error}${res.url ? `: ${res.url}` : ""}`,
        url: res.url,
      };
    if (!res.dryRun) void sources.refreshGithub(true);
    const extra = [
      res.status ? `in ${res.status}` : "",
      res.sprint
        ? `sprint ${res.sprint === "@current" ? "(current)" : res.sprint}`
        : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      ok: true,
      message: res.dryRun
        ? "checked (dry run)"
        : `created #${res.number}${extra ? ` ${extra}` : ""}`,
      url: res.url,
      number: res.number,
    };
  });
  // Create with Claude (Board): the ticket session's folder gets the boards, the people, where
  // the + was clicked, and a create command it may run without asking.
  reg.handle(CH.ticketBuilderPrepare, (_e, ctx: unknown) => {
    const cfg = latest?.config;
    if (!cfg)
      return {
        ok: false,
        message: "the board is not loaded yet",
        canContinue: false,
      };
    // Two or more accounts: the tab's own folder (its session runs as the tab's account).
    let dir: string;
    try {
      dir = ticketBuilderDir(
        paths.home,
        (ctx as { tabId?: string } | null)?.tabId ?? null,
        isMulti(cfg),
      );
    } catch (e) {
      return { ok: false, message: (e as Error).message, canContinue: false };
    }
    if (!ticketDirOk(paths.home, dir))
      return { ok: false, message: "refusing a ticket builder folder that is a link", canContinue: false };
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const script = join(dir, "create-ticket.sh");
    writeFileSync(script, ticketBuilderScript(dir));
    chmodSync(script, 0o755);
    // The Bash it may run unasked: the create command, and reading GitHub.
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        {
          permissions: {
            allow: [
              "Bash(./create-ticket.sh:*)",
              `Bash(${script}:*)`,
              "Bash(gh issue view:*)",
              "Bash(gh issue list:*)",
              "Bash(gh label list:*)",
              "Bash(gh search issues:*)",
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    const people = [
      ...new Set([
        ...(latest?.me ? [latest.me] : []),
        ...(latest?.board?.cards.flatMap((c) => c.assignees) ?? []),
      ]),
    ];
    writeFileSync(
      join(dir, "CLAUDE.md"),
      // The tab's account: one with no board gets only its own repositories, and no board.
      ticketContext(
        cfg,
        latest?.sprints ?? [],
        people,
        latest?.me ?? null,
        typeof (ctx as { account?: unknown } | null)?.account === "string"
          ? (ctx as { account: string }).account
          : null,
      ),
    );
    writeFileSync(
      join(dir, "context.json"),
      JSON.stringify(ctx ?? {}, null, 2) + "\n",
    );
    const proj = join(paths.projectsDir, dir.replace(/[^A-Za-z0-9]/g, "-"));
    let canContinue = false;
    try {
      canContinue = readdirSync(proj).some((f) => f.endsWith(".jsonl"));
    } catch {
      /* first time */
    }
    return { ok: true, message: "ready", canContinue };
  });
  // Labels, milestones and people who can be assigned in a repo (the New ticket dialog), cached a while.
  reg.handle(CH.ticketRepoMeta, async (_e, repo: unknown) => {
    if (
      typeof repo !== "string" ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)
    )
      return { labels: [], milestones: [], assignees: [] };
    const hit = repoMetaCache.get(repo);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.meta;
    const lines = async (args: string[]) => {
      const r = await ghDirect(repo, args, { timeoutMs: 30_000 });
      return r.code === 0
        ? r.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    };
    const [labels, milestones, assignees] = await Promise.all([
      lines([
        "label",
        "list",
        "-R",
        repo,
        "--limit",
        "200",
        "--json",
        "name",
        "-q",
        ".[].name",
      ]),
      lines([
        "api",
        `repos/${repo}/milestones?state=open&per_page=100`,
        "-q",
        ".[].title",
      ]),
      lines(["api", `repos/${repo}/assignees?per_page=100`, "-q", ".[].login"]),
    ]);
    const meta = {
      labels: labels.sort((a, b) => a.localeCompare(b)),
      milestones,
      assignees: assignees.sort((a, b) => a.localeCompare(b)),
    };
    repoMetaCache.set(repo, { at: Date.now(), meta });
    return meta;
  });
  // The + menu: the workspace and its repos, to open a terminal or a session in.
  reg.handle(CH.workspaceRepos, () => {
    const seen = new Set<string>();
    return [paths.masterWorkspace, ...ops.repos()]
      .filter((p) => typeof p === "string" && p && existsSync(p))
      .map((p) => resolve(p))
      .filter((p) => !seen.has(p) && seen.add(p))
      .map((p) => ({ name: basename(p), path: p }));
  });
  // A Claude session without a ticket: `claude --bg -n <name> [--model] [first message]` in a folder.
  reg.handle(CH.startClaude, async (_e, raw: unknown) => {
    const o = (raw ?? {}) as {
      name?: unknown;
      cwd?: unknown;
      prompt?: unknown;
      model?: unknown;
      workflow?: unknown;
      mode?: unknown;
      account?: unknown;
      peers?: unknown;
    };
    const mode =
      typeof o.mode === "string" &&
      ["plan", "acceptEdits", "auto", "manual"].includes(o.mode)
        ? o.mode
        : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
      return {
        ok: false,
        message: "name: letters, digits, dot, dash and underscore",
      };
    if (latest?.sessions.some((s) => s.name === name && s.state !== "done"))
      return {
        ok: false,
        message: `a session named ${name} is already running`,
      };
    const cwd = typeof o.cwd === "string" ? o.cwd : "";
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory())
      return { ok: false, message: "pick a folder that exists" };
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
    // A message starting with "-" would read as a flag.
    if (prompt.startsWith("-"))
      return { ok: false, message: "the first message can't start with -" };
    const model =
      typeof o.model === "string" && /^[\w.[\]-]{1,80}$/.test(o.model)
        ? o.model
        : "";
    const as = await settingsFor(
      typeof o.account === "string" ? o.account : null,
      () =>
        originNow(cwd).then((origin) =>
          defaultAccount({ origin }, getConfig()),
        ),
    );
    if (!as.ok) return { ok: false, message: as.message };
    if (
      typeof o.workflow === "string" &&
      o.workflow &&
      o.workflow !== DEFAULT_TEMPLATE
    )
      workflows().setPending(name, o.workflow);
    const linked = livePeerKeys(o.peers);
    if (linked.length) peerStore.expect(name, linked);
    const r = await run(
      claudeBin,
      [
        "--bg",
        ...as.args,
        "-n",
        name,
        ...(model ? ["--model", model] : []),
        ...(mode ? ["--permission-mode", mode] : []),
        ...(prompt ? [prompt] : []),
      ],
      {
        cwd,
        timeoutMs: 60_000,
      },
    );
    if (r.code !== 0)
      return {
        ok: false,
        message: (r.stderr || r.stdout).trim().slice(0, 300),
      };
    if (as.account) {
      // On disk at once when claude printed the bg id (a quit before the first claim keeps it).
      const bg = bgIdFromOutput(r.stdout);
      if (bg) sessionAccounts.set([bg], as.account);
      sessionAccounts.expect(name, as.account);
    }
    void sources.refreshAgents();
    return { ok: true, message: name };
  });
  reg.handle(
    CH.resumeSession,
    (e, id: string, name: string, cwd: string | null, account?: unknown) =>
      resumeBg(
        id,
        name,
        cwd,
        typeof account === "string" && account ? account : null,
        null,
        !isRemote(e),
      ),
  );
  // A new session's account for a folder (its origin remote's account, else the primary).
  reg.handle(CH.accountFor, async (_e, cwd: unknown) =>
    typeof cwd === "string" && cwd && isMulti(getConfig())
      ? defaultAccount({ origin: await originNow(cwd) }, getConfig())
      : null,
  );
  reg.handle(CH.resumeStopped, () => sources.resumeStopped());
  reg.handle(CH.tokensByDay, (_e, ids: unknown) =>
    sources.tokensByDay(Array.isArray(ids) ? ids : []),
  );
  // Working hours (issue #64) stay on this Mac: DECK_ACCESS blocks both, and main refuses a remote call too.
  reg.handle(CH.hoursActivity, async (e, ids: unknown) => {
    if (isRemote(e)) return {};
    const raw = await sources.hoursActivity(Array.isArray(ids) ? ids : []);
    // One origin lookup per folder, all at once (originNow caches them).
    const entries = await Promise.all(
      Object.entries(raw).map(async ([id, a]): Promise<[string, SessionActivity]> => [
        id,
        {
          spans: a.spans,
          account: hoursAccount(
            {
              recorded: sessionAccounts.get({ sessionId: id, key: a.key }),
              origin: a.cwd ? await originNow(a.cwd) : null,
            },
            getConfig(),
          ),
        },
      ]),
    );
    return Object.fromEntries(entries);
  });
  reg.handle(CH.hoursExport, async (e, csv: unknown, name: unknown) => {
    if (isRemote(e) || typeof csv !== "string" || csv.length > 5_000_000)
      return null;
    const file =
      typeof name === "string" && /^[\w.-]{1,80}\.csv$/.test(name)
        ? name
        : "hours.csv";
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath("downloads"), file),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, csv);
    return r.filePath;
  });
  reg.handle(CH.dismissStopped, () => sources.dismissStopped());
  reg.handle(CH.setSettings, (e, s: unknown) =>
    sources.setSettings(
      isRemote(e) ? remoteSettings(s, sources.getSettings()) : s,
    ),
  );
  reg.handle(CH.watchStop, (_e, id: unknown) =>
    typeof id === "string"
      ? id.startsWith("pr:")
        ? prWatch.stop(id)
        : watches.stop(id)
      : false,
  );
  reg.handle(CH.startHere, (_e, o: Parameters<typeof startHere>[0]) =>
    startHere(o),
  );
  reg.handle(CH.prSummary, (_e, url: string) =>
    // A PR of a repository no account lists: as the account whose board holds a card of that repository.
    forCard(prRepo(String(url))).github.prSummary(url),
  );
  // Only the workspace from Setup: + Shell opens there, and nothing else should be switched.
  reg.handle(CH.shellPrepare, (_e, dir: unknown) =>
    typeof dir === "string" && dir && dir === getConfig().workspace
      ? toDefaultBranch(run, dir)
      : { ok: true, message: null },
  );
  reg.handle(CH.ticketMemory, (_e, ticket: unknown) => {
    const t = asTicket(ticket);
    return t ? sources.ticketMemory(t) : [];
  });
  reg.handle(CH.issueBody, (_e, ticket: unknown) => {
    const t = asTicket(ticket);
    return t
      ? forCard(t.repo, t.number).github.issueBody(t)
      : { ok: false, message: "bad ticket" };
  });
  // The Assign popup's people: the card's repository's, read as that repository's account (also
  // from the web: a read; the repository is checked in AssignableUsers.get).
  reg.handle(CH.assignableUsers, (_e, repo: unknown) => assignableUsers.get(repo));
  reg.handle(
    CH.assignIssue,
    async (_e, issue: unknown, login: string, current: string[]) => {
      const t = asTicket(issue);
      if (!t) return { ok: false, message: "bad issue" };
      const r = await forCard(t.repo, t.number).github.assign(t, login, current);
      if (r.ok) sources.noteAssigned(t, login);
      return r;
    },
  );
  // The Start dialog's "Create worktree": only from the Mac's own window (a folder on this Mac).
  reg.handle(CH.worktreeInfo, (e, cwd: unknown) => {
    const dir = worktreeFolder(isRemote(e), cwd);
    return dir.ok ? worktreeInfo(run, dir.cwd) : dir;
  });
  reg.handle(CH.worktreeCreate, (e, cwd: unknown, branch: unknown, base: unknown) => {
    const dir = worktreeFolder(isRemote(e), cwd);
    return dir.ok ? createWorktree(run, dir.cwd, branch, base) : dir;
  });
  reg.handle(CH.assign, (_e, given: AssignRequest) => {
    // Only a mode the Start dialog offers: the web reaches this handler too.
    const req: AssignRequest = { ...given, permissionMode: isPermissionMode(given?.permissionMode) && given.permissionMode ? given.permissionMode : undefined };
    // The template picked in the Start dialog: the new session copies it instead of the default.
    if (
      typeof req?.workflow === "string" &&
      req.workflow !== DEFAULT_TEMPLATE &&
      typeof req.name === "string"
    )
      workflows().setPending(req.name, req.workflow);
    const peers = livePeerKeys(given?.peers);
    if (peers.length && typeof req.name === "string") peerStore.expect(req.name, peers);
    return assignNow(req);
  });
  reg.handle(CH.defaultModel, () => configuredModel(paths.claudeSettings));
  // The Refresh buttons: fetch from GitHub even when the shared gh cache has an answer.
  reg.handle(CH.refresh, async () => {
    await refreshAccounts();
    return sources.refreshGithub(true, true);
  });
  reg.handle(CH.boardRefresh, () => sources.refreshGithub(true, true));
  reg.handle(CH.setupCheck, () => setupCheck());
  reg.handle(CH.setupTool, (_e, tool: SetupTool) => setupTool(tool));
  reg.handle(CH.ghAccounts, () => ghAccounts());
  // Setup: a newly connected account's commit identity (GitHub name, noreply email; editable there).
  reg.handle(CH.ghUser, async (_e, login: unknown) => {
    if (typeof login !== "string" || !GH_LOGIN.test(login))
      return { name: "", email: "" };
    const tok = await tokenEnv(login);
    const env = tok && { ...tok, GHC_ACCOUNT: login };
    // No token: no read at all (never gh's active account); a token for another login is ignored.
    const got = env
      ? parseGhUser((await run("gh", ["api", "user"], { env, timeoutMs: 20_000 })).stdout)
      : null;
    const u = got && got.login.toLowerCase() === login.toLowerCase() ? got : null;
    return { name: u?.name ?? login, email: noreplyEmail(login, u?.id ?? null) };
  });
  reg.handle(CH.ghOwners, async () => {
    // Straight to gh, not the shared cache (no account here).
    const [user, orgs] = await Promise.all([
      run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 }),
      run("gh", ["api", "user/orgs", "--paginate", "--jq", ".[].login"], {
        timeoutMs: 30_000,
      }),
    ]);
    const login = user.stdout.trim();
    if (user.code !== 0 || !/^[A-Za-z0-9-]{1,39}$/.test(login))
      return {
        user: null,
        orgs: [],
        error:
          (user.stderr || user.stdout).trim().slice(0, 300) ||
          "gh is not logged in",
      };
    return {
      user: login,
      orgs: orgs.stdout
        .split("\n")
        .map((x) => x.trim())
        .filter((x) => /^[A-Za-z0-9-]{1,39}$/.test(x)),
      ...(orgs.code !== 0
        ? {
            error: `organizations: ${(orgs.stderr || orgs.stdout).trim().slice(0, 200)}`,
          }
        : {}),
    };
  });
  // As the account Setup shows (its token, read-only, even with one account); from a browser only
  // for connected accounts. No login: gh's active account.
  reg.handle(CH.configDetectAll, async (e, login: unknown) => {
    const r = await detectEnv(
      login,
      isRemote(e),
      getConfig().accounts.map((a) => a.login),
      tokenEnv,
    );
    return "error" in r
      ? { ok: false as const, message: r.error }
      : cli.configDetectAll(r.env);
  });
  reg.handle(CH.configDetect, (_e, owner: unknown, project: unknown) =>
    typeof owner === "string"
      ? cli.configDetect(
          owner.trim(),
          typeof project === "number" ? project : undefined,
        )
      : { ok: false, message: "owner required" },
  );
  reg.handle(CH.configSave, async (_e, patch: unknown) => {
    const r = await cli.configSave(patch);
    if (r.ok) sources.loadConfig();
    return r;
  });
  reg.handle(CH.trust, (e, cwd: unknown, wait: unknown) => {
    if (isRemote(e) || typeof cwd !== "string") return null;
    return cli.trust(cwd, typeof wait === "number" && wait > 0 ? wait : 0);
  });
  reg.handle(CH.openClaudeIn, (e, cwd: unknown) => openClaude(cwd, isRemote(e)));
  reg.handle(CH.pickFolder, async (_e, start: unknown) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: typeof start === "string" && start ? start : homedir(),
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  reg.handle(CH.skillReinstall, (_e, name: unknown) => {
    if (typeof name !== "string")
      return { ok: false, message: "bad skill name" };
    const r = reinstallSkill(
      paths.bundledSkills,
      paths.skillsDir,
      name,
      app.getVersion(),
    );
    // Added back: no longer one the user removed.
    if (r.ok)
      writeRemoved(
        skillsFile(),
        readRemoved(skillsFile()).filter((x) => x !== name),
      );
    refreshSkills();
    return r;
  });
  reg.handle(CH.summaryGet, (_e, key: string) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return { summary: null, stale: false };
    const summary = summaries.get(s.sessionId);
    const t = sources.sessionFacts(s.sessionId, s.key).transcript;
    const size = t && existsSync(t) ? statSync(t).size : 0;
    return { summary, stale: !!summary && size > summary.size };
  });
  reg.handle(CH.summaryMake, (_e, key: string) => makeSummaryFor(key));
  reg.handle(CH.summaryPost, async (_e, key: string) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return { ok: false, message: "session not found" };
    if (s.issue === null)
      return { ok: false, message: "this session is not linked to an issue" };
    const summary = summaries.get(s.sessionId);
    if (!summary) return { ok: false, message: "no summary yet" };
    const body = `### Session summary: ${s.name}\n\n${summary.text}\n\n<sub>Made by MasterDeck from the session's transcript.</sub>\n`;
    const r = await ghDirect(
      s.issueRepo ?? null,
      [
        "issue",
        "comment",
        String(s.issue),
        "-R",
        fullRepo(s.issueRepo),
        "--body-file",
        "-",
      ],
      { stdin: body, timeoutMs: 30_000 },
    );
    return r.code === 0
      ? { ok: true, message: r.stdout.trim() || "posted" }
      : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) };
  });
  reg.handle(CH.workflowGet, () => ({
    hooks: collectHooks(dirname(paths.claudeSettings), [
      paths.masterWorkspace,
      ...ops.repos(),
    ]),
    skills: listSkills(paths.skillsDir, dirname(paths.claudeSettings), [
      paths.masterWorkspace,
      ...ops.repos(),
    ]),
    flow: workflows().template(DEFAULT_TEMPLATE)?.flow ?? null,
    templates: workflows().templates(),
    triggers: workflows().triggers(),
    monitors: workflows().monitors(),
  }));
  reg.handle(CH.workflowSave, (_e, raw: unknown) => {
    workflows().saveTemplate(DEFAULT_TEMPLATE, "Default", parseFlow(raw));
    return syncWorkflowHooks();
  });
  reg.handle(
    CH.workflowTemplateSave,
    (_e, id: unknown, name: unknown, raw: unknown) => {
      const tid = workflows().saveTemplate(
        typeof id === "string" ? id : null,
        typeof name === "string" ? name : "",
        parseFlow(raw),
      );
      if (!tid) return { ok: false, message: "give the template a name" };
      const r = syncWorkflowHooks();
      return r.ok ? { ok: true, message: "template saved", id: tid } : r;
    },
  );
  reg.handle(CH.workflowTemplateDelete, (_e, id: unknown) => {
    if (typeof id !== "string" || !workflows().deleteTemplate(id))
      return { ok: false, message: "no such template" };
    syncWorkflowHooks();
    return { ok: true, message: "template deleted" };
  });
  // The builder: its folder gets the format, the skills and the open workflow before it starts.
  reg.handle(CH.workflowBuilderPrepare, (_e, templateId: unknown) => {
    const t =
      (typeof templateId === "string" && workflows().template(templateId)) ||
      workflows().template(DEFAULT_TEMPLATE);
    if (!t) return { ok: false, message: "no workflow", canContinue: false };
    const dir = builderDir();
    mkdirSync(dir, { recursive: true });
    const skills = listSkills(paths.skillsDir, dirname(paths.claudeSettings), [
      paths.masterWorkspace,
      ...ops.repos(),
    ]);
    writeFileSync(
      join(dir, "CLAUDE.md"),
      builderContext(
        skills,
        { id: t.id, name: t.name },
        workflows().triggers(),
        workflows().monitors(),
      ),
    );
    writeFileSync(
      join(dir, "current.json"),
      JSON.stringify({ id: t.id, name: t.name, flow: t.flow }, null, 2) + "\n",
    );
    // A chat to continue: Claude keeps this folder's transcripts under ~/.claude/projects.
    const proj = join(paths.projectsDir, dir.replace(/[^A-Za-z0-9]/g, "-"));
    let canContinue = false;
    try {
      canContinue = readdirSync(proj).some((f) => f.endsWith(".jsonl"));
    } catch {
      /* first time */
    }
    return { ok: true, message: "ready", canContinue };
  });
  reg.handle(CH.workflowDraftGet, () => builderDraft);
  // Discard asks first: it throws away the draft and every trigger and skill Claude made for it.
  reg.handle(CH.workflowDraftDiscard, async (e) => {
    const d = builderDraft;
    if (!d) {
      clearDraft();
      return { ok: true, message: "nothing to discard" };
    }
    const lines = [
      `The workflow${d.name ? ` "${d.name}"` : ""} (${d.flow.nodes.length} blocks)`,
      ...(d.triggers.length
        ? [
            `${d.triggers.length} new trigger${d.triggers.length === 1 ? "" : "s"}: ${d.triggers.map((t) => t.name).join(", ")}`,
          ]
        : []),
      ...(d.skills.length
        ? [
            `${d.skills.length} new skill${d.skills.length === 1 ? "" : "s"}: ${d.skills.map((x) => x.name).join(", ")}`,
          ]
        : []),
      ...(d.monitors.length
        ? [
            `${d.monitors.length} new monitor${d.monitors.length === 1 ? "" : "s"}: ${d.monitors.map((x) => x.def.name).join(", ")}`,
          ]
        : []),
    ];
    const choice = isRemote(e) ? { response: 1 } : await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: ["Cancel", "Discard"],
      defaultId: 0,
      cancelId: 0,
      message: "Discard Claude's draft?",
      detail: `This deletes:\n${lines.map((l) => `• ${l}`).join("\n")}\n\nNone of it was installed.`,
    });
    if (choice.response !== 1) return { ok: false, message: "cancelled" };
    clearDraft();
    return { ok: true, message: "discarded" };
  });
  // Apply (to the open workflow) or save as a new template: install the draft's triggers and
  // skills first, then save the workflow, then clear the draft.
  reg.handle(CH.workflowDraftApply, (_e, target: unknown) => {
    readDraft(true);
    const d = builderDraft;
    if (!d) return { ok: false, message: "no draft" };
    const t = (target ?? {}) as { templateId?: unknown; newName?: unknown };
    const clash = d.check.problems.find((p) => /already exists/.test(p));
    if (clash)
      return { ok: false, message: `${clash}. Ask the builder to rename it.` };
    const badMon = d.monitors.find((x) => x.problems.length);
    if (badMon)
      return {
        ok: false,
        message: `monitor ${badMon.def.id} is not ready: ${badMon.problems[0]}`,
      };
    const bad = d.skills.filter((x) => x.problems.length);
    if (bad.length)
      return {
        ok: false,
        message: `skill ${bad[0].name} is not ready: ${bad[0].problems[0]}`,
      };
    for (const tr of d.triggers) workflows().saveTrigger(tr);
    // Monitors: the definition and its script, into the library (their blocks then point there).
    for (const m of d.monitors)
      workflows().saveMonitor(
        m.def,
        readFileSync(join(draftMonitorsDir(), `${m.def.id}.sh`), "utf8"),
      );
    for (const sk of d.skills) {
      mkdirSync(paths.skillsDir, { recursive: true });
      cpSync(join(draftSkillsDir(), sk.name), join(paths.skillsDir, sk.name), {
        recursive: true,
      });
    }
    const hooks = syncWorkflowHooks();
    let id: string | null;
    if (typeof t.newName === "string")
      id = workflows().saveTemplate(
        null,
        t.newName || d.name || "From the builder",
        d.flow,
      );
    else {
      const tid =
        typeof t.templateId === "string" ? t.templateId : DEFAULT_TEMPLATE;
      const cur = workflows().template(tid);
      id = cur ? workflows().saveTemplate(tid, cur.name, d.flow) : null;
    }
    if (!id) return { ok: false, message: "could not save the workflow" };
    syncWorkflowHooks();
    clearDraft();
    const extra = [
      d.triggers.length
        ? `${d.triggers.length} trigger${d.triggers.length === 1 ? "" : "s"}`
        : "",
      d.skills.length
        ? `${d.skills.length} skill${d.skills.length === 1 ? "" : "s"}`
        : "",
      d.monitors.length
        ? `${d.monitors.length} monitor${d.monitors.length === 1 ? "" : "s"}`
        : "",
    ].filter(Boolean);
    return {
      ok: true,
      id,
      message: `saved${extra.length ? `, with ${extra.join(", ")} installed` : ""}${hooks.ok ? "" : ` (hooks: ${hooks.message})`}`,
    };
  });
  reg.handle(CH.workflowTriggerDelete, (_e, id: unknown) => {
    if (typeof id !== "string" || !workflows().deleteTrigger(id))
      return { ok: false, message: "no such trigger" };
    syncWorkflowHooks();
    return { ok: true, message: "trigger deleted" };
  });
  reg.handle(CH.workflowStatus, (_e, sid: unknown) => {
    if (!validSessionId(sid)) return null;
    const s = latest?.sessions.find((x) => x.sessionId === sid);
    const doc = workflows().sessionDoc(sid);
    const flow = doc?.flow ?? workflows().template(DEFAULT_TEMPLATE)?.flow;
    if (!flow) return null;
    // Every sign of a trigger point being reached: the transcript, the PRs, the hook log.
    const events: FlowEvent[] = [];
    const track = s ? sources.flowTrackOf(s.key) : null;
    for (const [t, at] of Object.entries(track?.reached ?? {}))
      events.push({ trigger: t as FlowTrigger, at: at as number });
    if (track) events.push(...commandEvents(flow, track.commands));
    for (const url of latest?.sessionPrs[sid] ?? []) {
      const pr = latest?.prLive[url];
      if (pr?.createdAt)
        events.push({ trigger: "pr-created", at: pr.createdAt });
      if (pr?.mergedAt) events.push({ trigger: "pr-merged", at: pr.mergedAt });
    }
    if (s?.startedAt)
      events.push({ trigger: "session-start", at: s.startedAt });
    const stoppedAt = s ? (latest?.hookInfo[s.key]?.stoppedAt ?? 0) : 0;
    if (stoppedAt) events.push({ trigger: "turn-end", at: stoppedAt });
    const run = workflows().lastRun(sid);
    if (run) events.push({ trigger: run.trigger as FlowTrigger, at: run.at });
    const working = !!s && (s.state === "working" || !!s.busyWith);
    const watching = !!s && !!s.waitingOn;
    return {
      from: doc?.from ?? null,
      ...flowProgress(flow, events, stoppedAt, working, watching),
    };
  });
  reg.handle(CH.sessionWorkflowGet, (_e, sid: unknown) =>
    validSessionId(sid) ? workflows().sessionDoc(sid) : null,
  );
  reg.handle(
    CH.sessionWorkflowSave,
    (_e, sid: unknown, raw: unknown, from: unknown) => {
      if (!validSessionId(sid)) return { ok: false, message: "bad session" };
      workflows().saveSession(sid, {
        flow: parseFlow(raw),
        from: typeof from === "string" ? from.slice(0, 80) : null,
        at: Date.now(),
      });
      const r = syncWorkflowHooks();
      return r.ok ? { ok: true, message: "saved for this session" } : r;
    },
  );
  reg.handle(CH.skillRemove, (_e, name: unknown) => {
    if (typeof name !== "string")
      return { ok: false, message: "bad skill name" };
    const r = removeSkill(paths.bundledSkills, paths.skillsDir, name);
    if (r.ok) {
      writeRemoved(skillsFile(), [...readRemoved(skillsFile()), name]);
    }
    refreshSkills();
    return r;
  });
  reg.handle(CH.teamPrsRefresh, (_e, maxAgeMs: unknown) =>
    typeof maxAgeMs === "number" && maxAgeMs > 0
      ? sources.refreshTeamPrs(maxAgeMs)
      : sources.refreshTeamPrs(0, true),
  );
  reg.handle(
    CH.linkSession,
    (_e, issue: unknown, sessionId: string, cwd: string | null) =>
      linkSession(issue, sessionId, cwd),
  );
  reg.handle(CH.peersSet, (_e, a: unknown, b: unknown, on: unknown) => {
    if (typeof a !== "string" || typeof b !== "string" || a.length > 200 || b.length > 200) return { ok: false, message: "bad session" };
    const live = new Set((latest?.sessions ?? []).filter((s) => s.state !== "done").map((s) => s.key));
    if (on === true && (!live.has(a) || !live.has(b))) return { ok: false, message: "link running sessions only" };
    const r = peerStore.set(a, b, on === true);
    if (!r.ok) return r;
    if (on !== true) peerSync.unlinked(a, b);
    peerSync.refreshAll([a, b]);
    return r;
  });
  reg.handle(CH.peersSync, (_e, key: unknown) =>
    typeof key === "string" && key.length <= 200
      ? peerSync.syncNow(key)
      : { ok: false, message: "bad session" },
  );
  reg.on(CH.boardOpen, (_e, open: boolean) => sources.setBoardOpen(open));
  // The repository view asks for its repositories (also from the web: a read; the list is checked in RepoIssues.ask).
  reg.on(CH.boardRepos, (_e, repos: unknown) => sources.askRepos(repos));
  // Create a GitHub board: on the Mac only (DECK_ACCESS blocks them; refused here as well).
  reg.handle(CH.boardCreatePlan, (e, account: unknown) =>
    isRemote(e)
      ? { ok: false, message: "Create the board from MasterDeck on your Mac" }
      : boardCreator.plan(account),
  );
  reg.handle(CH.boardCreate, (e, req: unknown) =>
    boardCreator.create(req, isRemote(e)),
  );
  reg.handle(CH.boardCreateRetry, (e, account: unknown) =>
    boardCreator.retry(account, isRemote(e)),
  );
  reg.on(CH.setFocus, (_e, id: string | null) => {
    focused = id;
    sources.setFocus(id);
  });
  reg.on(CH.setVisible, (_e, ids: string[]) => sources.setVisible(ids));
  reg.on(CH.openExternal, (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
  reg.handle(CH.openEditor, (_e, dir: string) => openEditor(dir));
  reg.on(CH.copy, (_e, text: string) => clipboard.writeText(text));
  reg.handle(CH.accountSignIn, (_e, p: unknown) => {
    if (p === "google" || p === "github" || p === "apple") void account.signInWith(p);
  });
  reg.handle(CH.accountCancel, () => account.cancel());
  reg.handle(CH.accountReopen, () => account.reopen());
  reg.handle(CH.accountUseCode, () => account.useCode());
  reg.handle(CH.accountProviders, () => account.providers());
  reg.handle(CH.accountEmail, (_e, a: unknown) => {
    const x = (a ?? {}) as Record<string, unknown>;
    if (
      typeof x.email !== "string" || x.email.length > 254 ||
      typeof x.password !== "string" || x.password.length > 200 ||
      typeof x.create !== "boolean" ||
      (x.name !== undefined && (typeof x.name !== "string" || x.name.length > 200))
    )
      return { ok: false, message: "invalid input" };
    return account.signInEmail(x.email, x.password, x.create, x.name as string | undefined);
  });
  reg.handle(CH.accountSignOut, () => account.signOut(readToken(remoteTokenFile())));
  reg.handle(CH.accountManage, () => void shell.openExternal(`${REMOTE}/account`));
  reg.handle(CH.browserDecide, (_e, id: unknown, allow: unknown) =>
    typeof id === "string" ? bridge!.decide(id, allow === true) : undefined,
  );
  reg.handle(CH.browserRevoke, async (_e, id: unknown) => {
    if (typeof id !== "string" || !id || id.length > 100) return { ok: false };
    // Backend first, then the local close (e2e H): the browser gets 4003 and asks for approval again.
    return { ok: await bridge!.revoke(id) };
  });
  reg.handle(CH.stopSession, async (e, bgId: string, name: string) => {
    if (!isSafeBgId(bgId)) return { ok: false, message: "bad background id" };
    // From a browser: the web UI asked first; no native dialog on the Mac.
    const choice = isRemote(e) ? { response: 1 } : await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: ["Cancel", "Stop session"],
      defaultId: 0,
      cancelId: 0,
      message: `Stop ${name}?`,
      detail:
        "The background session ends. Its conversation is kept and can be resumed later.",
    });
    if (choice.response !== 1) return { ok: false, message: "cancelled" };
    return stopBg(bgId);
  });
  reg.handle(
    CH.stopOtherSession,
    async (e, pid: unknown, name: string) => {
      if (typeof pid !== "number" || !(await isClaudePid(pid)))
        return {
          ok: false,
          message: "that session is not a running claude process here",
        };
      const choice = isRemote(e) ? { response: 1 } : await dialog.showMessageBox(win!, {
        type: "warning",
        buttons: ["Cancel", "Stop session"],
        defaultId: 0,
        cancelId: 0,
        message: `Stop ${String(name).slice(0, 80)}?`,
        detail:
          "It runs in another terminal; its claude process is stopped there. The conversation is kept and can be resumed later.",
      });
      if (choice.response !== 1) return { ok: false, message: "cancelled" };
      await stopPid(pid);
      await sources.refreshAgents();
      return (await isClaudePid(pid))
        ? { ok: false, message: "it did not stop; close it in its terminal" }
        : { ok: true, message: "stopped" };
    },
  );
  reg.handle(CH.stopSessions, async (e, keys: unknown) => {
    const want = new Set(
      Array.isArray(keys)
        ? keys.filter((k): k is string => typeof k === "string")
        : [],
    );
    const list = (latest?.sessions ?? []).filter(
      (s) => want.has(s.key) && canStop(s),
    );
    if (!list.length) return { ok: false, message: "nothing to stop" };
    const names = list.map((s) => s.name);
    const choice = isRemote(e) ? { response: 1 } : await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: [
        "Cancel",
        `Stop ${list.length} session${list.length === 1 ? "" : "s"}`,
      ],
      defaultId: 0,
      cancelId: 0,
      message: `Stop ${list.length} session${list.length === 1 ? "" : "s"}?`,
      detail: `${names.slice(0, 15).join("\n")}${names.length > 15 ? `\n…and ${names.length - 15} more` : ""}\n\nTheir conversations are kept: resume one later from its ticket on the Board.`,
    });
    if (choice.response !== 1) return { ok: false, message: "cancelled" };
    const results = await Promise.all(
      list.map(async (s) => {
        if (s.kind === "background" && s.bgId && isSafeBgId(s.bgId)) {
          const r = await run(claudeBin, ["stop", s.bgId], {
            timeoutMs: 30_000,
          });
          return r.code === 0 ? s.key : null;
        }
        if (s.pid !== null && (await isClaudePid(s.pid))) {
          await stopPid(s.pid);
          return (await isClaudePid(s.pid)) ? null : s.key;
        }
        return null;
      }),
    );
    await sources.refreshAgents();
    const stopped = results.filter((k): k is string => k !== null);
    const failed = list
      .filter((s) => !stopped.includes(s.key))
      .map((s) => s.name);
    return failed.length
      ? {
          ok: stopped.length > 0,
          stopped,
          message: `stopped ${stopped.length}; could not stop ${failed.join(", ")}`,
        }
      : {
          ok: true,
          stopped,
          message: `stopped ${stopped.length} session${stopped.length === 1 ? "" : "s"}`,
        };
  });
  reg.handle(CH.setManualStatus, (_e, key: unknown, status: unknown) =>
    typeof key === "string" && key.length < 200
      ? sources.setManualStatus(key, status)
      : { ok: false, message: "bad session" },
  );
  reg.handle(CH.statuslineInstall, () => installHook());
  reg.handle(CH.statuslineUninstall, () => {
    const r = uninstallStatusline(statuslineOpts());
    sources.statuslineInstalled = isInstalled(
      paths.claudeSettings,
      paths.installedTee,
    );
    return r;
  });
  reg.handle(CH.masterStart, () => startMaster());
  reg.handle(
    CH.ptyOpen,
    (e, id: string, spec: PaneSpec, cols: number, rows: number) => {
      // gh's browser login is Setup's on the Mac (it opens a browser there).
      if (isRemote(e) && spec?.kind === "gh-login")
        return { ok: false, replay: "", seq: 0, exited: true, message: "log in to GitHub on the Mac" };
      // Claude Code's trust prompt is answered on the Mac.
      if (isRemote(e) && spec?.kind === "claude-here")
        return { ok: false, replay: "", seq: 0, exited: true, message: "open Claude in that folder on the Mac" };
      // Spec §4: a browser's size never resizes a pane the Mac's window shows.
      if (!isRemote(e)) macPanes.local(id, cols);
      else [cols, rows] = macPanes.remoteSize(id, cols, rows) ?? [0, 0];
      return ptys.open(id, spec, cols, rows, isRemote(e));
    },
  );
  reg.on(CH.ptyWrite, (_e, id: string, data: string) =>
    ptys.write(id, data),
  );
  reg.on(CH.ptyResize, (e, id: string, cols: number, rows: number) => {
    if (!isRemote(e)) macPanes.local(id, cols);
    else if (!macPanes.remoteSize(id, cols, rows)) return;
    // cols 0: the window hid the pane; nothing to resize.
    if (cols > 0 && rows > 0) ptys.resize(id, cols, rows);
  });
  reg.on(CH.ptyClose, (_e, id: string) => {
    macPanes.closed(id);
    ptys.close(id);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    title: "MasterDeck",
    backgroundColor: "#0f1117",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.on("ready-to-show", () => {
    if (!SMOKE) win?.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  win.on("closed", () => {
    win = null;
  });
}

/** What Setup needs to know: which tools are on PATH and who gh is logged in as. */
/** One tool of Setup's first step. */
async function setupTool(
  tool: SetupTool,
): Promise<{ ok: boolean; detail: string }> {
  const cmd: Record<SetupTool, [string, string[]]> = {
    claude: [claudeBin, ["--version"]],
    gh: ["gh", ["--version"]],
    python: [paths.python, ["--version"]],
    git: ["git", ["--version"]],
    jq: ["jq", ["--version"]],
  };
  if (!Object.hasOwn(cmd, tool)) return { ok: false, detail: "unknown tool" };
  const c = cmd[tool];
  // Tests of the install flow: these tools read as missing.
  if ((process.env.MASTERDECK_SETUP_MISSING ?? "").split(",").includes(tool))
    return { ok: false, detail: "not found (MASTERDECK_SETUP_MISSING)" };
  const r = await run(c[0], c[1], { timeoutMs: 15_000 });
  return {
    ok: r.code === 0,
    detail: (r.stdout || r.stderr).trim().split("\n")[0].slice(0, 80),
  };
}

async function ghAccounts(): Promise<{
  accounts: GhAccount[];
  error?: string;
}> {
  const r = await run("gh", ["auth", "status", "--hostname", "github.com"], {
    timeoutMs: 20_000,
  });
  const accounts = parseGhAccounts(r.stdout + "\n" + r.stderr);
  return accounts.length
    ? { accounts }
    : {
        accounts,
        error:
          (r.stderr || r.stdout).trim().slice(0, 300) || "gh is not logged in",
      };
}

const GH_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** GH_TOKEN for one gh login (Setup's reads about an account, connected or not yet); null when gh has none. Never logged. */
async function tokenEnv(login: string): Promise<Record<string, string> | null> {
  const t = await run(
    "gh",
    ["auth", "token", "--hostname", "github.com", "--user", login],
    { timeoutMs: 15_000 },
  );
  const token = t.stdout.trim();
  return t.code === 0 && token ? { GH_TOKEN: token } : null;
}

// Set from the default config at load, so a state emitted before the first refreshAccounts (at
// launch, after loadConfig) does not start a second one.
let accountsKey = accountsKeyOf(getConfig());

/**
 * Tokens and settings files of the connected accounts (launch, config change, hourly). Resolves once
 * the local token reads are done; GitHub's health answers update ghAccounts in the background.
 */
async function refreshAccounts(): Promise<void> {
  const cfg = getConfig();
  accountsKey = accountsKeyOf(cfg);
  // A disconnected account's file stays while a live session still runs as it (until the agents
  // poll has answered, every session recorded in session-accounts.json counts as live).
  const inUse = accountsInUse(
    join(paths.home, "session-accounts.json"),
    latest && sources.isHealthy("agents") ? latest.sessions : null,
  );
  await accountEnv.refresh(cfg.accounts, inUse);
  sources.setGhAccounts(accountEnv.status());
  void refreshGhActive();
  void accountEnv
    .check()
    .then(() => sources.setGhAccounts(accountEnv.status()))
    .catch((e) => console.error(`accounts check: ${String(e)}`));
}

/**
 * gh's active login, for the Needs-you notice when it is not MasterDeck's primary (one account runs
 * as it). `gh config get user` reads gh's own config file: no network, so it can run every minute.
 */
async function refreshGhActive(): Promise<void> {
  const r = await run("gh", ["config", "get", "user", "-h", "github.com"], {
    timeoutMs: 5_000,
  });
  const login = r.stdout.trim();
  sources.setGhActive(r.code === 0 && GH_LOGIN.test(login) ? login : null);
}

/**
 * First launch of the multi-account version (see migrateLegacyConfig): in the background, since gh
 * auth status and gh api user go to the network; one account behaves as before meanwhile. The
 * config is re-read from the file after the waits (getConfig() lags the 2 s file watch).
 */
async function migrateAccounts(): Promise<void> {
  const r = await migrateLegacyConfig({
    read: () => sources.loadConfig(),
    activeLogin: async () => {
      const { accounts } = await ghAccounts();
      return (accounts.find((a) => a.active) ?? accounts[0])?.login ?? null;
    },
    run,
    backup: () =>
      copyFileSync(
        paths.config,
        join(dirname(paths.config), `config.backup.${Date.now()}.json`),
      ),
    save: (patch) => cli.configSave(patch),
  });
  if (r === "migrated") sources.loadConfig();
}

async function setupCheck(): Promise<SetupCheck> {
  const ok = async (cmd: string, args: string[]) =>
    (await run(cmd, args, { timeoutMs: 15_000 })).code === 0;
  const [ghOk, py, jq, git, user, status] = await Promise.all([
    ok("gh", ["--version"]),
    ok(paths.python, ["--version"]),
    ok("jq", ["--version"]),
    ok("git", ["--version"]),
    run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 }),
    run("gh", ["auth", "status"], { timeoutMs: 20_000 }),
  ]);
  const login = user.code === 0 ? user.stdout.trim() : "";
  // Several accounts print a block each, with that token's scopes. One account: the active
  // account's; two or more: only scopes every connected account has (see setupScopes).
  const accounts = parseGhAccounts(status.stdout + "\n" + status.stderr);
  const cfg = getConfig();
  const scopes = setupScopes(
    accounts,
    isMulti(cfg) ? cfg.accounts.map((a) => a.login) : null,
  ).join(",");
  const claudeOk = await ok(claudeBin, ["--version"]);
  return {
    claude: claudeOk ? claudeBin : null,
    gh: ghOk,
    ghUser: /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null,
    ghScopes: scopes
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
    python: py,
    jq,
    git,
  };
}

// Windows shows notifications only for an app with this id (the one the installer registers).
if (process.platform === "win32")
  app.setAppUserModelId("io.github.amntoppo.masterdeck");

app.whenReady().then(async () => {
  app.setName("MasterDeck");
  // Token and identity must agree. Judged by the token FILE (not by decrypting it), so a transient
  // Keychain error never signs the user out: a legacy pasted token (no identity) is removed, and an
  // identity whose token file is gone is cleared.
  {
    const hasTok = existsSync(remoteTokenFile());
    const st = account.state();
    if (hasTok && st.kind !== "signedIn") writeToken(remoteTokenFile(), null);
    else if (!hasTok && st.kind === "signedIn") account.signedOutRemotely("Signed out; sign in again");
  }
  pathEnv = await loginPath();
  claudeBin = await resolveClaude(env());
  registerIpc();
  // Links made by babysit-ticket before MasterDeck kept its own: copied once.
  try {
    if (linkStore.importOnce()) sources.reloadLinks();
  } catch (e) {
    console.error(`ticket links import: ${String(e)}`);
  }
  try {
    macKey = await loadMacKey(join(paths.home, "browser-key"), safeStorage);
  } catch (e) {
    console.error(`browser key unreadable; browsers cannot connect: ${String(e)}`);
  }
  sources.setLinker(linkSession);
  const parked = new ParkedStore(join(paths.home, "parked-sessions.json"));
  sources.setParked((s) => parked.get(s));
  sources.statuslineInstalled = isInstalled(
    paths.claudeSettings,
    paths.installedTee,
  );
  if (sources.statuslineInstalled) {
    // settings.json points at the installed copy: keep it present and current with this app version.
    const r = refreshTee(paths.bundledTee, paths.installedTee);
    if (r) console.error(r);
  } else if (!SMOKE && process.env.MASTERDECK_NO_HOOK !== "1") {
    const r = installHook();
    if (!r.ok) console.error(r.message);
  }
  // Bundled skills: install the missing ones, update our own unmodified copies.
  if (process.env.MASTERDECK_NO_SKILLS !== "1") {
    const r = syncSkills(
      paths.bundledSkills,
      paths.skillsDir,
      app.getVersion(),
      readRemoved(skillsFile()),
    );
    for (const e of r.errors) console.error(e);
    sources.setSkills(r.skills);
  }
  // Once: older versions installed hooks for babysit-ticket, babysit-pr and queue. MasterDeck does
  // that work itself now; the skills stay for use by hand.
  if (
    process.platform !== "win32" &&
    !SMOKE &&
    process.env.MASTERDECK_NO_HOOK !== "1"
  ) {
    const marker = join(paths.home, "native-hooks.json");
    if (!existsSync(marker))
      try {
        // Nothing is switched off: self-review and board moves are Default-workflow steps now.
        const m = migrateLegacyHooks(paths.claudeSettings, paths.home);
        // Sessions running now keep the queue skill's hooks (read at their start): the deck hook
        // leaves /queue to those until they end (pruneLegacy below).
        if (m.removed.some((r) => r.startsWith("queue"))) deckHooks.markLegacy();
        writeFileSync(
          marker,
          JSON.stringify({ at: Date.now(), ...m }, null, 2) + "\n",
        );
      } catch (e) {
        console.error(`hook migration: ${String(e)}`);
      }
  }
  // Always in place; guardedBuiltin skips sessions whose workflow leaves pr-review out.
  if (
    process.platform !== "win32" &&
    !SMOKE &&
    process.env.MASTERDECK_NO_HOOK !== "1"
  ) {
    const g = installReviewGate(paths.claudeSettings, paths.home, paths.home, true);
    if (!g.ok) console.error(g.message);
  }
  refreshHooks();
  // MasterDeck's own hook: permissions answered from Needs you, exact statuses, API errors,
  // compactions, and the ticket's context after a compaction. New sessions pick it up.
  if (process.platform !== "win32") {
    try {
      deckHooks.setup();
      deckHooks.setMonitorsBy(sources.getSettings().monitorsBy);
      sources.onSettings = (st) => deckHooks.setMonitorsBy(st.monitorsBy);
      watches.load();
      setInterval(pumpWatches, 1000);
      sources.setDeckHooks(deckHooks, (sid) => {
        const s = summaries.get(sid);
        return s ? { text: s.text, at: s.at } : null;
      });
      if (
        !SMOKE &&
        process.env.MASTERDECK_NO_HOOK !== "1" &&
        !deckHooksInstalled(paths.claudeSettings)
      ) {
        const r = installDeckHooks(
          paths.claudeSettings,
          paths.home,
          deckHooks.script,
        );
        if (!r.ok) console.error(r.message);
      }
      // Status and queue-off with the deck hook in place (refreshHooks ran before it was).
      refreshHooks();
    } catch (e) {
      console.error(`MasterDeck hooks: ${String(e)}`);
    }
  }
  // Workflows: older installs had one hook per step; now one per trigger, reading each session's copy.
  if (
    process.platform !== "win32" &&
    !SMOKE &&
    process.env.MASTERDECK_NO_HOOK !== "1"
  )
    try {
      workflows().migrate();
      const r = syncWorkflowHooks();
      if (!r.ok) console.error(r.message);
    } catch (e) {
      console.error(`workflow hooks: ${String(e)}`);
    }
  // PR watch (all platforms): rows join the monitors in Details; review offers for its PRs step aside.
  sources.setWatchInfo(() => [
    ...watches.info(),
    ...prWatch.info(latest?.sessions ?? []),
  ]);
  prWatch.load();
  // Only PRs whose session can take a message now: a parked session's offer stays in Needs you.
  sources.setWatchedPrs(() =>
    prWatch.watched(
      latest?.sessions ?? [],
      (s) =>
        canSend(
          s,
          ptys.isAlive(`s:${s.key}`),
          latest?.master.kind === "attached" ||
            latest?.master.kind === "elsewhere",
        ).ok,
    ),
  );
  setInterval(() => void prWatch.poll(), 60_000);
  // The builder's drafts, and tickets the Board's session created: cheap checks each second.
  setInterval(() => {
    try {
      prWatch.deliver(latest?.sessions ?? []);
    } catch (e) {
      console.error(`PR watch: ${String(e)}`);
    }
    try {
      readCreatedTickets();
      void pumpTicketRequests();
    } catch (e) {
      console.error(`tickets: ${String(e)}`);
    }
    try {
      readDraft();
    } catch (e) {
      console.error(`workflow draft: ${String(e)}`);
    }
  }, 1000);
  createWindow();
  sources.setResumer((e) =>
    resumeBg(e.sessionId, e.name, e.cwd, null, e.bgId),
  );
  // Accounts before the first GitHub reads: with two or more, each read needs its account's token.
  // Only the local token reads are awaited; nothing here waits on the network.
  try {
    sources.loadConfig();
    await refreshAccounts();
  } catch (e) {
    console.error(`accounts: ${String(e)}`);
  }
  if (!SMOKE)
    void migrateAccounts().catch((e) =>
      console.error(`accounts migration: ${String(e)}`),
    );
  setInterval(() => void refreshAccounts(), 3_600_000);
  setInterval(() => void refreshGhActive().catch(() => {}), 60_000);
  sources.start();
  syncRemote();
  if (SMOKE) {
    setTimeout(() => {
      console.log(
        "SMOKE FAIL: no healthy state within 30 s",
        JSON.stringify(latest?.errors ?? []),
      );
      app.exit(1);
    }, 30_000);
  }
  // Dev aid: MASTERDECK_CAPTURE=<png> saves a screenshot of the window (after running
  // MASTERDECK_CAPTURE_JS in the page, if set) and quits.
  const capture = process.env.MASTERDECK_CAPTURE;
  if (capture) {
    // Test runs only: the capture script can ask for named screenshots along the way.
    reg.handle("test:shot", async (_e, name: string) => {
      const img = await win?.webContents.capturePage();
      const file = join(
        dirname(capture),
        `${String(name).replace(/[^\w.-]/g, "_")}.png`,
      );
      if (img) writeFileSync(file, img.toPNG());
      return file;
    });
    setTimeout(async () => {
      const js = process.env.MASTERDECK_CAPTURE_JS;
      if (js)
        console.log(
          "capture js:",
          await win?.webContents
            .executeJavaScript(js)
            .catch((e) => `error ${e}`),
        );
      setTimeout(
        async () => {
          const img = await win?.webContents.capturePage();
          if (img) writeFileSync(capture, img.toPNG());
          console.log(`captured ${capture}`);
          app.exit(0);
        },
        Number(process.env.MASTERDECK_CAPTURE_WAIT ?? 4000),
      );
    }, 8000);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

// Cmd+Q skips window-all-closed; clean up here so no `claude attach` outlives the app.
app.on("will-quit", () => {
  cloud?.stop();
  peerStore.flush();
  sender.killAll();
  watches.killAll();
  ptys.closeAll();
  sources.stop();
});

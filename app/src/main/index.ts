import { parseIdentity, remoteUrl } from "@shared/account";
import { Account } from "./account";
import { Watches } from "./watches";
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
  mkdtempSync,
  chmodSync,
} from "node:fs";
import { canStop } from "@shared/cleanup";
import { readFile } from "node:fs/promises";
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
import { MASTER_NAME, sessionForProposal } from "@shared/derive";
import type {
  AppState,
  CliResult,
  HookStatus,
  NotifyEvent,
  PaneSpec,
  Session,
  SetupCheck,
} from "@shared/types";
import { getConfig } from "@shared/appConfig";
import { parseGhAccounts, type GhAccount } from "@shared/ghAuth";
import { startAssign } from "./assign";
import { randomUUID } from "node:crypto";
import { RemoteCommands } from "./remoteCommands";
import { CloudSync } from "./cloudSync";
import { IpcRegistry, isRemote } from "./ipcRegistry";
import { knownDirsOnly, remoteSettings } from "./remoteGuards";
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
import { Sender } from "./send";
import { Ops } from "./ops";
import { cleanEnv, loginPath, resolveClaude } from "./env";
import { MasterCli } from "./masterCli";
import { resolvePaths } from "./paths";
import { PtyManager } from "./ptys";
import { makeRunner } from "./run";
import { Sources } from "./sources";
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
import { asTicket, fullRepo, ticketLabel, ticketRef } from "@shared/ticket";
import {
  deckHooksInstalled,
  hookStatus,
  installDeckHooks,
  installHooks,
  installWorkflowHooks,
  guardBuiltinHooks,
} from "./hooks";
import { DeckHooks } from "./deckHooks";
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
let focused: string | null = null;
let pathEnv = process.env.PATH ?? "";
let claudeBin = "claude";

const paths = resolvePaths(
  app.getAppPath(),
  process.resourcesPath,
  app.isPackaged,
);
const env = () => cleanEnv(process.env, pathEnv);
const run = makeRunner(env);
const cli = new MasterCli(run, paths.libDir, paths.python);
const ptys = new PtyManager(
  env,
  (channel, ...args) => emit(channel, ...args),
  () => claudeBin,
  () => join(paths.home, "installer"),
  () => builderDir(),
  () => ticketDir(),
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
const sender = new Sender(
  ptys,
  cli,
  env,
  () => claudeBin,
  (key) => latest?.sessions.find((x) => x.key === key),
);
const ops = new Ops(run, paths, () => claudeBin, gh);
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
/** Monitor calls already answered (the hook removes its file once it read the answer). */
const answeredWatches = new Map<string, number>();
/** Take over the Monitor calls the hook hands in, then give sessions what their monitors printed. */
function pumpWatches(): void {
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
const deckHooks = new DeckHooks(paths.home);
const sources = new Sources(
  paths,
  run,
  cli,
  (state) => {
    const prev = latest;
    latest = state;
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
  gh,
  () => readGhCacheStatus(),
);

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
    b.browsers().map(({ id, name, approvedAt, connected }) => ({ id, name, approvedAt, connected })),
    b.requests(),
    b.warning(),
  );
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
  call: (ch, a) => reg.call(ch, a),
  onChange: () => publishBrowsers(),
  hello: { appVersion: app.getVersion(), platform: process.platform, home: homedir() },
  log: (l) => console.log(l),
});
const remoteCommands = new RemoteCommands(
  {
    state: () => latest,
    // remote = true: a client token is less trusted than the window (see runInboxAction).
    inboxAct: (id, type, payload) => inboxAct(id, type, payload, true),
    draftAssign: (t) => cli.draftAssign(t),
    startAssign: (req) => startAssign(cli, req),
    stopBg,
    resume: (id, name, cwd) => resumeBg(id, name, cwd),
    // Never relayed through master-agent: remote text goes straight to the session or not at all.
    sendNow: (s, text) => sender.send(s, text, sendMasterUp(true, latest?.master.kind)),
    queueEdit: (sessionId, edit) => {
      const { ok, message } = editQueue(sessionId, edit);
      return { ok, message };
    },
    setManualStatus: (key, status) => sources.setManualStatus(key, status),
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
    onDisconnect: () => bridge!.closeAll(),
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
      return type === "approve"
        ? cli.approve([d.proposal.id])
        : cli.reject([d.proposal.id]);
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
 * Link an existing session to an issue the way the session itself would: babysit-ticket's
 * `tt.sh link`, told which session and folder through TT_SESSION / TT_CWD. Like any
 * babysit-ticket link, it moves the ticket to In Dev (forward only).
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
  if (!existsSync(paths.babysitTt))
    return {
      ok: false,
      message: `babysit-ticket not found at ${paths.babysitTt}`,
    };
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  const r = await run(
    "bash",
    [paths.babysitTt, "link", ticketRef(t.repo, t.number)],
    {
      cwd: dir,
      timeoutMs: 60_000,
      env: { TT_SESSION: sessionId, TT_CWD: dir },
    },
  );
  sources.reloadLinks();
  const out = (r.stdout.trim() || r.stderr.trim()).split("\n").filter(Boolean);
  return r.code === 0
    ? {
        ok: true,
        message: out[0] ?? `linked to ${ticketLabel(t.repo, t.number)}`,
      }
    : { ok: false, message: out.at(-1) ?? `exit ${r.code}` };
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
/** `claude --bg --resume <id>`: continue a stopped session in the background under the same id. */
async function resumeBg(
  id: string,
  name: string,
  cwd: string | null,
): Promise<CliResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return { ok: false, message: "bad session id" };
  // A name we can't pass safely is left out: the session keeps the one it has.
  const named = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(name)
    ? ["-n", name]
    : [];
  const r = await run(claudeBin, ["--bg", "--resume", id, ...named], {
    cwd: cwd && existsSync(cwd) ? cwd : homedir(),
    timeoutMs: 60_000,
  });
  return r.code === 0
    ? { ok: true, message: name }
    : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) };
}

/** The Board's ticket session works here: its CLAUDE.md, context.json, create-ticket.sh, created.jsonl. */
const ticketDir = () => join(paths.home, "ticket-builder");
let ticketsSeen = -1;
/** Tickets the Board's session created (created.jsonl grew): refresh the board, and tell the page. */
function readCreatedTickets(): void {
  let lines: string[] = [];
  try {
    lines = readFileSync(join(ticketDir(), "created.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    if (ticketsSeen < 0) ticketsSeen = 0;
    return;
  }
  // At launch: the ones already there are old news.
  if (ticketsSeen < 0) ticketsSeen = lines.length;
  if (lines.length <= ticketsSeen) return;
  const fresh = lines.slice(ticketsSeen);
  ticketsSeen = lines.length;
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

/** The hook that belongs to a skill (off when the skill is removed). */
const SKILL_HOOK: Record<string, keyof HookStatus> = {
  "babysit-ticket": "ticket",
  "babysit-pr": "pr",
  queue: "queue",
};

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
  const r = await run(
    claudeBin,
    ["--bg", "--resume", o.sessionId, "-n", o.name],
    { cwd, timeoutMs: 60_000 },
  );
  return r.code === 0
    ? { ok: true, message: r.stdout.trim().split("\n")[0] ?? "started" }
    : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) };
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
  const r = await run(claudeBin, ["--bg", "-n", MASTER_NAME, "/master"], {
    cwd: paths.masterWorkspace,
    timeoutMs: 60_000,
  });
  if (r.code !== 0) masterStartingUntil = 0;
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
    (_e, issue: unknown, title?: string, url?: string) => {
      const t = asTicket(issue);
      return t
        ? cli.draftAssign(t, title, url)
        : { ok: false, message: "bad issue" };
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
    async (_e, id: unknown, type: unknown, payload: unknown) => {
      if (typeof id !== "string" || typeof type !== "string")
        return { ok: false, message: "bad inbox action" };
      const p =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      return inboxAct(id, type, p);
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
    const r = await ops.setStatus(t, status);
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
  // New ticket (Board): an issue created, put on the board with its status and sprint, by
  // babysit-ticket's `tt.sh create` (the Board's Claude session uses the same command).
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
    if (!existsSync(paths.babysitTt))
      return {
        ok: false,
        message: `babysit-ticket not found at ${paths.babysitTt}`,
      };
    const dir = mkdtempSync(join(tmpdir(), "masterdeck-ticket-"));
    try {
      const bodyFile = join(dir, "body.md");
      writeFileSync(bodyFile, str(o.body, 60_000));
      const args = [
        paths.babysitTt,
        "create",
        "--title",
        title,
        "--body-file",
        bodyFile,
      ];
      const add = (flag: string, v: string) => v && args.push(flag, v);
      add("--repo", str(o.repo, 140));
      add("--project", str(o.project, 140));
      add("--status", str(o.status, 100));
      add("--assignee", list(o.assignees).join(","));
      for (const l of list(o.labels)) args.push("--label", l);
      add("--milestone", str(o.milestone, 200));
      add("--sprint", str(o.sprint, 200));
      add("--sprint-field", str(o.sprintField, 100));
      if (o.dryRun === true) args.push("--dry-run");
      const r = await run("bash", args, { cwd: dir, timeoutMs: 90_000 });
      let res: {
        ok?: boolean;
        url?: string;
        number?: number;
        error?: string;
        status?: string;
        sprint?: string;
      } = {};
      // tt.sh prints one JSON object (after anything gh said).
      try {
        res = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      } catch {
        /* no JSON: an error on stderr */
      }
      if (r.code !== 0 || !res.ok)
        return {
          ok: false,
          message: res.error
            ? `${res.error}${res.url ? `: ${res.url}` : ""}`
            : (r.stderr || r.stdout)
                .trim()
                .split("\n")
                .pop()
                ?.replace(/^babysit-ticket: /, "") ||
              "could not create the issue",
          url: res.url,
        };
      if (o.dryRun !== true) void sources.refreshGithub(true);
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
        message:
          o.dryRun === true
            ? "checked (dry run)"
            : `created #${res.number}${extra ? ` ${extra}` : ""}`,
        url: res.url,
        number: res.number,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const dir = ticketDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const script = join(dir, "create-ticket.sh");
    const log = join(dir, "created.jsonl");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "# Written by MasterDeck: create one ticket on the board (babysit-ticket's tt.sh create) and log it.",
        `out="$(bash ${shellQuote(paths.babysitTt)} create "$@")"; code=$?`,
        `printf '%s\\n' "$out"`,
        `case " $* " in *" --dry-run "*) ;; *) [ $code -eq 0 ] && printf '%s' "$out" | jq -c . >> ${shellQuote(log)} 2>/dev/null ;; esac`,
        "exit $code",
        "",
      ].join("\n"),
    );
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
      ticketContext(cfg, latest?.sprints ?? [], people, latest?.me ?? null),
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
      const r = await run("gh", args, { timeoutMs: 30_000 });
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
    if (
      typeof o.workflow === "string" &&
      o.workflow &&
      o.workflow !== DEFAULT_TEMPLATE
    )
      workflows().setPending(name, o.workflow);
    const r = await run(
      claudeBin,
      [
        "--bg",
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
    void sources.refreshAgents();
    return { ok: true, message: name };
  });
  reg.handle(
    CH.resumeSession,
    (_e, id: string, name: string, cwd: string | null) =>
      resumeBg(id, name, cwd),
  );
  reg.handle(CH.resumeStopped, () => sources.resumeStopped());
  reg.handle(CH.tokensByDay, (_e, ids: unknown) =>
    sources.tokensByDay(Array.isArray(ids) ? ids : []),
  );
  reg.handle(CH.dismissStopped, () => sources.dismissStopped());
  reg.handle(CH.setSettings, (e, s: unknown) =>
    sources.setSettings(
      isRemote(e) ? remoteSettings(s, sources.getSettings()) : s,
    ),
  );
  reg.handle(CH.watchStop, (_e, id: unknown) =>
    typeof id === "string" ? watches.stop(id) : false,
  );
  reg.handle(CH.startHere, (_e, o: Parameters<typeof startHere>[0]) =>
    startHere(o),
  );
  reg.handle(CH.prSummary, (_e, url: string) => github.prSummary(url));
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
    return t ? github.issueBody(t) : { ok: false, message: "bad ticket" };
  });
  reg.handle(
    CH.assignIssue,
    async (_e, issue: unknown, login: string, current: string[]) => {
      const t = asTicket(issue);
      if (!t) return { ok: false, message: "bad issue" };
      const r = await github.assign(t, login, current);
      if (r.ok) sources.noteAssigned(t, login);
      return r;
    },
  );
  reg.handle(CH.assign, (_e, req: AssignRequest) => {
    // The template picked in the Start dialog: the new session copies it instead of the default.
    if (
      typeof req?.workflow === "string" &&
      req.workflow !== DEFAULT_TEMPLATE &&
      typeof req.name === "string"
    )
      workflows().setPending(req.name, req.workflow);
    return startAssign(cli, req);
  });
  reg.handle(CH.defaultModel, () => configuredModel(paths.claudeSettings));
  // The Refresh buttons: fetch from GitHub even when the shared gh cache has an answer.
  reg.handle(CH.refresh, () => sources.refreshGithub(true));
  reg.handle(CH.boardRefresh, () => sources.refreshGithub(true));
  reg.handle(CH.setupCheck, () => setupCheck());
  reg.handle(CH.setupTool, (_e, tool: SetupTool) => setupTool(tool));
  reg.handle(CH.ghAccounts, () => ghAccounts());
  reg.handle(CH.ghSwitch, async (_e, login: string) => {
    const { accounts } = await ghAccounts();
    if (!accounts.some((a) => a.login === login))
      return { ok: false, message: `gh is not logged in to ${login}` };
    const r = await run(
      "gh",
      ["auth", "switch", "--hostname", "github.com", "--user", login],
      { timeoutMs: 20_000 },
    );
    return r.code === 0
      ? { ok: true, message: `gh now uses ${login}` }
      : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) };
  });
  reg.handle(CH.ghOwners, async () => {
    // Straight to gh, not the shared cache: it is not per account.
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
  reg.handle(CH.configDetectAll, () => cli.configDetectAll());
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
  reg.handle(CH.pickFolder, async (_e, start: unknown) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: typeof start === "string" && start ? start : homedir(),
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  reg.handle(CH.hooksInstall, (_e, which: HookStatus) => {
    const r = installHooks(paths.claudeSettings, paths.home, {
      ticket: !!which?.ticket,
      pr: !!which?.pr,
      queue: !!which?.queue,
    });
    sources.setHooks(hookStatus(paths.claudeSettings));
    return r;
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
  reg.handle(CH.summaryMake, async (_e, key: string) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return { ok: false, message: "session not found" };
    const f = sources.sessionFacts(s.sessionId, s.key);
    if (!f.transcript)
      return { ok: false, message: "no transcript for this session yet" };
    return summaries.make({
      sessionId: s.sessionId,
      name: s.name,
      transcript: f.transcript,
      cwd: f.cwd ?? s.cwd,
      issue: s.issue !== null ? ticketRef(s.issueRepo, s.issue) : null,
      prs: f.prs,
    });
  });
  reg.handle(CH.summaryPost, async (_e, key: string) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return { ok: false, message: "session not found" };
    if (s.issue === null)
      return { ok: false, message: "this session is not linked to an issue" };
    const summary = summaries.get(s.sessionId);
    if (!summary) return { ok: false, message: "no summary yet" };
    const body = `### Session summary: ${s.name}\n\n${summary.text}\n\n<sub>Made by MasterDeck from the session's transcript.</sub>\n`;
    const r = await run(
      "gh",
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
      // Its hook would call a script that is gone: turn it off too.
      const key = SKILL_HOOK[name];
      const hooks = hookStatus(paths.claudeSettings);
      if (key && hooks[key]) {
        installHooks(paths.claudeSettings, paths.home, {
          ...hooks,
          [key]: false,
        });
        sources.setHooks(hookStatus(paths.claudeSettings));
      }
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
  reg.on(CH.boardOpen, (_e, open: boolean) => sources.setBoardOpen(open));
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
    bridge!.revoke(id);
    const token = readToken(remoteTokenFile());
    if (!token) return { ok: false };
    try {
      const r = await fetch(`${REMOTE}/v1/browsers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      return { ok: r.ok };
    } catch {
      return { ok: false };
    }
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
    (_e, id: string, spec: PaneSpec, cols: number, rows: number) =>
      ptys.open(id, spec, cols, rows),
  );
  reg.on(CH.ptyWrite, (_e, id: string, data: string) =>
    ptys.write(id, data),
  );
  reg.on(CH.ptyResize, (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows),
  );
  reg.on(CH.ptyClose, (_e, id: string) => ptys.close(id));
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
  // Several accounts print a block each: the scopes that count are the active account's.
  const accounts = parseGhAccounts(status.stdout + "\n" + status.stderr);
  const scopes =
    (accounts.find((a) => a.active) ?? accounts[0])?.scopes.join(",") ?? "";
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
  try {
    macKey = await loadMacKey(join(paths.home, "browser-key"), safeStorage);
  } catch (e) {
    console.error(`browser key unreadable; browsers cannot connect: ${String(e)}`);
  }
  sources.setLinker(linkSession);
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
  sources.setHooks(hookStatus(paths.claudeSettings));
  // MasterDeck's own hook: permissions answered from Needs you, exact statuses, API errors,
  // compactions, and the ticket's context after a compaction. New sessions pick it up.
  if (process.platform !== "win32") {
    try {
      deckHooks.setup();
      deckHooks.setMonitorsBy(sources.getSettings().monitorsBy);
      sources.onSettings = (st) => deckHooks.setMonitorsBy(st.monitorsBy);
      sources.setWatchInfo(() => watches.info());
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
      // Built-ins a workflow can leave out: their hooks check the session's workflow first.
      const g = guardBuiltinHooks(paths.claudeSettings, paths.home);
      if (!g.ok) console.error(g.message);
    } catch (e) {
      console.error(`workflow hooks: ${String(e)}`);
    }
  // The builder's drafts, and tickets the Board's session created: cheap checks each second.
  setInterval(() => {
    try {
      readCreatedTickets();
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
  sources.setResumer((e) => resumeBg(e.sessionId, e.name, e.cwd));
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
  sender.killAll();
  watches.killAll();
  ptys.closeAll();
  sources.stop();
});

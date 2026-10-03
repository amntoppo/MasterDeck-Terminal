import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CliResult, HookStatus } from "@shared/types";
import { runsOrExit, shellQuote, STEP_MARK, TRIGGERS } from "@shared/workflow";
import {
  customTriggerCommand,
  flowTriggerCommand,
  guardedBuiltin,
  HOOK_TRIGGERS,
  type BuiltinId,
  type CustomTrigger,
} from "@shared/flow";
import { DECK_EVENTS } from "@shared/deckHooks";

/**
 * Claude Code hooks MasterDeck installs into ~/.claude/settings.json: its own deck hook
 * (main/deckHooks.ts), the workflow trigger hooks, and the self-review gate. Older versions
 * installed hooks for the babysit-ticket, babysit-pr and queue skills; migrateLegacyHooks takes
 * exactly those out once (the skills stay installed for use by hand). Every edit keeps the rest of
 * the file and writes a backup first.
 */

type Hook = { type: "command"; command: string; timeout?: number };
type Matcher = { matcher?: string; hooks: Hook[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, Matcher[]> };

/** What older MasterDeck versions wrote for the skills, exactly (the migration matches these). */
export const LEGACY_COMMANDS = {
  ticket: '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook',
  prPre:
    `cmd=$(jq -r '.tool_input.command // ""'); case "$cmd" in *'gh pr create'*) sha=$(git rev-parse HEAD 2>/dev/null) || exit 0; ` +
    `[ -f ".git/pr-selfreview-$sha" ] && exit 0; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Soft gate: no self-review marker for current HEAD. ` +
    `Before creating this PR, run the pre-PR self-review from the babysit-pr skill (review branch diff, fix findings, commit, write marker .git/pr-selfreview-<HEAD sha>). ` +
    `Proceed without it only if the user explicitly said to skip review."}}' ;; esac`,
  prPost:
    `cmd=$(jq -r '.tool_input.command // ""'); case "$cmd" in *'gh pr create'*) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"PR created. ` +
    `Arm the Monitor now (timeout_ms 1800000; re-arm on each expiry, there is no persistent flag), per the Monitor phase of the babysit-pr skill: ` +
    `it emits an event per new review comment; on each wake fix and push, reply, resolve threads; the watch ends when the PR is merged/closed."}}' ;; esac`,
  queueSubmit: '"$HOME/.claude/skills/queue/scripts/queue-submit.sh"',
  queueDrain: '"$HOME/.claude/skills/queue/scripts/queue-drain.sh"',
} as const;

const LEGACY: {
  what: "ticket" | "pr" | "queue";
  event: string;
  exact: string;
  builtin?: BuiltinId;
  inner?: string;
}[] = [
  { what: "ticket", event: "PostToolUse", exact: LEGACY_COMMANDS.ticket, builtin: "ticket", inner: "babysit-ticket/scripts/tt.sh" },
  { what: "ticket", event: "SessionStart", exact: LEGACY_COMMANDS.ticket, builtin: "ticket", inner: "babysit-ticket/scripts/tt.sh" },
  { what: "pr", event: "PreToolUse", exact: LEGACY_COMMANDS.prPre, builtin: "pr-review", inner: "pr-selfreview-" },
  { what: "pr", event: "PostToolUse", exact: LEGACY_COMMANDS.prPost, builtin: "pr-watch", inner: "Monitor phase of the babysit-pr skill" },
  { what: "queue", event: "UserPromptSubmit", exact: LEGACY_COMMANDS.queueSubmit },
  { what: "queue", event: "Stop", exact: LEGACY_COMMANDS.queueDrain },
];

/** MasterDeck wrote it: the exact old command, or its guarded wrapper (`# masterdeck-builtin:<id>`). */
const ours = (l: (typeof LEGACY)[number], cmd: string): boolean =>
  cmd === l.exact ||
  (!!l.builtin &&
    !!l.inner &&
    cmd.includes(`# masterdeck-builtin:${l.builtin}`) &&
    cmd.includes(l.inner));

/** Take out the skill hooks older MasterDeck versions installed; nothing else. Writes (with a
 * backup) only when something was removed. */
export function migrateLegacyHooks(
  settingsPath: string,
  backupDir: string,
): { removed: string[] } {
  const s = read(settingsPath);
  const removed: string[] = [];
  for (const l of LEGACY) {
    const list = s.hooks?.[l.event];
    if (!Array.isArray(list)) continue;
    let hit = false;
    const kept = list
      .map((m) => ({
        ...m,
        hooks: (m.hooks ?? []).filter(
          (h) => !(typeof h.command === "string" && ours(l, h.command) && (hit = true)),
        ),
      }))
      .filter((m) => m.hooks.length > 0);
    if (!hit) continue;
    removed.push(`${l.what} (${l.event})`);
    if (kept.length) s.hooks![l.event] = kept;
    else delete s.hooks![l.event];
  }
  if (removed.length) write(settingsPath, backupDir, s);
  return { removed: [...new Set(removed)] };
}

/** The self-review gate's marker (in its command line; hookStatus and the installer find it). */
export const REVIEW_MARK = "masterdeck-review-gate";

const REVIEW_REASON =
  "MasterDeck: before creating this PR, review your diff against the base branch (git diff <base>...HEAD): look for bugs, leftover debug code and changes outside the task; " +
  "fix what you find and commit. Then run gh pr create again (it is let through the second time). Skip the review only if the user said to.";

/**
 * Before `gh pr create` (a command that runs it, not text that mentions it): deny the first try of
 * a session with the review instruction; the retry passes. Also passes when a hand-run /babysit-pr
 * wrote `.git/pr-selfreview-<HEAD sha>`. Skipped for sessions whose workflow left the pr-review
 * built-in out (guardedBuiltin). bash 3.2.
 */
export function reviewGateCommand(home: string): string {
  const before = TRIGGERS.find((t) => t.id === "before-pr")!.command!;
  const inner = [
    `input=$(cat)`,
    `cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')`,
    runsOrExit(before),
    `sid=$(printf '%s' "$input" | jq -r '.session_id // "none"')`,
    `case "$sid" in *[!A-Za-z0-9-]*) exit 0;; esac`,
    `sha=$(git rev-parse HEAD 2>/dev/null) && [ -f "$(git rev-parse --git-path "pr-selfreview-$sha" 2>/dev/null)" ] && exit 0`,
    `m="\${TMPDIR:-/tmp}/masterdeck-review-$sid"; [ -f "$m" ] && exit 0; touch "$m"`,
    `jq -n --arg r ${shellQuote(REVIEW_REASON)} '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'`,
  ].join("; ");
  return `${guardedBuiltin("pr-review", inner, home)} # ${REVIEW_MARK}`;
}

/** Install (or with `on` false remove) the review gate; idempotent. A changed home reinstalls. */
export function installReviewGate(
  settingsPath: string,
  backupDir: string,
  home: string,
  on: boolean,
): CliResult {
  if (process.platform === "win32") return { ok: true, message: "skipped" };
  try {
    const s = read(settingsPath);
    const cmd = reviewGateCommand(home);
    if (on ? has(s, "PreToolUse", cmd) : !has(s, "PreToolUse", REVIEW_MARK))
      return { ok: true, message: "already set" };
    remove(s, "PreToolUse", REVIEW_MARK);
    if (on) add(s, "PreToolUse", "Bash", cmd, REVIEW_MARK, 10);
    write(settingsPath, backupDir, s);
    return { ok: true, message: on ? "review gate installed" : "review gate removed" };
  } catch (e) {
    return { ok: false, message: `could not update ${settingsPath}: ${String(e)}` };
  }
}

/** The queue skill's hook scripts by name: from ~/.claude/skills or ~/.claude/hooks alike. */
const Q_SUBMIT_MARK = "queue-submit.sh";
const Q_DRAIN_MARK = "queue-drain.sh";

export function hookStatus(settingsPath: string): HookStatus {
  try {
    const s = read(settingsPath);
    const submit = has(s, "UserPromptSubmit", Q_SUBMIT_MARK);
    const drain = has(s, "Stop", Q_DRAIN_MARK);
    // Any skill queue hook switches MasterDeck's off (deckHooks.setQueueOff), so no prompt is
    // stored or run twice; then only a complete pair runs /queue.
    const foreignQueue = submit || drain;
    return {
      queue: (deckInstalledIn(s) && !foreignQueue) || (submit && drain),
      foreignQueue,
      reviewGate: has(s, "PreToolUse", REVIEW_MARK),
    };
  } catch {
    return { queue: false, foreignQueue: false, reviewGate: false };
  }
}

function read(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Settings;
}

function has(s: Settings, event: string, mark: string): boolean {
  return (s.hooks?.[event] ?? []).some((m) =>
    (m.hooks ?? []).some(
      (h) => typeof h.command === "string" && h.command.includes(mark),
    ),
  );
}

function add(
  s: Settings,
  event: string,
  matcher: string | undefined,
  command: string,
  mark: string,
  timeout?: number,
): void {
  if (has(s, event, mark)) return;
  s.hooks ??= {};
  const list = (s.hooks[event] ??= []);
  list.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command, ...(timeout ? { timeout } : {}) }],
  });
}

function remove(s: Settings, event: string, mark: string): void {
  const list = s.hooks?.[event];
  if (!list) return;
  const kept = list
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter(
        (h) => !(typeof h.command === "string" && h.command.includes(mark)),
      ),
    }))
    .filter((m) => m.hooks.length > 0);
  if (kept.length) s.hooks![event] = kept;
  else delete s.hooks![event];
}

function write(settingsPath: string, backupDir: string, s: Settings): void {
  if (existsSync(settingsPath)) {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(
      settingsPath,
      join(backupDir, `settings.backup.${Date.now()}.json`),
    );
  }
  // Follow a symlink so a dotfiles link stays a link.
  const target = existsSync(settingsPath)
    ? realpathSync(settingsPath)
    : settingsPath;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.masterdeck-tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, target);
}

/**
 * The workflow hooks: one per trigger, reading each session's own workflow (or the default) from
 * `dir` (see `triggerCommand`). They replace every hook MasterDeck made for a workflow before
 * (older versions had one per step); with `on` false they are all removed. The rest of
 * settings.json is kept.
 */
export function installWorkflowHooks(
  settingsPath: string,
  backupDir: string,
  dir: string,
  on: boolean,
  /** The events custom triggers in the library use: one hook each, for every tool. */
  customEvents: CustomTrigger["event"][] = [],
): CliResult {
  if (process.platform === "win32")
    return {
      ok: false,
      message:
        "these hooks are bash commands; on Windows add them by hand under Git Bash",
    };
  try {
    const s = read(settingsPath);
    const want: {
      event: string;
      matcher: string | undefined;
      cmd: string;
      mark: string;
    }[] = on
      ? [
          ...HOOK_TRIGGERS.map((t) => ({
            event: t.event!,
            matcher:
              t.event === "PreToolUse" || t.event === "PostToolUse"
                ? "Bash"
                : undefined,
            cmd: flowTriggerCommand(t, dir, `${STEP_MARK}trigger-${t.id}`),
            mark: `${STEP_MARK}trigger-${t.id}`,
          })),
          ...[...new Set(customEvents)].map((ev) => {
            const mark = `${STEP_MARK}custom-${ev.toLowerCase()}`;
            return {
              event: ev,
              matcher: undefined,
              cmd: customTriggerCommand(ev, dir, mark),
              mark,
            };
          }),
        ]
      : [];
    const current = Object.values(s.hooks ?? {})
      .flatMap((list) =>
        (Array.isArray(list) ? list : []).flatMap((m) =>
          (m?.hooks ?? []).map((h: { command?: string }) => h?.command ?? ""),
        ),
      )
      .filter((c) => c.includes(STEP_MARK));
    if (
      current.length === want.length &&
      want.every((w) => current.includes(w.cmd))
    )
      return { ok: true, message: "workflow saved" };
    for (const event of Object.keys(s.hooks ?? {})) remove(s, event, STEP_MARK);
    for (const w of want) add(s, w.event, w.matcher, w.cmd, w.mark, 10);
    write(settingsPath, backupDir, s);
    return { ok: true, message: "workflow saved" };
  } catch (e) {
    return {
      ok: false,
      message: `could not update ${settingsPath}: ${String(e)}`,
    };
  }
}

/** MasterDeck's own hook (main/deckHooks.ts): marked by its path, one entry per event. */
const DECK_MARK = "/deck/hook.sh";
/** Plus PreToolUse on Monitor: hands a monitor to MasterDeck when Settings say so. */
const DECK_MONITOR_MARK = "/deck/hook.sh\" MonitorCall";

function deckInstalledIn(s: Settings): boolean {
  return (
    DECK_EVENTS.every((e) => has(s, e, DECK_MARK)) &&
    has(s, "PreToolUse", DECK_MONITOR_MARK)
  );
}

export function deckHooksInstalled(settingsPath: string): boolean {
  try {
    return deckInstalledIn(read(settingsPath));
  } catch {
    return false;
  }
}

/**
 * Register MasterDeck's hook for its events (idempotent; the rest of settings.json is kept). A
 * PermissionRequest may wait up to 10 minutes for an answer from MasterDeck; the terminal prompt
 * shows meanwhile. The others only write a line and return.
 */
export function installDeckHooks(
  settingsPath: string,
  backupDir: string,
  script: string,
): CliResult {
  if (process.platform === "win32")
    return {
      ok: false,
      message: "MasterDeck hooks are a bash script; not installed on Windows",
    };
  try {
    const s = read(settingsPath);
    // A moved script (another MasterDeck home): replace the old entries.
    const cmd = (e: string) => `"${script}" ${e}`;
    const stale = DECK_EVENTS.some(
      (e) => has(s, e, DECK_MARK) && !has(s, e, cmd(e)),
    );
    const monitorCmd = cmd("MonitorCall");
    const monitorStale =
      has(s, "PreToolUse", DECK_MONITOR_MARK) &&
      !has(s, "PreToolUse", monitorCmd);
    if (
      DECK_EVENTS.every((e) => has(s, e, cmd(e))) &&
      has(s, "PreToolUse", monitorCmd) &&
      !stale &&
      !monitorStale
    )
      return { ok: true, message: "already installed" };
    remove(s, "PreToolUse", DECK_MONITOR_MARK);
    add(s, "PreToolUse", "Monitor", monitorCmd, DECK_MONITOR_MARK, 15);
    for (const e of DECK_EVENTS) {
      remove(s, e, DECK_MARK);
      add(
        s,
        e,
        undefined,
        cmd(e),
        DECK_MARK,
        e === "PermissionRequest" ? 600 : 10,
      );
    }
    write(settingsPath, backupDir, s);
    return { ok: true, message: "MasterDeck hooks installed" };
  } catch (e) {
    return {
      ok: false,
      message: `could not update ${settingsPath}: ${String(e)}`,
    };
  }
}

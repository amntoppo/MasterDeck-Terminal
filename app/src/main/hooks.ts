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
import { STEP_MARK } from "@shared/workflow";
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
 * Claude Code hooks the bundled skills rely on, installed into ~/.claude/settings.json:
 * - babysit-ticket: `tt.sh hook` after each Bash call and at session start (moves the board).
 * - babysit-pr: a soft gate before `gh pr create` (self-review first) and a reminder after it
 *   (start babysitting the PR).
 * - queue: `/queue <prompt>` is stored instead of sent (UserPromptSubmit), and the next stored
 *   prompt runs when a response ends (Stop).
 * Installing is idempotent and keeps everything else in the file; a backup is written first.
 */

type Hook = { type: "command"; command: string; timeout?: number };
type Matcher = { matcher?: string; hooks: Hook[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, Matcher[]> };

const TT = '"$HOME/.claude/skills/babysit-ticket/scripts/tt.sh" hook';
const TT_MARK = "babysit-ticket/scripts/tt.sh";

const PR_PRE =
  `cmd=$(jq -r '.tool_input.command // ""'); case "$cmd" in *'gh pr create'*) sha=$(git rev-parse HEAD 2>/dev/null) || exit 0; ` +
  `[ -f ".git/pr-selfreview-$sha" ] && exit 0; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Soft gate: no self-review marker for current HEAD. ` +
  `Before creating this PR, run the pre-PR self-review from the babysit-pr skill (review branch diff, fix findings, commit, write marker .git/pr-selfreview-<HEAD sha>). ` +
  `Proceed without it only if the user explicitly said to skip review."}}' ;; esac`;
const PR_POST =
  `cmd=$(jq -r '.tool_input.command // ""'); case "$cmd" in *'gh pr create'*) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"PR created. ` +
  `Arm the Monitor now (timeout_ms 1800000; re-arm on each expiry, there is no persistent flag), per the Monitor phase of the babysit-pr skill: ` +
  `it emits an event per new review comment; on each wake fix and push, reply, resolve threads; the watch ends when the PR is merged/closed."}}' ;; esac`;
const Q_SUBMIT = '"$HOME/.claude/skills/queue/scripts/queue-submit.sh"';
const Q_DRAIN = '"$HOME/.claude/skills/queue/scripts/queue-drain.sh"';
// Script names only: an older install from ~/.claude/hooks counts too, so it is never doubled.
const Q_SUBMIT_MARK = "queue-submit.sh";
const Q_DRAIN_MARK = "queue-drain.sh";

const PR_MARK = "pr-selfreview-";
const PR_POST_MARK = "Monitor phase of the babysit-pr skill";

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

export function hookStatus(settingsPath: string): HookStatus {
  try {
    const s = read(settingsPath);
    return {
      ticket: has(s, "PostToolUse", TT_MARK) && has(s, "SessionStart", TT_MARK),
      pr: has(s, "PreToolUse", PR_MARK) && has(s, "PostToolUse", PR_POST_MARK),
      queue:
        has(s, "UserPromptSubmit", Q_SUBMIT_MARK) &&
        has(s, "Stop", Q_DRAIN_MARK),
    };
  } catch {
    return { ticket: false, pr: false, queue: false };
  }
}

/** Any of the queue skill's hooks in settings.json (by hand or older MasterDeck): MasterDeck's own
 * hook then leaves /queue to them, so no prompt is stored or run twice. */
export function queueSkillHooked(settingsPath: string): boolean {
  try {
    const s = read(settingsPath);
    return (
      has(s, "UserPromptSubmit", Q_SUBMIT_MARK) || has(s, "Stop", Q_DRAIN_MARK)
    );
  } catch {
    return false;
  }
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

export function installHooks(
  settingsPath: string,
  backupDir: string,
  which: HookStatus,
): CliResult {
  if (process.platform === "win32")
    return {
      ok: false,
      message:
        "these hooks are bash scripts; on Windows add them by hand under Git Bash (see README)",
    };
  try {
    const s = read(settingsPath);
    const g = (id: BuiltinId, cmd: string) =>
      guardedBuiltin(id, cmd, backupDir);
    if (which.ticket) {
      add(s, "PostToolUse", "Bash", g("ticket", TT), TT_MARK);
      add(s, "SessionStart", undefined, g("ticket", TT), TT_MARK);
    } else {
      remove(s, "PostToolUse", TT_MARK);
      remove(s, "SessionStart", TT_MARK);
    }
    if (which.pr) {
      add(s, "PreToolUse", "Bash", g("pr-review", PR_PRE), PR_MARK);
      add(s, "PostToolUse", "Bash", g("pr-watch", PR_POST), PR_POST_MARK);
    } else {
      remove(s, "PreToolUse", PR_MARK);
      remove(s, "PostToolUse", PR_POST_MARK);
    }
    if (which.queue) {
      add(s, "UserPromptSubmit", undefined, Q_SUBMIT, Q_SUBMIT_MARK, 10);
      add(s, "Stop", undefined, Q_DRAIN, Q_DRAIN_MARK, 10);
    } else {
      remove(s, "UserPromptSubmit", Q_SUBMIT_MARK);
      remove(s, "Stop", Q_DRAIN_MARK);
    }
    write(settingsPath, backupDir, s);
    return { ok: true, message: "hooks saved" };
  } catch (e) {
    return {
      ok: false,
      message: `could not update ${settingsPath}: ${String(e)}`,
    };
  }
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

export function deckHooksInstalled(settingsPath: string): boolean {
  try {
    const s = read(settingsPath);
    return (
      DECK_EVENTS.every((e) => has(s, e, DECK_MARK)) &&
      has(s, "PreToolUse", DECK_MONITOR_MARK)
    );
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

const GUARD_MARK = "masterdeck-builtin:";

/**
 * Built-in hooks installed before workflows could leave them out: replace each with its guarded
 * version (it skips sessions whose workflow removed the built-in). `dir`: MasterDeck's home.
 */
export function guardBuiltinHooks(
  settingsPath: string,
  dir: string,
): CliResult {
  if (process.platform === "win32") return { ok: true, message: "skipped" };
  try {
    const s = read(settingsPath);
    const want: [string, string | undefined, string, string, BuiltinId][] = [
      ["PostToolUse", "Bash", TT, TT_MARK, "ticket"],
      ["SessionStart", undefined, TT, TT_MARK, "ticket"],
      ["PreToolUse", "Bash", PR_PRE, PR_MARK, "pr-review"],
      ["PostToolUse", "Bash", PR_POST, PR_POST_MARK, "pr-watch"],
    ];
    let changed = false;
    for (const [event, matcher, cmd, mark, id] of want) {
      const list = s.hooks?.[event] ?? [];
      const found = list
        .flatMap((m) => m.hooks ?? [])
        .filter(
          (h) => typeof h.command === "string" && h.command.includes(mark),
        );
      if (!found.length || found.every((h) => h.command.includes(GUARD_MARK)))
        continue;
      remove(s, event, mark);
      add(s, event, matcher, guardedBuiltin(id, cmd, dir), mark);
      changed = true;
    }
    if (changed) write(settingsPath, dir, s);
    return {
      ok: true,
      message: changed ? "built-in hooks guarded" : "already guarded",
    };
  } catch (e) {
    return {
      ok: false,
      message: `could not update ${settingsPath}: ${String(e)}`,
    };
  }
}

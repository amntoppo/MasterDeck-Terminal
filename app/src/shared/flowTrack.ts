/**
 * Where a session is in its workflow, from what it did: the Bash commands in its transcript (a
 * push, `gh pr create`, `gh pr merge`, babysit-ticket's link), its PRs on GitHub (opened, merged),
 * its last turn end, and the steps MasterDeck's hooks logged. The hooks' log alone is not enough:
 * built-in steps don't write to it, and a session keeps the hooks it started with (Claude Code
 * reads them once, at start), so older sessions never log.
 */
import {
  builtinInfo,
  compileFlow,
  FLOW_TRIGGERS,
  triggerInfo,
  type Flow,
  type FlowTrigger,
} from "./flow";

export interface FlowEvent {
  trigger: FlowTrigger;
  at: number;
}

export interface FlowTrackState {
  /** tool_use ids of commands whose result has not been seen yet. */
  pending: Map<string, { cmd: string; at: number }>;
  /** The latest time each trigger point was reached. */
  reached: Partial<Record<FlowTrigger, number>>;
  /** Recent Bash commands (newest last), for command triggers. */
  commands: { cmd: string; at: number; ok: boolean }[];
}

/** A command without its heredoc bodies: text written to a file is not a command that runs. */
export function stripHeredocs(cmd: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const line of cmd.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (m) end = m[1];
  }
  return out.join("\n");
}

export const newFlowTrack = (): FlowTrackState => ({
  pending: new Map(),
  reached: {},
  commands: [],
});

const RUNS = (re: string) =>
  new RegExp(`(^|[;&|(\\n]|&&|\\|\\|)\\s*(command\\s+)?${re}`, "m");
const PUSH = RUNS("git\\s+push\\b");
const PR_CREATE = RUNS("gh\\s+pr\\s+create\\b");
const PR_MERGE = RUNS("gh\\s+pr\\s+merge\\b");
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        c &&
        typeof c === "object" &&
        typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .join("\n");
  return "";
}

const mark = (s: FlowTrackState, t: FlowTrigger, at: number) => {
  if ((s.reached[t] ?? 0) < at) s.reached[t] = at;
};

/** Feed complete transcript lines in file order. */
export function scanFlowLines(lines: string[], s: FlowTrackState): void {
  for (const line of lines) {
    const link = line.includes('"pr-link"');
    if (!link && !line.includes("tool_use") && !line.includes("tool_result"))
      continue;
    let o: {
      type?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const at =
      typeof o.timestamp === "string" ? Date.parse(o.timestamp) || 0 : 0;
    if (o.type === "pr-link") {
      mark(s, "pr-created", at);
      continue;
    }
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (!b || typeof b !== "object") continue;
      if (
        b.type === "tool_use" &&
        typeof b.id === "string" &&
        b.name === "Bash"
      ) {
        const raw = (b.input as { command?: unknown } | undefined)?.command;
        if (typeof raw !== "string") continue;
        const cmd = stripHeredocs(raw);
        s.pending.set(b.id, { cmd, at });
        if (PR_CREATE.test(cmd)) mark(s, "before-pr", at);
      } else if (
        b.type === "tool_result" &&
        typeof b.tool_use_id === "string"
      ) {
        const p = s.pending.get(b.tool_use_id);
        if (!p) continue;
        s.pending.delete(b.tool_use_id);
        const ok = b.is_error !== true;
        const out = textOf(b.content);
        const when = at || p.at;
        s.commands.push({ cmd: p.cmd.slice(0, 500), at: when, ok });
        if (s.commands.length > 60)
          s.commands.splice(0, s.commands.length - 60);
        if (!ok) continue;
        if (PUSH.test(p.cmd)) mark(s, "after-push", when);
        if (PR_CREATE.test(p.cmd) && PR_URL.test(out))
          mark(s, "pr-created", when);
        if (PR_MERGE.test(p.cmd)) mark(s, "pr-merged", when);
        // tt.sh is often called through a variable ($T link …): its answer is what counts.
        if (/linked session to #/.test(out)) mark(s, "linked", when);
      }
    }
  }
}

/** The order a ticket goes through; the other triggers can fire at any point. */
export const LIFECYCLE: FlowTrigger[] = [
  "session-start",
  "linked",
  "after-push",
  "before-pr",
  "pr-created",
  "pr-merged",
];

export interface FlowProgress {
  /** The trigger reached last, what the workflow does there, and whether the session is on it. */
  current: {
    trigger: FlowTrigger;
    at: number;
    lines: string[];
    builtins: string[];
    ongoing: boolean;
  } | null;
  /** Lifecycle points still ahead that the workflow does something at, in order. */
  next: FlowTrigger[];
  /** Other triggers in the workflow (commands, turn end, needs you, idle). */
  anytime: FlowTrigger[];
}

/**
 * Where a session is in its workflow. `events`: every time a trigger point was reached (any
 * source); `stoppedAt`: its last turn end; `working`: it is working now; `watching`: it waits on a
 * monitor (what a built-in like the PR watch leaves running).
 */
export function flowProgress(
  flow: Flow,
  events: FlowEvent[],
  stoppedAt: number,
  working: boolean,
  watching = false,
): FlowProgress {
  const compiled = compileFlow(flow);
  const triggers = new Set(
    flow.nodes
      .filter((n) => n.kind === "trigger")
      .map((n) => (n as { trigger: FlowTrigger }).trigger),
  );
  // A trigger counts when the workflow does something there: its own steps, or a built-in hung from it.
  const doesSomething = (t: FlowTrigger) =>
    compiled.steps.some((s) => s.trigger === t) ||
    builtinsAt(flow, t).length > 0;
  const active = [...triggers].filter(doesSomething);
  const latest = new Map<FlowTrigger, number>();
  for (const e of events)
    if (e.at > (latest.get(e.trigger) ?? 0)) latest.set(e.trigger, e.at);
  // The current point: the most recent one the workflow does something at, or a lifecycle point
  // (a merged PR shows as merged even when the workflow does nothing there).
  let current: FlowProgress["current"] = null;
  const counts = (t: FlowTrigger) =>
    active.includes(t) || (LIFECYCLE.includes(t) && t !== "session-start");
  for (const [t, at] of latest) {
    if (!counts(t) || (current && current.at >= at)) continue;
    const lines = compiled.steps
      .filter((s) => s.trigger === t)
      .flatMap((s) => s.note.split("\n"))
      .filter(
        (l) =>
          l.trim() && !/^Workflow step|^Then carry on|^Do these before/.test(l),
      )
      .map((l) => l.trim());
    current = {
      trigger: t,
      at,
      lines,
      builtins: builtinsAt(flow, t),
      ongoing: false,
    };
  }
  if (current) {
    // Running: the session works on it (since its last turn end), or waits on the watch a
    // built-in started there, and nothing later in the lifecycle has happened.
    const later =
      LIFECYCLE.indexOf(current.trigger) >= 0 &&
      LIFECYCLE.slice(LIFECYCLE.indexOf(current.trigger) + 1).some((t) =>
        latest.has(t),
      );
    const something = current.lines.length > 0 || current.builtins.length > 0;
    current.ongoing =
      something &&
      !later &&
      ((working && current.at > stoppedAt) ||
        (watching && current.builtins.length > 0));
  }
  // Lifecycle points after the furthest one reached.
  const furthest = Math.max(
    -1,
    ...LIFECYCLE.map((t, i) => (latest.has(t) ? i : -1)),
  );
  const next = LIFECYCLE.filter((t, i) => i > furthest && active.includes(t));
  const anytime = active.filter((t) => !LIFECYCLE.includes(t));
  return { current, next, anytime };
}

/** The built-ins hung from a trigger's blocks (reachable from it). */
function builtinsAt(flow: Flow, t: FlowTrigger): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    for (const e of flow.edges.filter((e) => e.from === id)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      const n = flow.nodes.find((x) => x.id === e.to);
      if (n?.kind === "builtin") out.push(builtinInfo(n.builtin).label);
      walk(e.to);
    }
  };
  for (const n of flow.nodes)
    if (n.kind === "trigger" && n.trigger === t) walk(n.id);
  return out;
}

/** Command triggers: when a recent command matched a trigger's pattern. */
export function commandEvents(
  flow: Flow,
  commands: FlowTrackState["commands"],
): FlowEvent[] {
  const out: FlowEvent[] = [];
  for (const n of flow.nodes) {
    if (
      n.kind !== "trigger" ||
      (n.trigger !== "command-before" && n.trigger !== "command-after") ||
      !n.pattern
    )
      continue;
    let re: RegExp;
    try {
      re = new RegExp(n.pattern);
    } catch {
      continue;
    }
    const hit = [...commands].reverse().find((c) => re.test(c.cmd));
    if (hit) out.push({ trigger: n.trigger, at: hit.at });
  }
  return out;
}

export const triggerShort = (t: string): string => {
  try {
    return triggerInfo(t as FlowTrigger).short;
  } catch {
    return t;
  }
};

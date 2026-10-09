/**
 * Workflows as a graph: trigger blocks, the actions that follow them (skills, instructions,
 * notifications) and MasterDeck's built-in steps, joined by arrows. An arrow is "then" (do the
 * next block after this one), or an outcome arrow ("if it worked" / "if it failed") the session
 * follows from the result. Each trigger's blocks compile to one plan the session is handed when
 * the trigger fires (by a hook), or to what MasterDeck does itself (needs you, idle).
 */
import {
  parseSteps,
  runsOrExit,
  shellQuote as q,
  TRIGGERS,
  type CustomStep,
  type TriggerId,
} from "./workflow";

export type FlowTrigger =
  | TriggerId
  | "command-before"
  | "command-after"
  | "turn-end"
  | "needs-you"
  | "idle"
  /** A trigger defined by the user or the builder (see CustomTrigger). */
  | `custom:${string}`;

export interface FlowTriggerInfo {
  id: FlowTrigger;
  label: string;
  /** Short text on the block. */
  short: string;
  hint: string;
  /** hook: a Claude Code hook hands the session its plan; deck: MasterDeck watches and acts. */
  runner: "hook" | "deck";
  /** The hook event (hook runners). */
  event?:
    "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop" | "UserPromptSubmit";
}

const SHORT: Record<TriggerId, string> = {
  "session-start": "Session starts",
  linked: "Linked to issue",
  "after-push": "After git push",
  "before-pr": "Before PR",
  "pr-created": "PR created",
  "pr-merged": "PR merged",
};

export const FLOW_TRIGGERS: FlowTriggerInfo[] = [
  ...TRIGGERS.map((t): FlowTriggerInfo => ({
    id: t.id,
    label: t.label,
    short: SHORT[t.id],
    hint:
      t.once === "commit"
        ? "Once per session and commit."
        : "Once per session.",
    runner: "hook",
    event: t.event,
  })),
  {
    id: "command-before",
    label: "Before a command runs",
    short: "Before command",
    hint: "Before a Bash command matching your pattern (a regular expression, e.g. npm test). Once per session and commit.",
    runner: "hook",
    event: "PreToolUse",
  },
  {
    id: "command-after",
    label: "After a command runs",
    short: "After command",
    hint: "After a Bash command matching your pattern (a regular expression, e.g. terraform apply). Once per session and commit.",
    runner: "hook",
    event: "PostToolUse",
  },
  {
    id: "turn-end",
    label: "When the session finishes a turn",
    short: "Turn finished",
    hint: "When the session stops and would wait for you: it does these first, once per turn.",
    runner: "hook",
    event: "Stop",
  },
  {
    id: "needs-you",
    label: "When the session needs you",
    short: "Needs you",
    hint: "When it waits on a prompt, a permission or a question. MasterDeck notifies you (notify blocks only).",
    runner: "deck",
  },
  {
    id: "idle",
    label: "When the session is idle for a while",
    short: "Idle",
    hint: "When it has been idle for the minutes you set: MasterDeck sends the instructions to it as a message and shows notifications. Once per idle spell.",
    runner: "deck",
  },
];

/**
 * A trigger defined by the user (or the workflow builder): a Claude Code hook event, the tool it
 * applies to, and a pattern on the command, the file, the prompt or the tool's output.
 */
export interface CustomTrigger {
  /** Lowercase letters, digits, dashes; used as `custom:<id>` in flows. */
  id: string;
  name: string;
  description: string;
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit";
  /** A regular expression on the tool name (e.g. `Bash`, `Edit|Write`); empty: any tool. */
  tool: string;
  /** What `pattern` is matched against: the Bash command, the file path, or the prompt. */
  field: "command" | "file" | "prompt";
  /** A regular expression; empty: always. */
  pattern: string;
  /** PostToolUse: a regular expression the tool's output must match (e.g. `FAIL|Error`). */
  output: string;
  once: "always" | "session" | "commit";
}

export const CUSTOM_PREFIX = "custom:";
export const isCustomTrigger = (t: string): t is `custom:${string}` =>
  /^custom:[a-z0-9-]{1,40}$/.test(t);

/** Validate a custom trigger from JSON; null when it can't be used. */
export function parseCustomTrigger(raw: unknown): CustomTrigger | null {
  const o = obj(raw);
  const id = str(o.id, 40).toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
  const event =
    o.event === "PreToolUse" ||
    o.event === "PostToolUse" ||
    o.event === "UserPromptSubmit"
      ? o.event
      : null;
  if (!event) return null;
  const field =
    o.field === "file" || o.field === "prompt" ? o.field : "command";
  const once = o.once === "always" || o.once === "session" ? o.once : "commit";
  return {
    id,
    name: str(o.name, 60).trim() || id,
    description: str(o.description, 300).trim(),
    event,
    tool: event === "UserPromptSubmit" ? "" : str(o.tool, 100),
    field: event === "UserPromptSubmit" ? "prompt" : field,
    pattern: str(o.pattern, 300),
    output: event === "PostToolUse" ? str(o.output, 300) : "",
    once,
  };
}

/** What is wrong with a custom trigger (bad regular expressions, a prompt field on a tool event). */
export function customTriggerProblems(c: CustomTrigger): string[] {
  const out: string[] = [];
  for (const [k, v] of [
    ["tool", c.tool],
    ["pattern", c.pattern],
    ["output", c.output],
  ] as const)
    if (v)
      try {
        new RegExp(v);
      } catch {
        out.push(`${c.id}: ${k} is not a valid regular expression`);
      }
  if (c.field === "prompt" && c.event !== "UserPromptSubmit")
    out.push(`${c.id}: field "prompt" only works with UserPromptSubmit`);
  if (!c.pattern && !c.output && !c.tool && c.event !== "UserPromptSubmit")
    out.push(
      `${c.id}: matches every tool call; give it a tool, a pattern or an output`,
    );
  return out;
}

/** The custom triggers the editor and the compiler know (MasterDeck's library). */
let customs: CustomTrigger[] = [];
export function setCustomTriggers(list: CustomTrigger[]): void {
  customs = list;
}
export const customTriggerList = (): CustomTrigger[] => customs;

const CUSTOM_EVENT_TEXT: Record<CustomTrigger["event"], string> = {
  PreToolUse: "Before",
  PostToolUse: "After",
  UserPromptSubmit: "When you send a prompt",
};

export function customInfo(c: CustomTrigger): FlowTriggerInfo {
  const what = [
    CUSTOM_EVENT_TEXT[c.event],
    c.tool
      ? `${c.tool} calls`
      : c.event === "UserPromptSubmit"
        ? ""
        : "any tool call",
    c.pattern ? `where the ${c.field} matches ${c.pattern}` : "",
    c.output ? `with output matching ${c.output}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const once =
    c.once === "always"
      ? "Every time."
      : c.once === "session"
        ? "Once per session."
        : "Once per session and commit.";
  return {
    id: `custom:${c.id}`,
    label: c.name,
    short: c.name,
    hint: `${c.description ? `${c.description} ` : ""}${what}. ${once}`,
    runner: "hook",
    event: c.event,
  };
}

/** A trigger's description; custom ones from `extra` (a draft's) or the library. */
export const triggerInfo = (
  id: FlowTrigger,
  extra: CustomTrigger[] = [],
): FlowTriggerInfo => {
  const known = FLOW_TRIGGERS.find((t) => t.id === id);
  if (known) return known;
  const cid = String(id).slice(CUSTOM_PREFIX.length);
  const c =
    extra.find((x) => x.id === cid) ?? customs.find((x) => x.id === cid);
  if (c) return customInfo(c);
  return {
    id,
    label: `Unknown trigger ${cid}`,
    short: cid,
    hint: "This custom trigger is not in the library (deleted?).",
    runner: "hook",
  };
};

/** Whether a trigger id is one MasterDeck knows (built-in, or a custom one in the library or `extra`). */
export const knownTrigger = (
  id: string,
  extra: CustomTrigger[] = [],
): boolean =>
  FLOW_TRIGGERS.some((t) => t.id === id) ||
  (isCustomTrigger(id) &&
    [...extra, ...customs].some((c) => `custom:${c.id}` === id));

export type BuiltinId = "ticket" | "pr-review" | "pr-watch";

export interface BuiltinInfo {
  id: BuiltinId;
  label: string;
  /** The trigger it belongs to (where its hook runs). */
  trigger: FlowTrigger;
  what: string;
}

export const BUILTINS: BuiltinInfo[] = [
  {
    id: "ticket",
    label: "Board moves",
    trigger: "linked",
    what: "MasterDeck links the session to its issue and moves the card: In Dev, PR Raised (not for drafts), Dev Done; and links the PR under Development.",
  },
  {
    id: "pr-review",
    label: "Self-review before the PR",
    trigger: "before-pr",
    what: "MasterDeck stops the first `gh pr create` of each branch and asks it to review its diff against the base branch.",
  },
  {
    id: "pr-watch",
    label: "Watch the PR",
    trigger: "pr-created",
    what: "MasterDeck watches the PR and sends the session new review threads, comments, conflicts, a stalled review and the merge, until it is merged or closed.",
  },
];

export const builtinInfo = (id: BuiltinId): BuiltinInfo =>
  BUILTINS.find((b) => b.id === id)!;

export type FlowNode =
  | {
      id: string;
      x: number;
      y: number;
      kind: "trigger";
      trigger: FlowTrigger;
      pattern?: string;
      minutes?: number;
    }
  | {
      id: string;
      x: number;
      y: number;
      kind: "skill";
      skill: string;
      mode: "background" | "session";
      instructions: string;
    }
  | { id: string; x: number; y: number; kind: "instruction"; text: string }
  | { id: string; x: number; y: number; kind: "notify"; text: string }
  | { id: string; x: number; y: number; kind: "builtin"; builtin: BuiltinId }
  /** Arm a monitor from the library: `args` go to its script, `instructions` say what to do per event. */
  | {
      id: string;
      x: number;
      y: number;
      kind: "monitor";
      monitor: string;
      args: string;
      instructions: string;
    }
  /** A frame of blocks the session repeats until its criterion is met or a limit is hit (#82). */
  | {
      id: string;
      x: number;
      y: number;
      kind: "loop";
      name: string;
      members: string[];
      w: number;
      h: number;
      check: {
        command: string;
        output: string;
        outputMode: "match" | "no-match";
        timeoutMin: number;
      };
      agentDone: { on: boolean; goal: string };
      limits: { iterations: number; minutes: number; stall: number };
    };

/** The blocks a loop may repeat: what the session does itself (no triggers, built-ins or loops). */
export const LOOP_MEMBER_KINDS = [
  "skill",
  "instruction",
  "monitor",
  "notify",
] as const;

/** A new, empty Loop frame. */
export const newLoop = (id: string, x: number, y: number): FlowNode => ({
  id,
  x,
  y,
  kind: "loop",
  name: "Loop",
  members: [],
  w: 420,
  h: 200,
  check: { command: "", output: "", outputMode: "match", timeoutMin: 5 },
  agentDone: { on: false, goal: "" },
  limits: { iterations: 10, minutes: 0, stall: 0 },
});

/**
 * A monitor: a script whose every output line is an event that wakes the session (Claude Code's
 * Monitor tool). Workflows arm it at a trigger; the session acts on each event.
 */
export interface MonitorDef {
  /** Lowercase letters, digits, dashes. */
  id: string;
  name: string;
  /** What it watches; shown in each notification. */
  description: string;
  /** Minutes before it expires (Claude Code allows at most 30). */
  timeoutMin: number;
  /** Re-arm it each time it expires. */
  rearm: boolean;
  /** When to stop re-arming (e.g. "the PR is merged or closed"). */
  until: string;
  /** What to do on each event, unless the block says otherwise. */
  onEvent: string;
  /** The script's absolute path (set when MasterDeck loads it). */
  path: string;
}

export function parseMonitor(raw: unknown, path = ""): MonitorDef | null {
  const o = obj(raw);
  const id = str(o.id, 40).toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
  return {
    id,
    name: str(o.name, 60).trim() || id,
    description: str(o.description, 300).trim(),
    timeoutMin: Math.min(30, Math.max(1, num(o.timeoutMin, 30))),
    rearm: o.rearm !== false,
    until: str(o.until, 200).trim(),
    onEvent: str(o.onEvent, 1000).trim(),
    path: path || str(o.path, 500),
  };
}

let monitors: MonitorDef[] = [];
export function setMonitors(list: MonitorDef[]): void {
  monitors = list;
}
export const monitorList = (): MonitorDef[] => monitors;
export const findMonitor = (
  id: string,
  extra: MonitorDef[] = [],
): MonitorDef | undefined =>
  extra.find((m) => m.id === id) ?? monitors.find((m) => m.id === id);

/** What a monitor block tells the session: arm it (exactly), re-arm it, and act on each event. */
export function monitorText(
  m: MonitorDef,
  args: string,
  instructions: string,
): string {
  const cmd = `bash '${m.path.replace(/'/g, "'\\''")}'${args.trim() ? ` ${args.trim()}` : ""}`;
  const act = instructions.trim() || m.onEvent || "act on it";
  return (
    `Arm a monitor with the Monitor tool: command \`${cmd}\`${args.includes("<") ? " (fill in the <...> parts)" : ""}, ` +
    `description "${m.name}${m.description ? `: ${m.description}` : ""}", timeout_ms ${m.timeoutMin * 60_000}. ` +
    (m.rearm
      ? `When it expires, arm it again${m.until ? `, until ${m.until}` : ""}. `
      : "") +
    `On each event it emits: ${act}`
  );
}

/** `met` / `limit` leave a loop: when its criterion is met, or when a limit stopped it. */
export type EdgeKind = "then" | "ok" | "fail" | "met" | "limit";
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
}
export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const EDGE_LABEL: Record<EdgeKind, string> = {
  then: "then",
  ok: "if it worked",
  fail: "if it failed",
  met: "when met",
  limit: "at the limit",
};

export const newNodeId = (): string =>
  `n-${Math.random().toString(36).slice(2, 8)}`;
export const edgeId = (from: string, to: string): string => `e-${from}-${to}`;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";
const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d;
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
const ID = /^[a-z0-9-]{1,24}$/;

/** A flow from JSON: unknown blocks, bad fields and arrows to nothing are dropped. */
export function parseFlow(raw: unknown): Flow {
  const o = obj(raw);
  const nodes: FlowNode[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(o.nodes) ? o.nodes.map(obj) : []) {
    const id = str(r.id, 24);
    if (!ID.test(id) || seen.has(id)) continue;
    const x = num(r.x, 0);
    const y = num(r.y, 0);
    let n: FlowNode | null = null;
    // Custom triggers are kept even when unknown here: the check reports them.
    if (
      r.kind === "trigger" &&
      typeof r.trigger === "string" &&
      (FLOW_TRIGGERS.some((t) => t.id === r.trigger) ||
        isCustomTrigger(r.trigger))
    ) {
      n = { id, x, y, kind: "trigger", trigger: r.trigger as FlowTrigger };
      if (r.trigger === "command-before" || r.trigger === "command-after")
        n.pattern = str(r.pattern, 200);
      if (r.trigger === "idle")
        n.minutes = Math.min(24 * 60, Math.max(1, num(r.minutes, 15)));
    } else if (r.kind === "skill" && /^[\w:.-]{0,80}$/.test(str(r.skill, 80)))
      n = {
        id,
        x,
        y,
        kind: "skill",
        skill: str(r.skill, 80),
        mode: r.mode === "session" ? "session" : "background",
        instructions: str(r.instructions, 2000),
      };
    else if (r.kind === "instruction")
      n = { id, x, y, kind: "instruction", text: str(r.text, 4000) };
    else if (r.kind === "notify")
      n = { id, x, y, kind: "notify", text: str(r.text, 300) };
    else if (r.kind === "builtin" && BUILTINS.some((b) => b.id === r.builtin))
      n = { id, x, y, kind: "builtin", builtin: r.builtin as BuiltinId };
    else if (
      r.kind === "monitor" &&
      /^[a-z0-9-]{1,40}$/.test(str(r.monitor, 40))
    )
      n = {
        id,
        x,
        y,
        kind: "monitor",
        monitor: str(r.monitor, 40),
        args: str(r.args, 300),
        instructions: str(r.instructions, 2000),
      };
    else if (r.kind === "loop") {
      const check = obj(r.check);
      const done = obj(r.agentDone);
      const lim = obj(r.limits);
      const stall = num(lim.stall, 0);
      n = {
        id,
        x,
        y,
        kind: "loop",
        name: str(r.name, 60) || "Loop",
        // Checked against the kept blocks below, once every block is known.
        members: (Array.isArray(r.members) ? r.members : [])
          .map((m) => str(m, 24))
          .filter((m) => ID.test(m)),
        w: clamp(num(r.w, 420), 200, 2000),
        h: clamp(num(r.h, 200), 120, 1500),
        check: {
          command: str(check.command, 500),
          output: str(check.output, 300),
          outputMode: check.outputMode === "no-match" ? "no-match" : "match",
          // The hook has 10 minutes in all; the check gets at most 9 of them.
          timeoutMin: clamp(num(check.timeoutMin, 5), 1, 9),
        },
        agentDone: { on: done.on === true, goal: str(done.goal, 1000) },
        limits: {
          iterations: clamp(num(lim.iterations, 10), 1, 100),
          minutes: clamp(num(lim.minutes, 0), 0, 24 * 60),
          // 0 is off; one identical round is no stall, so on starts at 2.
          stall: stall <= 0 ? 0 : clamp(stall, 2, 10),
        },
      };
    }
    if (!n) continue;
    seen.add(id);
    nodes.push(n);
  }
  // One of each built-in.
  const builtins = new Set<string>();
  const kept = nodes.filter(
    (n) =>
      n.kind !== "builtin" ||
      (!builtins.has(n.builtin) && builtins.add(n.builtin)),
  );
  // A loop's members: blocks that exist and may repeat, each in the first loop that lists it.
  const memberOf = new Map<string, string>();
  for (const n of kept) {
    if (n.kind !== "loop") continue;
    n.members = n.members.filter((m) => {
      const b = kept.find((k) => k.id === m);
      if (
        !b ||
        memberOf.has(m) ||
        !(LOOP_MEMBER_KINDS as readonly string[]).includes(b.kind)
      )
        return false;
      memberOf.set(m, n.id);
      return true;
    });
  }
  const ids = new Set(kept.map((n) => n.id));
  const edges: FlowEdge[] = [];
  const pairs = new Set<string>();
  for (const r of Array.isArray(o.edges) ? o.edges.map(obj) : []) {
    const from = str(r.from, 24);
    let to = str(r.to, 24);
    if (!ids.has(from) || !ids.has(to)) continue;
    // Leaving a loop goes through its met / limit arrows: a member's arrow out of its frame
    // (its own frame included) is dropped. Entering one starts it at its top: an arrow into a
    // member from outside points at the loop.
    const inLoop = memberOf.get(from);
    if (inLoop && memberOf.get(to) !== inLoop) continue;
    const toLoop = memberOf.get(to);
    if (toLoop && toLoop !== inLoop) to = toLoop;
    if (from === to || pairs.has(`${from}>${to}`)) continue;
    if (kept.find((n) => n.id === to)?.kind === "trigger") continue;
    const fromKind = kept.find((n) => n.id === from)?.kind;
    const kind: EdgeKind =
      fromKind === "loop"
        ? r.kind === "met" || r.kind === "limit"
          ? r.kind
          : "then"
        : fromKind !== "trigger" && (r.kind === "ok" || r.kind === "fail")
          ? r.kind
          : "then";
    pairs.add(`${from}>${to}`);
    edges.push({ id: edgeId(from, to), from, to, kind });
  }
  return { nodes: kept, edges };
}

/** Each loop member's loop id. */
export function frameOf(flow: Flow): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of flow.nodes)
    if (n.kind === "loop")
      for (const m of n.members) if (!out.has(m)) out.set(m, n.id);
  return out;
}

/**
 * Whether an arrow from→to would close a cycle. A Loop frame counts as one node (its repeating is
 * the hook's, not the graph's), so the graph stays acyclic; between members of one frame they are
 * ordinary blocks.
 */
export function makesCycle(flow: Flow, from: string, to: string): boolean {
  const frame = frameOf(flow);
  const inFrame = frame.get(from);
  if (inFrame && inFrame === frame.get(to))
    return walksTo(flow, new Map(), from, to);
  const fromF = frame.get(from) ?? from;
  const toF = frame.get(to) ?? to;
  // A frame and its own member (or a block and itself): never an arrow.
  if (fromF === toF) return true;
  return walksTo(flow, frame, fromF, toF);
}

function walksTo(
  flow: Flow,
  frame: Map<string, string>,
  from: string,
  to: string,
): boolean {
  const next = new Map<string, string[]>();
  for (const e of flow.edges) {
    const a = frame.get(e.from) ?? e.from;
    next.set(a, [...(next.get(a) ?? []), frame.get(e.to) ?? e.to]);
  }
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(next.get(n) ?? []));
  }
  return false;
}

/** The workflow every install starts with: each trigger, and the built-ins under theirs. */
export function defaultFlow(): Flow {
  return fromSteps([]);
}

/** A flow from the old list of steps (each hung from its trigger), with every built-in. */
export function fromSteps(steps: CustomStep[]): Flow {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  TRIGGERS.forEach((t, i) => {
    const tid = `t-${t.id}`.slice(0, 24);
    nodes.push({ id: tid, x: 0, y: 0, kind: "trigger", trigger: t.id });
    const hang = (n: FlowNode) => {
      nodes.push(n);
      edges.push({ id: edgeId(tid, n.id), from: tid, to: n.id, kind: "then" });
    };
    for (const b of BUILTINS.filter((b) => b.trigger === t.id))
      hang({ id: `b-${b.id}`, x: 0, y: 0, kind: "builtin", builtin: b.id });
    for (const s of steps.filter((s) => s.trigger === t.id)) {
      const id = `s-${s.id}`.slice(0, 24).replace(/-+$/, "") || `s-${i}`;
      hang(
        s.kind === "instruction"
          ? { id, x: 0, y: 0, kind: "instruction", text: s.instructions }
          : {
              id,
              x: 0,
              y: 0,
              kind: "skill",
              skill: s.skill,
              mode: s.mode,
              instructions: s.instructions,
            },
      );
    }
  });
  return layoutFlow({ nodes, edges });
}

/** Place the blocks: each trigger on its own row, what follows it to the right, branches below. */
export function layoutFlow(flow: Flow, gapX = 290, gapY = 110): Flow {
  const out = new Map<string, FlowEdge[]>();
  for (const e of flow.edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const pos = new Map<string, { x: number; y: number }>();
  let row = 0;
  const place = (id: string, depth: number) => {
    if (pos.has(id)) return;
    pos.set(id, { x: depth * gapX, y: row * gapY });
    const kids = out.get(id) ?? [];
    kids.forEach((e, i) => {
      if (i > 0 && !pos.has(e.to)) row++;
      place(e.to, depth + 1);
    });
  };
  const triggers = flow.nodes.filter((n) => n.kind === "trigger");
  for (const t of triggers) {
    place(t.id, 0);
    row++;
  }
  // Blocks no trigger reaches: a row of their own at the bottom.
  for (const n of flow.nodes) if (!pos.has(n.id)) (place(n.id, 1), row++);
  return {
    ...flow,
    nodes: flow.nodes.map((n) => ({ ...n, ...pos.get(n.id)! })),
  };
}

/** What a skill block tells the session. */
function skillText(n: Extract<FlowNode, { kind: "skill" }>): string {
  const extra = n.instructions.trim() ? ` ${n.instructions.trim()}` : "";
  if (n.mode === "session")
    return `Use the ${n.skill} skill for this session's work.${extra}`;
  return (
    `Launch a subagent with the Agent tool (general-purpose, in the background; do not wait for it) with this prompt, filled in: ` +
    `"Use the ${n.skill} skill for the work on branch <branch> in <worktree path>, linked to issue <#N>.${extra} ` +
    `Do not commit, push or switch branches unless the skill says to; at the end, report what you did." Pass on its report when it arrives.`
  );
}

function blockText(n: FlowNode, mons: MonitorDef[] = []): string | null {
  switch (n.kind) {
    case "monitor": {
      const m = findMonitor(n.monitor, mons);
      return m ? monitorText(m, n.args, n.instructions) : null;
    }
    case "skill":
      return n.skill ? skillText(n) : null;
    case "instruction":
      return n.text.trim() || null;
    case "builtin":
      return `${builtinInfo(n.builtin).label}: MasterDeck does this itself and tells you when there is something to do; wait for that before moving on.`;
    default:
      return null;
  }
}

type LoopNode = Extract<FlowNode, { kind: "loop" }>;

/** What ends a loop, in the words the session reads ("" when nothing does: the check reports it). */
function loopCriterion(n: LoopNode): string {
  const cmd = n.check.command.trim();
  const check = !cmd
    ? ""
    : n.check.output
      ? `the output of \`${cmd}\` must ${n.check.outputMode === "no-match" ? "no longer match" : "match"} \`${n.check.output}\``
      : `\`${cmd}\` must pass`;
  const goal = n.agentDone.goal.trim();
  if (!n.agentDone.on) return check;
  if (!check)
    return `you reach this goal: ${goal}; when you have, end your turn with a line starting "LOOP DONE:" and why`;
  return `${check}, and you end your turn with a line starting "LOOP DONE:" and why once you reach this goal: ${goal}`;
}

/** Where a loop's round starts: its members no other member leads to, in the frame's order. */
function loopEntry(flow: Flow, n: LoopNode): string[] {
  const inside = new Set(n.members);
  return n.members.filter(
    (m) => !flow.edges.some((e) => e.to === m && inside.has(e.from)),
  );
}

/** The targets of a block's arrows of one kind. */
const targets = (flow: Flow, from: string, kind: EdgeKind): string[] =>
  flow.edges.filter((e) => e.from === from && e.kind === kind).map((e) => e.to);

/** The plan for the blocks after `start` (see `planFrom`). */
function planLines(
  flow: Flow,
  start: string,
  mons: MonitorDef[] = [],
): string[] {
  return planFrom(
    flow,
    flow.edges.filter((e) => e.from === start).map((e) => e.to),
    mons,
  );
}

/**
 * The plan from the blocks `first`: numbered steps in order; several arrows out of a block run
 * side by side; outcome arrows become "If it worked / If it failed" under the step; a loop is one
 * step with its round and what comes after it inside.
 */
function planFrom(
  flow: Flow,
  first: string[],
  mons: MonitorDef[] = [],
): string[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const out = new Map<string, FlowEdge[]>();
  for (const e of flow.edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const numbered = new Map<string, string>();
  const lines: string[] = [];

  const chain = (first: string[], indent: string, prefix: string) => {
    // Built-ins with nothing after them add nothing to the plan (their hook speaks for itself).
    const quiet = (id: string) =>
      byId.get(id)?.kind === "builtin" && !(out.get(id) ?? []).length;
    let current = first.filter((id) => !quiet(id));
    let i = 1;
    while (current.length) {
      if (current.length > 1) {
        lines.push(
          `${indent}${i === 1 ? "At the same time:" : "Then, at the same time:"}`,
        );
        current.forEach((id, k) =>
          chain(
            [id],
            `${indent}  `,
            `${prefix}${i}${String.fromCharCode(97 + k)}.`,
          ),
        );
        return;
      }
      const id = current[0];
      const n = byId.get(id);
      if (!n) return;
      const label = `${prefix}${i}`;
      const seen = numbered.get(id);
      if (seen) {
        lines.push(`${indent}${label}. Go on with step ${seen}.`);
        return;
      }
      const kids = out.get(id) ?? [];
      if (n.kind === "loop") {
        numbered.set(id, label);
        const crit = loopCriterion(n);
        lines.push(
          `${indent}${label}. ${i > 1 ? "Then: " : ""}Repeat until the loop "${n.name}" is done (MasterDeck checks it each time you finish a turn${crit ? `: ${crit}` : ""}). Each round:`,
        );
        chain(loopEntry(flow, n), `${indent}   `, `${label}.`);
        lines.push(
          `${indent}   Write a short note of what you tried to the loop's progress file each round (MasterDeck gives you its path).`,
        );
        // Headings only over a branch that says something (a notify block adds nothing here).
        const over = lines.length;
        lines.push(`${indent}   When MasterDeck says the loop is over:`);
        for (const [kind, head] of [
          ["met", "If the criterion was met:"],
          ["limit", "If a limit was hit:"],
        ] as const) {
          const branch = targets(flow, id, kind);
          if (!branch.length) continue;
          const at = lines.length;
          lines.push(`${indent}     ${head}`);
          chain(branch, `${indent}       `, `${label}.${kind}.`);
          if (lines.length === at + 1) lines.pop();
        }
        if (lines.length === over + 1) lines.pop();
        // A plain arrow out of a frame goes on after the loop, however it ended.
        current = kids
          .filter((e) => e.kind === "then" && !quiet(e.to))
          .map((e) => e.to);
        i++;
        continue;
      }
      // A built-in with nothing after it adds nothing to the plan (its hook speaks for itself).
      const text =
        n.kind === "builtin" && !kids.length ? null : blockText(n, mons);
      if (!text) {
        current = kids.filter((e) => e.kind === "then").map((e) => e.to);
        continue;
      }
      numbered.set(id, label);
      lines.push(`${indent}${label}. ${i > 1 ? "Then: " : ""}${text}`);
      for (const [kind, head] of [
        ["ok", "If it worked:"],
        ["fail", "If it failed:"],
      ] as const) {
        const branch = kids.filter((e) => e.kind === kind).map((e) => e.to);
        if (!branch.length) continue;
        lines.push(`${indent}   ${head}`);
        chain(branch, `${indent}     `, `${label}.`);
      }
      current = kids
        .filter((e) => e.kind === "then" && !quiet(e.to))
        .map((e) => e.to);
      i++;
    }
  };
  chain(first, "", "");
  return lines;
}

/** What a trigger compiles to: the hook's plan, or MasterDeck's own actions. */
export interface CompiledStep {
  /** The trigger block's id and a hash of what it says: a changed plan reaches sessions again. */
  id: string;
  trigger: FlowTrigger;
  pattern?: string;
  minutes?: number;
  /** Hook triggers: the text handed to the session. Idle: the message MasterDeck sends. */
  note: string;
  /** Deck triggers: notifications to show. */
  notify?: string[];
  /** Custom triggers: what the hook matches (copied from the definition, so a session file has all it needs). */
  custom?: Omit<CustomTrigger, "id" | "name" | "description">;
  /** The loops under this trigger: everything the loop hook needs, so the session file is enough. */
  loops?: CompiledLoop[];
}

export interface CompiledLoop {
  id: string;
  name: string;
  check: LoopNode["check"];
  agentDone: { on: boolean; goal: string };
  limits: { iterations: number; minutes: number; stall: number };
  /** The members' plan, handed back each iteration. */
  plan: string;
  /** What to do after: the `met` and `limit` branches' plan text ("" when there is no arrow). */
  met: string;
  limit: string;
  /**
   * The loop whose arrow leads here (through blocks that are not loops), and which arrow; null
   * for a loop the trigger starts. Only those are armed when the trigger fires; the loop hook
   * opens the others when the loop before them closes.
   */
  after: { loop: string; via: "met" | "limit" | "then" } | null;
}

/**
 * Where each loop after `start` sits: the loop it comes after, and whether an "if it worked /
 * failed" arrow leads to it. The first path found decides (a block is numbered once in the plan).
 */
function loopPlaces(
  flow: Flow,
  start: string,
): Map<string, { after: CompiledLoop["after"]; branch: boolean }> {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const out = new Map<string, { after: CompiledLoop["after"]; branch: boolean }>();
  const seen = new Set<string>();
  const walk = (id: string, after: CompiledLoop["after"], branch: boolean) => {
    const isLoop = byId.get(id)?.kind === "loop";
    for (const e of flow.edges.filter((e) => e.from === id)) {
      const next = isLoop
        ? {
            loop: id,
            via: e.kind === "met" || e.kind === "limit" ? e.kind : ("then" as const),
          }
        : after;
      const inBranch = branch || e.kind === "ok" || e.kind === "fail";
      if (byId.get(e.to)?.kind === "loop" && !out.has(e.to))
        out.set(e.to, { after: next, branch: inBranch });
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      walk(e.to, next, inBranch);
    }
  };
  walk(start, null, false);
  return out;
}

export interface Problem {
  node?: string;
  text: string;
}

const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 7);
};

const ENDING: Partial<Record<FlowTrigger, string>> = {
  "turn-end":
    "Do these before you finish this turn, then stop as you would have.",
  "command-before":
    "Do these before running the command, then run it (unless a step says not to).",
};

/** The flow as the hooks and MasterDeck run it, and what is wrong with it. */
export function compileFlow(
  flow: Flow,
  extra: CustomTrigger[] = [],
  extraMonitors: MonitorDef[] = [],
): {
  steps: CompiledStep[];
  builtins: BuiltinId[];
  problems: Problem[];
} {
  const steps: CompiledStep[] = [];
  const problems: Problem[] = [];
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  // What a block leads to: its arrows' targets, and a loop's members (no arrow enters them).
  const next = (id: string): string[] => {
    const n = byId.get(id);
    return [
      ...flow.edges.filter((e) => e.from === id).map((e) => e.to),
      ...(n?.kind === "loop" ? n.members : []),
    ];
  };
  const reached = new Set<string>();
  const reach = (id: string) => {
    for (const to of next(id))
      if (!reached.has(to)) {
        reached.add(to);
        reach(to);
      }
  };
  for (const n of flow.nodes) {
    if (n.kind !== "trigger") continue;
    reach(n.id);
    const info = triggerInfo(n.trigger, extra);
    const def = isCustomTrigger(n.trigger)
      ? [...extra, ...customs].find((c) => `custom:${c.id}` === n.trigger)
      : undefined;
    if (isCustomTrigger(n.trigger) && !def) {
      problems.push({
        node: n.id,
        text: `Unknown trigger ${n.trigger.slice(7)}: it is not in the trigger library`,
      });
      continue;
    }
    const under = new Set<string>();
    const walk = (id: string) => {
      for (const to of next(id))
        if (!under.has(to)) {
          under.add(to);
          walk(to);
        }
    };
    walk(n.id);
    const blocks = [...under].map((id) => byId.get(id)!).filter(Boolean);
    if (
      (n.trigger === "command-before" || n.trigger === "command-after") &&
      blocks.length
    ) {
      if (!n.pattern?.trim())
        problems.push({
          node: n.id,
          text: `${info.short}: set the command pattern`,
        });
      else
        try {
          new RegExp(n.pattern);
        } catch {
          problems.push({
            node: n.id,
            text: `${info.short}: the pattern is not a valid regular expression`,
          });
        }
    }
    const notify = blocks
      .filter((b) => b.kind === "notify")
      .map((b) => (b as { text: string }).text.trim() || `${info.short}`);
    if (info.runner === "hook") {
      for (const b of blocks.filter((b) => b.kind === "notify"))
        problems.push({
          node: b.id,
          text: "Notify works after “Needs you” and “Idle” only",
        });
      const lines = planLines(flow, n.id, extraMonitors);
      if (!lines.length) continue;
      const loopNodes = blocks.filter((b): b is LoopNode => b.kind === "loop");
      // S6: the turn-end trigger stands aside while a loop is open, so a loop it started would
      // block every stop for ever: reported, and never armed.
      if (n.trigger === "turn-end")
        for (const b of loopNodes)
          problems.push({
            node: b.id,
            text: `A loop under "${info.short}" would never end: put it under another trigger`,
          });
      const places = loopPlaces(flow, n.id);
      const place = (id: string) =>
        places.get(id) ?? { after: null, branch: false };
      if (n.trigger !== "turn-end") {
        // ponytail: the hook cannot see which outcome arrow the session followed, so a loop in
        // such a branch is refused; allowing it needs the session to report the branch it took.
        for (const b of loopNodes)
          if (place(b.id).branch)
            problems.push({
              node: b.id,
              text: `Loop "${b.name}" is inside an "if it worked/failed" branch: MasterDeck can't tell which branch the session took. Put it on the main path.`,
            });
        // ponytail: one open loop per session (the hook works on the first open one); running
        // loops side by side needs the hook to evaluate each open loop at every turn end.
        // A "then" arrow out of a loop leads on however it ended, so it meets its met and its
        // limit arrows too.
        const together = (
          a: CompiledLoop["after"],
          b: CompiledLoop["after"],
        ): boolean =>
          a === null || b === null
            ? a === b
            : a.loop === b.loop &&
              (a.via === b.via || a.via === "then" || b.via === "then");
        const seen: LoopNode[] = [];
        for (const b of loopNodes) {
          const first = seen.find((s) =>
            together(place(s.id).after, place(b.id).after),
          );
          if (first)
            problems.push({
              node: b.id,
              text: `Loops "${first.name}" and "${b.name}" would run at the same time: put one after the other.`,
            });
          else seen.push(b);
        }
      }
      const loops: CompiledLoop[] =
        n.trigger === "turn-end"
          ? []
          : loopNodes.map((b) => ({
              id: b.id,
              name: b.name,
              check: { ...b.check },
              agentDone: { ...b.agentDone },
              limits: { ...b.limits },
              plan: planFrom(flow, loopEntry(flow, b), extraMonitors).join(
                "\n",
              ),
              met: planFrom(flow, targets(flow, b.id, "met"), extraMonitors).join(
                "\n",
              ),
              limit: planFrom(
                flow,
                targets(flow, b.id, "limit"),
                extraMonitors,
              ).join("\n"),
              after: place(b.id).after,
            }));
      // Lowercase the first letter, unless it starts an acronym ("SQL migration edited").
      const label = /^[A-Z][A-Z]/.test(info.label)
        ? info.label
        : `${info.label[0].toLowerCase()}${info.label.slice(1)}`;
      const head = `Workflow step (${label}${n.pattern ? `: ${n.pattern}` : ""}):`;
      const note = [
        head,
        ...lines,
        ENDING[n.trigger] ?? "Then carry on with what you were doing.",
      ].join("\n");
      const custom = def
        ? {
            event: def.event,
            tool: def.tool,
            field: def.field,
            pattern: def.pattern,
            output: def.output,
            once: def.once,
          }
        : undefined;
      steps.push({
        // A changed loop (a limit, the check) reaches sessions again, like a changed plan.
        id: `${n.id}-${hash(note + (n.pattern ?? "") + (custom ? JSON.stringify(custom) : "") + (loops.length ? JSON.stringify(loops) : ""))}`.slice(
          0,
          40,
        ),
        trigger: n.trigger,
        ...(n.pattern ? { pattern: n.pattern } : {}),
        note,
        ...(custom ? { custom } : {}),
        // Only when there are any: a flow without loops compiles byte for byte as before.
        ...(loops.length ? { loops } : {}),
      });
    } else {
      // No Stop hook drives a deck trigger's blocks: a loop under one could never be enforced.
      for (const b of blocks.filter((b) => b.kind === "loop"))
        problems.push({
          node: b.id,
          text: "Loops run in the session: put them under a trigger the session gets",
        });
      const acts = blocks.filter(
        (b) => b.kind !== "notify" && b.kind !== "builtin" && b.kind !== "loop",
      );
      if (n.trigger === "needs-you")
        for (const b of acts)
          problems.push({
            node: b.id,
            text: "After “Needs you”, only notify blocks run (a message would answer its prompt)",
          });
      for (const b of blocks.filter((b) => b.kind === "builtin"))
        problems.push({
          node: b.id,
          text: "Built-ins run from their own hook; connect them to their trigger",
        });
      const note =
        n.trigger === "idle"
          ? planLines(flow, n.id, extraMonitors).join("\n")
          : "";
      if (!note && !notify.length) continue;
      steps.push({
        id: `${n.id}-${hash(note + notify.join("|") + (n.minutes ?? ""))}`.slice(
          0,
          40,
        ),
        trigger: n.trigger,
        ...(n.minutes ? { minutes: n.minutes } : {}),
        note,
        ...(notify.length ? { notify } : {}),
      });
    }
  }
  for (const n of flow.nodes) {
    if (n.kind === "trigger") continue;
    if (!reached.has(n.id) && n.kind !== "builtin")
      problems.push({
        node: n.id,
        text: "Not connected to a trigger: it never runs",
      });
    if (n.kind === "monitor" && !findMonitor(n.monitor, extraMonitors))
      problems.push({
        node: n.id,
        text: `Unknown monitor ${n.monitor}: it is not in the monitor library`,
      });
    if (n.kind === "skill" && !n.skill)
      problems.push({ node: n.id, text: "Pick a skill" });
    if ((n.kind === "instruction" || n.kind === "notify") && !n.text.trim())
      problems.push({ node: n.id, text: "Empty: write what it says" });
    if (n.kind === "loop") problems.push(...loopProblems(n));
  }
  const builtins = flow.nodes
    .filter(
      (n): n is Extract<FlowNode, { kind: "builtin" }> => n.kind === "builtin",
    )
    .map((n) => n.builtin);
  return { steps, builtins, problems };
}

/** What is wrong with a loop on its own (where it sits is compileFlow's). */
function loopProblems(n: LoopNode): Problem[] {
  const out: string[] = [];
  if (!n.members.length) out.push(`Loop "${n.name}" has no blocks inside`);
  if (!n.check.command.trim() && !n.agentDone.on)
    out.push(`Loop "${n.name}" needs a check command or the agent's goal`);
  if (n.check.output)
    try {
      new RegExp(n.check.output);
    } catch {
      out.push(
        `Loop "${n.name}": the output pattern is not a valid regular expression`,
      );
    }
  if (n.agentDone.on && !n.agentDone.goal.trim())
    out.push(`Loop "${n.name}": write the goal the agent works toward`);
  return out.map((text) => ({ node: n.id, text }));
}

/** How many blocks do something (not triggers): a template's size. */
export const actionCount = (flow: Flow): number =>
  flow.nodes.filter((n) => n.kind !== "trigger").length;

/** Triggers that need a hook (installed once, for everyone; each reads the session's workflow). */
export const HOOK_TRIGGERS = FLOW_TRIGGERS.filter((t) => t.runner === "hook");

/**
 * The loops the steps that fired (`$ids`) start, each with its step's id; nothing when there are
 * none. A loop that comes after another (`after`) is opened by the loop hook, not here.
 */
const ARM_PICK = `($ids | split(" ") | map(select(. != ""))) as $w | [.steps[]? | select(.id as $i | $w | index($i)) | .id as $s | .loops[]? | select(.after == null) | {id, step: $s}] | select(length > 0)`;
/**
 * The loop file with those loops armed (iteration 0), then one line per loop armed afresh. A loop
 * still open is left as it is: a trigger firing twice does not reset it.
 * ponytail: a loop armed again replaces its last run (history, notes); keeping older runs needs a
 * list of runs per loop.
 */
const ARM_FILE =
  `. as $cur | (reduce $new[] as $n (.; {id: $n.id, step: $n.step, state: "open", iteration: 0, startedAt: $now, history: [], reason: null, lastCheck: null} as $fresh | ` +
  `if any(.loops[]; .id? == $n.id and .state? == "open") then . elif any(.loops[]; .id? == $n.id) then .loops |= map(if .id? == $n.id then $fresh else . end) else .loops += [$fresh] end)) as $out | ` +
  `($out | tojson), ($new[] | .id as $i | select(any($cur.loops[]; .id? == $i and .state? == "open") | not) | $i)`;
/**
 * Arm the loops of the steps that fired (D7): write `<dir>/workflows/loops/<sid>.json` (temp file
 * and rename) and an empty progress file per loop armed afresh. Every trigger's hook carries it
 * (the hook is one for everyone), so without a loop it costs one grep and writes nothing. A loop
 * file that is not one (corrupt) is replaced: the trigger firing is the start of a run.
 */
const ARM_LOOPS =
  `grep -q '"loops"' "$f" 2>/dev/null && new=$(jq -c --arg ids "$ids" ${q(ARM_PICK)} "$f" 2>/dev/null) && [ -n "$new" ] && { ` +
  `mkdir -p "$d/workflows/loops"; L="$d/workflows/loops/$sid.json"; ` +
  `cur=$(jq -cse ${q(`if length == 1 and (.[0].loops | type) == "array" then .[0] else empty end`)} "$L" 2>/dev/null) || cur='{"loops":[]}'; ` +
  `out=$(printf '%s' "$cur" | jq -r --argjson new "$new" --argjson now "$(date +%s)000" ${q(ARM_FILE)} 2>/dev/null) && [ -n "$out" ] && ` +
  `printf '%s\\n' "$out" | head -n 1 > "$L.tmp" && mv "$L.tmp" "$L" && ` +
  `for id in $(printf '%s\\n' "$out" | tail -n +2); do case "$id" in ""|*[!a-z0-9-]*) continue;; esac; : > "$d/workflows/loops/$sid-$id.md"; done; }`;

/**
 * The hook for one trigger: reads the session's workflow (`<dir>/workflows/sessions/<id>.json`,
 * else the default `<dir>/workflow.json`) and hands over the compiled steps for this trigger that
 * have not run yet. Command triggers match each step's pattern against the command; the turn-end
 * trigger asks Claude to go on (once per turn: never while it is already going on because of it).
 */
export function flowTriggerCommand(
  t: FlowTriggerInfo,
  dir: string,
  mark: string,
): string {
  const legacy = TRIGGERS.find((x) => x.id === t.id);
  const lines = [`input=$(cat)`];
  if (legacy?.command) {
    lines.push(
      `cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')`,
    );
    lines.push(runsOrExit(legacy.command));
  }
  if (legacy?.success)
    lines.push(
      `printf '%s' "$input" | jq -r '.tool_response | tostring' | grep -q ${q(legacy.success)} || exit 0`,
    );
  if (t.id === "command-before" || t.id === "command-after") {
    lines.push(
      `cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')`,
    );
    lines.push(`[ -n "$cmd" ] || exit 0`);
  }
  if (t.id === "turn-end")
    lines.push(
      `[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = true ] && exit 0`,
    );
  lines.push(`sid=$(printf '%s' "$input" | jq -r '.session_id // ""')`);
  lines.push(`case "$sid" in ""|*[!A-Za-z0-9-]*) exit 0;; esac`);
  lines.push(
    `d=${q(dir)}; f="$d/workflows/sessions/$sid.json"; [ -f "$f" ] || f="$d/workflow.json"; [ -f "$f" ] || exit 0`,
  );
  // Command triggers: the steps whose pattern the command matches (a bad pattern matches nothing).
  const pick =
    t.id === "command-before" || t.id === "command-after"
      ? `jq -r --arg t ${q(t.id)} --arg c "$cmd" '.steps[]? | select(.trigger == $t) | select(.pattern as $p | try ($c | test($p)) catch false) | .id' "$f"`
      : `jq -r --arg t ${q(t.id)} '.steps[]? | select(.trigger == $t) | .id' "$f"`;
  const once =
    t.id === "turn-end"
      ? ""
      : t.id === "session-start" || t.id === "linked"
        ? "$sid"
        : `$sid-$(git rev-parse HEAD 2>/dev/null || echo none)`;
  const markLine = once
    ? `m="\${TMPDIR:-/tmp}/masterdeck-workflow-$id-${once}"; [ -f "$m" ] && continue; touch "$m"; `
    : "";
  lines.push(
    `ids=""; for id in $(${pick}); do case "$id" in *[!a-z0-9-]*) continue;; esac; ${markLine}ids="$ids $id"; done`,
  );
  lines.push(`[ -n "$ids" ] || exit 0`);
  // What ran, for MasterDeck (the Workflow line in a session's Details).
  lines.push(
    `mkdir -p "$d/workflows" 2>/dev/null; printf '{"at":%s000,"sid":"%s","trigger":"%s","ids":"%s"}\\n' "$(date +%s)" "$sid" ${q(t.id)} "$ids" >> "$d/workflows/runs.jsonl" 2>/dev/null`,
  );
  lines.push(ARM_LOOPS);
  const text = `([.steps[] | select(.id as $i | $w | index($i)) | .note] | join("\\n\\n"))`;
  const outp =
    t.id === "turn-end"
      ? `{decision: "block", reason: ${text}}`
      : `{hookSpecificOutput: {hookEventName: ${JSON.stringify(t.event)}, additionalContext: ${text}}}`;
  lines.push(
    `jq -c --arg ids "$ids" ${q(`($ids | split(" ") | map(select(. != ""))) as $w | ${outp}`)} "$f"`,
  );
  return `${lines.join("; ")} # ${mark}`;
}

/**
 * Wrap a built-in's hook command: it skips sessions whose workflow left the built-in out (a
 * workflow file with a `builtins` list that does not name it).
 */
export function guardedBuiltin(
  id: BuiltinId,
  command: string,
  dir: string,
): string {
  return (
    `input=$(cat); sid=$(printf '%s' "$input" | jq -r '.session_id // ""'); ` +
    `case "$sid" in ""|*[!A-Za-z0-9-]*) ;; *) d=${q(dir)}; f="$d/workflows/sessions/$sid.json"; [ -f "$f" ] || f="$d/workflow.json"; ` +
    `[ -f "$f" ] && jq -e --arg b ${q(id)} '(.builtins // null) as $x | $x != null and ($x | index($b) | not)' "$f" >/dev/null 2>&1 && exit 0;; esac; ` +
    `printf '%s' "$input" | { ${command}; } # masterdeck-builtin:${id}`
  );
}

/**
 * Per-session workflows. Each session keeps its own copy of the workflow (made the first time
 * MasterDeck sees it, from the default or the template picked when starting it) and follows it;
 * templates are named workflows to start from. One hook per trigger reads the session's copy, or
 * the default while it has none.
 */
export interface WorkflowDoc {
  flow: Flow;
  /** The template it was copied from (its name), and when. */
  from: string | null;
  at: number | null;
}

export interface WorkflowTemplate {
  /** 'default' is the workflow new sessions copy (workflow.json). */
  id: string;
  name: string;
  flow: Flow;
}

export const DEFAULT_TEMPLATE = "default";

/** A workflow file: its flow, or (older files) its list of steps turned into one. */
export function parseDoc(raw: unknown): WorkflowDoc {
  const o = obj(raw);
  const flow = o.flow ? parseFlow(o.flow) : fromSteps(parseSteps(raw));
  return {
    flow,
    from: typeof o.from === "string" ? o.from.slice(0, 80) : null,
    at: typeof o.at === "number" ? o.at : null,
  };
}

/** A workflow file as MasterDeck and the hooks read it: the flow, and what it compiles to. */
export function docJson(doc: WorkflowDoc, name?: string): string {
  const { steps, builtins } = compileFlow(doc.flow);
  return (
    JSON.stringify(
      {
        ...(name ? { name } : {}),
        from: doc.from,
        at: doc.at,
        flow: doc.flow,
        steps,
        builtins,
      },
      null,
      2,
    ) + "\n"
  );
}

/** A template's file id from its name. */
export function templateId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return !base || base === DEFAULT_TEMPLATE
    ? `t-${Math.random().toString(36).slice(2, 8)}`
    : base;
}

export const validSessionId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9-]{8,80}$/.test(id);

/**
 * The hook for custom triggers on one event: for each compiled step of a custom trigger on this
 * event in the session's workflow (else the default), check the tool, the pattern (on the Bash
 * command, the file path or the prompt) and the output, run it once (per its setting), and hand
 * the session the plans that matched. `matcher`-less: the steps say which tools they want.
 */
export function customTriggerCommand(
  event: CustomTrigger["event"],
  dir: string,
  mark: string,
): string {
  const pick =
    `. as $in | $wf[0].steps[]? | select(.custom.event == $ev) | . as $s | ` +
    `select(($s.custom.tool // "") == "" or (($in.tool_name // "") | try test("^(" + $s.custom.tool + ")$") catch false)) | ` +
    `select(($s.custom.pattern // "") == "" or ((if $s.custom.field == "file" then ($in.tool_input.file_path // $in.tool_input.notebook_path // $in.tool_input.path // "") ` +
    `elif $s.custom.field == "prompt" then ($in.prompt // "") else ($in.tool_input.command // "") end) | tostring | try test($s.custom.pattern) catch false)) | ` +
    `select(($s.custom.output // "") == "" or (($in.tool_response // "") | tostring | try test($s.custom.output) catch false)) | ` +
    `"\\($s.id) \\($s.custom.once // "commit")"`;
  const lines = [
    `input=$(cat)`,
    `sid=$(printf '%s' "$input" | jq -r '.session_id // ""')`,
    `case "$sid" in ""|*[!A-Za-z0-9-]*) exit 0;; esac`,
    `d=${q(dir)}; f="$d/workflows/sessions/$sid.json"; [ -f "$f" ] || f="$d/workflow.json"; [ -f "$f" ] || exit 0`,
    `grep -q '"custom"' "$f" || exit 0`,
    `hits=$(printf '%s' "$input" | jq -r --arg ev ${q(event)} --slurpfile wf "$f" ${q(pick)} 2>/dev/null)`,
    `[ -n "$hits" ] || exit 0`,
    `ids=""; for h in $(printf '%s' "$hits" | tr ' ' ':'); do id=\${h%%:*}; once=\${h#*:}; case "$id" in ""|*[!a-z0-9-]*) continue;; esac; ` +
      `case "$once" in always) ;; session) m="\${TMPDIR:-/tmp}/masterdeck-workflow-$id-$sid"; [ -f "$m" ] && continue; touch "$m";; ` +
      `*) m="\${TMPDIR:-/tmp}/masterdeck-workflow-$id-$sid-$(git rev-parse HEAD 2>/dev/null || echo none)"; [ -f "$m" ] && continue; touch "$m";; esac; ` +
      `ids="$ids $id"; done`,
    `[ -n "$ids" ] || exit 0`,
    `mkdir -p "$d/workflows" 2>/dev/null; printf '{"at":%s000,"sid":"%s","trigger":"custom","ids":"%s"}\\n' "$(date +%s)" "$sid" "$ids" >> "$d/workflows/runs.jsonl" 2>/dev/null`,
    ARM_LOOPS,
    `jq -c --arg ids "$ids" ${q(`($ids | split(" ") | map(select(. != ""))) as $w | {hookSpecificOutput: {hookEventName: ${JSON.stringify(event)}, additionalContext: ([.steps[] | select(.id as $i | $w | index($i)) | .note] | join("\\n\\n"))}}`)} "$f"`,
  ];
  return `${lines.join("; ")} # ${mark}`;
}

/**
 * The workflow builder: a Claude session in its own folder that writes workflows from a prompt.
 * MasterDeck gives it the format and what is available (CLAUDE.md) and the workflow open on the
 * canvas (current.json); it writes draft.json, and may add triggers (in the draft) and skills
 * (skills/<name>/SKILL.md) the workflow needs. MasterDeck checks the draft (check.json, which it
 * reads back to fix problems) and shows it on the canvas: applying it installs its triggers and
 * skills too; discarding it (after asking) throws them all away.
 */
import {
  BUILTINS,
  compileFlow,
  customInfo,
  customTriggerProblems,
  EDGE_LABEL,
  FLOW_TRIGGERS,
  isCustomTrigger,
  layoutFlow,
  parseCustomTrigger,
  parseFlow,
  type CustomTrigger,
  type Flow,
  parseMonitor,
  type MonitorDef,
  findMonitor,
  LOOP_MEMBER_KINDS,
} from "./flow";

export const BUILDER_NAME = "md-workflow-builder";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};

/** An id the flow format accepts, from whatever the draft used. */
const safeId = (v: unknown, i: number): string => {
  const s = String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s || `n-${i}`;
};

/** A skill the builder wrote in its folder (skills/<name>/SKILL.md), as MasterDeck read it. */
export interface DraftSkill {
  /** Its folder's name (what it is installed as). */
  name: string;
  description: string;
  /** Files in its folder, SKILL.md included. */
  files: number;
  problems: string[];
}

/** Read a drafted skill's SKILL.md (the frontmatter's name and description). */
export function readDraftSkill(
  folder: string,
  text: string | null,
  files: number,
): DraftSkill {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(folder))
    problems.push(
      `skill folder "${folder}": use lowercase letters, digits and dashes`,
    );
  if (text === null)
    return {
      name: folder,
      description: "",
      files,
      problems: [...problems, `skills/${folder}: no SKILL.md`],
    };
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const name = fm
    ? /^name:\s*(.+)$/m
        .exec(fm[1])?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "")
    : undefined;
  const description = fm
    ? (/^description:\s*(.+)$/m
        .exec(fm[1])?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "") ?? "")
    : "";
  if (!fm)
    problems.push(
      `skills/${folder}/SKILL.md: starts without a --- frontmatter block (name, description)`,
    );
  else if (name !== folder)
    problems.push(
      `skills/${folder}/SKILL.md: frontmatter name must be "${folder}"`,
    );
  if (fm && !description)
    problems.push(
      `skills/${folder}/SKILL.md: add a description (when to use the skill)`,
    );
  if (text.replace(/^---[\s\S]*?---/, "").trim().length < 40)
    problems.push(
      `skills/${folder}/SKILL.md: the body is almost empty; write the instructions`,
    );
  return {
    name: folder,
    description: description.slice(0, 240),
    files,
    problems,
  };
}

/**
 * A draft as the builder wrote it: `{name?, flow: {nodes, edges}, triggers?}` or the flow itself.
 * Ids are made safe (and arrows follow them), `source`/`target` are read as `from`/`to`, a draft
 * without positions is laid out, and its new triggers are validated.
 */
export function normalizeDraft(raw: unknown): {
  name: string | null;
  flow: Flow;
  triggers: CustomTrigger[];
  monitors: MonitorDef[];
  /** What the draft asked for that the format refused: a loop's members, an arrow's kind. */
  dropped: string[];
} {
  const o = obj(raw);
  const f = obj(o.flow ?? o);
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const nodes = (Array.isArray(f.nodes) ? f.nodes : []).map(
    (n, i): Obj & { id: string } => {
      const r = obj(n);
      let id = safeId(r.id, i);
      while (used.has(id)) id = `${id.slice(0, 20)}-${i}`;
      used.add(id);
      ids.set(String(r.id ?? ""), id);
      return { ...r, id };
    },
  );
  // A loop's members follow their blocks' safe ids, like arrows do (a member may come later).
  for (const n of nodes)
    if (n.kind === "loop" && Array.isArray(n.members))
      n.members = n.members.map((m) => ids.get(String(m)) ?? String(m));
  const edges = (Array.isArray(f.edges) ? f.edges : []).map((e): Obj => {
    const r = obj(e);
    return {
      ...r,
      from: ids.get(String(r.from ?? r.source ?? "")) ?? "",
      to: ids.get(String(r.to ?? r.target ?? "")) ?? "",
    };
  });
  let flow = parseFlow({ nodes, edges });
  // parseFlow quietly drops a member that may not repeat; the builder must hear why.
  const droppedMembers: string[] = [];
  for (const r of nodes) {
    const loop = flow.nodes.find((n) => n.id === r.id);
    if (loop?.kind !== "loop" || !Array.isArray(r.members)) continue;
    for (const m of r.members as string[]) {
      if (loop.members.includes(m)) continue;
      const b = flow.nodes.find((n) => n.id === m);
      droppedMembers.push(
        `loop ${loop.id}: member ${m} was left out (${
          !b
            ? "no such block"
            : b.kind === "loop"
              ? "no loop in a loop"
              : !(LOOP_MEMBER_KINDS as readonly string[]).includes(b.kind)
                ? `a ${b.kind} block can't repeat: only ${LOOP_MEMBER_KINDS.join(", ")}`
                : "it is already in another loop"
        })`,
      );
    }
  }
  // An arrow kept with another kind than the draft gave: met / limit leave a loop only, a loop
  // leaves through then / met / limit, and nothing but then leaves a trigger.
  const kinds: string[] = [];
  for (const r of edges) {
    const want = typeof r.kind === "string" ? r.kind : "then";
    const got = flow.edges.find((e) => e.from === r.from && e.to === r.to);
    if (got && got.kind !== want)
      kinds.push(
        `arrow ${r.from} → ${r.to}: "${want}" isn't allowed there, read as "${got.kind}" (met and limit leave a loop; ok and fail leave an action)`,
      );
  }
  const placed = nodes.some(
    (n) =>
      typeof (n as Obj).x === "number" &&
      ((n as Obj).x !== 0 || (n as Obj).y !== 0),
  );
  if (!placed) flow = layoutFlow(flow);
  const triggers = (Array.isArray(o.triggers) ? o.triggers : [])
    .map(parseCustomTrigger)
    .filter((t): t is CustomTrigger => !!t);
  const monitors = (Array.isArray(o.monitors) ? o.monitors : [])
    .map((m) => parseMonitor(m))
    .filter((m): m is MonitorDef => !!m);
  return {
    name:
      typeof o.name === "string" && o.name.trim()
        ? o.name.trim().slice(0, 60)
        : null,
    flow,
    triggers,
    monitors,
    dropped: [...droppedMembers, ...kinds],
  };
}

/** A monitor the builder defined (in the draft) with its script (monitors/<id>.sh), as MasterDeck read it. */
export interface DraftMonitor {
  def: MonitorDef;
  problems: string[];
}

/**
 * Check a drafted monitor's script: it must exist and parse (`syntax`: bash -n's complaint, if
 * any), and should flush its output per line (a buffered pipe emits nothing until it ends).
 */
export function readDraftMonitor(
  def: MonitorDef,
  script: string | null,
  syntax: string | null,
): DraftMonitor {
  const problems: string[] = [];
  if (script === null)
    problems.push(
      `monitors/${def.id}.sh: missing (write the watch script there)`,
    );
  else {
    if (syntax)
      problems.push(`monitors/${def.id}.sh: ${syntax.split("\n")[0]}`);
    if (
      /\|\s*grep\b(?![^|]*--line-buffered)/.test(script) &&
      /tail\s+-f|while\s+true|inotifywait/.test(script)
    )
      problems.push(
        `monitors/${def.id}.sh: grep in a live pipe needs --line-buffered, or events sit in its buffer`,
      );
    if (!script.trim()) problems.push(`monitors/${def.id}.sh: empty`);
  }
  if (!def.description)
    problems.push(
      `monitor ${def.id}: add a description (it is shown in every notification)`,
    );
  return { def, problems };
}

export interface DraftCheck {
  ok: boolean;
  problems: string[];
  dropped: string[];
  /** Not blocking: a drafted skill or trigger the workflow does not use, a trigger that replaces one. */
  warnings: string[];
  plans: { trigger: string; note: string }[];
}

/**
 * What MasterDeck writes back for a draft: whether it is usable, and what sessions would get.
 * `library`: the custom triggers installed; `installedSkills`: the skill names Claude Code has;
 * `skills`: the ones the builder drafted.
 */
export function checkDraft(
  raw: unknown,
  ctx: {
    library?: CustomTrigger[];
    installedSkills?: string[];
    skills?: DraftSkill[];
    /** Monitors in the library, and the ones the builder drafted (paths set to their scripts). */
    monitorLibrary?: MonitorDef[];
    monitors?: DraftMonitor[];
  } = {},
): DraftCheck {
  const { flow, triggers, dropped: refused } = normalizeDraft(raw);
  const draftMons = (ctx.monitors ?? []).map((m) => m.def);
  const monLib = ctx.monitorLibrary ?? [];
  const f = obj(obj(raw).flow ?? raw);
  const given = Array.isArray(f.nodes) ? f.nodes.length : 0;
  const dropped: string[] = [];
  if (flow.nodes.length < given)
    dropped.push(
      `${given - flow.nodes.length} block(s) were not understood and left out (check kind and fields)`,
    );
  const givenEdges = Array.isArray(f.edges) ? f.edges.length : 0;
  if (flow.edges.length < givenEdges)
    dropped.push(
      `${givenEdges - flow.edges.length} arrow(s) were left out (unknown block, into a trigger, a cycle, a duplicate, or out of a loop's block: leave a loop through its met / limit / then arrows)`,
    );
  dropped.push(...refused);
  const givenTriggers = Array.isArray(obj(raw).triggers)
    ? (obj(raw).triggers as unknown[]).length
    : 0;
  if (triggers.length < givenTriggers)
    dropped.push(
      `${givenTriggers - triggers.length} trigger definition(s) were left out (id, or event: PreToolUse, PostToolUse, UserPromptSubmit)`,
    );
  const warnings: string[] = [];
  const library = ctx.library ?? [];
  for (const t of triggers)
    if (library.some((l) => l.id === t.id))
      warnings.push(
        `trigger ${t.id} replaces the one in the library with the same id`,
      );
  const c = compileFlow(
    flow,
    [
      ...triggers,
      ...library.filter((l) => !triggers.some((t) => t.id === l.id)),
    ],
    [
      ...draftMons,
      ...monLib.filter((l) => !draftMons.some((m) => m.id === l.id)),
    ],
  );
  const problems = c.problems.map((p) => {
    const n = p.node ? flow.nodes.find((x) => x.id === p.node) : null;
    return n ? `${n.id} (${n.kind}): ${p.text}` : p.text;
  });
  for (const t of triggers) problems.push(...customTriggerProblems(t));
  const used = new Set(
    flow.nodes.flatMap((n) =>
      n.kind === "trigger" && isCustomTrigger(n.trigger)
        ? [n.trigger.slice(7)]
        : [],
    ),
  );
  for (const t of triggers)
    if (!used.has(t.id))
      warnings.push(`trigger ${t.id} is defined but no trigger block uses it`);
  // Skills: every skill block names one Claude Code has, or one drafted here.
  const drafted = ctx.skills ?? [];
  const installed = new Set(ctx.installedSkills ?? []);
  for (const s of drafted) {
    problems.push(...s.problems);
    if (installed.has(s.name))
      problems.push(
        `skill ${s.name} already exists: pick another name (or use the installed one)`,
      );
  }
  if (ctx.installedSkills)
    for (const n of flow.nodes)
      if (
        n.kind === "skill" &&
        n.skill &&
        !installed.has(n.skill) &&
        !drafted.some((s) => s.name === n.skill)
      )
        problems.push(
          `${n.id} (skill): no skill named ${n.skill}; use one from the list, or write it in skills/${n.skill}/SKILL.md`,
        );
  for (const m of ctx.monitors ?? []) {
    problems.push(...m.problems);
    if (monLib.some((l) => l.id === m.def.id))
      warnings.push(
        `monitor ${m.def.id} replaces the one in the library with the same id`,
      );
  }
  const monBlocks = new Set(
    flow.nodes.flatMap((n) => (n.kind === "monitor" ? [n.monitor] : [])),
  );
  for (const m of draftMons)
    if (!monBlocks.has(m.id))
      warnings.push(`monitor ${m.id} is defined but no monitor block uses it`);
  const skillBlocks = new Set(
    flow.nodes.flatMap((n) => (n.kind === "skill" ? [n.skill] : [])),
  );
  for (const s of drafted)
    if (!skillBlocks.has(s.name))
      warnings.push(`skill ${s.name} is written but no skill block uses it`);
  return {
    ok: !problems.length && !dropped.length && flow.nodes.length > 0,
    problems,
    dropped,
    warnings,
    plans: c.steps.map((s) => ({ trigger: s.trigger, note: s.note })),
  };
}

/** The builder's CLAUDE.md: its job, the format, the triggers, built-ins and skills, and the rules. */
export function builderContext(
  skills: { name: string; description: string; source?: string }[],
  current: { id: string; name: string },
  library: CustomTrigger[] = [],
  monitorLibrary: MonitorDef[] = [],
): string {
  const monList = monitorLibrary.length
    ? monitorLibrary
        .map(
          (m) =>
            `- \`${m.id}\` (${m.name}): ${m.description}${m.rearm ? " Re-armed on expiry" + (m.until ? ` until ${m.until}` : "") + "." : ""}`,
        )
        .join("\n")
    : "- (none yet)";
  const triggers = FLOW_TRIGGERS.map(
    (t) =>
      `- \`${t.id}\`: ${t.label}. ${t.hint}${t.id.startsWith("command") ? " Needs `pattern`." : ""}${t.id === "idle" ? " Takes `minutes`." : ""}`,
  ).join("\n");
  const custom = library.length
    ? library
        .map((c) => `- \`custom:${c.id}\` (${c.name}): ${customInfo(c).hint}`)
        .join("\n")
    : "- (none yet)";
  const builtins = BUILTINS.map(
    (b) =>
      `- \`${b.id}\` (${b.label}), belongs after trigger \`${b.trigger}\`: ${b.what}`,
  ).join("\n");
  const bySource = new Map<string, string[]>();
  for (const s of skills) {
    const k = s.source ?? "yours";
    bySource.set(k, [
      ...(bySource.get(k) ?? []),
      `  - \`${s.name}\`${s.description ? `: ${s.description.replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
    ]);
  }
  const skillList = [...bySource]
    .map(([k, list]) => `- ${k}:\n${list.join("\n")}`)
    .join("\n");
  return `# MasterDeck workflow builder

You build MasterDeck workflows from what the user asks. A workflow says what every Claude Code
session following it does at points of its work (a trigger), as blocks joined by arrows. When the
workflow needs a trigger, a skill or a monitor that doesn't exist yet, you create it too.

The user sees this conversation next to MasterDeck's Workflow canvas. The workflow open there is
**${current.name}** (id \`${current.id}\`), in \`current.json\` (re-read it: the user may switch).

## How to work

1. Read \`current.json\` when the request is about changing the open workflow.
2. Prefer what exists: the built-in triggers, the custom triggers and the skills listed below.
   Create a new trigger or skill only when the workflow needs one that isn't there.
3. Write the whole new workflow to \`draft.json\` (not only the changes; keep the blocks the user
   did not ask to change), with any new triggers in its \`triggers\` list. Write new skills as
   \`skills/<name>/SKILL.md\` (see below). Positions are optional: leave \`x\`/\`y\` out and
   MasterDeck lays it out.
4. Wait a moment, then read \`check.json\`: MasterDeck checks each draft there (\`ok\`, \`problems\`,
   \`dropped\`, \`warnings\`, and \`plans\`: the exact text each trigger will hand sessions). Fix every
   problem and write again until \`ok\` is true.
5. Tell the user in a few lines what the workflow does, and which triggers, skills and monitors
   you created. They apply it on the canvas (Apply, or Save as template), which installs them; if
   they discard it, those are thrown away too. You never install anything yourself.

Only write in this folder (\`draft.json\`, \`skills/\`, \`monitors/\`). Don't edit other files, and don't touch
\`~/.claude\`, \`~/.claude/settings.json\` or MasterDeck's own files.

## draft.json

\`\`\`ts
{
  name?: string            // a suggested template name
  flow: {
    nodes: Node[]
    edges: { from: string; to: string; kind: 'then' | 'ok' | 'fail' | 'met' | 'limit' }[]
  }
  triggers?: CustomTrigger[]   // new triggers this workflow uses (see "Creating triggers")
  monitors?: Monitor[]         // new monitors it arms (see "Creating monitors")
}
type Node =
  | { id: string; kind: 'trigger'; trigger: string; pattern?: string; minutes?: number }
  | { id: string; kind: 'skill'; skill: string; mode: 'background' | 'session'; instructions: string }
  | { id: string; kind: 'instruction'; text: string }
  | { id: string; kind: 'notify'; text: string }
  | { id: string; kind: 'builtin'; builtin: 'ticket' | 'pr-review' | 'pr-watch' }
  | { id: string; kind: 'monitor'; monitor: string; args: string; instructions: string }
  | { id: string; kind: 'loop'; name: string; members: string[];
      check: { command: string; output: string; outputMode: 'match' | 'no-match'; timeoutMin: number };
      agentDone: { on: boolean; goal: string };
      limits: { iterations: number; minutes: number; stall: number } }   // see "Loops"
\`\`\`

Ids: short, lowercase letters, digits and dashes (e.g. \`push\`, \`run-tests\`).

## Triggers

Built in:

${triggers}

Custom triggers already in the library (use as \`trigger: "custom:<id>"\`):

${custom}

## Creating triggers

When no trigger fits (e.g. "when a migration file is edited", "after the tests fail", "when I ask
about deploys"), define one in \`draft.json\`'s \`triggers\` list and use it as \`custom:<id>\`:

\`\`\`ts
type CustomTrigger = {
  id: string            // lowercase letters, digits, dashes
  name: string          // short, shown on the block: "Migration edited"
  description: string   // one line: what it's for
  event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit'   // before a tool, after it, or on the user's prompt
  tool: string          // regular expression on the tool name: 'Bash', 'Edit|Write|MultiEdit'; '' = any
  field: 'command' | 'file' | 'prompt'   // what pattern matches: the Bash command, the file path, the prompt
  pattern: string       // regular expression; '' = always
  output: string        // PostToolUse only: regular expression on the tool's output, e.g. 'FAIL|Error'; '' = any
  once: 'always' | 'session' | 'commit'  // how often it may fire in a session
}
\`\`\`

Keep patterns specific: a trigger that fires on every tool call is refused.

## Creating skills

When the workflow needs a procedure no listed skill covers, write a new skill:
\`skills/<name>/SKILL.md\`, where \`<name>\` is lowercase with dashes and not the name of an
existing skill. Other files the skill needs (scripts, templates) go in the same folder.

\`\`\`markdown
---
name: <name>
description: <when to use it: one or two sentences, specific enough to pick it>
---

# <Title>

<Step-by-step instructions for Claude: what to check, what to run, what to report.>
\`\`\`

Then use it in a skill block (\`skill: "<name>"\`).

## Monitors

A monitor is a watch script whose every output line is an event that wakes the session (Claude
Code's Monitor tool): new review comments, CI results, errors in a log, a deploy finishing. A
\`monitor\` block arms one at its trigger; the session acts on each event.

Monitors in the library (use as \`{ "kind": "monitor", "monitor": "<id>", "args": "...", "instructions": "..." }\`):

${monList}

\`args\` are passed to the script (e.g. \`"<PR number>"\`: the session fills in \`<...>\`);
\`instructions\` say what to do on each event (the monitor's \`onEvent\` otherwise).

## Creating monitors

When the workflow needs to watch something no listed monitor covers, define it in \`draft.json\`'s
\`monitors\` list and write its script to \`monitors/<id>.sh\`:

\`\`\`ts
type Monitor = {
  id: string            // lowercase letters, digits, dashes
  name: string          // short: "CI on the PR"
  description: string   // what it watches; shown in every notification
  timeoutMin: number    // 1-30: it expires then (Claude Code's limit is 30 minutes)
  rearm: boolean        // arm it again each time it expires
  until: string         // when to stop re-arming: "the PR is merged or closed"
  onEvent: string       // what to do on each event, by default
}
\`\`\`

The script (bash; arguments in \`$1\`, \`$2\`…): each stdout line is one event, so print only lines
worth acting on. Rules:
- Every pipe stage must flush per line: \`grep --line-buffered\`, \`awk\` with \`fflush()\`; never \`head\`.
- Poll remote APIs every 30s or more; don't let one failed call end it (\`|| true\`).
- Cover failures, not only success: emit on every terminal state (failed, cancelled, timed out).
- Exit when the watched thing is over (e.g. the PR is merged); otherwise it runs until it expires.
- Nothing to watch (no checks, no such PR, no log file): print one line saying so and exit;
  silence looks the same as "still waiting".

Example \`monitors/pr-ci.sh\`, emitting each finished check of PR \`$1\` and exiting when all are done:

\`\`\`bash
prev=""
while true; do
  s=$(gh pr checks "$1" --json name,bucket 2>/dev/null || echo '[]')
  cur=$(echo "$s" | jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' | sort)
  comm -13 <(echo "$prev") <(echo "$cur")
  prev=$cur
  echo "$s" | jq -e 'length > 0 and all(.bucket!="pending")' >/dev/null && break
  sleep 30
done
\`\`\`

## Built-ins

MasterDeck's own steps. Keep each one hung from its trigger unless the user wants it off (leaving it
out turns it off for sessions following the workflow). At most one of each.

${builtins}

## Arrows

- \`then\` (${EDGE_LABEL.then}): do the next block after this one. Several \`then\` arrows out of one
  block run side by side. Arrows out of a trigger are always \`then\`.
- \`ok\` (${EDGE_LABEL.ok}) and \`fail\` (${EDGE_LABEL.fail}): from an action, the session follows the one
  that matches how the step went.
- \`met\` (${EDGE_LABEL.met}) and \`limit\` (${EDGE_LABEL.limit}): only out of a loop block, see "Loops".

No cycles: to repeat work use a loop node. Nothing points into a trigger, and every action must be
reached from a trigger.

## Loops

A \`loop\` block is a frame: the session repeats the blocks listed in its \`members\` until its
criterion is met or a limit is hit. MasterDeck checks it each time the session finishes a turn
(its Stop hook): not done yet, the session is told to go on with the next round.

- \`members\`: ids of the blocks inside, as many as needed. Only \`skill\`, \`instruction\`, \`monitor\`
  and \`notify\` blocks (notify works only after \`needs-you\` or \`idle\`, where loops are refused, so in
  practice skills, instructions and monitors); no loop in a loop, and a block in one loop only.
  Arrows between members order a round; nothing else points at a member (an arrow from outside
  into a member points at the loop instead: a loop always starts at its top).
- Leaving: a member's arrow to a block outside its frame is dropped. The loop's own arrows lead on:
  \`met\` when the criterion was met, \`limit\` when a limit stopped it, \`then\` however it ended.
- The criterion, at least one of:
  - \`check.command\`: a shell command MasterDeck runs in the session's folder after each round.
    With \`check.output\` empty it passes on exit code 0; otherwise \`check.output\` is a regular
    expression on its output that decides alone: \`outputMode\` \`'match'\` passes when it matches,
    \`'no-match'\` when it no longer does. \`timeoutMin\` 1-9 (default 5): a check that runs longer fails.
  - \`agentDone\`: \`{ on: true, goal }\`: the session works toward \`goal\` and ends its turn with a
    line starting \`LOOP DONE:\` and why. With a check command too, both must hold (a LOOP DONE the
    check does not back is refused).
- \`limits\`: \`iterations\` 1-100 (default 10); \`minutes\` 0 = off, else up to 1440; \`stall\` 0 = off,
  else 2-10 (stop when that many rounds in a row leave the same check output and the same code;
  3 is a good choice). At a limit MasterDeck asks the user in Needs you (they can give it more
  rounds), so the \`limit\` arrow is only for what the session should do then.
- \`name\`: short, shown on the frame and in progress ("Fix the tests").
- Progress: MasterDeck tells the session to end each round with one line starting \`PROGRESS:\`
  that says what it tried, and keeps those lines (the session never writes the progress file
  itself: Claude Code refuses writes there). So never ask the session to write a progress file or
  notes file in a member block.
- Where loops may go: under a trigger the session gets, except \`turn-end\` (a loop there would
  never end) and never under \`needs-you\` or \`idle\`. One loop open at a time, on the main path:
  not inside an \`ok\` / \`fail\` branch (MasterDeck can't tell which branch the session took), and
  never two side by side; a second loop goes after the first, through its \`met\`, \`limit\` or
  \`then\` arrow.

After a push: until \`npm test\` passes, fix the failing tests; at most 8 rounds; at the limit, tell
the user what still fails:

\`\`\`json
{
  "name": "Green after push",
  "flow": {
    "nodes": [
      { "id": "push", "kind": "trigger", "trigger": "after-push" },
      { "id": "green", "kind": "loop", "name": "Fix the tests", "members": ["read", "fix"],
        "check": { "command": "npm test", "output": "", "outputMode": "match", "timeoutMin": 5 },
        "agentDone": { "on": false, "goal": "" },
        "limits": { "iterations": 8, "minutes": 0, "stall": 3 } },
      { "id": "read", "kind": "instruction", "text": "Run npm test and read what failed." },
      { "id": "fix", "kind": "instruction", "text": "Fix the cause, not the test, then commit." },
      { "id": "push-fix", "kind": "instruction", "text": "Push the fixes." },
      { "id": "stuck", "kind": "instruction", "text": "Stop, and tell the user which tests still fail and what you tried." }
    ],
    "edges": [
      { "from": "push", "to": "green", "kind": "then" },
      { "from": "read", "to": "fix", "kind": "then" },
      { "from": "green", "to": "push-fix", "kind": "met" },
      { "from": "green", "to": "stuck", "kind": "limit" }
    ]
  }
}
\`\`\`

## Actions

- \`skill\`: a skill from the list below (or one you create), by its exact name. \`background\` runs it
  in a background subagent while the session carries on; \`session\` has the session do it.
  \`instructions\` add to it.
- \`instruction\`: text the session is told as it is. Be specific and short.
- \`notify\`: a desktop notification. Only after \`needs-you\` or \`idle\`. After \`idle\`, instructions
  are sent to the session as a message; after \`needs-you\` only notify blocks work.

## Skills available

${skillList || "- (none installed)"}

## Example

After a push, run the tests; if they fail, fix them and push again; if they pass, post the preview
URL on the PR. And whenever a migration file is edited, check it with a new skill:

\`\`\`json
{
  "name": "Tests after push",
  "flow": {
    "nodes": [
      { "id": "push", "kind": "trigger", "trigger": "after-push" },
      { "id": "tests", "kind": "instruction", "text": "Run the test suite." },
      { "id": "fix", "kind": "instruction", "text": "Fix the failures, commit and push again." },
      { "id": "post", "kind": "instruction", "text": "Post the preview URL in the PR description." },
      { "id": "mig", "kind": "trigger", "trigger": "custom:migration-edited" },
      { "id": "check-mig", "kind": "skill", "skill": "check-migration", "mode": "session", "instructions": "" }
    ],
    "edges": [
      { "from": "push", "to": "tests", "kind": "then" },
      { "from": "tests", "to": "fix", "kind": "fail" },
      { "from": "tests", "to": "post", "kind": "ok" },
      { "from": "mig", "to": "check-mig", "kind": "then" }
    ]
  },
  "triggers": [
    { "id": "migration-edited", "name": "Migration edited", "description": "A database migration was changed",
      "event": "PostToolUse", "tool": "Edit|Write|MultiEdit", "field": "file", "pattern": "migrations/.*\\\\.sql$",
      "output": "", "once": "session" }
  ]
}
\`\`\`

(with \`skills/check-migration/SKILL.md\` written next to it.)
`;
}

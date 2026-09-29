/**
 * The workflow builder: a Claude session in its own folder that writes workflows from a prompt.
 * MasterDeck gives it the format and what is available (CLAUDE.md) and the workflow open on the
 * canvas (current.json); it writes draft.json; MasterDeck checks the draft (check.json, which it
 * reads back to fix problems) and shows it on the canvas to apply.
 */
import {
  BUILTINS,
  compileFlow,
  EDGE_LABEL,
  FLOW_TRIGGERS,
  layoutFlow,
  parseFlow,
  type Flow,
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

/**
 * A draft as the builder wrote it: `{name?, flow: {nodes, edges}}` or the flow itself. Ids are made
 * safe (and arrows follow them), `source`/`target` are read as `from`/`to`, and a draft without
 * positions is laid out.
 */
export function normalizeDraft(raw: unknown): {
  name: string | null;
  flow: Flow;
} {
  const o = obj(raw);
  const f = obj(o.flow ?? o);
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const nodes = (Array.isArray(f.nodes) ? f.nodes : []).map((n, i) => {
    const r = obj(n);
    let id = safeId(r.id, i);
    while (used.has(id)) id = `${id.slice(0, 20)}-${i}`;
    used.add(id);
    ids.set(String(r.id ?? ""), id);
    return { ...r, id };
  });
  const edges = (Array.isArray(f.edges) ? f.edges : []).map((e) => {
    const r = obj(e);
    return {
      ...r,
      from: ids.get(String(r.from ?? r.source ?? "")) ?? "",
      to: ids.get(String(r.to ?? r.target ?? "")) ?? "",
    };
  });
  let flow = parseFlow({ nodes, edges });
  const placed = nodes.some(
    (n) =>
      typeof (n as Obj).x === "number" &&
      ((n as Obj).x !== 0 || (n as Obj).y !== 0),
  );
  if (!placed) flow = layoutFlow(flow);
  return {
    name:
      typeof o.name === "string" && o.name.trim()
        ? o.name.trim().slice(0, 60)
        : null,
    flow,
  };
}

/** What MasterDeck writes back for a draft: whether it is usable, and what sessions would get. */
export function checkDraft(raw: unknown): {
  ok: boolean;
  problems: string[];
  dropped: string[];
  plans: { trigger: string; note: string }[];
} {
  const { flow } = normalizeDraft(raw);
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
      `${givenEdges - flow.edges.length} arrow(s) were left out (unknown block, into a trigger, a loop or a duplicate)`,
    );
  const c = compileFlow(flow);
  const problems = c.problems.map((p) => {
    const n = p.node ? flow.nodes.find((x) => x.id === p.node) : null;
    return n ? `${n.id} (${n.kind}): ${p.text}` : p.text;
  });
  return {
    ok: !problems.length && !dropped.length && flow.nodes.length > 0,
    problems,
    dropped,
    plans: c.steps.map((s) => ({ trigger: s.trigger, note: s.note })),
  };
}

/** The builder's CLAUDE.md: its job, the format, the triggers, built-ins and skills, and the rules. */
export function builderContext(
  skills: { name: string; description: string; source?: string }[],
  current: { id: string; name: string },
): string {
  const triggers = FLOW_TRIGGERS.map(
    (t) =>
      `- \`${t.id}\`: ${t.label}. ${t.hint}${t.id.startsWith("command") ? " Needs `pattern`." : ""}${t.id === "idle" ? " Takes `minutes`." : ""}`,
  ).join("\n");
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
session following it does at points of its work (a trigger), as blocks joined by arrows.

The user sees this conversation next to MasterDeck's Workflow canvas. The workflow open there is
**${current.name}** (id \`${current.id}\`), in \`current.json\`.

## How to work

1. Read \`current.json\` when the request is about changing the open workflow.
2. Write the whole new workflow to \`draft.json\` (not only the changes; keep the blocks the user
   did not ask to change). Positions are optional: leave \`x\`/\`y\` out and MasterDeck lays it out.
3. Wait a moment, then read \`check.json\`: MasterDeck checks each draft there (\`ok\`, \`problems\`,
   \`dropped\`, and \`plans\`: the exact text each trigger will hand sessions). Fix every problem
   and write \`draft.json\` again until \`ok\` is true.
4. Tell the user in a few lines what the workflow does. They apply it on the canvas (Apply, or
   Save as template); you don't apply it yourself.

Only write \`draft.json\` in this folder. Don't edit other files, and don't touch
\`~/.claude/settings.json\` or MasterDeck's own files.

## draft.json

\`\`\`ts
{
  name?: string            // a suggested template name
  flow: {
    nodes: Node[]
    edges: { from: string; to: string; kind: 'then' | 'ok' | 'fail' }[]
  }
}
type Node =
  | { id: string; kind: 'trigger'; trigger: Trigger; pattern?: string; minutes?: number }
  | { id: string; kind: 'skill'; skill: string; mode: 'background' | 'session'; instructions: string }
  | { id: string; kind: 'instruction'; text: string }
  | { id: string; kind: 'notify'; text: string }
  | { id: string; kind: 'builtin'; builtin: 'ticket' | 'pr-review' | 'pr-watch' }
\`\`\`

Ids: short, lowercase letters, digits and dashes (e.g. \`push\`, \`run-tests\`).

## Triggers

${triggers}

## Built-ins

MasterDeck's own steps. Keep each one hung from its trigger unless the user wants it off (leaving it
out turns it off for sessions following the workflow). At most one of each.

${builtins}

## Arrows

- \`then\` (${EDGE_LABEL.then}): do the next block after this one. Several \`then\` arrows out of one
  block run side by side. Arrows out of a trigger are always \`then\`.
- \`ok\` (${EDGE_LABEL.ok}) and \`fail\` (${EDGE_LABEL.fail}): from an action, the session follows the one
  that matches how the step went.

No loops, nothing points into a trigger, and every action must be reached from a trigger.

## Actions

- \`skill\`: a skill from the list below, by its exact name. \`background\` runs it in a background
  subagent while the session carries on; \`session\` has the session do it. \`instructions\` add to it.
- \`instruction\`: text the session is told as it is. Be specific and short.
- \`notify\`: a desktop notification. Only after \`needs-you\` or \`idle\`. After \`idle\`, instructions
  are sent to the session as a message; after \`needs-you\` only notify blocks work.

## Skills available

${skillList || "- (none installed)"}

## Example

After a push, run the tests; if they fail, fix them and push again; if they pass, post the preview
URL on the PR:

\`\`\`json
{
  "name": "Tests after push",
  "flow": {
    "nodes": [
      { "id": "push", "kind": "trigger", "trigger": "after-push" },
      { "id": "tests", "kind": "instruction", "text": "Run the test suite." },
      { "id": "fix", "kind": "instruction", "text": "Fix the failures, commit and push again." },
      { "id": "post", "kind": "instruction", "text": "Post the preview URL in the PR description." }
    ],
    "edges": [
      { "from": "push", "to": "tests", "kind": "then" },
      { "from": "tests", "to": "fix", "kind": "fail" },
      { "from": "tests", "to": "post", "kind": "ok" }
    ]
  }
}
\`\`\`
`;
}

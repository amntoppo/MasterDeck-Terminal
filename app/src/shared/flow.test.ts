import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileFlow,
  defaultFlow,
  edgeId,
  fromSteps,
  FLOW_TRIGGERS,
  flowTriggerCommand,
  guardedBuiltin,
  makesCycle,
  parseFlow,
  type EdgeKind,
  type Flow,
  type FlowNode,
} from "./flow";

const at = { x: 0, y: 0 };
const e = (from: string, to: string, kind: EdgeKind = "then") => ({
  id: edgeId(from, to),
  from,
  to,
  kind,
});
const T = (id: string, trigger: string, extra: object = {}) =>
  ({ id, ...at, kind: "trigger", trigger, ...extra }) as FlowNode;
const I = (id: string, text: string) =>
  ({ id, ...at, kind: "instruction", text }) as FlowNode;
const S = (
  id: string,
  skill: string,
  mode: "background" | "session" = "session",
) => ({ id, ...at, kind: "skill", skill, mode, instructions: "" }) as FlowNode;

describe("flows", () => {
  it("compiles a chain, side-by-side branches and outcome arrows into one plan", () => {
    const flow: Flow = {
      nodes: [
        T("push", "after-push"),
        S("tests", "run-tests"),
        I("ok", "Post the preview URL."),
        I("bad", "Fix it and ask me."),
        I("after", "Update the ticket."),
        S("dep", "deploy", "background"),
      ],
      edges: [
        e("push", "tests"),
        e("push", "dep"),
        e("tests", "ok", "ok"),
        e("tests", "bad", "fail"),
        e("tests", "after"),
      ],
    };
    const { steps, problems } = compileFlow(flow);
    expect(problems).toEqual([]);
    expect(steps).toHaveLength(1);
    const note = steps[0].note;
    expect(note).toContain("Workflow step (after a git push):");
    expect(note).toContain("At the same time:");
    expect(note).toMatch(/1a\.1\. Use the run-tests skill/);
    expect(note).toMatch(/If it worked:\n\s+1a\.1\.1\. Post the preview URL\./);
    expect(note).toMatch(/If it failed:\n\s+1a\.1\.1\. Fix it and ask me\./);
    expect(note).toMatch(/1a\.2\. Then: Update the ticket\./);
    expect(note).toMatch(/1b\.1\. Launch a subagent/);
    // A changed plan gets a new id (it reaches sessions again).
    const again = compileFlow({
      ...flow,
      nodes: flow.nodes.map((n) =>
        n.id === "ok" ? { ...n, text: "Post it." } : n,
      ) as FlowNode[],
    });
    expect(again.steps[0].id).not.toBe(steps[0].id);
  });
  it("reports blocks that never run, and misplaced ones", () => {
    const { problems, steps } = compileFlow({
      nodes: [
        T("ny", "needs-you"),
        I("msg", "hello"),
        I("loose", "nobody"),
        T("cmd", "command-after", { pattern: "(" }),
        I("x", "y"),
        { id: "nt", ...at, kind: "notify", text: "Check it" },
      ],
      edges: [e("ny", "msg"), e("ny", "nt"), e("cmd", "x")],
    });
    expect(problems.map((p) => p.node)).toEqual(
      expect.arrayContaining(["msg", "loose", "cmd"]),
    );
    expect(steps.find((s) => s.trigger === "needs-you")?.notify).toEqual([
      "Check it",
    ]);
  });
  it("parses safely: bad blocks, arrows into triggers, loops and duplicate built-ins go", () => {
    const f = parseFlow({
      nodes: [
        T("a", "after-push"),
        I("b", "x"),
        { id: "BAD ID", kind: "instruction", text: "x" },
        { id: "c", kind: "builtin", builtin: "pr-watch" },
        { id: "d", kind: "builtin", builtin: "pr-watch" },
        { id: "z", kind: "nope" },
      ],
      edges: [e("a", "b", "ok"), e("b", "a"), e("b", "b"), e("b", "gone")],
    });
    expect(f.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(f.edges).toEqual([e("a", "b", "then")]);
    expect(
      makesCycle(
        { nodes: f.nodes, edges: [e("a", "b"), e("b", "c")] },
        "c",
        "b",
      ),
    ).toBe(true);
  });
  it("turns the old steps into a flow with every built-in", () => {
    const f = fromSteps([
      {
        id: "note-1",
        trigger: "pr-created",
        kind: "instruction",
        skill: "",
        mode: "session",
        instructions: "Post the URL.",
      },
    ]);
    const { steps, builtins } = compileFlow(f);
    expect(builtins.sort()).toEqual(["pr-review", "pr-watch", "ticket"]);
    expect(steps).toHaveLength(1);
    expect(steps[0].note).toMatch(
      /\(when a PR is created\):\n1\. Post the URL\./,
    );
    // The default alone asks nothing of sessions (the built-ins' hooks speak for themselves).
    expect(compileFlow(defaultFlow()).steps).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("flow hooks", () => {
  const SID = "aaaaaaaa-1111-2222-3333-444444444444";
  const setup = (doc: object) => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    mkdirSync(join(dir, "workflows", "sessions"), { recursive: true });
    writeFileSync(
      join(dir, "workflows", "sessions", `${SID}.json`),
      JSON.stringify(doc),
    );
    return dir;
  };
  const run = (cmd: string, dir: string, input: object) =>
    execFileSync("bash", ["-c", cmd], {
      cwd: dir,
      input: JSON.stringify(input),
      env: { ...process.env, TMPDIR: dir },
      encoding: "utf8",
    });
  const trig = (id: string) => FLOW_TRIGGERS.find((t) => t.id === id)!;

  it("command triggers match their pattern; turn-end asks Claude to go on once per turn", () => {
    const flow: Flow = {
      nodes: [
        T("c", "command-after", { pattern: "npm (run )?test" }),
        I("i", "Summarise the failures."),
        T("s", "turn-end"),
        I("j", "Run the linter."),
      ],
      edges: [e("c", "i"), e("s", "j")],
    };
    const dir = setup({ ...compileFlow(flow) });
    const after = flowTriggerCommand(trig("command-after"), dir, "m");
    expect(
      run(after, dir, { session_id: SID, tool_input: { command: "ls" } }),
    ).toBe("");
    expect(
      JSON.parse(
        run(after, dir, {
          session_id: SID,
          tool_input: { command: "cd x && npm run test" },
        }),
      ).hookSpecificOutput.additionalContext,
    ).toContain("Summarise the failures.");
    const stop = flowTriggerCommand(trig("turn-end"), dir, "m");
    const out = JSON.parse(
      run(stop, dir, { session_id: SID, stop_hook_active: false }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("Run the linter.");
    expect(run(stop, dir, { session_id: SID, stop_hook_active: true })).toBe(
      "",
    );
    // Each run is logged for MasterDeck (the Workflow line in Details).
    const log = readFileSync(join(dir, "workflows", "runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.map((r) => [r.sid, r.trigger])).toEqual([
      [SID, "command-after"],
      [SID, "turn-end"],
    ]);
  }, 20_000);
  it("a built-in left out of the workflow skips its hook", () => {
    const on = setup({ builtins: ["pr-watch"] });
    const cmd = guardedBuiltin("pr-watch", `jq -c '{got: .session_id}'`, on);
    expect(JSON.parse(run(cmd, on, { session_id: SID })).got).toBe(SID);
    const off = setup({ builtins: ["ticket"] });
    expect(
      run(guardedBuiltin("pr-watch", `jq -c '{got: .session_id}'`, off), off, {
        session_id: SID,
      }),
    ).toBe("");
    // No list (an older file): runs.
    const old = setup({ steps: [] });
    expect(
      run(guardedBuiltin("pr-watch", `jq -c '{got: .session_id}'`, old), old, {
        session_id: SID,
      }),
    ).not.toBe("");
  }, 20_000);
});

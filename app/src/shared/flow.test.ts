import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileFlow,
  customTriggerCommand,
  defaultFlow,
  edgeId,
  fromSteps,
  FLOW_TRIGGERS,
  flowTriggerCommand,
  guardedBuiltin,
  makesCycle,
  newLoop,
  parseFlow,
  type CustomTrigger,
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
  it("turn-end does not fire while a loop is open", () => {
    const flow: Flow = {
      nodes: [T("s", "turn-end"), I("j", "Run the linter.")],
      edges: [e("s", "j")],
    };
    const dir = setup({ ...compileFlow(flow) });
    const stop = flowTriggerCommand(trig("turn-end"), dir, "m");
    const loops = join(dir, "workflows", "loops");
    mkdirSync(loops, { recursive: true });
    const file = (state: string) =>
      writeFileSync(
        join(loops, `${SID}.json`),
        JSON.stringify({ loops: [{ id: "lp", state }] }),
      );
    file("open");
    expect(run(stop, dir, { session_id: SID, stop_hook_active: false })).toBe(
      "",
    );
    expect(existsSync(join(dir, "workflows", "runs.jsonl"))).toBe(false);
    // Over (or a file that is not one): the turn-end plan runs again.
    file("met");
    expect(
      JSON.parse(run(stop, dir, { session_id: SID, stop_hook_active: false }))
        .reason,
    ).toContain("Run the linter.");
    writeFileSync(join(loops, `${SID}.json`), "{not json");
    expect(
      run(stop, dir, { session_id: SID, stop_hook_active: false }),
    ).not.toBe("");
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

describe("loops", () => {
  const L = (id: string, members: string[], extra: object = {}) => ({
    ...newLoop(id, 0, 0),
    members,
    ...extra,
  });
  const loopOf = (f: Flow, id: string) =>
    f.nodes.find((n) => n.id === id) as Extract<FlowNode, { kind: "loop" }>;

  it("parses a loop with its fields clamped", () => {
    const low = loopOf(
      parseFlow({
        nodes: [
          L("lp", [], {
            name: "n".repeat(80),
            w: 10,
            h: 10,
            check: {
              command: "c".repeat(600),
              output: "o".repeat(400),
              outputMode: "no-match",
              timeoutMin: 0,
            },
            agentDone: { on: true, goal: "g".repeat(1200) },
            limits: { iterations: 0, minutes: -1, stall: 1 },
          }),
        ],
        edges: [],
      }),
      "lp",
    );
    expect(low.name).toHaveLength(60);
    expect(low.check.command).toHaveLength(500);
    expect(low.check.output).toHaveLength(300);
    expect(low.check.outputMode).toBe("no-match");
    expect(low.check.timeoutMin).toBe(1);
    expect(low.agentDone).toEqual({ on: true, goal: "g".repeat(1000) });
    expect(low.limits).toEqual({ iterations: 1, minutes: 0, stall: 2 });
    expect([low.w, low.h]).toEqual([200, 120]);
    const high = loopOf(
      parseFlow({
        nodes: [
          L("lp", [], {
            w: 9000,
            h: 9000,
            check: {
              command: "npm test",
              output: "",
              outputMode: "x",
              timeoutMin: 20,
            },
            limits: { iterations: 500, minutes: 2000, stall: 40 },
          }),
        ],
        edges: [],
      }),
      "lp",
    );
    expect(high.check).toEqual({
      command: "npm test",
      output: "",
      outputMode: "match",
      timeoutMin: 9,
    });
    expect(high.limits).toEqual({ iterations: 100, minutes: 1440, stall: 10 });
    expect([high.w, high.h]).toEqual([2000, 1500]);
    // Junk fields fall back to a new loop's.
    const junk = loopOf(
      parseFlow({ nodes: [{ id: "lp", kind: "loop" }] }),
      "lp",
    );
    expect(junk).toEqual({ ...newLoop("lp", 0, 0), members: [] });
  });

  it("keeps only members that exist and may be in a loop", () => {
    const f = parseFlow({
      nodes: [
        T("t", "after-push"),
        { id: "b", ...at, kind: "builtin", builtin: "pr-watch" },
        I("a", "Run the tests."),
        S("s", "fix"),
        { id: "nt", ...at, kind: "notify", text: "Ping." },
        L("inner", []),
        L("lp", ["t", "b", "missing", "inner", "a", "s", "nt", "a"]),
      ],
      edges: [],
    });
    expect(loopOf(f, "lp").members).toEqual(["a", "s", "nt"]);
  });

  it("a block is in one loop only", () => {
    const f = parseFlow({
      nodes: [I("a", "x"), I("b", "y"), L("one", ["a"]), L("two", ["a", "b"])],
      edges: [],
    });
    expect(loopOf(f, "one").members).toEqual(["a"]);
    expect(loopOf(f, "two").members).toEqual(["b"]);
  });

  it("no loop in a loop", () => {
    const f = parseFlow({
      nodes: [L("outer", ["inner"]), L("inner", ["outer"])],
      edges: [],
    });
    expect(loopOf(f, "outer").members).toEqual([]);
    expect(loopOf(f, "inner").members).toEqual([]);
  });

  const framed = (edges: ReturnType<typeof e>[]) =>
    parseFlow({
      nodes: [
        T("t", "after-push"),
        I("a", "Run the tests."),
        I("b", "Fix the cause."),
        I("out", "Open the PR."),
        L("lp", ["a", "b"]),
      ],
      edges,
    }).edges.map((x) => `${x.from}>${x.to}:${x.kind}`);

  it("an arrow from outside into a member points at the loop", () => {
    expect(framed([e("t", "a"), e("t", "b"), e("t", "lp")])).toEqual([
      "t>lp:then",
    ]);
  });

  it("an arrow from a member to outside is dropped", () => {
    // Out of the frame, into its own frame, and the frame into its own member.
    expect(framed([e("a", "out"), e("b", "lp"), e("lp", "a")])).toEqual([]);
  });

  it("arrows between members are kept", () => {
    expect(framed([e("a", "b", "fail")])).toEqual(["a>b:fail"]);
  });

  it("met and limit arrows only leave a loop", () => {
    expect(
      framed([e("t", "lp", "met"), e("a", "b", "limit"), e("lp", "out", "met")]),
    ).toEqual(["t>lp:then", "a>b:then", "lp>out:met"]);
    expect(framed([e("lp", "out", "limit")])).toEqual(["lp>out:limit"]);
    expect(framed([e("lp", "out", "ok")])).toEqual(["lp>out:then"]);
    expect(framed([e("lp", "out", "fail")])).toEqual(["lp>out:then"]);
  });

  it("makesCycle treats the frame as one node", () => {
    const flow = parseFlow({
      nodes: [
        T("t", "after-push"),
        I("a", "Run the tests."),
        I("b", "Fix the cause."),
        I("out", "Open the PR."),
        L("lp", ["a", "b"]),
      ],
      edges: [e("t", "lp"), e("a", "b"), e("lp", "out", "met")],
    });
    // Back into a member from the loop's met target: around the frame.
    expect(makesCycle(flow, "out", "a")).toBe(true);
    expect(makesCycle(flow, "out", "lp")).toBe(true);
    // Inside the frame, members are ordinary blocks.
    expect(makesCycle(flow, "b", "a")).toBe(true);
    expect(makesCycle(flow, "a", "b")).toBe(false);
    // The frame into its own member (or a member into its frame) is no arrow at all.
    expect(makesCycle(flow, "lp", "a")).toBe(true);
    expect(makesCycle(flow, "a", "lp")).toBe(true);
    expect(makesCycle(flow, "t", "a")).toBe(false);
  });

  it("an old reader drops the loop", () => {
    // S1: a MasterDeck from before loops drops the unknown node; the members stay as blocks no
    // trigger reaches, so nothing runs and the check says so.
    const raw = {
      nodes: [
        T("t", "after-push"),
        I("a", "Run the tests."),
        I("b", "Fix the cause."),
        L("lp", ["a", "b"]),
      ],
      edges: [e("t", "lp"), e("a", "b")],
    };
    const old = parseFlow({
      ...raw,
      nodes: raw.nodes.filter((n) => n.kind !== "loop"),
    });
    expect(old.nodes.map((n) => n.id)).toEqual(["t", "a", "b"]);
    expect(old.edges.map((x) => x.id)).toEqual([edgeId("a", "b")]);
    const { steps, problems } = compileFlow(old);
    expect(steps).toEqual([]);
    expect(problems.map((p) => p.node)).toEqual(["a", "b"]);
  });
});

describe("compiling loops", () => {
  type Loop = Extract<FlowNode, { kind: "loop" }>;
  const L = (id: string, members: string[], extra: Partial<Loop> = {}) =>
    ({ ...newLoop(id, 0, 0), members, ...extra }) as FlowNode;
  const N = (id: string, text: string) =>
    ({ id, ...at, kind: "notify", text }) as FlowNode;
  const check = (command: string, output = "", outputMode = "match") => ({
    check: {
      command,
      output,
      outputMode: outputMode as "match" | "no-match",
      timeoutMin: 5,
    },
  });
  const fixFlow = (loop: Partial<Loop> = check("npm test")): Flow => ({
    nodes: [
      T("t", "after-push"),
      I("a", "A"),
      I("b", "B"),
      I("c", "C"),
      I("d", "D"),
      N("n", "Stuck."),
      L("lp", ["b", "c"], { name: "Fix", ...loop }),
    ],
    edges: [
      e("t", "a"),
      e("a", "lp"),
      e("b", "c"),
      e("lp", "d", "met"),
      e("lp", "n", "limit"),
    ],
  });
  const loopLine = (loop: Partial<Loop>) =>
    compileFlow(fixFlow(loop))
      .steps[0].note.split("\n")
      .find((l) => l.includes("Repeat until"));

  it("a loop is one numbered step with its members inside", () => {
    const { steps } = compileFlow(fixFlow());
    expect(steps[0].note).toBe(
      [
        "Workflow step (after a git push):",
        "1. A",
        '2. Then: Repeat until the loop "Fix" is done (MasterDeck checks it each time you finish a turn: `npm test` must pass). Each round:',
        "   2.1. B",
        "   2.2. Then: C",
        '   End each round with one line starting "PROGRESS:" that says what you tried (MasterDeck keeps these as the loop\'s progress).',
        "   When MasterDeck says the loop is over:",
        "     If the criterion was met:",
        "       2.met.1. D",
        // The limit branch is a notify block, which adds nothing to a hook's plan: no empty heading.
        "Then carry on with what you were doing.",
      ].join("\n"),
    );
  });

  it("a then arrow out of a loop goes on after it, however it ended", () => {
    const flow = fixFlow();
    flow.nodes.push(I("after", "Open the PR."));
    flow.edges.push(e("lp", "after"));
    const note = compileFlow(flow).steps[0].note;
    expect(note).toContain("\n3. Then: Open the PR.\n");
    expect(note.indexOf("2.met.1. D")).toBeLessThan(note.indexOf("3. Then"));
  });

  it("says the criterion in words", () => {
    expect(loopLine(check("npm test"))).toContain(": `npm test` must pass)");
    expect(loopLine(check("curl -s x", "ready"))).toContain(
      ": the output of `curl -s x` must match `ready`)",
    );
    expect(loopLine(check("curl -s x", "busy", "no-match"))).toContain(
      ": the output of `curl -s x` must no longer match `busy`)",
    );
    expect(
      loopLine({
        ...check(""),
        agentDone: { on: true, goal: "the page loads" },
      }),
    ).toContain(
      ': you reach this goal: the page loads; when you have, end your turn with a line starting "LOOP DONE:" and why)',
    );
    expect(
      loopLine({
        ...check("npm test"),
        agentDone: { on: true, goal: "the page loads" },
      }),
    ).toContain(
      ': `npm test` must pass, and you end your turn with a line starting "LOOP DONE:" and why once you reach this goal: the page loads)',
    );
  });

  it("compileFlow puts the loop in its trigger's step", () => {
    const { steps, problems } = compileFlow(fixFlow());
    // The notify block under the limit is reported as for any hook trigger.
    expect(problems.map((p) => p.node)).toEqual(["n"]);
    expect(steps).toHaveLength(1);
    expect(steps[0].loops).toEqual([
      {
        id: "lp",
        name: "Fix",
        check: {
          command: "npm test",
          output: "",
          outputMode: "match",
          timeoutMin: 5,
        },
        agentDone: { on: false, goal: "" },
        limits: { iterations: 10, minutes: 0, stall: 0 },
        plan: "1. B\n2. Then: C",
        met: "1. D",
        limit: "",
        then: "",
        after: null,
      },
    ]);
  });

  it("a loop knows the blocks its then arrows lead to, but not the loops", () => {
    const flow = fixFlow();
    flow.nodes.push(
      I("after", "Open the PR."),
      I("x1", "x"),
      L("lx", ["x1"], { name: "X", ...check("true") }),
    );
    flow.edges.push(e("lp", "after"), e("lp", "lx"));
    const lp = compileFlow(flow).steps[0].loops!.find((l) => l.id === "lp")!;
    // The loop behind the then arrow is opened by the hook (its `after`), not told as text.
    expect(lp.then).toBe("1. Open the PR.");
    expect(compileFlow(fixFlow()).steps[0].loops![0].then).toBe("");
  });

  it("the step id changes when the loop changes", () => {
    const one = compileFlow(fixFlow()).steps[0];
    const two = compileFlow(
      fixFlow({
        ...check("npm test"),
        limits: { iterations: 3, minutes: 0, stall: 0 },
      }),
    ).steps[0];
    expect(two.note).toBe(one.note);
    expect(two.id).not.toBe(one.id);
  });

  it("members are reached through their loop", () => {
    const { problems } = compileFlow(fixFlow());
    expect(problems.find((p) => /Not connected/.test(p.text))).toBeUndefined();
  });

  it("reports what is wrong with a loop", () => {
    const texts = (flow: Flow) => compileFlow(flow).problems.map((p) => p.text);
    const empty = fixFlow();
    (empty.nodes.find((n) => n.id === "lp") as Loop).members = [];
    expect(texts(empty)).toContain('Loop "Fix" has no blocks inside');
    expect(texts(fixFlow(check("")))).toContain(
      'Loop "Fix" needs a check command or the agent\'s goal',
    );
    expect(texts(fixFlow(check("npm test", "(")))).toContain(
      'Loop "Fix": the output pattern is not a valid regular expression',
    );
    expect(
      texts(
        fixFlow({ ...check("npm test"), agentDone: { on: true, goal: " " } }),
      ),
    ).toContain('Loop "Fix": write the goal the agent works toward');
    const under = (trigger: string) =>
      compileFlow({
        nodes: [
          T("t", trigger),
          I("b", "B"),
          L("lp", ["b"], { name: "Fix", ...check("npm test") }),
        ],
        edges: [e("t", "lp")],
      });
    for (const t of ["needs-you", "idle"])
      expect(under(t).problems.map((p) => p.text)).toContain(
        "Loops run in the session: put them under a trigger the session gets",
      );
    const turn = under("turn-end");
    expect(turn.problems.map((p) => p.text)).toContain(
      'A loop under "Turn finished" would never end: put it under another trigger',
    );
    // Never armed there.
    expect(turn.steps[0].loops).toBeUndefined();
    const loose = compileFlow({
      nodes: [T("t", "after-push"), I("b", "B"), L("lp", ["b"], check("x"))],
      edges: [],
    });
    expect(
      loose.problems
        .filter((p) => /Not connected/.test(p.text))
        .map((p) => p.node),
    ).toEqual(["b", "lp"]);
  });

  /** trigger → A; A -met→ B; A -then→ C; A -limit→ notify → D. */
  const chained = (): Flow => ({
    nodes: [
      T("t", "after-push"),
      I("a1", "Fix."),
      I("b1", "Polish."),
      I("c", "Report."),
      I("d1", "Try another way."),
      N("n", "Stuck."),
      L("la", ["a1"], { name: "A", ...check("npm test") }),
      L("lb", ["b1"], { name: "B", ...check("npm run lint") }),
      L("ld", ["d1"], { name: "D", ...check("npm test") }),
    ],
    edges: [
      e("t", "la"),
      e("la", "lb", "met"),
      e("la", "c"),
      e("la", "n", "limit"),
      e("n", "ld"),
    ],
  });

  it("each loop knows the loop it comes after", () => {
    const { steps, problems } = compileFlow(chained());
    expect(
      steps[0].loops!.map((l) => [l.id, l.after]),
    ).toEqual([
      ["la", null],
      ["lb", { loop: "la", via: "met" }],
      ["ld", { loop: "la", via: "limit" }],
    ]);
    expect(problems.filter((p) => /Loops? "/.test(p.text))).toEqual([]);
  });

  it("a loop in an outcome branch is a problem", () => {
    const { problems } = compileFlow({
      nodes: [
        T("t", "after-push"),
        S("tests", "run-tests"),
        I("b", "Fix."),
        L("lp", ["b"], { name: "Fix", ...check("npm test") }),
      ],
      edges: [e("t", "tests"), e("tests", "lp", "fail")],
    });
    expect(problems).toContainEqual({
      node: "lp",
      text: 'Loop "Fix" is inside an "if it worked/failed" branch: MasterDeck can\'t tell which branch the session took. Put it on the main path.',
    });
  });

  it("two loops open at the same time are a problem", () => {
    const side = compileFlow({
      nodes: [
        T("t", "after-push"),
        I("a1", "x"),
        I("b1", "y"),
        L("la", ["a1"], { name: "A", ...check("true") }),
        L("lb", ["b1"], { name: "B", ...check("true") }),
      ],
      edges: [e("t", "la"), e("t", "lb")],
    });
    expect(side.problems).toContainEqual({
      node: "lb",
      text: 'Loops "A" and "B" would run at the same time: put one after the other.',
    });
    // Two loops after the same loop's met arrow, too.
    const flow = chained();
    flow.nodes.push(
      I("e1", "z"),
      L("le", ["e1"], { name: "E", ...check("true") }),
    );
    flow.edges.push(e("la", "le", "met"));
    expect(compileFlow(flow).problems).toContainEqual({
      node: "le",
      text: 'Loops "B" and "E" would run at the same time: put one after the other.',
    });
  });

  it("a loop behind a then arrow meets the loops behind met and limit", () => {
    // la -then→ lc and la -met→ lb: lc opens whatever the outcome, so with a met it runs beside lb.
    for (const kind of ["met", "limit"] as const) {
      const { problems } = compileFlow({
        nodes: [
          T("t", "after-push"),
          I("a1", "x"),
          I("b1", "y"),
          I("c1", "z"),
          L("la", ["a1"], { name: "A", ...check("true") }),
          L("lb", ["b1"], { name: "B", ...check("true") }),
          L("lc", ["c1"], { name: "C", ...check("true") }),
        ],
        edges: [e("t", "la"), e("la", "lb", kind), e("la", "lc")],
      });
      expect(problems.filter((p) => /would run at the same time/.test(p.text))).toHaveLength(1);
    }
    // met and limit alone never run together.
    expect(
      compileFlow(chained()).problems.filter((p) =>
        /would run at the same time/.test(p.text),
      ),
    ).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("arming a loop", () => {
  const SID = "aaaaaaaa-1111-2222-3333-444444444444";
  const trig = FLOW_TRIGGERS.find((t) => t.id === "after-push")!;
  const loopFlow = (): Flow => ({
    nodes: [
      T("t", "after-push"),
      I("b", "Fix the cause."),
      {
        ...newLoop("lp", 0, 0),
        name: "Fix",
        members: ["b"],
        check: {
          command: "npm test",
          output: "",
          outputMode: "match",
          timeoutMin: 5,
        },
      } as FlowNode,
    ],
    edges: [e("t", "lp")],
  });
  const setup = (flow: Flow) => {
    const dir = mkdtempSync(join(tmpdir(), "flow-arm-"));
    mkdirSync(join(dir, "workflows", "sessions"), { recursive: true });
    writeFileSync(
      join(dir, "workflows", "sessions", `${SID}.json`),
      JSON.stringify(compileFlow(flow)),
    );
    return dir;
  };
  // A fresh TMPDIR each time: the once-per-commit marks must not hide a second firing.
  const fire = (dir: string) =>
    execFileSync("bash", ["-c", flowTriggerCommand(trig, dir, "m")], {
      cwd: dir,
      input: JSON.stringify({
        session_id: SID,
        tool_input: { command: "git push" },
      }),
      env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), "flow-tmp-")) },
      encoding: "utf8",
    });
  const loopsDir = (dir: string) => join(dir, "workflows", "loops");
  const readLoops = (dir: string) =>
    JSON.parse(readFileSync(join(loopsDir(dir), `${SID}.json`), "utf8"));
  const writeLoops = (dir: string, v: object) =>
    writeFileSync(join(loopsDir(dir), `${SID}.json`), JSON.stringify(v));

  it("firing arms the loop", () => {
    const dir = setup(loopFlow());
    const before = Date.now() - 1000;
    const out = JSON.parse(fire(dir));
    expect(out.hookSpecificOutput.additionalContext).toContain("Repeat until");
    const step = compileFlow(loopFlow()).steps[0].id;
    const { loops } = readLoops(dir);
    expect(loops).toEqual([
      {
        id: "lp",
        step,
        state: "open",
        iteration: 0,
        startedAt: expect.any(Number),
        history: [],
        reason: null,
        lastCheck: null,
      },
    ]);
    expect(loops[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(readFileSync(join(loopsDir(dir), `${SID}-lp.md`), "utf8")).toBe("");
    // Atomic: nothing left behind.
    expect(readdirSync(loopsDir(dir)).sort()).toEqual([
      `${SID}-lp.md`,
      `${SID}.json`,
    ]);
  }, 20_000);

  it("firing again does not reset an open loop", () => {
    const dir = setup(loopFlow());
    fire(dir);
    const file = readLoops(dir);
    file.loops[0].iteration = 3;
    writeLoops(dir, file);
    writeFileSync(join(loopsDir(dir), `${SID}-lp.md`), "tried x\n");
    fire(dir);
    expect(readLoops(dir)).toEqual(file);
    expect(readFileSync(join(loopsDir(dir), `${SID}-lp.md`), "utf8")).toBe(
      "tried x\n",
    );
  }, 20_000);

  it("a met loop is armed again", () => {
    const dir = setup(loopFlow());
    fire(dir);
    const file = readLoops(dir);
    file.loops[0] = {
      ...file.loops[0],
      state: "met",
      iteration: 4,
      startedAt: 1,
      reason: "criterion met after 4 iterations",
      history: [{ n: 1 }],
    };
    // Another loop's entry is left as it is.
    file.loops.push({ id: "other", state: "limit", iteration: 2 });
    writeLoops(dir, file);
    writeFileSync(join(loopsDir(dir), `${SID}-lp.md`), "old notes\n");
    fire(dir);
    const { loops } = readLoops(dir);
    expect(loops).toHaveLength(2);
    expect(loops[0]).toMatchObject({
      id: "lp",
      state: "open",
      iteration: 0,
      history: [],
      reason: null,
    });
    expect(loops[0].startedAt).toBeGreaterThan(1);
    expect(loops[1]).toEqual({ id: "other", state: "limit", iteration: 2 });
    // ponytail: only the latest run of a loop is kept, its notes too.
    expect(readFileSync(join(loopsDir(dir), `${SID}-lp.md`), "utf8")).toBe("");
  }, 20_000);

  it("a corrupt loop file is replaced when the trigger fires", () => {
    const dir = setup(loopFlow());
    mkdirSync(loopsDir(dir), { recursive: true });
    writeFileSync(join(loopsDir(dir), `${SID}.json`), "{not json");
    fire(dir);
    expect(readLoops(dir).loops.map((l: { id: string }) => l.id)).toEqual([
      "lp",
    ]);
  }, 20_000);

  it("arms only the loops that start with the trigger", () => {
    const loop = (id: string, members: string[]) =>
      ({
        ...newLoop(id, 0, 0),
        members,
        check: { command: "true", output: "", outputMode: "match", timeoutMin: 5 },
      }) as FlowNode;
    const dir = setup({
      nodes: [
        T("t", "after-push"),
        I("a1", "Fix."),
        I("b1", "Polish."),
        loop("la", ["a1"]),
        loop("lb", ["b1"]),
      ],
      edges: [e("t", "la"), e("la", "lb", "met")],
    });
    fire(dir);
    expect(readLoops(dir).loops.map((l: { id: string }) => l.id)).toEqual([
      "la",
    ]);
    expect(readdirSync(loopsDir(dir)).sort()).toEqual([
      `${SID}-la.md`,
      `${SID}.json`,
    ]);
  }, 20_000);

  it("a custom trigger arms its loops too", () => {
    const always: CustomTrigger = {
      id: "edit",
      name: "Edited",
      description: "",
      event: "PostToolUse",
      tool: "Edit",
      field: "file",
      pattern: "",
      output: "",
      once: "always",
    };
    const flow = loopFlow();
    flow.nodes[0] = T("t", "custom:edit");
    const dir = mkdtempSync(join(tmpdir(), "flow-arm-"));
    mkdirSync(join(dir, "workflows", "sessions"), { recursive: true });
    writeFileSync(
      join(dir, "workflows", "sessions", `${SID}.json`),
      JSON.stringify(compileFlow(flow, [always])),
    );
    execFileSync("bash", ["-c", customTriggerCommand("PostToolUse", dir, "m")], {
      cwd: dir,
      input: JSON.stringify({ session_id: SID, tool_name: "Edit" }),
      env: { ...process.env, TMPDIR: dir },
      encoding: "utf8",
    });
    expect(readLoops(dir).loops.map((l: { id: string }) => l.id)).toEqual([
      "lp",
    ]);
  }, 20_000);

  it("steps without loops write nothing", () => {
    const dir = setup({
      nodes: [T("t", "after-push"), I("b", "Post the URL.")],
      edges: [e("t", "b")],
    });
    expect(
      JSON.parse(fire(dir)).hookSpecificOutput.additionalContext,
    ).toContain("Post the URL.");
    expect(existsSync(loopsDir(dir))).toBe(false);
  }, 20_000);
});

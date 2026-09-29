import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileFlow, parseFlow, parseMonitor, setMonitors } from "./flow";
import { checkDraft, readDraftMonitor } from "./flowBuilder";
import { WorkflowStore } from "../main/workflow";

const ci = parseMonitor(
  {
    id: "pr-ci",
    name: "CI on the PR",
    description: "each finished check of the PR",
    timeoutMin: 30,
    rearm: true,
    until: "all checks are done",
    onEvent: "Fix failing checks and push.",
  },
  "/home/me/mon/pr-ci.sh",
)!;
const flow = parseFlow({
  nodes: [
    { id: "pr", kind: "trigger", trigger: "pr-created" },
    {
      id: "m",
      kind: "monitor",
      monitor: "pr-ci",
      args: "<PR number>",
      instructions: "",
    },
  ],
  edges: [{ from: "pr", to: "m" }],
});

afterEach(() => setMonitors([]));

describe("monitors", () => {
  it("compile to exact Monitor tool instructions", () => {
    expect(compileFlow(flow).problems.map((p) => p.text)).toEqual([
      "Unknown monitor pr-ci: it is not in the monitor library",
    ]);
    setMonitors([ci]);
    const note = compileFlow(flow).steps[0].note;
    expect(note).toContain(
      "Arm a monitor with the Monitor tool: command `bash '/home/me/mon/pr-ci.sh' <PR number>` (fill in the <...> parts)",
    );
    expect(note).toContain("timeout_ms 1800000");
    expect(note).toContain(
      "When it expires, arm it again, until all checks are done.",
    );
    expect(note).toContain(
      "On each event it emits: Fix failing checks and push.",
    );
    expect(parseMonitor({ id: "x", timeoutMin: 90 })!.timeoutMin).toBe(30);
  });
  it("check drafted scripts", () => {
    expect(readDraftMonitor(ci, null, null).problems[0]).toMatch(/missing/);
    expect(
      readDraftMonitor(ci, "tail -f app.log | grep ERROR", null).problems[0],
    ).toMatch(/--line-buffered/);
    expect(
      readDraftMonitor(
        ci,
        "while true; do echo hi; done",
        "line 1: syntax error",
      ).problems[0],
    ).toMatch(/syntax error/);
    const good = readDraftMonitor(
      ci,
      'tail -f app.log | grep --line-buffered -E "ERROR|FATAL"',
      null,
    );
    expect(good.problems).toEqual([]);
    const draft = {
      flow: { nodes: flow.nodes, edges: flow.edges },
      monitors: [ci],
    };
    expect(checkDraft(draft, { monitors: [good] }).ok).toBe(true);
    expect(checkDraft(draft, { monitors: [] }).problems.join()).toMatch(
      /Unknown monitor pr-ci/,
    );
  });
  it("are kept in the library with an executable script", () => {
    const home = mkdtempSync(join(tmpdir(), "mon-"));
    const w = new WorkflowStore(home);
    w.saveMonitor(ci, "echo event");
    const [m] = w.monitors();
    expect(m.id).toBe("pr-ci");
    expect(m.path).toBe(join(home, "workflows", "monitors", "pr-ci.sh"));
    expect(readFileSync(m.path, "utf8")).toBe("echo event\n");
    // Windows has no executable bit (the script is run with bash either way).
    if (process.platform !== "win32")
      expect(statSync(m.path).mode & 0o111).toBeTruthy();
    expect(w.deleteMonitor("pr-ci")).toBe(true);
    expect(w.monitors()).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { defaultFlow, edgeId, type Flow } from "./flow";
import {
  commandEvents,
  flowProgress,
  newFlowTrack,
  scanFlowLines,
  stripHeredocs,
} from "./flowTrack";

const t0 = Date.parse("2026-09-29T10:00:00Z");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
const use = (id: string, command: string, min: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(min),
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });
const result = (id: string, out: string, min: number, isError = false) =>
  JSON.stringify({
    type: "user",
    timestamp: at(min),
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: out,
          is_error: isError,
        },
      ],
    },
  });

describe("scanFlowLines", () => {
  it("finds pushes, PR creation and merges that ran, not text that mentions them", () => {
    const s = newFlowTrack();
    scanFlowLines(
      [
        use("a", "cd x && git push -u origin feat", 1),
        result("a", "branch set up", 2),
        use("b", "cat > notes.md <<'EOF'\ngh pr create --fill\nEOF", 3),
        result("b", "", 3),
        use("c", "gh pr create --fill", 5),
        result("c", "https://github.com/o/r/pull/12", 6),
        use("d", "gh pr merge 12 --squash", 9),
        result("d", "failed", 9, true),
      ],
      s,
    );
    expect(s.reached).toEqual({
      "after-push": t0 + 2 * 60_000,
      "before-pr": t0 + 5 * 60_000,
      "pr-created": t0 + 6 * 60_000,
    });
    expect(s.commands.map((c) => c.ok)).toEqual([true, true, true, false]);
    expect(stripHeredocs("cat <<EOF\nsecret\nEOF\nls")).toBe("cat <<EOF\nls");
  });
});

describe("flowProgress", () => {
  const flow = defaultFlow();
  it("shows the last point reached that the workflow does something at, and what is ahead", () => {
    const ev = [
      { trigger: "session-start" as const, at: 1 },
      { trigger: "linked" as const, at: 2 },
      { trigger: "pr-created" as const, at: 10 },
    ];
    const p = flowProgress(flow, ev, 50, false, true);
    expect(p.current?.trigger).toBe("pr-created");
    expect(p.current?.builtins).toEqual(["Watch the PR"]);
    // Waiting on the PR watch: running.
    expect(p.current?.ongoing).toBe(true);
    // Working on something else after the turn that opened the PR: not this step.
    expect(flowProgress(flow, ev, 50, true, false).current?.ongoing).toBe(
      false,
    );
    // Merged: shown as merged, over.
    const merged = flowProgress(
      flow,
      [...ev, { trigger: "pr-merged", at: 60 }],
      50,
      true,
      true,
    );
    expect(merged.current).toMatchObject({
      trigger: "pr-merged",
      ongoing: false,
      lines: [],
      builtins: [],
    });
    // Merged: nothing is done there in the default; no lifecycle point left.
    expect(p.next).toEqual([]);
    const early = flowProgress(flow, [{ trigger: "linked", at: 2 }], 5, false);
    expect(early.current).toMatchObject({ trigger: "linked", ongoing: false });
    expect(early.next).toEqual(["before-pr", "pr-created"]);
  });
  it("runs its own steps, and command triggers match recent commands", () => {
    const f: Flow = {
      nodes: [
        {
          id: "c",
          x: 0,
          y: 0,
          kind: "trigger",
          trigger: "command-after",
          pattern: "npm (run )?test",
        },
        {
          id: "i",
          x: 0,
          y: 0,
          kind: "instruction",
          text: "Summarise the failures.",
        },
      ],
      edges: [{ id: edgeId("c", "i"), from: "c", to: "i", kind: "then" }],
    };
    const ev = commandEvents(f, [
      { cmd: "ls", at: 1, ok: true },
      { cmd: "npm test", at: 7, ok: false },
    ]);
    expect(ev).toEqual([{ trigger: "command-after", at: 7 }]);
    const p = flowProgress(f, ev, 3, true);
    expect(p.current).toMatchObject({
      trigger: "command-after",
      lines: ["1. Summarise the failures."],
      ongoing: true,
    });
    expect(p.anytime).toEqual(["command-after"]);
    expect(flowProgress(f, ev, 9, true).current?.ongoing).toBe(false);
  });
});

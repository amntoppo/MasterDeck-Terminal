import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { edgeId, type Flow } from "@shared/flow";
import { WorkflowStore } from "./workflow";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const SID2 = "bbbbbbbb-1111-2222-3333-444444444444";
const flowWith = (text: string, trigger = "pr-created"): Flow => ({
  nodes: [
    { id: "t", x: 0, y: 0, kind: "trigger", trigger: trigger as "pr-created" },
    { id: "i", x: 0, y: 0, kind: "instruction", text },
  ],
  edges: [{ id: edgeId("t", "i"), from: "t", to: "i", kind: "then" }],
});

describe("WorkflowStore", () => {
  it("copies the default, or the picked template, into each new session once", () => {
    const home = mkdtempSync(join(tmpdir(), "wfs-"));
    const w = new WorkflowStore(home);
    w.saveTemplate("default", "Default", flowWith("Default note."));
    const tid = w.saveTemplate(
      null,
      "Quick fix",
      flowWith("Run the smoke test.", "after-push"),
    )!;
    expect(tid).toBe("quick-fix");
    w.setPending("fix-login", tid);
    expect(
      w.snapshot(
        [
          { sessionId: SID, name: "other" },
          { sessionId: SID2, name: "fix-login" },
        ],
        5,
      ),
    ).toBe(2);
    expect(w.sessionDoc(SID)?.from).toBe("Default");
    expect(w.sessionDoc(SID2)?.from).toBe("Quick fix");
    expect(w.compiledFor(SID2)[0].note).toContain("Run the smoke test.");
    // Editing the default later does not change a session's copy.
    w.saveTemplate("default", "Default", { nodes: [], edges: [] });
    expect(w.compiledFor(SID)[0].note).toContain("Default note.");
    expect(w.compiledFor("cccccccc-1111-2222-3333-444444444444")).toEqual([]);
    expect(
      new WorkflowStore(home).snapshot([{ sessionId: SID, name: "other" }]),
    ).toBe(0);
    expect(w.templates().map((t) => t.name)).toEqual(["Default", "Quick fix"]);
    expect(w.deleteTemplate("default")).toBe(false);
    expect(w.deleteTemplate(tid)).toBe(true);
  });
  it("rewrites files from before flows, keeping their steps and turning on every built-in", () => {
    const home = mkdtempSync(join(tmpdir(), "wfm-"));
    writeFileSync(
      join(home, "workflow.json"),
      JSON.stringify({
        steps: [
          {
            id: "note-1",
            trigger: "pr-created",
            kind: "instruction",
            skill: "",
            mode: "session",
            instructions: "Post the URL.",
          },
        ],
      }),
    );
    mkdirSync(join(home, "workflows", "sessions"), { recursive: true });
    writeFileSync(
      join(home, "workflows", "sessions", `${SID}.json`),
      JSON.stringify({ from: "Default", at: 1, steps: [] }),
    );
    new WorkflowStore(home).migrate();
    const def = JSON.parse(readFileSync(join(home, "workflow.json"), "utf8"));
    expect(
      def.flow.nodes.some((n: { text?: string }) => n.text === "Post the URL."),
    ).toBe(true);
    expect(def.steps[0].note).toContain("Post the URL.");
    expect(def.builtins.sort()).toEqual(["pr-review", "pr-watch", "ticket"]);
    const mine = JSON.parse(
      readFileSync(join(home, "workflows", "sessions", `${SID}.json`), "utf8"),
    );
    expect(mine.from).toBe("Default");
    expect(mine.builtins).toHaveLength(3);
  });
  it("keeps the last run of each session", () => {
    const home = mkdtempSync(join(tmpdir(), "wfr-"));
    const w = new WorkflowStore(home);
    expect(w.lastRun(SID)).toBeNull();
    w.logRun(SID, "idle", ["id-1"]);
    w.logRun(SID2, "needs-you", ["ny-1"]);
    w.logRun(SID, "needs-you", ["ny-2"]);
    expect(w.lastRun(SID)).toMatchObject({ trigger: "needs-you", ids: ["ny-2"] });
    expect(w.lastRun(SID2)?.trigger).toBe("needs-you");
  });
});

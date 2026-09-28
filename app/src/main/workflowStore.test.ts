import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIGGERS, triggerCommand, type CustomStep } from "@shared/workflow";
import { WorkflowStore } from "./workflow";

const step = (p: Partial<CustomStep>): CustomStep => ({
  id: "deploy-ab12",
  trigger: "pr-created",
  kind: "instruction",
  skill: "",
  mode: "session",
  instructions: "Post the preview URL.",
  ...p,
});
const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const SID2 = "bbbbbbbb-1111-2222-3333-444444444444";

describe("WorkflowStore", () => {
  it("copies the default, or the picked template, into each new session once", () => {
    const home = mkdtempSync(join(tmpdir(), "wfs-"));
    const w = new WorkflowStore(home);
    w.saveTemplate("default", "Default", [step({})]);
    const tid = w.saveTemplate(null, "Quick fix", [
      step({
        id: "qa-1",
        trigger: "after-push",
        instructions: "Run the smoke test.",
      }),
    ])!;
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
    expect(w.sessionDoc(SID)).toEqual({
      steps: [step({})],
      from: "Default",
      at: 5,
    });
    expect(w.sessionDoc(SID2)?.from).toBe("Quick fix");
    expect(w.sessionDoc(SID2)?.steps.map((s) => s.id)).toEqual(["qa-1"]);
    // Editing the default later does not change a session's copy.
    w.saveTemplate("default", "Default", []);
    expect(w.snapshot([{ sessionId: SID, name: "other" }])).toBe(0);
    expect(w.sessionDoc(SID)?.steps).toHaveLength(1);
    // A new store (restart) keeps copies that exist.
    expect(
      new WorkflowStore(home).snapshot([{ sessionId: SID, name: "other" }]),
    ).toBe(0);
    expect(w.templates().map((t) => t.name)).toEqual(["Default", "Quick fix"]);
    expect(w.deleteTemplate("default")).toBe(false);
    expect(w.deleteTemplate(tid)).toBe(true);
    expect(w.anySteps()).toBe(true); // SID's copy still has one
  });
});

describe.skipIf(process.platform === "win32")("trigger hooks", () => {
  it("hand each session its own workflow's steps, once", () => {
    const home = mkdtempSync(join(tmpdir(), "wft-"));
    const w = new WorkflowStore(home);
    w.saveTemplate("default", "Default", [
      step({ id: "def-1", instructions: "Default note." }),
    ]);
    w.saveSession(SID, {
      steps: [
        step({ id: "mine-1", instructions: "My note." }),
        step({ id: "mine-2", instructions: "Second." }),
      ],
      from: "Default",
      at: 1,
    });
    const t = TRIGGERS.find((x) => x.id === "pr-created")!;
    const run = (sid: string) =>
      execFileSync("bash", ["-c", triggerCommand(t, home)], {
        cwd: home,
        input: JSON.stringify({
          session_id: sid,
          tool_input: { command: "gh pr create --fill" },
          tool_response: { stdout: "https://github.com/o/r/pull/7" },
        }),
        env: { ...process.env, TMPDIR: home },
        encoding: "utf8",
      });
    const mine = JSON.parse(run(SID)).hookSpecificOutput.additionalContext;
    expect(mine).toContain("My note.");
    expect(mine).toContain("Second.");
    expect(mine).not.toContain("Default note.");
    expect(run(SID)).toBe("");
    // No copy yet: the default.
    expect(
      JSON.parse(run(SID2)).hookSpecificOutput.additionalContext,
    ).toContain("Default note.");
    // An empty copy: nothing.
    w.saveSession("cccccccc-1111-2222-3333-444444444444", {
      steps: [],
      from: null,
      at: 1,
    });
    expect(run("cccccccc-1111-2222-3333-444444444444")).toBe("");
    expect(
      existsSync(join(home, "workflow.json")) &&
        JSON.parse(readFileSync(join(home, "workflow.json"), "utf8")).steps[0]
          .note,
    ).toContain("Default note.");
  }, 20_000);
});

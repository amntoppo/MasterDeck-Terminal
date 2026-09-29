import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileFlow,
  customTriggerCommand,
  customTriggerProblems,
  edgeId,
  parseCustomTrigger,
  parseFlow,
  setCustomTriggers,
  triggerInfo,
  type Flow,
} from "./flow";

const migration = parseCustomTrigger({
  id: "migration-edit",
  name: "Migration edited",
  event: "PostToolUse",
  tool: "Edit|Write",
  field: "file",
  pattern: "migrations/.*\\.sql$",
  once: "session",
})!;
const testsFail = parseCustomTrigger({
  id: "tests-fail",
  name: "Tests failed",
  event: "PostToolUse",
  tool: "Bash",
  field: "command",
  pattern: "npm (run )?test",
  output: "FAIL",
  once: "always",
})!;
const flow: Flow = parseFlow({
  nodes: [
    { id: "m", kind: "trigger", trigger: "custom:migration-edit" },
    {
      id: "i",
      kind: "instruction",
      text: "Run the migration against a scratch database first.",
    },
    { id: "t", kind: "trigger", trigger: "custom:tests-fail" },
    {
      id: "j",
      kind: "instruction",
      text: "Read the failures before changing code.",
    },
  ],
  edges: [
    { id: edgeId("m", "i"), from: "m", to: "i", kind: "then" },
    { id: edgeId("t", "j"), from: "t", to: "j", kind: "then" },
  ],
});

afterEach(() => setCustomTriggers([]));

describe("custom triggers", () => {
  it("validates definitions", () => {
    expect(
      parseCustomTrigger({ id: "Bad Id", event: "PreToolUse" }),
    ).toBeNull();
    expect(parseCustomTrigger({ id: "x", event: "Nope" })).toBeNull();
    expect(customTriggerProblems({ ...migration, pattern: "(" })).toEqual([
      "migration-edit: pattern is not a valid regular expression",
    ]);
    expect(
      customTriggerProblems({
        ...migration,
        tool: "",
        pattern: "",
        output: "",
      })[0],
    ).toMatch(/every tool call/);
  });
  it("compiles with the definition inside the step; unknown ones are problems", () => {
    expect(compileFlow(flow).problems.map((p) => p.text)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Unknown trigger migration-edit/),
      ]),
    );
    setCustomTriggers([migration, testsFail]);
    const c = compileFlow(flow);
    expect(c.problems).toEqual([]);
    expect(c.steps.map((s) => [s.trigger, s.custom?.pattern])).toEqual([
      ["custom:migration-edit", "migrations/.*\\.sql$"],
      ["custom:tests-fail", "npm (run )?test"],
    ]);
    expect(triggerInfo("custom:tests-fail").label).toBe("Tests failed");
    // A draft's own triggers count too.
    setCustomTriggers([]);
    expect(compileFlow(flow, [migration, testsFail]).problems).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("custom trigger hooks", () => {
  it("match tool, file, command and output; honour once", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-"));
    const SID = "aaaaaaaa-1111-2222-3333-444444444444";
    mkdirSync(join(dir, "workflows", "sessions"), { recursive: true });
    writeFileSync(
      join(dir, "workflows", "sessions", `${SID}.json`),
      JSON.stringify(compileFlow(flow, [migration, testsFail])),
    );
    const cmd = customTriggerCommand("PostToolUse", dir, "m");
    const run = (input: object) =>
      execFileSync("bash", ["-c", cmd], {
        cwd: dir,
        input: JSON.stringify({ session_id: SID, ...input }),
        env: { ...process.env, TMPDIR: dir },
        encoding: "utf8",
      });
    const ctx = (out: string) =>
      out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
    expect(
      run({
        tool_name: "Read",
        tool_input: { file_path: "db/migrations/001.sql" },
      }),
    ).toBe("");
    expect(
      ctx(
        run({
          tool_name: "Edit",
          tool_input: { file_path: "db/migrations/001.sql" },
        }),
      ),
    ).toContain("scratch database");
    // Once per session.
    expect(
      run({
        tool_name: "Write",
        tool_input: { file_path: "db/migrations/002.sql" },
      }),
    ).toBe("");
    expect(
      run({
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "all passed" },
      }),
    ).toBe("");
    expect(
      ctx(
        run({
          tool_name: "Bash",
          tool_input: { command: "cd app && npm run test" },
          tool_response: { stdout: "FAIL src/a.test.ts" },
        }),
      ),
    ).toContain("Read the failures");
    // Every time.
    expect(
      ctx(
        run({
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          tool_response: { stdout: "FAIL again" },
        }),
      ),
    ).toContain("Read the failures");
  }, 20_000);
});

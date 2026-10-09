import { describe, expect, it } from "vitest";
import {
  builderContext,
  checkDraft,
  normalizeDraft,
  readDraftSkill,
} from "./flowBuilder";
import { paneCommand } from "./paneCommand";

describe("workflow builder drafts", () => {
  const draft = {
    name: "Tests after push",
    flow: {
      nodes: [
        { id: "Push Trigger", kind: "trigger", trigger: "after-push" },
        { id: "tests", kind: "instruction", text: "Run the test suite." },
        { id: "fix", kind: "instruction", text: "Fix and push again." },
      ],
      edges: [
        { source: "Push Trigger", target: "tests" },
        { from: "tests", to: "fix", kind: "fail" },
      ],
    },
  };
  it("makes ids safe, reads source/target, and lays out a draft without positions", () => {
    const { name, flow } = normalizeDraft(draft);
    expect(name).toBe("Tests after push");
    expect(flow.nodes.map((n) => n.id)).toEqual([
      "push-trigger",
      "tests",
      "fix",
    ]);
    expect(flow.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ["push-trigger", "tests", "then"],
      ["tests", "fix", "fail"],
    ]);
    expect(new Set(flow.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(3);
  });
  it("checks a draft: what sessions get, and what is wrong", () => {
    const good = checkDraft(draft);
    expect(good.ok).toBe(true);
    expect(good.plans[0].note).toMatch(
      /If it failed:\n\s+1\.1\. Fix and push again\./,
    );
    const bad = checkDraft({
      flow: {
        nodes: [
          ...draft.flow.nodes,
          { id: "x", kind: "nope" },
          { id: "lost", kind: "instruction", text: "hi" },
        ],
        edges: draft.flow.edges,
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.dropped[0]).toMatch(/1 block/);
    expect(
      bad.problems.some((p) =>
        p.startsWith("lost (instruction): Not connected"),
      ),
    ).toBe(true);
  });
  it("gives the builder the format, triggers and skills", () => {
    const md = builderContext(
      [
        {
          name: "superpowers:brainstorming",
          description: "Ideas first",
          source: "plugin superpowers",
        },
      ],
      { id: "default", name: "Default" },
    );
    expect(md).toContain("`command-after`");
    expect(md).toContain("`pr-watch`");
    expect(md).toContain("`superpowers:brainstorming`: Ideas first");
    expect(md).toContain("**Default**");
  });
  it("runs the builder as its own Claude session, without the user hooks", () => {
    expect(
      paneCommand(
        { kind: "builder", resume: true },
        "darwin",
        "/bin/zsh",
        "claude",
      ).args,
    ).toEqual([
      "--continue",
      "-n",
      "md-workflow-builder",
      "--setting-sources",
      "project,local",
      "--permission-mode",
      "acceptEdits",
    ]);
  });
  it("checks new triggers and skills the builder made", () => {
    const raw = {
      flow: {
        nodes: [
          { id: "mig", kind: "trigger", trigger: "custom:migration-edited" },
          {
            id: "chk",
            kind: "skill",
            skill: "check-migration",
            mode: "session",
            instructions: "",
          },
        ],
        edges: [{ from: "mig", to: "chk" }],
      },
      triggers: [
        {
          id: "migration-edited",
          name: "Migration edited",
          event: "PostToolUse",
          tool: "Edit|Write",
          field: "file",
          pattern: "migrations/.*\\.sql$",
          output: "",
          once: "session",
        },
      ],
    };
    const skill = readDraftSkill(
      "check-migration",
      "---\nname: check-migration\ndescription: Check a SQL migration before it ships\n---\n\n# Check\n\nRead the migration, look for locking changes and missing down steps, report.",
      1,
    );
    expect(skill.problems).toEqual([]);
    const ok = checkDraft(raw, {
      installedSkills: ["master"],
      skills: [skill],
    });
    expect(ok.ok).toBe(true);
    expect(ok.plans[0].trigger).toBe("custom:migration-edited");
    // No skill written: the block points at nothing.
    expect(
      checkDraft(raw, { installedSkills: ["master"] }).problems.join(),
    ).toMatch(/no skill named check-migration/);
    // A name that already exists is refused; a thin skill is flagged.
    expect(
      checkDraft(raw, {
        installedSkills: ["check-migration"],
        skills: [skill],
      }).problems.join(),
    ).toMatch(/already exists/);
    expect(
      readDraftSkill("Bad_Name", "hello", 1).problems.length,
    ).toBeGreaterThan(1);
    // A trigger no block uses is a note, not a problem.
    const extra = checkDraft(
      {
        ...raw,
        triggers: [...raw.triggers, { ...raw.triggers[0], id: "unused" }],
      },
      { installedSkills: [], skills: [skill] },
    );
    expect(extra.warnings.join()).toMatch(
      /unused is defined but no trigger block uses it/,
    );
  });
  describe("loops", () => {
    const loop = (members: string[], extra: Record<string, unknown> = {}) => ({
      id: "Green",
      kind: "loop",
      name: "Fix the tests",
      members,
      check: {
        command: "npm test",
        output: "",
        outputMode: "match",
        timeoutMin: 5,
      },
      agentDone: { on: false, goal: "" },
      limits: { iterations: 8, minutes: 0, stall: 3 },
      ...extra,
    });
    const base = [
      { id: "push", kind: "trigger", trigger: "after-push" },
      {
        id: "Read",
        kind: "instruction",
        text: "Run npm test, read what failed.",
      },
      { id: "fix", kind: "instruction", text: "Fix the cause, not the test." },
      {
        id: "stuck",
        kind: "instruction",
        text: "Tell the user what still fails.",
      },
    ];
    const edges = [
      { from: "push", to: "Green", kind: "then" },
      { from: "Read", to: "fix", kind: "then" },
      { from: "Green", to: "stuck", kind: "limit" },
    ];
    it("accepts a loop draft, its members following their safe ids", () => {
      const draft = {
        flow: { nodes: [...base, loop(["Read", "fix"])], edges },
      };
      const c = checkDraft(draft);
      expect(c.dropped).toEqual([]);
      expect(c.problems).toEqual([]);
      expect(c.ok).toBe(true);
      expect(c.plans[0].note).toMatch(
        /Repeat until the loop "Fix the tests" is done/,
      );
      const { flow } = normalizeDraft(draft);
      const l = flow.nodes.find((n) => n.kind === "loop");
      expect(l?.kind === "loop" && l.members).toEqual(["read", "fix"]);
      expect(flow.edges.find((e) => e.from === "green")?.kind).toBe("limit");
    });
    it("reports a member the format refuses instead of dropping it quietly", () => {
      const c = checkDraft({
        flow: {
          nodes: [
            ...base,
            loop(["Read", "fix", "push", "ghost"]),
            { id: "inner", kind: "loop", name: "Inner", members: [] },
            { id: "outer", kind: "loop", name: "Outer", members: ["inner"] },
          ],
          edges,
        },
      });
      expect(c.ok).toBe(false);
      expect(c.dropped).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /loop green: member push .*a trigger block can't repeat/,
          ),
          expect.stringMatching(/loop green: member ghost .*no such block/),
          expect.stringMatching(/loop outer: member inner .*no loop in a loop/),
        ]),
      );
    });
    it("reports met / limit out of a block that is not a loop", () => {
      const bad = checkDraft({
        flow: {
          nodes: [
            ...base,
            loop(["Read", "fix"]),
            { id: "more", kind: "instruction", text: "More." },
          ],
          edges: [...edges, { from: "stuck", to: "more", kind: "met" }],
        },
      });
      expect(bad.ok).toBe(false);
      expect(bad.dropped.join()).toMatch(
        /arrow stuck → more: "met" isn't allowed there, read as "then"/,
      );
    });
    it("passes on the loop problems the check finds", () => {
      const c = checkDraft({
        flow: {
          nodes: [...base, loop(["Read", "fix"], { check: { command: "" } })],
          edges,
        },
      });
      expect(c.problems).toContain(
        'green (loop): Loop "Fix the tests" needs a check command or the agent\'s goal',
      );
      const branch = checkDraft({
        flow: {
          nodes: [...base, loop(["Read", "fix"])],
          edges: [
            { from: "push", to: "stuck", kind: "then" },
            { from: "stuck", to: "Green", kind: "fail" },
            { from: "Read", to: "fix", kind: "then" },
          ],
        },
      });
      expect(branch.problems.join()).toMatch(
        /inside an "if it worked\/failed" branch/,
      );
      const turnEnd = checkDraft({
        flow: {
          nodes: [
            { id: "t", kind: "trigger", trigger: "turn-end" },
            ...base.slice(1),
            loop(["Read", "fix"]),
          ],
          edges: [
            { from: "t", to: "Green" },
            { from: "Read", to: "fix" },
          ],
        },
      });
      expect(turnEnd.problems.join()).toMatch(/would never end/);
    });
    it("tells the builder how loops work, with an example that checks clean", () => {
      const md = builderContext([], { id: "default", name: "Default" });
      expect(md).toContain("## Loops");
      expect(md).toContain(
        "No cycles: to repeat work use a loop node. Nothing points into a trigger",
      );
      expect(md).toContain("'met' | 'limit'");
      expect(md).toMatch(/no loop in a loop/);
      expect(md).toMatch(/LOOP DONE:/);
      expect(md).toMatch(/`iterations` 1-100 \(default 10\)/);
      const json = /```json\n([\s\S]*?)```/.exec(md.split("## Loops")[1])![1];
      const c = checkDraft(JSON.parse(json));
      expect(c.problems).toEqual([]);
      expect(c.dropped).toEqual([]);
      expect(c.ok).toBe(true);
    });
  });
});

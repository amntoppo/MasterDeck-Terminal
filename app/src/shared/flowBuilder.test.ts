import { describe, expect, it } from "vitest";
import { builderContext, checkDraft, normalizeDraft } from "./flowBuilder";
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
});

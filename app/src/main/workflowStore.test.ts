import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultFlow, edgeId, type Flow } from "@shared/flow";
import { BUILTIN_WORKFLOWS, type BuiltinWorkflow } from "@shared/builtinWorkflows";
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
  it("a loop's rounds are not the session's last workflow step", () => {
    const home = mkdtempSync(join(tmpdir(), "wfr-"));
    const w = new WorkflowStore(home);
    w.logRun(SID, "after-push", ["push-1"]);
    // What loop.sh logs for each round.
    appendFileSync(
      join(home, "workflows", "runs.jsonl"),
      JSON.stringify({ at: Date.now(), sid: SID, trigger: "loop", ids: "lp", iteration: 3, state: "open" }) + "\n",
    );
    expect(w.lastRun(SID)).toMatchObject({ trigger: "after-push", ids: ["push-1"] });
  });
  // The Default workflow hangs every built-in under its trigger, so every session on it gets
  // self-review, board moves and the PR watch; this test pins that.
  it("builtinsFor: the session copy decides; the default has every built-in", () => {
    const home = mkdtempSync(join(tmpdir(), "wfb-"));
    const w = new WorkflowStore(home);
    w.migrate();
    const sid = "33333333-3333-4333-8333-333333333333";
    expect(w.builtinsFor(sid).sort()).toEqual(["pr-review", "pr-watch", "ticket"]);
    const flow = defaultFlow();
    w.saveSession(sid, {
      flow: { ...flow, nodes: flow.nodes.filter((n) => !(n.kind === "builtin" && n.builtin === "pr-watch")) },
      from: null,
      at: null,
    });
    expect(w.builtinsFor(sid)).not.toContain("pr-watch");
  });

  describe("built-in workflows", () => {
    // Fixture built-ins, so these tests do not depend on the shipped flows.
    const ship = (id: string, text: string, name = id): BuiltinWorkflow => ({
      id,
      name,
      description: `About ${id}.`,
      whenToUse: `When ${id} fits.`,
      flow: flowWith(text),
    });
    const LIST = [
      ship("md-acme-one", "Do one.", "Acme one"),
      ship("md-acme-two", "Do two.", "Acme two"),
    ];
    const setup = () => {
      const home = mkdtempSync(join(tmpdir(), "wfbi-"));
      const w = new WorkflowStore(home);
      w.migrate();
      mkdirSync(join(home, "workflows", "templates"), { recursive: true });
      return { home, w, file: (id: string) => join(home, "workflows", "templates", `${id}.json`) };
    };
    const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
    const one = (w: WorkflowStore, list = LIST) => w.templates(list).find((x) => x.id === "md-acme-one")!;

    it("a fresh install gets every built-in, marked; a second launch writes nothing", () => {
      const { home, w, file } = setup();
      expect(w.seedBuiltins(LIST)).toBe(2);
      expect(read(file("md-acme-one")).builtin.id).toBe("md-acme-one");
      expect(one(w).name).toBe("Acme one");
      expect(one(w).builtin).toEqual({
        id: "md-acme-one",
        edited: false,
        updated: false,
        description: "About md-acme-one.",
        whenToUse: "When md-acme-one fits.",
      });
      expect(w.templates(LIST)[0].builtin).toBeUndefined(); // the Default
      const before = statSync(file("md-acme-one")).mtimeMs;
      expect(new WorkflowStore(home).seedBuiltins(LIST)).toBe(0);
      expect(statSync(file("md-acme-one")).mtimeMs).toBe(before);
    });

    it("an unedited built-in follows a changed shipped flow, keeping its name", () => {
      const { w } = setup();
      w.seedBuiltins(LIST);
      const next = [ship("md-acme-one", "Do one better.", "Acme one, v2"), LIST[1]];
      expect(w.seedBuiltins(next)).toBe(1);
      const t = one(w, next);
      expect(t.name).toBe("Acme one");
      expect(t.flow).toEqual(next[0].flow);
      expect(t.builtin).toMatchObject({ edited: false, updated: false });
    });

    it("an update keeps a renamed built-in's name; Restore original resets it", () => {
      const { w } = setup();
      w.seedBuiltins(LIST);
      w.saveTemplate("md-acme-one", "Our one", LIST[0].flow); // renamed, flow unedited
      const next = [ship("md-acme-one", "Do one better.", "Acme one, v2"), LIST[1]];
      expect(w.seedBuiltins(next)).toBe(1);
      expect(one(w, next).name).toBe("Our one");
      expect(one(w, next).flow).toEqual(next[0].flow);
      expect(one(w, next).builtin!.edited).toBe(false);
      expect(w.restoreBuiltin("md-acme-one", next)).toBe(true);
      expect(one(w, next).name).toBe("Acme one, v2");
    });

    it("an edited built-in is kept, and says when the shipped flow changed since", () => {
      const { w } = setup();
      w.seedBuiltins(LIST);
      const mine = flowWith("My own way.");
      expect(w.saveTemplate("md-acme-one", "Acme one", mine)).toBe("md-acme-one");
      expect(one(w).builtin).toMatchObject({ edited: true, updated: false });
      const next = [ship("md-acme-one", "Do one better."), LIST[1]];
      expect(w.seedBuiltins(next)).toBe(0);
      const t = one(w, next);
      expect(t.flow).toEqual(mine);
      expect(t.builtin).toMatchObject({ edited: true, updated: true });
    });

    it("formatting is not an edit; moving a block is", () => {
      const { w, file } = setup();
      w.seedBuiltins(LIST);
      const f = file("md-acme-one");
      writeFileSync(f, JSON.stringify(read(f))); // same content, no indentation
      expect(one(w).builtin!.edited).toBe(false);
      const moved = flowWith("Do one.");
      moved.nodes[1] = { ...moved.nodes[1], x: 290 };
      w.saveTemplate("md-acme-one", "Acme one", moved);
      expect(one(w).builtin!.edited).toBe(true);
    });

    it("never touches a file at a built-in's id without the mark", () => {
      const { w, file } = setup();
      mkdirSync(join(file("x"), ".."), { recursive: true });
      const text = JSON.stringify({ name: "Mine", flow: flowWith("Mine.") });
      writeFileSync(file("md-acme-one"), text);
      // A mark naming another id is no mark either (a hand-made copy).
      const other = JSON.stringify({
        name: "Copy",
        flow: flowWith("Copy."),
        builtin: { id: "md-acme-one", hash: "x" },
      });
      writeFileSync(file("md-acme-two"), other);
      expect(w.seedBuiltins(LIST)).toBe(0);
      expect(readFileSync(file("md-acme-one"), "utf8")).toBe(text);
      expect(readFileSync(file("md-acme-two"), "utf8")).toBe(other);
      expect(w.templates(LIST).every((t) => !t.builtin)).toBe(true);
      expect(w.restoreBuiltin("md-acme-one", LIST)).toBe(false);
      expect(w.restoreBuiltin("md-acme-two", LIST)).toBe(false);
      expect(readFileSync(file("md-acme-one"), "utf8")).toBe(text);
      // Deleting it records nothing: it was never a built-in.
      expect(w.deleteTemplate("md-acme-one")).toBe(true);
      expect(existsSync(w.builtinsFile)).toBe(false);
    });

    it("a mark naming no shipped built-in is a plain template", () => {
      const { w } = setup();
      w.seedBuiltins(LIST);
      expect(w.templates([LIST[1]]).find((x) => x.id === "md-acme-one")!.builtin).toBeUndefined();
    });

    it("a deleted built-in stays deleted; restore one, restore all", () => {
      const { w, file, home } = setup();
      w.seedBuiltins(LIST);
      expect(w.deleteTemplate("md-acme-one")).toBe(true);
      expect(w.deleteTemplate("md-acme-two")).toBe(true);
      expect(read(w.builtinsFile).removed.sort()).toEqual(["md-acme-one", "md-acme-two"]);
      expect(new WorkflowStore(home).seedBuiltins(LIST)).toBe(0);
      expect(existsSync(file("md-acme-one"))).toBe(false);
      expect(w.builtinsRemoved(LIST).sort()).toEqual(["md-acme-one", "md-acme-two"]);

      expect(w.restoreBuiltin("md-acme-one", LIST)).toBe(true);
      expect(one(w).builtin!.edited).toBe(false);
      expect(w.builtinsRemoved(LIST)).toEqual(["md-acme-two"]);

      expect(w.restoreBuiltin(null, LIST)).toBe(true);
      expect(read(w.builtinsFile).removed).toEqual([]);
      expect(w.builtinsRemoved(LIST)).toEqual([]);
      expect(existsSync(file("md-acme-two"))).toBe(true);
      expect(w.restoreBuiltin(null, LIST)).toBe(false);
      expect(w.restoreBuiltin("md-nobody", LIST)).toBe(false);
    });

    it("restore original writes an edited, renamed built-in back as shipped", () => {
      const { w } = setup();
      w.seedBuiltins(LIST);
      w.saveTemplate("md-acme-one", "Renamed", flowWith("Mine."));
      expect(w.restoreBuiltin("md-acme-one", LIST)).toBe(true);
      const t = one(w);
      expect(t.name).toBe("Acme one");
      expect(t.flow).toEqual(LIST[0].flow);
      expect(t.builtin!.edited).toBe(false);
    });

    it("deleting a plain template records nothing", () => {
      const { w } = setup();
      const id = w.saveTemplate(null, "Acme chores", flowWith("Chores."))!;
      expect(w.deleteTemplate(id)).toBe(true);
      expect(existsSync(w.builtinsFile)).toBe(false);
    });

    it("renaming keeps the mark; a duplicate has none", () => {
      const { w, file } = setup();
      w.seedBuiltins(LIST);
      const mark = read(file("md-acme-one")).builtin;
      w.saveTemplate("md-acme-one", "Acme one, mine", LIST[0].flow);
      expect(read(file("md-acme-one")).builtin).toEqual(mark);
      expect(one(w).name).toBe("Acme one, mine");
      expect(one(w).builtin).toMatchObject({ id: "md-acme-one", edited: false });
      const copy = w.saveTemplate(null, "Acme one (copy)", one(w).flow)!;
      expect(copy).not.toBe("md-acme-one");
      expect(read(file(copy)).builtin).toBeUndefined();
      expect(w.templates(LIST).find((x) => x.id === copy)!.builtin).toBeUndefined();
    });

    it("the shipped built-ins seed and read back unedited", () => {
      const { w } = setup();
      expect(w.seedBuiltins()).toBe(BUILTIN_WORKFLOWS.length);
      const marked = w.templates().filter((t) => t.builtin);
      expect(marked.map((t) => t.id)).toEqual(BUILTIN_WORKFLOWS.map((b) => b.id).sort());
      expect(marked.every((t) => !t.builtin!.edited)).toBe(true);
      expect(w.seedBuiltins()).toBe(0);
      // A new template never takes a built-in's id.
      expect(w.saveTemplate(null, BUILTIN_WORKFLOWS[0].id, flowWith("x."))).not.toBe(BUILTIN_WORKFLOWS[0].id);
    });

    it("reads a broken builtins.json as nothing removed", () => {
      const { w } = setup();
      writeFileSync(w.builtinsFile, "{not json");
      expect(w.seedBuiltins(LIST)).toBe(2);
      writeFileSync(w.builtinsFile, JSON.stringify({ removed: [1, "a/b", "md-acme-two"] }));
      expect(w.builtinsRemoved(LIST)).toEqual([]); // md-acme-two is on disk
    });
  });
});

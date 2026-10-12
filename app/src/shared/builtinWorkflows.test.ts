import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILTIN_WORKFLOWS,
  builtinById,
  flowHash,
  type BuiltinWorkflow,
} from "./builtinWorkflows";
import { compileFlow, parseFlow, type FlowNode } from "./flow";
import { CHECK_PASSED } from "./loopHook";

type LoopNode = Extract<FlowNode, { kind: "loop" }>;
const loops = (b: BuiltinWorkflow): LoopNode[] =>
  b.flow.nodes.filter((n): n is LoopNode => n.kind === "loop");
const loopOf = (id: string): LoopNode => loops(builtinById(id)!)[0];

describe("the built-in workflows", () => {
  it("are the five, in order, with their names", () => {
    expect(BUILTIN_WORKFLOWS.map((b) => [b.id, b.name])).toEqual([
      ["md-superpowers", "Superpowers"],
      ["md-ticket-to-pr", "Ticket to PR"],
      ["md-bug-fix", "Bug fix"],
      ["md-tdd", "TDD (locked tests)"],
      ["md-ci-doctor", "CI doctor"],
    ]);
  });

  it("have unique ids that fit the md- prefix and the template id rule", () => {
    const ids = BUILTIN_WORKFLOWS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^md-[a-z0-9-]+$/);
      // WorkflowStore's rule for a template's file id.
      expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
  });

  it("say what each is and when to use it, in one sentence each", () => {
    for (const b of BUILTIN_WORKFLOWS)
      for (const s of [b.description, b.whenToUse]) {
        expect(s.trim().length, b.id).toBeGreaterThan(5);
        expect(s.match(/\.(\s|$)/g)?.length, `${b.id}: ${s}`).toBe(1);
      }
  });

  it("finds one by id", () => {
    expect(builtinById("md-tdd")?.name).toBe("TDD (locked tests)");
    expect(builtinById("tdd")).toBeUndefined();
  });

  describe.each(BUILTIN_WORKFLOWS.map((b) => [b.id, b] as const))(
    "%s",
    (_id, b) => {
      it("parses back exactly as written (nothing dropped or clamped)", () => {
        expect(parseFlow(JSON.parse(JSON.stringify(b.flow)))).toEqual(b.flow);
      });

      it("compiles with no problems", () => {
        expect(compileFlow(b.flow).problems).toEqual([]);
      });

      it("keeps MasterDeck's three built-ins under their triggers and a needs-you notify", () => {
        const { builtins, steps } = compileFlow(b.flow);
        expect([...builtins].sort()).toEqual(["pr-review", "pr-watch", "ticket"]);
        const under = (builtin: string) =>
          b.flow.edges.find(
            (e) => e.to === `b-${builtin}`,
          )?.from;
        expect(under("ticket")).toBe("t-linked");
        expect(under("pr-review")).toBe("t-before-pr");
        expect(under("pr-watch")).toBe("t-pr-created");
        expect(
          steps.find((s) => s.trigger === "needs-you")?.notify?.length,
        ).toBe(1);
      });

      it("has loops with a goal and limits", () => {
        expect(loops(b).length).toBe(1);
        for (const l of loops(b)) {
          expect(l.agentDone.on).toBe(true);
          expect(l.agentDone.goal.trim()).not.toBe("");
          expect(l.limits.iterations).toBeGreaterThan(0);
          expect(l.limits.stall).toBeGreaterThan(0);
          expect(l.members.length).toBeGreaterThan(0);
        }
      });

      it("uses only skills MasterDeck ships", () => {
        for (const n of b.flow.nodes)
          if (n.kind === "skill") expect(n.skill).toBe("babysit-worktree");
      });

      it("says never to push to main or master wherever it pushes", () => {
        for (const n of b.flow.nodes) {
          if (n.kind !== "instruction") continue;
          const pushes = /\bpush(?! notification)\b|gh pr create|create a PR/i;
          if (pushes.test(n.text) && !/^Don't/.test(n.text))
            expect(n.text, n.id).toMatch(/never push to main or master/i);
        }
      });
    },
  );

  it("loop limits follow the spec", () => {
    const lim = (id: string) => loopOf(id).limits;
    expect(lim("md-superpowers")).toEqual({ iterations: 15, minutes: 0, stall: 3 });
    expect(lim("md-ticket-to-pr")).toEqual({ iterations: 10, minutes: 0, stall: 3 });
    expect(lim("md-bug-fix")).toEqual({ iterations: 8, minutes: 0, stall: 3 });
    expect(lim("md-tdd")).toEqual({ iterations: 15, minutes: 0, stall: 3 });
    expect(lim("md-ci-doctor")).toEqual({ iterations: 5, minutes: 0, stall: 2 });
    expect(loopOf("md-ci-doctor").check.timeoutMin).toBe(2);
  });

  it("Superpowers names Superpowers' skills in text only, and has no ui-screenshots", () => {
    const sp = builtinById("md-superpowers")!;
    const text = JSON.stringify(sp.flow);
    expect(text).not.toContain("ui-screenshots");
    expect(text).toContain("superpowers:brainstorming");
    // Every block that names a superpowers skill says what to do without it.
    for (const n of sp.flow.nodes)
      if (n.kind === "instruction" && n.text.includes("superpowers:"))
        expect(n.text, n.id).toMatch(/isn't installed/);
  });

  it("CI doctor's loop runs after a push", () => {
    const ci = builtinById("md-ci-doctor")!;
    const loop = loopOf("md-ci-doctor");
    expect(ci.flow.edges.find((e) => e.to === loop.id)?.from).toBe("t-after-push");
  });
});

describe("flowHash", () => {
  const flow = builtinById("md-bug-fix")!.flow;
  it("is stable and ignores key order and formatting", () => {
    const shuffled = JSON.parse(
      JSON.stringify(flow),
      (_k, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
    );
    expect(flowHash(flow)).toBe(flowHash(flow));
    expect(flowHash(shuffled)).toBe(flowHash(flow));
  });
  it("changes when a block moves or its text changes", () => {
    const moved = {
      ...flow,
      nodes: flow.nodes.map((n, i) => (i === 3 ? { ...n, x: n.x + 10 } : n)),
    };
    const reworded = {
      ...flow,
      nodes: flow.nodes.map((n) =>
        n.kind === "instruction" && n.id === "reproduce"
          ? { ...n, text: n.text + " Quickly." }
          : n,
      ),
    };
    expect(flowHash(moved)).not.toBe(flowHash(flow));
    expect(flowHash(reworded)).not.toBe(flowHash(flow));
  });
  it("differs between the built-ins", () => {
    const all = BUILTIN_WORKFLOWS.map((b) => flowHash(b.flow));
    expect(new Set(all).size).toBe(all.length);
  });
});

// The check commands, run as the loop hook runs them (`sh -c` in the session's folder).
const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "md-builtin-"));
  tmps.push(d);
  return d;
};
// No global or system git config (signing, hooks): the user's machine never shapes the result.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "acme",
  GIT_AUTHOR_EMAIL: "dev@acme.test",
  GIT_COMMITTER_NAME: "acme",
  GIT_COMMITTER_EMAIL: "dev@acme.test",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" }).toString();
const run = (cwd: string, command: string, env: NodeJS.ProcessEnv = GIT_ENV) => {
  const r = spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8" });
  return { exit: r.status, out: `${r.stdout}${r.stderr}` };
};

describe.skipIf(process.platform === "win32")(
  "TDD's check: the tests: commit is unchanged",
  { timeout: 20_000 },
  () => {
    const guard = loopOf("md-tdd").check.command;
    it("passes on the exit code alone", () => {
      expect(loopOf("md-tdd").check.output).toBe("");
      expect(guard).toContain("git log --grep='^tests:'");
    });

    it("fails without a tests: commit, passes after it, fails when a test changes", () => {
      const r = tmp();
      git(r, "init", "-q", "-b", "work");
      mkdirSync(join(r, "src"));
      mkdirSync(join(r, "test"));
      writeFileSync(join(r, "src", "parse.js"), "export const parse = () => null;\n");
      git(r, "add", "-A");
      git(r, "commit", "-qm", "Start acme parser");
      expect(run(r, guard).exit).toBe(1);

      writeFileSync(join(r, "test", "parse.test.js"), "expect(parse('1')).toBe(1);\n");
      writeFileSync(join(r, "test", "edge.test.js"), "expect(parse('')).toBe(null);\n");
      git(r, "add", "-A");
      git(r, "commit", "-qm", "tests: the acme parser's cases");
      expect(run(r, guard).exit).toBe(0);

      // An implementation change, uncommitted and then committed: the tests are untouched.
      writeFileSync(join(r, "src", "parse.js"), "export const parse = (s) => (s ? Number(s) : null);\n");
      expect(run(r, guard).exit).toBe(0);
      git(r, "commit", "-qam", "Parse numbers");
      expect(run(r, guard).exit).toBe(0);

      // A test edited in the working tree only.
      const t = join(r, "test", "parse.test.js");
      const before = readFileSync(t, "utf8");
      writeFileSync(t, "// skipped\n");
      expect(run(r, guard).exit).toBe(1);
      writeFileSync(t, before);
      expect(run(r, guard).exit).toBe(0);

      // A test edit committed.
      writeFileSync(t, "expect(parse('1')).toBeTruthy();\n");
      git(r, "commit", "-qam", "Loosen a test");
      expect(run(r, guard).exit).toBe(1);
    });

    it("fails when a test file is deleted", () => {
      const r = tmp();
      git(r, "init", "-q", "-b", "work");
      writeFileSync(join(r, "a.test.js"), "expect(1).toBe(1);\n");
      git(r, "add", "-A");
      git(r, "commit", "-qm", "tests: acme case");
      expect(run(r, guard).exit).toBe(0);
      unlinkSync(join(r, "a.test.js"));
      expect(run(r, guard).exit).toBe(1);
    });

    it("guards the newest tests: commit", () => {
      const r = tmp();
      git(r, "init", "-q", "-b", "work");
      writeFileSync(join(r, "a.test.js"), "a\n");
      git(r, "add", "-A");
      git(r, "commit", "-qm", "tests: first acme cases");
      writeFileSync(join(r, "b.test.js"), "b\n");
      git(r, "add", "-A");
      git(r, "commit", "-qm", "tests: a gap the review found");
      expect(run(r, guard).exit).toBe(0);
      writeFileSync(join(r, "b.test.js"), "changed\n");
      expect(run(r, guard).exit).toBe(1);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "CI doctor's check: the newest run of this commit succeeded",
  { timeout: 20_000 },
  () => {
    const loop = loopOf("md-ci-doctor");
    // A stand-in gh: logs its arguments and answers with $FAKE_RUNS through its --jq filter, as
    // gh itself does.
    const setup = () => {
      const r = tmp();
      git(r, "init", "-q", "-b", "fix-ci");
      writeFileSync(join(r, "README.md"), "acme\n");
      git(r, "add", "-A");
      git(r, "commit", "-qm", "Start");
      const bin = join(r, ".bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "gh"),
        [
          "#!/bin/bash",
          'printf \'%s\\n\' "$*" >> "$GH_LOG"',
          'q="."; while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done',
          'printf \'%s\' "$FAKE_RUNS" | jq -r "$q"',
          "",
        ].join("\n"),
      );
      chmodSync(join(bin, "gh"), 0o755);
      return { r, bin, log: join(r, "gh.log") };
    };
    // The hook's verdict: CHECK_PASSED over the output, as loop.sh computes it.
    const verdict = (exit: number, out: string): boolean =>
      execFileSync(
        "jq",
        [
          "-Rs",
          "--argjson", "exit", String(exit),
          "--arg", "output", loop.check.output,
          "--arg", "mode", loop.check.outputMode,
          "--arg", "re", loop.check.output,
          `{exit: $exit, out: ., output: $output, mode: $mode} | ${CHECK_PASSED.replace(/\n/g, " ")}`,
        ],
        { input: out },
      ).toString().trim() === "true";

    it.each([
      [[{ status: "completed", conclusion: "success" }], "completed success", true],
      [[{ status: "completed", conclusion: "failure" }], "completed failure", false],
      [[{ status: "in_progress", conclusion: null }], "in_progress null", false],
      [[{ status: "in_progress", conclusion: "" }], "in_progress ", false],
      [[], "null null", false],
    ])("%j prints %j: passed %s", (runs, printed, passes) => {
      const { r, bin, log } = setup();
      const res = run(r, loop.check.command, {
        ...GIT_ENV,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_RUNS: JSON.stringify(runs),
        GH_LOG: log,
      });
      expect(res.exit).toBe(0);
      expect(res.out).toBe(`${printed}\n`);
      expect(new RegExp(loop.check.output, "m").test(res.out)).toBe(passes);
      expect(verdict(res.exit ?? 1, res.out)).toBe(passes);
      // It asks about this commit's run.
      const head = git(r, "rev-parse", "HEAD").trim();
      expect(readFileSync(log, "utf8")).toContain(`run list --commit ${head} --limit 1`);
    });

    it("fails when gh does", () => {
      const { r } = setup();
      const bin = join(r, ".fail");
      mkdirSync(bin);
      writeFileSync(join(bin, "gh"), "#!/bin/bash\necho 'gh: not logged in' >&2\nexit 4\n");
      chmodSync(join(bin, "gh"), 0o755);
      const res = run(r, loop.check.command, {
        ...GIT_ENV,
        PATH: `${bin}:${process.env.PATH}`,
      });
      expect(res.exit).toBe(4);
      expect(verdict(res.exit ?? 1, res.out)).toBe(false);
    });
  },
);

/**
 * The workflows MasterDeck ships (#104): seeded into every install's templates with a mark, so
 * they can be picked, copied, edited and restored. The flows live as JSON next to this file
 * (readable and diffable; a flow edited on the canvas can be pasted back as it is).
 */
import { parseFlow, type Flow } from "./flow";
import superpowers from "./builtin-workflows/md-superpowers.json";
import ticketToPr from "./builtin-workflows/md-ticket-to-pr.json";
import bugFix from "./builtin-workflows/md-bug-fix.json";
import tdd from "./builtin-workflows/md-tdd.json";
import ciDoctor from "./builtin-workflows/md-ci-doctor.json";

export interface BuiltinWorkflow {
  /** The template's file id: `md-` and lowercase letters, digits, dashes. */
  id: string;
  name: string;
  /** One sentence: what it does. */
  description: string;
  /** One sentence: when to pick it. */
  whenToUse: string;
  flow: Flow;
}

// JSON imports type their strings as string, not the literal unions Flow needs; the tests check
// that parseFlow keeps every flow exactly as written.
const asFlow = (json: { flow: unknown }): Flow => json.flow as Flow;

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  {
    id: "md-superpowers",
    name: "Superpowers",
    description:
      "Brainstorm a design with you, write a plan of small tasks, build it test first until the suite passes, get a review, then open the PR.",
    whenToUse:
      "A feature or change big enough to design first, where you answer questions at the start and approve the plan.",
    flow: asFlow(superpowers),
  },
  {
    id: "md-ticket-to-pr",
    name: "Ticket to PR",
    description:
      "Read the issue and the code, write a short plan, build with tests until the checks pass, get a second-opinion review, then open the PR.",
    whenToUse:
      "A well-described ticket of ordinary size that needs no design session.",
    flow: asFlow(ticketToPr),
  },
  {
    id: "md-bug-fix",
    name: "Bug fix",
    description:
      "Reproduce the bug, pin it with a failing test, name the root cause, make the smallest fix until the test and suite pass, then open the PR.",
    whenToUse: "A bug report.",
    flow: asFlow(bugFix),
  },
  {
    id: "md-tdd",
    name: "TDD (locked tests)",
    description:
      "Write the tests first and commit them alone, then implement until they pass while MasterDeck checks the tests stay unchanged.",
    whenToUse:
      "Behaviour you can state as inputs and outputs, such as a function, an API or a parser.",
    flow: asFlow(tdd),
  },
  {
    id: "md-ci-doctor",
    name: "CI doctor",
    description:
      "After each push, wait for CI, read the failing logs and fix the root cause, until the run of the latest commit succeeds.",
    whenToUse:
      "A branch whose CI should be green before review, where the session pushes and then waits for CI itself.",
    flow: asFlow(ciDoctor),
  },
];

export const builtinById = (id: string): BuiltinWorkflow | undefined =>
  BUILTIN_WORKFLOWS.find((b) => b.id === id);

/**
 * A flow's fingerprint: over the parsed flow, so formatting and dropped junk never count as an
 * edit, while moving a block does.
 */
export function flowHash(flow: Flow): string {
  return cyrb53(JSON.stringify(parseFlow(flow)));
}

/** JSON with every object's keys sorted: the same value always gives the same text. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * A flow's fingerprint exactly as written, without parseFlow (key order and formatting aside). A
 * built-in's mark keeps it as `raw`, so a later parseFlow that reads the same file differently
 * never makes an unedited built-in look edited.
 */
export function rawFlowHash(flow: unknown): string {
  return cyrb53(stableJson(flow));
}

/** A built-in's mark in its template file: which one it is, and the written flow's hashes. */
export interface BuiltinMark {
  id: string;
  /** flowHash of the flow written. */
  hash: string;
  /** rawFlowHash of the flow written; marks written before it have none. */
  raw?: string;
}

/** The mark of a built-in written as shipped. */
export const markFor = (
  b: BuiltinWorkflow,
  hash: (f: Flow) => string = flowHash,
): BuiltinMark => ({ id: b.id, hash: hash(b.flow), raw: rawFlowHash(b.flow) });

/**
 * Whether a flow, as read from its file (not parsed), is still the one its mark was written with:
 * the raw hash matches, or the parsed one does (all an older mark has). The one rule for "edited".
 */
export function sameAsMark(
  mark: BuiltinMark,
  rawFlow: unknown,
  hash: (f: Flow) => string = flowHash,
): boolean {
  if (mark.raw && rawFlowHash(rawFlow) === mark.raw) return true;
  return hash(parseFlow(rawFlow)) === mark.hash;
}

/** cyrb53 (53 bits): no crypto module, so it runs in the renderer too. */
function cyrb53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

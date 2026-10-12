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
 * edit, while moving a block does. cyrb53 (53 bits): no crypto module, so it runs in the
 * renderer too.
 */
export function flowHash(flow: Flow): string {
  const s = JSON.stringify(parseFlow(flow));
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

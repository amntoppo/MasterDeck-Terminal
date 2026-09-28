import { describe, expect, it } from "vitest";
import { flowActions } from "./flowWatch";
import type { CompiledStep } from "./flow";

const steps: CompiledStep[] = [
  { id: "ny-1", trigger: "needs-you", note: "", notify: ["Look at it"] },
  {
    id: "id-1",
    trigger: "idle",
    minutes: 10,
    note: "1. Check CI and continue.",
    notify: ["Idle"],
  },
];
const MIN = 60_000;

describe("flowActions", () => {
  it("fires needs-you once per spell, and idle after its minutes", () => {
    let r = flowActions(
      {},
      [{ key: "a", status: "needs-input" }],
      () => steps,
      0,
    );
    expect(r.actions).toEqual([
      { key: "a", step: "ny-1", notify: ["Look at it"], message: null },
    ]);
    r = flowActions(
      r.next,
      [{ key: "a", status: "question" }],
      () => steps,
      MIN,
    );
    expect(r.actions).toEqual([]);
    r = flowActions(
      r.next,
      [{ key: "a", status: "idle" }],
      () => steps,
      2 * MIN,
    );
    expect(r.actions).toEqual([]);
    r = flowActions(
      r.next,
      [{ key: "a", status: "idle" }],
      () => steps,
      12 * MIN,
    );
    expect(r.actions).toEqual([
      {
        key: "a",
        step: "id-1",
        notify: ["Idle"],
        message: "1. Check CI and continue.",
      },
    ]);
    r = flowActions(
      r.next,
      [{ key: "a", status: "idle" }],
      () => steps,
      30 * MIN,
    );
    expect(r.actions).toEqual([]);
    // Working again, then waiting: a new spell.
    r = flowActions(
      r.next,
      [{ key: "a", status: "working" }],
      () => steps,
      31 * MIN,
    );
    r = flowActions(
      r.next,
      [{ key: "a", status: "needs-input" }],
      () => steps,
      32 * MIN,
    );
    expect(r.actions.map((a) => a.step)).toEqual(["ny-1"]);
  });
});

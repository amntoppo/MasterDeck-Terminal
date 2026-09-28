import { describe, expect, it } from "vitest";
import { canStop, cleanupDefaults } from "./cleanup";
import type { PrStage } from "./review";
import type { Session } from "./types";

const sess = (key: string, o: Partial<Session> = {}) =>
  ({
    key,
    name: key,
    kind: "background",
    bgId: `b${key}`,
    pid: null,
    state: "idle",
    ...o,
  }) as unknown as Session;
const stage = (kind: PrStage["kind"]) =>
  ({ kind, prs: [1], why: "" }) as unknown as PrStage;

describe("cleanup", () => {
  it("stops background sessions by id and others by pid, not parked or done ones", () => {
    expect(canStop(sess("a"))).toBe(true);
    expect(
      canStop(
        sess("b", {
          kind: "interactive",
          bgId: null,
          pid: 42,
        } as Partial<Session>),
      ),
    ).toBe(true);
    expect(
      canStop(
        sess("c", { kind: "interactive", bgId: null } as Partial<Session>),
      ),
    ).toBe(false);
    expect(canStop(sess("d", { state: "suspended" } as Partial<Session>))).toBe(
      false,
    );
    expect(canStop(sess("e", { state: "done" } as Partial<Session>))).toBe(
      false,
    );
  });
  it("selects merged sessions by default", () => {
    const list = [
      sess("a"),
      sess("b"),
      sess("c", { state: "suspended" } as Partial<Session>),
      sess("d"),
    ];
    expect([
      ...cleanupDefaults(list, {
        a: stage("merged"),
        b: stage("rework"),
        c: stage("merged"),
        d: undefined,
      }),
    ]).toEqual(["a"]);
  });
});

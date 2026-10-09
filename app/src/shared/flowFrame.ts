/**
 * The Loop frame on the canvas (#82): which blocks sit in a frame, what moving or resizing it
 * does, and which arrows may start or end at it. Pure, so the editor and its tests agree with
 * `parseFlow`'s rules (a member's arrows stay in its frame; an arrow into a member enters the
 * frame; met / limit leave a frame only).
 */
import {
  BLOCK_H,
  BLOCK_W,
  edgeId,
  frameOf,
  LOOP_MEMBER_KINDS,
  makesCycle,
  type EdgeKind,
  type Flow,
  type FlowEdge,
  type FlowNode,
} from "./flow";
import { loopLast, type LoopView } from "./loops";

export type LoopNode = Extract<FlowNode, { kind: "loop" }>;

/** How far right of a frame a block that may not be in it is put back. */
const OUT_GAP = 40;

/** A block's box: a frame's own size, else a block's. */
const box = (n: FlowNode) =>
  n.kind === "loop"
    ? { x: n.x, y: n.y, w: n.w, h: n.h }
    : { x: n.x, y: n.y, w: BLOCK_W, h: BLOCK_H };

/** Whether a block sits in a frame: its centre inside the frame's box. */
export function insideFrame(node: FlowNode, frame: LoopNode): boolean {
  const b = box(node);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return (
    cx >= frame.x &&
    cx <= frame.x + frame.w &&
    cy >= frame.y &&
    cy <= frame.y + frame.h
  );
}

/** Whether a block may repeat in a frame (no triggers, built-ins or loops). */
export const canJoinFrame = (n: FlowNode): boolean =>
  (LOOP_MEMBER_KINDS as readonly string[]).includes(n.kind);

/** The smallest other frame a block sits in. */
function frameAt(flow: Flow, n: FlowNode): LoopNode | undefined {
  return flow.nodes
    .filter((f): f is LoopNode => f.kind === "loop" && f.id !== n.id)
    .filter((f) => insideFrame(n, f))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
}

/** A frame and its members moved together. */
export function moveFrame(
  flow: Flow,
  frameId: string,
  dx: number,
  dy: number,
): Flow {
  const f = flow.nodes.find((n) => n.id === frameId);
  if (f?.kind !== "loop" || (!dx && !dy)) return flow;
  const moving = new Set([frameId, ...f.members]);
  return {
    ...flow,
    nodes: flow.nodes.map((n) =>
      moving.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
    ),
  };
}

/**
 * The arrow kind an arrow from a block of this kind gets: a frame leaves through met / limit
 * (the toolbar's "if it worked / failed" become "when met / at the limit"), a block never does.
 */
export function edgeKindFrom(
  fromKind: FlowNode["kind"] | undefined,
  kind: EdgeKind,
): EdgeKind {
  if (fromKind === "trigger") return "then";
  if (fromKind === "loop")
    return kind === "ok" ? "met" : kind === "fail" ? "limit" : kind;
  return kind === "met" ? "ok" : kind === "limit" ? "fail" : kind;
}

/** The arrow kinds offered from a block of this kind. */
export const framedEdgeKinds = (
  fromKind: FlowNode["kind"] | undefined,
): EdgeKind[] =>
  fromKind === "loop" ? ["then", "met", "limit"] : ["then", "ok", "fail"];

/**
 * Where an arrow drawn from→to goes: into a member from outside its frame, to the frame (a loop
 * starts at its top); out of a member to outside its frame, nowhere (leave through met / limit).
 */
export function frameArrow(
  flow: Flow,
  from: string,
  to: string,
): { from: string; to: string } | { refuse: string } {
  const frame = frameOf(flow);
  const fromF = frame.get(from);
  const toF = frame.get(to);
  if (fromF && fromF !== toF)
    return {
      refuse:
        'A block in a loop leads only to blocks in it: leave the loop with its "when met" or "at the limit" arrow',
    };
  if (toF === from)
    return { refuse: "A loop starts at its first block: no arrow needed" };
  return { from, to: toF && toF !== fromF ? toF : to };
}

/**
 * The arrows after a frame's members changed, by `parseFlow`'s rules: a member's arrow out of its
 * frame is dropped, an arrow into a member from outside enters the frame, kinds fit their start
 * (met / limit from a frame only), and an arrow that now closes a cycle is dropped.
 */
export function frameEdges(flow: Flow): Flow {
  const frame = frameOf(flow);
  const kindOf = new Map(flow.nodes.map((n) => [n.id, n.kind]));
  const kept: FlowEdge[] = [];
  for (const e of flow.edges) {
    const fromF = frame.get(e.from);
    let to = e.to;
    if (fromF && frame.get(to) !== fromF) continue;
    const toF = frame.get(to);
    if (toF && toF !== fromF) to = toF;
    if (e.from === to || kept.some((k) => k.from === e.from && k.to === to))
      continue;
    if (makesCycle({ nodes: flow.nodes, edges: kept }, e.from, to)) continue;
    const kind = edgeKindFrom(kindOf.get(e.from), e.kind);
    kept.push(
      to === e.to && kind === e.kind
        ? e
        : { id: edgeId(e.from, to), from: e.from, to, kind },
    );
  }
  return { ...flow, edges: kept };
}

/**
 * After a block was dropped (dragged or added) where it now is: it joins the frame it sits in and
 * leaves the one it left. A trigger, a built-in or a loop never goes in a frame: it is put back
 * just right of it, with a note why; a frame put down takes in the blocks under it. Arrows
 * follow (`frameEdges`).
 */
export function membersAfterDrop(
  flow: Flow,
  nodeId: string,
): { flow: Flow; note: string | null } {
  const n = flow.nodes.find((x) => x.id === nodeId);
  if (!n) return { flow, note: null };
  const into = frameAt(flow, n);
  if (into && !canJoinFrame(n)) {
    const dx = into.x + into.w + OUT_GAP - n.x;
    const moved =
      n.kind === "loop"
        ? moveFrame(flow, n.id, dx, 0)
        : {
            ...flow,
            nodes: flow.nodes.map((x) =>
              x.id === n.id ? { ...x, x: x.x + dx } : x,
            ),
          };
    return {
      flow: moved,
      note:
        n.kind === "loop"
          ? "A loop can't go inside another loop"
          : n.kind === "trigger"
            ? "A trigger starts a workflow: it can't repeat in a loop"
            : "A built-in runs by itself: it can't repeat in a loop",
    };
  }
  // A frame put down over blocks takes them in, as a resize does.
  if (n.kind === "loop") return arrowsNote(flow, refitFrame(flow, n.id));
  if (!canJoinFrame(n)) return { flow, note: null };
  const was = frameOf(flow).get(n.id);
  if (was === into?.id) return { flow, note: null };
  return arrowsNote(
    flow,
    frameEdges({
      ...flow,
      nodes: flow.nodes.map((x) =>
        x.kind !== "loop"
          ? x
          : x.id === into?.id
            ? { ...x, members: [...x.members, n.id] }
            : x.id === was
              ? { ...x, members: x.members.filter((m) => m !== n.id) }
              : x,
      ),
    }),
  );
}

/** The changed flow, with a note when arrows had to go (so a drop never loses one unseen). */
function arrowsNote(
  before: Flow,
  after: Flow,
): { flow: Flow; note: string | null } {
  return {
    flow: after,
    note:
      after.edges.length < before.edges.length
        ? "Some arrows were removed: blocks in a loop lead only to each other, and the loop leaves through its own arrows"
        : null,
  };
}

/**
 * After a frame was resized: the blocks now in its box are its members, those left outside are
 * not. A block in another frame stays there.
 */
export function refitFrame(flow: Flow, frameId: string): Flow {
  const f = flow.nodes.find((n) => n.id === frameId);
  if (f?.kind !== "loop") return flow;
  const frame = frameOf(flow);
  const members = flow.nodes
    .filter(
      (n) =>
        canJoinFrame(n) &&
        insideFrame(n, f) &&
        (frame.get(n.id) ?? frameId) === frameId,
    )
    .map((n) => n.id);
  // Kept in the frame's order; new ones after.
  const next = [
    ...f.members.filter((m) => members.includes(m)),
    ...members.filter((m) => !f.members.includes(m)),
  ];
  if (
    next.length === f.members.length &&
    next.every((m, i) => m === f.members[i])
  )
    return flow;
  return frameEdges({
    ...flow,
    nodes: flow.nodes.map((n) =>
      n.id === frameId ? { ...n, members: next } : n,
    ),
  });
}

/** What ends a loop, short, for its frame's header. */
export function frameCriterion(n: LoopNode): string {
  const cmd = n.check.command.trim();
  const check = !cmd
    ? ""
    : n.check.output
      ? `${cmd} ${n.check.outputMode === "no-match" ? "stops matching" : "matches"} ${n.check.output}`
      : `${cmd} passes`;
  const done = n.agentDone.on ? "the agent says done" : "";
  return [check, done].filter(Boolean).join(" and ") || "nothing set";
}

/** The frame's header: name, what ends it, its iteration limit. */
export const frameHeader = (n: LoopNode): string =>
  `↻ ${n.name} · until ${frameCriterion(n)} · max ${n.limits.iterations}`;

/** A session's loop on its frame: the round it is at, or how it ended. */
export function frameLive(v: LoopView): string {
  if (v.state === "open") return `${v.iteration}/${v.max} · ${loopLast(v)}`;
  if (v.state === "met") return `done · ${v.iteration}/${v.max}`;
  if (v.state === "limit") return v.reason ?? "stopped at a limit";
  return v.reason ?? "stopped";
}

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type EdgeChange,
} from "@xyflow/react";
import { load as loadPref, save as savePref } from "../deck";
import "@xyflow/react/dist/style.css";
import {
  BUILTINS,
  builtinInfo,
  compileFlow,
  EDGE_LABEL,
  edgeId,
  FLOW_TRIGGERS,
  layoutFlow,
  makesCycle,
  newNodeId,
  triggerInfo,
  type BuiltinId,
  type EdgeKind,
  type Flow,
  type FlowNode,
  type FlowTrigger,
} from "@shared/flow";

export type Skill = { name: string; description: string; source?: string };

/** Skills by where they come from: yours, synced, then each plugin and each project. */
export function skillGroups(
  skills: Skill[],
): { key: string; label: string; skills: Skill[] }[] {
  const order = (k: string) =>
    k === "yours" ? 0 : k === "synced" ? 1 : k.startsWith("plugin ") ? 2 : 3;
  const by = new Map<string, Skill[]>();
  for (const s of skills) {
    const k = s.source ?? "yours";
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  const label = (k: string) =>
    k === "yours"
      ? "Your skills"
      : k === "synced"
        ? "Synced"
        : k.startsWith("plugin ")
          ? `Plugin · ${k.slice(7)}`
          : `Project · ${k.slice(8)}`;
  return [...by]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([key, list]) => ({ key, label: label(key), skills: list }));
}

/** A plugin skill's name without its plugin (the group says which). */
const shortSkill = (s: Skill): string =>
  s.source?.startsWith("plugin ")
    ? s.name.slice(s.name.indexOf(":") + 1)
    : s.name;

/** What a palette item drops on the canvas. */
type Drop =
  | { kind: "trigger"; trigger: FlowTrigger }
  | { kind: "builtin"; builtin: BuiltinId }
  | { kind: "skill"; skill: string }
  | { kind: "instruction" }
  | { kind: "notify" };

/** The palette's default width (px). */
const PAL_W = 176;

const DRAG_TYPE = "application/x-masterdeck-block";

function makeNode(d: Drop, x: number, y: number): FlowNode {
  const id = newNodeId();
  switch (d.kind) {
    case "trigger":
      return {
        id,
        x,
        y,
        kind: "trigger",
        trigger: d.trigger,
        ...(d.trigger === "idle" ? { minutes: 15 } : {}),
        ...(d.trigger.startsWith("command") ? { pattern: "" } : {}),
      };
    case "builtin":
      return { id, x, y, kind: "builtin", builtin: d.builtin };
    case "skill":
      return {
        id,
        x,
        y,
        kind: "skill",
        skill: d.skill,
        mode: "background",
        instructions: "",
      };
    case "instruction":
      return { id, x, y, kind: "instruction", text: "" };
    case "notify":
      return { id, x, y, kind: "notify", text: "" };
  }
}

type BlockData = {
  node: FlowNode;
  problem: string | null;
  readOnly: boolean;
  onDelete: (id: string) => void;
};

const KIND_LABEL: Record<FlowNode["kind"], string> = {
  trigger: "When",
  skill: "Skill",
  instruction: "Instruction",
  notify: "Notify",
  builtin: "Built-in",
};

function blockTitle(n: FlowNode): string {
  switch (n.kind) {
    case "trigger":
      return triggerInfo(n.trigger).short;
    case "skill":
      return n.skill || "Pick a skill";
    case "instruction":
      return n.text.trim() || "Write the instruction";
    case "notify":
      return n.text.trim() || "Write the notification";
    case "builtin":
      return builtinInfo(n.builtin).label;
  }
}

function blockSub(n: FlowNode): string | null {
  if (n.kind === "trigger")
    return n.trigger === "idle"
      ? `for ${n.minutes ?? 15} min`
      : n.pattern !== undefined
        ? n.pattern || "set a pattern"
        : null;
  if (n.kind === "skill")
    return `${n.mode === "background" ? "background subagent" : "in the session"}${n.instructions.trim() ? ` · ${n.instructions.trim()}` : ""}`;
  if (n.kind === "builtin") return "runs from its own hook";
  return null;
}

/** One block on the canvas. */
const Block = memo(function Block({
  data,
  selected,
}: NodeProps<Node<BlockData>>) {
  const n = data.node;
  return (
    <div
      className={`fb fb-${n.kind} ${selected ? "sel" : ""} ${data.problem ? "bad" : ""}`}
      title={data.problem ?? undefined}
    >
      {n.kind !== "trigger" && (
        <Handle type="target" position={Position.Left} className="fh" />
      )}
      <div className="fb-kind">
        {KIND_LABEL[n.kind]}
        {data.problem && <span className="fb-warn">!</span>}
        {!data.readOnly && (
          <button
            className="fb-x nodrag"
            title="Remove"
            aria-label="Remove block"
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete(n.id);
            }}
          >
            ×
          </button>
        )}
      </div>
      <div className="fb-title">{blockTitle(n)}</div>
      {blockSub(n) && <div className="fb-sub">{blockSub(n)}</div>}
      <Handle type="source" position={Position.Right} className="fh" />
    </div>
  );
});

const EDGE_COLOR: Record<EdgeKind, string> = {
  then: "var(--accent)",
  ok: "var(--green)",
  fail: "var(--red)",
};

/** An arrow: "then" solid; outcome arrows dashed, green or red, with their label. */
function Arrow(p: EdgeProps<Edge<{ kind: EdgeKind }>>) {
  const kind = p.data?.kind ?? "then";
  const [path, lx, ly] = getSmoothStepPath({ ...p, borderRadius: 10 });
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        markerEnd={p.markerEnd}
        style={{
          stroke: EDGE_COLOR[kind],
          strokeWidth: p.selected ? 3 : 2,
          strokeDasharray: kind === "then" ? undefined : "6 4",
        }}
        interactionWidth={18}
      />
      {kind !== "then" && (
        <EdgeLabelRenderer>
          <div
            className={`fe-label fe-${kind}`}
            style={{
              transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
            }}
          >
            {EDGE_LABEL[kind]}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { block: Block };
const edgeTypes = { arrow: Arrow };

interface Props {
  flow: Flow;
  onChange?: (flow: Flow) => void;
  skills: Skill[];
  readOnly?: boolean;
  /** Shown above the canvas on the right (Save state, buttons). */
  toolbar?: React.ReactNode;
}

/**
 * The workflow editor: drag triggers, built-ins, skills, instructions and notifications from the
 * palette, join them with arrows (then / if it worked / if it failed), and edit a block or arrow
 * on the right. With nothing selected the right side shows what sessions will be told, and what
 * is wrong. `readOnly`: the canvas alone.
 */
export function FlowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ flow: initial, onChange, skills, readOnly, toolbar }: Props) {
  const [flow, setFlowRaw] = useState<Flow>(initial);
  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(
    null,
  );
  // The arrow kind new connections get.
  const [arrowKind, setArrowKind] = useState<EdgeKind>("then");
  const [note, setNote] = useState<string | null>(null);
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const changed = useRef(false);

  const setFlow = useCallback((f: Flow | ((f: Flow) => Flow)) => {
    changed.current = true;
    setFlowRaw(f);
  }, []);
  // Tell the parent after each change (not for the flow it handed in).
  useEffect(() => {
    if (changed.current) onChange?.(flow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);
  const flash = (m: string) => {
    setNote(m);
    setTimeout(() => setNote((c) => (c === m ? null : c)), 3000);
  };

  const compiled = useMemo(() => compileFlow(flow), [flow]);
  const problemOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of compiled.problems)
      if (p.node && !m.has(p.node)) m.set(p.node, p.text);
    return m;
  }, [compiled]);

  const remove = useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      setFlow((f) => ({
        nodes: f.nodes.filter((n) => !gone.has(n.id)),
        edges: f.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
      }));
      setSel((s) => (s && gone.has(s.id) ? null : s));
    },
    [setFlow],
  );

  const nodes: Node<BlockData>[] = useMemo(
    () =>
      flow.nodes.map((n) => ({
        id: n.id,
        type: "block",
        position: { x: n.x, y: n.y },
        selected: sel?.type === "node" && sel.id === n.id,
        data: {
          node: n,
          problem: problemOf.get(n.id) ?? null,
          readOnly: !!readOnly,
          onDelete: (id: string) => remove([id]),
        },
      })),
    [flow.nodes, sel, problemOf, readOnly, remove],
  );
  const edges: Edge<{ kind: EdgeKind }>[] = useMemo(
    () =>
      flow.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "arrow",
        selected: sel?.type === "edge" && sel.id === e.id,
        data: { kind: e.kind },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: EDGE_COLOR[e.kind],
          width: 18,
          height: 18,
        },
      })),
    [flow.edges, sel],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<BlockData>>[]) => {
      const moves = new Map<string, { x: number; y: number }>();
      for (const c of changes) {
        if (c.type === "position" && c.position) moves.set(c.id, c.position);
        if (c.type === "select" && c.selected)
          setSel({ type: "node", id: c.id });
      }
      const removed = changes
        .filter((c) => c.type === "remove")
        .map((c) => c.id);
      if (removed.length) remove(removed);
      if (moves.size)
        setFlow((f) => ({
          ...f,
          nodes: f.nodes.map((n) =>
            moves.has(n.id)
              ? {
                  ...n,
                  x: Math.round(moves.get(n.id)!.x),
                  y: Math.round(moves.get(n.id)!.y),
                }
              : n,
          ),
        }));
    },
    [remove, setFlow],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes)
        if (c.type === "select" && c.selected)
          setSel({ type: "edge", id: c.id });
      const removed = new Set(
        changes.filter((c) => c.type === "remove").map((c) => c.id),
      );
      if (removed.size)
        setFlow((f) => ({
          ...f,
          edges: f.edges.filter((e) => !removed.has(e.id)),
        }));
    },
    [setFlow],
  );
  const connect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const target = flow.nodes.find((n) => n.id === c.target);
      if (target?.kind === "trigger")
        return flash("A trigger starts a workflow: nothing points into it");
      if (flow.edges.some((e) => e.from === c.source && e.to === c.target))
        return;
      if (makesCycle(flow, c.source, c.target))
        return flash("That arrow would make a loop");
      const fromTrigger =
        flow.nodes.find((n) => n.id === c.source)?.kind === "trigger";
      const kind: EdgeKind = fromTrigger ? "then" : arrowKind;
      setFlow((f) => ({
        ...f,
        edges: [
          ...f.edges,
          {
            id: edgeId(c.source!, c.target!),
            from: c.source!,
            to: c.target!,
            kind,
          },
        ],
      }));
    },
    [flow, arrowKind, setFlow],
  );

  const add = (d: Drop, at?: { x: number; y: number }) => {
    if (
      d.kind === "builtin" &&
      flow.nodes.some((n) => n.kind === "builtin" && n.builtin === d.builtin)
    )
      return flash("That built-in is already in the workflow");
    // Clicked (not dropped): after the selected block, joined to it; else in free space below.
    const after =
      !at && d.kind !== "trigger" && sel?.type === "node"
        ? flow.nodes.find((n) => n.id === sel.id)
        : undefined;
    let x: number;
    let y: number;
    if (at) {
      x = at.x - 90;
      y = at.y - 30;
    } else if (after) {
      const kids = flow.edges.filter((e) => e.from === after.id).length;
      x = after.x + 260;
      y = after.y + kids * 100;
    } else {
      x =
        d.kind === "trigger" ? Math.min(0, ...flow.nodes.map((n) => n.x)) : 260;
      y =
        (flow.nodes.length ? Math.max(...flow.nodes.map((n) => n.y)) : -110) +
        110;
    }
    const n = makeNode(d, Math.round(x), Math.round(y));
    const kind: EdgeKind = after?.kind === "trigger" ? "then" : arrowKind;
    setFlow((f) => ({
      nodes: [...f.nodes, n],
      edges: after
        ? [
            ...f.edges,
            { id: edgeId(after.id, n.id), from: after.id, to: n.id, kind },
          ]
        : f.edges,
    }));
    setSel({ type: "node", id: n.id });
    setTimeout(
      () =>
        rf.fitView({
          nodes: [{ id: n.id }],
          maxZoom: rf.getZoom(),
          minZoom: rf.getZoom(),
          duration: 250,
        }),
      30,
    );
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    add(
      JSON.parse(raw) as Drop,
      rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    );
  };

  const update = (id: string, patch: Partial<FlowNode>) =>
    setFlow((f) => ({
      ...f,
      nodes: f.nodes.map((n) =>
        n.id === id ? ({ ...n, ...patch } as FlowNode) : n,
      ),
    }));
  const setEdgeKind = (id: string, kind: EdgeKind) =>
    setFlow((f) => ({
      ...f,
      edges: f.edges.map((e) => (e.id === id ? { ...e, kind } : e)),
    }));
  const tidy = () => {
    setFlow((f) => layoutFlow(f));
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 300 }), 50);
  };

  const selNode =
    sel?.type === "node" ? flow.nodes.find((n) => n.id === sel.id) : undefined;
  const selEdge =
    sel?.type === "edge" ? flow.edges.find((e) => e.id === sel.id) : undefined;
  const dark = useDark();
  // The palette's width, dragged at its right edge (remembered; double-click resets).
  const [palW, setPalW] = useState<number>(() =>
    loadPref<number>("flowPalW", PAL_W),
  );
  useEffect(() => savePref("flowPalW", palW), [palW]);
  const edRef = useRef<HTMLDivElement>(null);
  const dragPal = (e: React.MouseEvent) => {
    e.preventDefault();
    const left = edRef.current?.getBoundingClientRect().left ?? 0;
    const move = (ev: MouseEvent) =>
      setPalW(Math.round(Math.min(Math.max(ev.clientX - left, 140), 420)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      ref={edRef}
      className={`flow-ed ${readOnly ? "ro" : ""}`}
      style={
        readOnly
          ? undefined
          : ({ "--pal-w": `${palW}px` } as React.CSSProperties)
      }
    >
      {!readOnly && (
        <div
          className="fp-resize"
          style={{ left: palW - 3 }}
          onMouseDown={dragPal}
          onDoubleClick={() => setPalW(PAL_W)}
          title="Drag to resize the blocks list · double-click to reset"
          role="separator"
          aria-orientation="vertical"
        />
      )}
      {!readOnly && (
        <Palette flow={flow} skills={skills} onAdd={(d) => add(d)} />
      )}
      <div className="flow-main">
        {!readOnly && (
          <div className="flow-tools">
            <span className="flow-tl">New arrows</span>
            <div
              className="seg flow-kinds"
              role="radiogroup"
              aria-label="Kind of new arrows"
            >
              {(["then", "ok", "fail"] as EdgeKind[]).map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={arrowKind === k}
                  className={`${arrowKind === k ? "on" : ""} k-${k}`}
                  onClick={() => setArrowKind(k)}
                  title={
                    k === "then"
                      ? "Do the next block after this one"
                      : `Follow this arrow ${EDGE_LABEL[k]} (outcome arrows start from an action, not a trigger)`
                  }
                >
                  {EDGE_LABEL[k]}
                </button>
              ))}
            </div>
            <button
              className="btn"
              onClick={tidy}
              title="Line the blocks up: each trigger on a row, what follows to the right"
            >
              Tidy up
            </button>
            <button
              className="btn"
              onClick={() => rf.fitView({ padding: 0.15, duration: 300 })}
            >
              Fit
            </button>
            {note && <span className="flow-note">{note}</span>}
            <span style={{ flex: 1 }} />
            {compiled.problems.length > 0 && (
              <button
                className="flow-problems"
                title={compiled.problems.map((p) => p.text).join("\n")}
                onClick={() => {
                  // Step through the blocks with a problem.
                  const ids = compiled.problems
                    .map((p) => p.node)
                    .filter((x): x is string => !!x);
                  if (!ids.length) return;
                  const i = sel?.type === "node" ? ids.indexOf(sel.id) : -1;
                  setSel({ type: "node", id: ids[(i + 1) % ids.length] });
                }}
              >
                {compiled.problems.length} problem
                {compiled.problems.length === 1 ? "" : "s"}
              </button>
            )}
            {toolbar}
          </div>
        )}
        <div
          className="flow-canvas"
          ref={wrap}
          onDragOver={(e) => (
            e.preventDefault(),
            (e.dataTransfer.dropEffect = "copy")
          )}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : connect}
            onPaneClick={() => setSel(null)}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable={!readOnly}
            deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            colorMode={dark ? "dark" : "light"}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.2}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {/* The selected block or arrow's settings: a card over the canvas, only while selected. */}
          {!readOnly && (selNode || selEdge) && (
            <div className="flow-pop" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className="flow-pop-x"
                onClick={() => setSel(null)}
                aria-label="Close"
                title="Close (click the canvas)"
              >
                ×
              </button>
              {selNode ? (
                <NodeForm
                  key={selNode.id}
                  node={selNode}
                  skills={skills}
                  problem={problemOf.get(selNode.id) ?? null}
                  onChange={(p) => update(selNode.id, p)}
                  onDelete={() => remove([selNode.id])}
                />
              ) : selEdge ? (
                <EdgeForm
                  edge={selEdge}
                  fromTrigger={
                    flow.nodes.find((n) => n.id === selEdge.from)?.kind ===
                    "trigger"
                  }
                  onKind={(k) => setEdgeKind(selEdge.id, k)}
                  onDelete={() => (
                    setFlow((f) => ({
                      ...f,
                      edges: f.edges.filter((e) => e.id !== selEdge.id),
                    })),
                    setSel(null)
                  )}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function useDark(): boolean {
  const q = () => {
    const t = document.documentElement.dataset.theme;
    return (
      t === "dark" ||
      (t !== "light" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
    );
  };
  const [dark, setDark] = useState(q);
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(q());
    m.addEventListener("change", on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      m.removeEventListener("change", on);
      mo.disconnect();
    };
  }, []);
  return dark;
}

/** The blocks to drag in (or click to add in the middle). */
function Palette({
  flow,
  skills,
  onAdd,
}: {
  flow: Flow;
  skills: Skill[];
  onAdd: (d: Drop) => void;
}) {
  const [q, setQ] = useState("");
  const item = (
    d: Drop,
    label: string,
    cls: string,
    title?: string,
    disabled = false,
  ) => (
    <button
      key={label}
      className={`fp-item ${cls}`}
      draggable={!disabled}
      disabled={disabled}
      title={`${title ? `${title}\n` : ""}Drag onto the canvas, or click to add (after the selected block, joined to it)`}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(d));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAdd(d)}
    >
      {label}
    </button>
  );
  const needle = q.trim().toLowerCase();
  const [open, setOpen] = useState<Set<string>>(() => new Set(["yours"]));
  const shown = skills.filter(
    (s) =>
      !needle ||
      s.name.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle),
  );
  return (
    <aside className="flow-pal" aria-label="Blocks">
      <div className="fp-sec">Triggers</div>
      {FLOW_TRIGGERS.map((t) =>
        item(
          { kind: "trigger", trigger: t.id },
          t.short,
          "fp-trigger",
          `${t.label}. ${t.hint}`,
        ),
      )}
      <div className="fp-sec">Actions</div>
      {item(
        { kind: "instruction" },
        "Instruction",
        "fp-instruction",
        "Text the session is told at this point, as it is",
      )}
      {item(
        { kind: "notify" },
        "Notify me",
        "fp-notify",
        "A desktop notification (after Needs you or Idle)",
      )}
      <div className="fp-sec">Built-ins</div>
      {BUILTINS.map((b) =>
        item(
          { kind: "builtin", builtin: b.id },
          b.label,
          "fp-builtin",
          b.what,
          flow.nodes.some((n) => n.kind === "builtin" && n.builtin === b.id),
        ),
      )}
      <div className="fp-sec">Skills</div>
      <input
        className="fp-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${skills.length} skills`}
        aria-label="Search skills"
      />
      <div className="fp-skills">
        {skillGroups(shown).map((g) => {
          // Searching opens every group with a match.
          const on = !!needle || open.has(g.key);
          return (
            <div key={g.key} className="fp-group">
              <button
                className={`fp-ghead ${on ? "on" : ""}`}
                aria-expanded={on}
                onClick={() =>
                  setOpen((o) => {
                    const n = new Set(o);
                    if (n.has(g.key)) n.delete(g.key);
                    else n.add(g.key);
                    return n;
                  })
                }
              >
                <span className="fp-caret">{on ? "▾" : "▸"}</span>
                <span className="fp-glabel">{g.label}</span>
                <span className="fp-gcount">{g.skills.length}</span>
              </button>
              {on && (
                <div className="fp-gbody">
                  {g.skills.map((s) =>
                    item(
                      { kind: "skill", skill: s.name },
                      shortSkill(s),
                      "fp-skill",
                      `${s.name}${s.description ? `: ${s.description}` : ""}`,
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!shown.length && <div className="fp-empty">No skill matches.</div>}
      </div>
    </aside>
  );
}

function NodeForm({
  node: n,
  skills,
  problem,
  onChange,
  onDelete,
}: {
  node: FlowNode;
  skills: Skill[];
  problem: string | null;
  onChange: (p: Partial<FlowNode>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="fs-form">
      <div className="fs-head">
        <span className={`fs-chip fb-${n.kind}`}>{KIND_LABEL[n.kind]}</span>
        <span style={{ flex: 1 }} />
        <button className="btn danger" onClick={onDelete}>
          Remove
        </button>
      </div>
      {problem && <div className="fs-problem">{problem}</div>}
      {n.kind === "trigger" && (
        <>
          <label>Trigger</label>
          <select
            className="fsel full"
            value={n.trigger}
            onChange={(e) =>
              onChange({
                trigger: e.target.value as FlowTrigger,
                ...(e.target.value === "idle"
                  ? { minutes: n.minutes ?? 15 }
                  : {}),
                ...(e.target.value.startsWith("command")
                  ? { pattern: n.pattern ?? "" }
                  : {}),
              })
            }
          >
            {FLOW_TRIGGERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="meta">{triggerInfo(n.trigger).hint}</div>
          {(n.trigger === "command-before" ||
            n.trigger === "command-after") && (
            <>
              <label>Command pattern</label>
              <input
                className="fs-input mono"
                value={n.pattern ?? ""}
                placeholder="e.g. npm (run )?test"
                onChange={(e) => onChange({ pattern: e.target.value })}
              />
              <div className="meta">
                A regular expression, matched anywhere in the Bash command.
              </div>
            </>
          )}
          {n.trigger === "idle" && (
            <>
              <label>Idle for (minutes)</label>
              <input
                className="fs-input"
                type="number"
                min={1}
                max={1440}
                value={n.minutes ?? 15}
                onChange={(e) =>
                  onChange({
                    minutes: Math.max(
                      1,
                      Math.min(1440, Number(e.target.value) || 15),
                    ),
                  })
                }
              />
            </>
          )}
        </>
      )}
      {n.kind === "skill" && (
        <>
          <label>Skill</label>
          <select
            className="fsel full"
            value={n.skill}
            onChange={(e) => onChange({ skill: e.target.value })}
          >
            <option value="">Choose a skill…</option>
            {n.skill && !skills.some((s) => s.name === n.skill) && (
              <option value={n.skill}>{n.skill} (not installed)</option>
            )}
            {skillGroups(skills).map((g) => (
              <optgroup key={g.key} label={g.label}>
                {g.skills.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {skills.find((s) => s.name === n.skill)?.description && (
            <div className="meta">
              {skills.find((s) => s.name === n.skill)!.description}
            </div>
          )}
          <label>How it runs</label>
          <div className="seg">
            <button
              className={n.mode === "background" ? "on" : ""}
              onClick={() => onChange({ mode: "background" })}
            >
              Background subagent
            </button>
            <button
              className={n.mode === "session" ? "on" : ""}
              onClick={() => onChange({ mode: "session" })}
            >
              In the session
            </button>
          </div>
          <label>Extra instructions</label>
          <textarea
            className="fs-text"
            value={n.instructions}
            placeholder="e.g. deploy to staging, then post the URL on the issue"
            onChange={(e) => onChange({ instructions: e.target.value })}
          />
        </>
      )}
      {n.kind === "instruction" && (
        <>
          <label>What the session is told</label>
          <textarea
            className="fs-text tall"
            autoFocus
            value={n.text}
            placeholder="e.g. Post the preview URL in the PR description."
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </>
      )}
      {n.kind === "notify" && (
        <>
          <label>Notification text</label>
          <input
            className="fs-input"
            autoFocus
            value={n.text}
            placeholder="e.g. Check the deploy"
            onChange={(e) => onChange({ text: e.target.value })}
          />
          <div className="meta">
            Shown as a desktop notification; clicking it opens the session.
          </div>
        </>
      )}
      {n.kind === "builtin" && (
        <div className="meta">
          {builtinInfo(n.builtin).what} Remove it to turn it off for sessions
          using this workflow; its hook then skips them.
        </div>
      )}
      <div className="meta fs-tip">
        Drag from the dot on the right of a block to another block to add an
        arrow. Select a block or arrow and press Delete to remove it.
      </div>
    </div>
  );
}

function EdgeForm({
  edge,
  fromTrigger,
  onKind,
  onDelete,
}: {
  edge: { kind: EdgeKind };
  fromTrigger: boolean;
  onKind: (k: EdgeKind) => void;
  onDelete: () => void;
}) {
  return (
    <div className="fs-form">
      <div className="fs-head">
        <span className="fs-chip">Arrow</span>
        <span style={{ flex: 1 }} />
        <button className="btn danger" onClick={onDelete}>
          Remove
        </button>
      </div>
      <label>Follow it</label>
      <div className="seg flow-kinds vertical">
        {(["then", "ok", "fail"] as EdgeKind[]).map((k) => (
          <button
            key={k}
            className={`${edge.kind === k ? "on" : ""} k-${k}`}
            disabled={fromTrigger && k !== "then"}
            onClick={() => onKind(k)}
          >
            {k === "then" ? "Then (always, next)" : EDGE_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="meta">
        {fromTrigger
          ? 'Arrows from a trigger start the plan: always "then".'
          : "Outcome arrows: the session follows the one that matches how the step went. Several arrows of the same kind run side by side."}
      </div>
    </div>
  );
}

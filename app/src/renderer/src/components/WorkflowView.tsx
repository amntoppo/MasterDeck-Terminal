import { useCallback, useEffect, useRef, useState } from "react";
import type { HookEntry } from "@shared/workflow";
import {
  actionCount,
  DEFAULT_TEMPLATE,
  type Flow,
  type WorkflowTemplate,
} from "@shared/flow";
import type { AppState } from "@shared/types";
import { deck } from "../deck";
import { FlowEditor, type Skill } from "./FlowEditor";

type Data = {
  hooks: HookEntry[];
  skills: Skill[];
  templates: WorkflowTemplate[];
};

const SOURCE: Record<HookEntry["source"], string> = {
  user: "your settings",
  project: "project",
  plugin: "plugin",
};

function whereLabel(h: HookEntry): string {
  return h.source === "user"
    ? SOURCE.user
    : `${SOURCE[h.source]} ${h.where ?? ""}`.trim();
}

/** A command, short: what runs, without the shell plumbing. */
function short(c: string): string {
  const one = c.replace(/\s+/g, " ").trim();
  return one.length > 110 ? `${one.slice(0, 110)}…` : one;
}

export type SaveState = "idle" | "saving" | "saved" | { error: string };

/** Save a flow shortly after the last change (drags and typing make many). */
export function useAutosave(
  save: (f: Flow) => Promise<{ ok: boolean; message: string }>,
): [SaveState, (f: Flow) => void] {
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(save);
  latest.current = save;
  const pending = useRef<Flow | null>(null);
  const flush = useCallback(async () => {
    const f = pending.current;
    if (!f) return;
    pending.current = null;
    setState("saving");
    const r = await latest.current(f);
    setState(r.ok ? "saved" : { error: r.message });
  }, []);
  // Anything not saved yet goes out when the editor closes.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );
  return [
    state,
    (f: Flow) => {
      pending.current = f;
      setState("saving");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 600);
    },
  ];
}

export function SaveBadge({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  if (typeof state === "object")
    return <span className="save-badge bad">{state.error}</span>;
  return (
    <span className={`save-badge ${state}`}>
      {state === "saving" ? "Saving…" : "Saved"}
    </span>
  );
}

/**
 * The Workflow window: the Default (what every new session copies) and the templates, each edited
 * on the canvas; on demand, every hook Claude Code runs. A session's own copy is edited from its
 * Workflow panel (Terminals), with the same editor.
 */
export function WorkflowView(_: { state: AppState }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tid, setTid] = useState<string>(DEFAULT_TEMPLATE);
  const [naming, setNaming] = useState<{
    mode: "new" | "rename";
    name: string;
  } | null>(null);
  const [showHooks, setShowHooks] = useState(false);

  const load = useCallback(async () => {
    const w = await deck().workflowGet();
    setData({ hooks: w.hooks, skills: w.skills, templates: w.templates });
  }, []);
  useEffect(() => void load(), [load]);

  const templates = data?.templates ?? [];
  const current = templates.find((t) => t.id === tid) ?? templates[0];
  useEffect(() => {
    if (data && !templates.some((t) => t.id === tid)) setTid(DEFAULT_TEMPLATE);
  }, [data, templates, tid]);

  // The template being edited keeps its id and name while the editor saves it.
  const target = useRef(current);
  target.current = current;
  const [saveState, onChange] = useAutosave(async (flow) => {
    const t = target.current;
    if (!t) return { ok: false, message: "nothing to save" };
    const r =
      t.id === DEFAULT_TEMPLATE
        ? await deck().workflowSave(flow)
        : await deck().workflowTemplateSave(t.id, t.name, flow);
    if (r.ok)
      setData((d) =>
        d
          ? {
              ...d,
              templates: d.templates.map((x) =>
                x.id === t.id ? { ...x, flow } : x,
              ),
            }
          : d,
      );
    return r;
  });

  const name = async () => {
    if (!naming || !current || !naming.name.trim()) return;
    const r = await deck().workflowTemplateSave(
      naming.mode === "new" ? null : current.id,
      naming.name.trim(),
      current.flow,
    );
    setMsg(r.message);
    if (r.ok) {
      await load();
      if (r.id) setTid(r.id);
      setNaming(null);
    }
  };
  const del = async () => {
    if (!current) return;
    const r = await deck().workflowTemplateDelete(current.id);
    setMsg(r.message);
    if (r.ok) {
      setTid(DEFAULT_TEMPLATE);
      await load();
    }
  };

  const byEvent = new Map<string, HookEntry[]>();
  for (const h of data?.hooks ?? [])
    byEvent.set(h.event, [...(byEvent.get(h.event) ?? []), h]);

  return (
    <section className="board-view panel wf-view">
      <header className="board-head">
        <h2>Workflow</h2>
        <span className="muted">
          drag blocks in, join them with arrows; each session follows its own
          copy
        </span>
        <span style={{ flex: 1 }} />
        {msg && <span className="muted">{msg}</span>}
        <button
          className={`btn ${showHooks ? "on" : ""}`}
          onClick={() => setShowHooks((s) => !s)}
        >
          {showHooks ? "Hide hooks" : `All hooks (${data?.hooks.length ?? 0})`}
        </button>
      </header>
      {data && current && (
        <div className="wf-templates">
          <span className="wf-label">Template</span>
          <div className="seg wf-seg" role="tablist">
            {templates.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={t.id === current.id}
                className={t.id === current.id ? "on" : ""}
                onClick={() => (setTid(t.id), setNaming(null))}
              >
                {t.name}
                <span className="wf-count">{actionCount(t.flow)}</span>
              </button>
            ))}
          </div>
          {naming ? (
            <span className="wf-name">
              <input
                autoFocus
                value={naming.name}
                placeholder={
                  naming.mode === "new"
                    ? "Name of the new template"
                    : "New name"
                }
                onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void name();
                  if (e.key === "Escape") setNaming(null);
                }}
              />
              <button
                className="btn primary"
                disabled={!naming.name.trim()}
                onClick={() => void name()}
              >
                {naming.mode === "new" ? "Create" : "Rename"}
              </button>
              <button className="btn" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button
                className="btn"
                onClick={() => setNaming({ mode: "new", name: "" })}
                title={`A new template, starting as a copy of ${current.name}`}
              >
                + New template
              </button>
              {current.id !== DEFAULT_TEMPLATE && (
                <>
                  <button
                    className="btn"
                    onClick={() =>
                      setNaming({ mode: "rename", name: current.name })
                    }
                  >
                    Rename
                  </button>
                  <button className="btn danger" onClick={() => void del()}>
                    Delete
                  </button>
                </>
              )}
            </>
          )}
          <span className="wf-note muted">
            {current.id === DEFAULT_TEMPLATE
              ? "Every new session starts with a copy of the Default."
              : "Pick it in the Start dialog, or apply it from a session’s Workflow panel."}
          </span>
        </div>
      )}
      {showHooks && data && (
        <div className="wf-hooks">
          <div className="meta">
            Every hook Claude Code runs: <code>~/.claude/settings.json</code>,
            the <code>.claude/settings*.json</code> of your workspace repos, and
            enabled plugins. MasterDeck's workflow hooks read each session's own
            workflow.
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Event</th>
                <th>From</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {[...byEvent].flatMap(([event, list]) =>
                list.map((h, i) => (
                  <tr key={`${event}-${i}`}>
                    <td className="mono nowrap">
                      {i === 0 ? event : ""}
                      {h.matcher ? (
                        <span className="muted"> · {h.matcher}</span>
                      ) : null}
                    </td>
                    <td className="nowrap">
                      <span className={`src src-${h.source}`}>
                        {whereLabel(h)}
                      </span>
                    </td>
                    <td title={h.command}>
                      {h.owner ? (
                        <b>{h.owner}</b>
                      ) : (
                        <span className="mono muted">{short(h.command)}</span>
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="wf-editor">
        {!data || !current ? (
          <div className="empty">Reading the workflows…</div>
        ) : (
          <FlowEditor
            key={current.id}
            flow={current.flow}
            skills={data.skills}
            onChange={onChange}
            toolbar={<SaveBadge state={saveState} />}
          />
        )}
      </div>
    </section>
  );
}

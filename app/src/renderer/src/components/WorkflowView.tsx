import { useCallback, useEffect, useRef, useState } from "react";
import type { HookEntry } from "@shared/workflow";
import {
  actionCount,
  customInfo,
  DEFAULT_TEMPLATE,
  setCustomTriggers,
  type Flow,
  type WorkflowTemplate,
  setMonitors,
} from "@shared/flow";
import type { AppState } from "@shared/types";
import { deck, load as loadPref, save as savePref } from "../deck";
import { webConfirm } from "../webConfirm";
import { FlowEditor, type Skill } from "./FlowEditor";
import { TerminalView } from "./TerminalView";
import type { WorkflowDraft } from "@shared/ipc";

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
 * Details (Workflow → Edit), with the same editor.
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
  // The builder: a Claude session on the right that writes workflows from a prompt.
  const [builder, setBuilder] = useState<{
    gen: number;
    resume: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  // The builder's width (px), dragged at its left edge; double-click resets it.
  const [builderW, setBuilderW] = useState<number>(() =>
    loadPref<number>("builderW", 560),
  );
  useEffect(() => savePref("builderW", builderW), [builderW]);
  const editorRef = useRef<HTMLDivElement>(null);
  const dragBuilder = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = editorRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) =>
      setBuilderW(
        Math.round(
          Math.min(Math.max(box.right - ev.clientX, 320), box.width - 420),
        ),
      );
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const [showDraft, setShowDraft] = useState(true);
  useEffect(() => {
    void deck().workflowDraftGet().then(setDraft);
    return deck().onWorkflowDraft((d) => {
      setDraft(d);
      setShowDraft(true);
    });
  }, []);

  const load = useCallback(async () => {
    const w = await deck().workflowGet();
    // The custom trigger library: the editor, the compiler and block titles use it.
    setCustomTriggers(w.triggers);
    setMonitors(w.monitors);
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
    if (!(await webConfirm(`Delete the workflow “${current.name}”?`, { confirmLabel: "Delete", danger: true })))
      return;
    const r = await deck().workflowTemplateDelete(current.id);
    setMsg(r.message);
    if (r.ok) {
      setTid(DEFAULT_TEMPLATE);
      await load();
    }
  };

  // The builder works on the workflow open here: its folder gets it (and the format) first.
  const openBuilder = async (fresh: boolean) => {
    if (!current) return;
    const r = await deck().workflowBuilderPrepare(current.id);
    if (!r.ok) return setMsg(r.message);
    if (builder) deck().ptyClose(`workflow-builder:${builder.gen}`);
    setBuilder({
      gen: (builder?.gen ?? 0) + 1,
      resume: !fresh && r.canContinue,
    });
  };
  useEffect(() => {
    if (builder && current) void deck().workflowBuilderPrepare(current.id);
    // Only when the open workflow changes: current.json follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  const closeBuilder = () => {
    if (builder) deck().ptyClose(`workflow-builder:${builder.gen}`);
    setBuilder(null);
  };
  // Apply or save: MasterDeck installs the draft's new triggers and skills, then saves it.
  const applyDraft = async (asNew: boolean) => {
    if (!draft || !current) return;
    const ask = asNew
      ? "Save the draft as a new template? Its triggers and skills are installed on your Mac."
      : `Apply the draft to “${current.name}”? Its triggers and skills are installed on your Mac.`;
    if (!(await webConfirm(ask, { confirmLabel: asNew ? "Save" : "Apply" }))) return;
    const r = await deck().workflowDraftApply(
      asNew
        ? { newName: draft.name ?? "From the builder" }
        : { templateId: current.id },
    );
    setMsg(
      r.ok
        ? `${asNew ? `“${draft.name ?? "From the builder"}”` : current.name} ${r.message}`
        : r.message,
    );
    if (!r.ok) return;
    await load();
    if (asNew && r.id) setTid(r.id);
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
          className={`btn ${builder ? "on" : "primary"}`}
          onClick={() => (builder ? closeBuilder() : void openBuilder(false))}
          title="A Claude session that builds a workflow from what you ask: it knows the format, your skills and this workflow"
        >
          {builder ? "Close builder" : "✦ Build with Claude"}
        </button>
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
              : "Pick it in the Start dialog, or apply it from a session’s Details (Workflow → Edit)."}
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
      <div className="wf-editor" ref={editorRef}>
        <div className="wf-canvas">
          {draft && current && (
            <div className={`wf-draft ${draft.check.ok ? "ok" : "bad"}`}>
              <span className="wf-draft-t">
                <b>Claude's draft</b>
                {draft.name ? ` · ${draft.name}` : ""} ·{" "}
                {draft.flow.nodes.length} blocks ·{" "}
                {draft.check.ok
                  ? "no problems"
                  : `${draft.check.problems.length + draft.check.dropped.length} problem(s)`}
              </span>
              {draft.triggers.length > 0 && (
                <span
                  className="wf-draft-chip trig"
                  title={draft.triggers
                    .map((t) => `${t.name}: ${customInfo(t).hint}`)
                    .join("\n")}
                >
                  + {draft.triggers.length} new trigger
                  {draft.triggers.length === 1 ? "" : "s"}
                </span>
              )}
              {draft.skills.length > 0 && (
                <span
                  className="wf-draft-chip skill"
                  title={draft.skills
                    .map(
                      (x) =>
                        `${x.name}: ${x.description || "(no description)"}`,
                    )
                    .join("\n")}
                >
                  + {draft.skills.length} new skill
                  {draft.skills.length === 1 ? "" : "s"}
                </span>
              )}
              {draft.monitors.length > 0 && (
                <span
                  className="wf-draft-chip mon"
                  title={draft.monitors
                    .map((m) => `${m.def.name}: ${m.def.description}`)
                    .join("\n")}
                >
                  + {draft.monitors.length} new monitor
                  {draft.monitors.length === 1 ? "" : "s"}
                </span>
              )}
              {draft.check.warnings.length > 0 && (
                <span
                  className="wf-draft-chip warn"
                  title={draft.check.warnings.join("\n")}
                >
                  {draft.check.warnings.length} note
                  {draft.check.warnings.length === 1 ? "" : "s"}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => setShowDraft((v) => !v)}>
                {showDraft ? `Show ${current.name}` : "Show draft"}
              </button>
              <button
                className="btn"
                onClick={async () => {
                  if (await webConfirm("Discard the builder's draft?", { confirmLabel: "Discard", danger: true }))
                    void deck().workflowDraftDiscard();
                }}
              >
                Discard
              </button>
              <button
                className="btn"
                onClick={() => void applyDraft(true)}
                title="Keep it as a new template"
              >
                Save as template
              </button>
              <button
                className="btn primary"
                onClick={() => void applyDraft(false)}
                title={`Replace ${current.name} with the draft`}
              >
                Apply to {current.name}
              </button>
            </div>
          )}
          {!data || !current ? (
            <div className="empty">Reading the workflows…</div>
          ) : draft && showDraft ? (
            <FlowEditor
              key={`draft:${draft.at}`}
              flow={draft.flow}
              skills={data.skills}
              extraTriggers={draft.triggers}
              extraMonitors={draft.monitors.map((m) => m.def)}
              readOnly
            />
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
        {builder && (
          <div
            className="wf-split"
            onMouseDown={dragBuilder}
            onDoubleClick={() => setBuilderW(560)}
            title="Drag to resize the builder · double-click to reset"
            role="separator"
            aria-orientation="vertical"
          />
        )}
        {builder && (
          <aside
            className="wf-builder"
            aria-label="Workflow builder"
            style={{ width: builderW }}
          >
            <div className="wf-builder-head">
              <b>✦ Workflow builder</b>
              <span className="muted small">
                works on {current?.name ?? "the Default"}
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="btn"
                onClick={() => void openBuilder(true)}
                title="Start a new conversation"
              >
                New chat
              </button>
              <button
                className="insp-hide"
                onClick={closeBuilder}
                aria-label="Close the builder"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="wf-builder-term">
              <TerminalView
                key={builder.gen}
                paneId={`workflow-builder:${builder.gen}`}
                spec={{ kind: "builder", resume: builder.resume }}
                visible
                focusOnShow
              />
            </div>
            <div className="wf-builder-tip muted">
              Ask for a workflow, e.g. “after a push run the tests; if they fail
              fix them, if they pass post the preview URL”. Its draft shows on
              the canvas to apply.
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

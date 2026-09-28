import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  actionCount,
  compileFlow,
  DEFAULT_TEMPLATE,
  triggerInfo,
  type Flow,
  type WorkflowDoc,
  type WorkflowTemplate,
} from "@shared/flow";
import type { AppState, Session } from "@shared/types";
import { deck } from "../deck";
import { FlowEditor, type Skill } from "./FlowEditor";
import { SaveBadge, useAutosave } from "./WorkflowView";

interface Props {
  state: AppState;
  /** The open session (null: a shell, or nothing open). */
  session: Session | null;
  onHide: () => void;
  /** Switch to the Details / Queue / Summary panel. */
  onPanel: () => void;
  /** Open the Workflow window (templates). */
  onTemplates: () => void;
}

/**
 * The Terminals screen's Workflow panel: the open session's own workflow (copied from the default,
 * or a template, when it started), as a map; Edit opens the same editor as the Workflow window,
 * full size. Changes apply to this session only. A template can replace it, and it can be saved
 * as a new template.
 */
export function SessionWorkflow({
  session,
  onHide,
  onPanel,
  onTemplates,
}: Props) {
  const sid = session?.sessionId ?? "";
  const [doc, setDoc] = useState<WorkflowDoc | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lib, setLib] = useState<{
    templates: WorkflowTemplate[];
    skills: Skill[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pick, setPick] = useState<string>("");
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Remounts the map after a change made elsewhere (the editor, a template applied).
  const [gen, setGen] = useState(0);

  const load = useCallback(async () => {
    const [d, w] = await Promise.all([
      sid ? deck().sessionWorkflowGet(sid) : Promise.resolve(null),
      deck().workflowGet(),
    ]);
    setDoc(d);
    setLib({ templates: w.templates, skills: w.skills });
    setLoaded(true);
    setGen((g) => g + 1);
  }, [sid]);
  useEffect(() => {
    setLoaded(false);
    setMsg(null);
    setSaveAs(null);
    setEditing(false);
    void load();
  }, [load]);

  const fallback = lib?.templates.find((t) => t.id === DEFAULT_TEMPLATE);
  const flow: Flow = doc?.flow ?? fallback?.flow ?? { nodes: [], edges: [] };
  const from = doc?.from ?? "Default";

  const save = async (next: Flow, source: string | null = from) => {
    if (!sid) return { ok: false, message: "no session" };
    const r = await deck().sessionWorkflowSave(sid, next, source);
    if (r.ok)
      setDoc((d) => ({ flow: next, from: source, at: d?.at ?? Date.now() }));
    return r;
  };
  const [saveState, onChange] = useAutosave((f) => save(f));
  const apply = async () => {
    const t = lib?.templates.find((x) => x.id === pick);
    if (!t) return;
    setBusy(true);
    const r = await save(t.flow, t.name);
    setBusy(false);
    setMsg({ text: r.ok ? `now follows ${t.name}` : r.message, ok: r.ok });
    if (r.ok) {
      setPick("");
      setGen((g) => g + 1);
    }
  };
  const saveTemplate = async () => {
    if (!saveAs?.trim()) return;
    setBusy(true);
    const r = await deck().workflowTemplateSave(null, saveAs.trim(), flow);
    setBusy(false);
    setMsg({
      text: r.ok ? `saved as template “${saveAs.trim()}”` : r.message,
      ok: r.ok,
    });
    if (r.ok) {
      setSaveAs(null);
      await load();
    }
  };
  const compiled = compileFlow(flow);
  const close = () => {
    setEditing(false);
    setGen((g) => g + 1);
  };

  return (
    <aside className="inspector wf-panel" aria-label="Session workflow">
      <div className="insp-head">
        <div className="seg" role="tablist">
          <button
            role="tab"
            aria-selected={false}
            onClick={onPanel}
            title="Details, Queue, Summary"
          >
            Panel
          </button>
          <button role="tab" aria-selected className="on">
            Workflow
          </button>
        </div>
        <button
          className="insp-hide"
          onClick={onHide}
          title="Hide the workflow"
          aria-label="Hide the workflow"
        >
          ›
        </button>
      </div>
      <div className="insp-body">
        {!session ? (
          <div className="insp-empty">
            Open a session to see and change its workflow. Shells have none.
          </div>
        ) : !loaded || !lib ? (
          <div className="insp-empty">Reading the workflow…</div>
        ) : (
          <div className="wf-body">
            <div className="wf-head">
              <div className="wf-title">
                <b>{session.name}</b>
                <span style={{ flex: 1 }} />
                <button
                  className="btn primary"
                  onClick={() => setEditing(true)}
                >
                  Edit workflow
                </button>
              </div>
              <div className="meta">
                {doc ? (
                  <>
                    Its own copy, from <b>{from}</b>
                    {doc.at
                      ? ` · ${new Date(doc.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                      : ""}
                    . Changes apply to this session only, from its next step on.
                  </>
                ) : (
                  <>Follows the Default until you change it.</>
                )}
              </div>
              <div className="wf-actions">
                <select
                  className="fsel"
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  aria-label="Template to apply"
                >
                  <option value="">Use a template…</option>
                  {lib.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({actionCount(t.flow)} blocks)
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  disabled={!pick || busy}
                  onClick={() => void apply()}
                  title="Replace this session's workflow with the template"
                >
                  Apply
                </button>
                <span style={{ flex: 1 }} />
                {saveAs === null && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => setSaveAs("")}
                    title="Keep this workflow as a template for later sessions"
                  >
                    Save as template
                  </button>
                )}
              </div>
              {saveAs !== null && (
                <div className="wf-actions">
                  <input
                    className="wf-input"
                    autoFocus
                    value={saveAs}
                    placeholder="Template name"
                    onChange={(e) => setSaveAs(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveTemplate();
                      if (e.key === "Escape") setSaveAs(null);
                    }}
                  />
                  <button
                    className="btn primary"
                    disabled={busy || !saveAs.trim()}
                    onClick={() => void saveTemplate()}
                  >
                    Save
                  </button>
                  <button className="btn" onClick={() => setSaveAs(null)}>
                    Cancel
                  </button>
                </div>
              )}
              {msg && (
                <div className={msg.ok ? "wf-ok" : "error"}>{msg.text}</div>
              )}
            </div>
            <div
              className="wf-map"
              onDoubleClick={() => setEditing(true)}
              title="Double-click to edit"
            >
              <FlowEditor
                key={`${sid}:${gen}`}
                flow={flow}
                skills={lib.skills}
                readOnly
              />
            </div>
            <div className="wf-summary">
              {compiled.steps.length === 0 && (
                <div className="meta">
                  No steps of its own: only the built-ins run.
                </div>
              )}
              {compiled.steps.map((s) => (
                <div key={s.id} className="wf-sum-row">
                  <span className="fb-kind">When</span>{" "}
                  {triggerInfo(s.trigger).short}
                  {s.pattern ? <code> {s.pattern}</code> : null}
                </div>
              ))}
              {compiled.problems.length > 0 && (
                <div className="error">
                  {compiled.problems.length} problem(s): open the editor to see
                  them.
                </div>
              )}
            </div>
            <button className="link-btn wf-link" onClick={onTemplates}>
              Templates and the Default are in the Workflow window →
            </button>
          </div>
        )}
      </div>
      {editing &&
        session &&
        lib &&
        createPortal(
          <div
            className="backdrop"
            onMouseDown={(e) => e.target === e.currentTarget && close()}
          >
            <div
              className="dialog flow-dialog"
              role="dialog"
              aria-label={`Workflow of ${session.name}`}
            >
              <h3>
                Workflow · {session.name}
                <span className="muted small">this session only</span>
                <span style={{ flex: 1 }} />
                <button className="btn primary" onClick={close}>
                  Done
                </button>
              </h3>
              <FlowEditor
                flow={flow}
                skills={lib.skills}
                onChange={onChange}
                toolbar={<SaveBadge state={saveState} />}
              />
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}

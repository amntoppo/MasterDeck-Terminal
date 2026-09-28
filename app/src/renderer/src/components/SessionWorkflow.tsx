import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TEMPLATE,
  type CustomStep,
  type WorkflowDoc,
  type WorkflowTemplate,
} from "@shared/workflow";
import type { AppState, Session } from "@shared/types";
import { deck } from "../deck";
import { WorkflowStages } from "./WorkflowView";

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
 * or a template, when it started). Changes apply to this session only; the hooks read its copy.
 * A template can replace it, and it can be saved as a new template.
 */
export function SessionWorkflow({
  state,
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
    skills: { name: string; description: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pick, setPick] = useState<string>("");
  const [saveAs, setSaveAs] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, w] = await Promise.all([
      sid ? deck().sessionWorkflowGet(sid) : Promise.resolve(null),
      deck().workflowGet(),
    ]);
    setDoc(d);
    setLib({ templates: w.templates, skills: w.skills });
    setLoaded(true);
  }, [sid]);
  useEffect(() => {
    setLoaded(false);
    setMsg(null);
    setSaveAs(null);
    void load();
  }, [load]);

  const fallback = lib?.templates.find((t) => t.id === DEFAULT_TEMPLATE);
  const steps = doc?.steps ?? fallback?.steps ?? [];
  const from = doc?.from ?? "Default";

  const save = async (next: CustomStep[], source: string | null = from) => {
    if (!sid) return false;
    setBusy(true);
    const r = await deck().sessionWorkflowSave(sid, next, source);
    setBusy(false);
    setMsg({ text: r.message, ok: r.ok });
    if (r.ok) await load();
    return r.ok;
  };
  const apply = async () => {
    const t = lib?.templates.find((x) => x.id === pick);
    if (!t) return;
    if (await save(t.steps, t.name)) {
      setPick("");
      setMsg({ text: `now follows ${t.name}`, ok: true });
    }
  };
  const saveTemplate = async () => {
    if (!saveAs?.trim()) return;
    setBusy(true);
    const r = await deck().workflowTemplateSave(null, saveAs.trim(), steps);
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
              <b>{session.name}</b>
              <div className="meta">
                {doc ? (
                  <>
                    Its own copy, from <b>{from}</b>
                    {doc.at
                      ? ` · ${new Date(doc.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                      : ""}
                    . Changes here apply to this session only, from its next
                    step on.
                  </>
                ) : (
                  <>Follows the default until you change it here.</>
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
                      {t.name} ({t.steps.length} step
                      {t.steps.length === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  disabled={!pick || busy}
                  onClick={() => void apply()}
                  title="Replace this session's steps with the template's"
                >
                  Apply
                </button>
                <span style={{ flex: 1 }} />
                {saveAs === null && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => setSaveAs("")}
                    title="Save these steps as a template for later sessions"
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
            <WorkflowStages
              key={sid}
              steps={steps}
              skills={lib.skills}
              masterOn={state.config.masterEnabled}
              busy={busy}
              compact
              onSave={(next) => save(next)}
            />
            <button className="link-btn wf-link" onClick={onTemplates}>
              Edit templates and the default in the Workflow window →
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

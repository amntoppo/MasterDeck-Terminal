import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  actionCount,
  DEFAULT_TEMPLATE,
  setCustomTriggers,
  triggerInfo,
  type Flow,
  type FlowTrigger,
  type WorkflowDoc,
  type WorkflowTemplate,
  setMonitors,
} from "@shared/flow";
import type { WorkflowStatus } from "@shared/ipc";
import { formatAgo } from "@shared/format";
import type { AppState, Session } from "@shared/types";
import { deck, useNow } from "../deck";
import { FlowEditor, type Skill } from "./FlowEditor";
import { SaveBadge, useAutosave } from "./WorkflowView";

/** A trigger's name for people; an unknown one (renamed since) as it is. */
const triggerName = (t: string): string => {
  try {
    return triggerInfo(t as FlowTrigger).short;
  } catch {
    return t;
  }
};

/**
 * The Workflow line in a session's Details: the workflow point it reached last (from its
 * transcript, its PRs and the hooks' log; see shared/flowTrack) with what the workflow does there,
 * shown as running while the session is on it; the points still ahead; and Edit, which opens the
 * session's workflow in the editor.
 */
export function WorkflowWidget({
  session: s,
  state,
}: {
  session: Session;
  state: AppState;
}) {
  const now = useNow(15_000);
  const [st, setSt] = useState<WorkflowStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const load = useCallback(
    async () => setSt(await deck().workflowStatus(s.sessionId)),
    [s.sessionId],
  );
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [load]);

  const cur = st?.current ?? null;
  const ongoing = !!cur?.ongoing;
  const lines = cur?.lines ?? [];
  const next = st?.next ?? [];

  return (
    <section className={`dsec wfw ${ongoing ? "on" : ""}`}>
      <div className="wfw-head">
        <span className="eyebrow">Workflow</span>
        <span
          className="muted wfw-from"
          title="Its own copy, made from this template"
        >
          {st?.from ?? "Default"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="link-btn"
          onClick={() => setOpen(true)}
          title="Change this session's workflow"
        >
          Edit
        </button>
      </div>
      {cur ? (
        <div
          className="wfw-step"
          onClick={() => setMore((m) => !m)}
          title={more ? "Show less" : "Show the whole step"}
        >
          <span
            className={`wfw-dot ${ongoing ? "live" : ""}`}
            aria-hidden="true"
          />
          <div className="wfw-main">
            <div className="wfw-title">
              <b>{triggerName(cur.trigger)}</b>
              <span className={ongoing ? "wfw-live" : "muted"}>
                {ongoing
                  ? ` · running · ${formatAgo(now - cur.at)}`
                  : ` · ${formatAgo(now - cur.at)} ago`}
              </span>
            </div>
            {cur.builtins.length === 0 && lines.length === 0 && (
              <div className="wfw-line muted">Nothing to do at this point</div>
            )}
            {cur.builtins.map((b) => (
              <div key={b} className="wfw-line wfw-builtin">
                {b}
              </div>
            ))}
            {(more ? lines : lines.slice(0, 2)).map((l, i) => (
              <div key={i} className="wfw-line">
                {l}
              </div>
            ))}
            {!more && lines.length > 2 && (
              <div className="wfw-line muted">+{lines.length - 2} more</div>
            )}
          </div>
        </div>
      ) : (
        <div className="wfw-step idle">
          <span className="wfw-dot" aria-hidden="true" />
          <div className="wfw-main">
            <div className="wfw-title muted">Not at a workflow step yet</div>
          </div>
        </div>
      )}
      {(next.length > 0 || (st?.anytime.length ?? 0) > 0) && (
        <div className="wfw-next muted">
          {next.length > 0 && <>Next: {next.map(triggerName).join(" → ")}</>}
          {next.length > 0 && (st?.anytime.length ?? 0) > 0 && " · "}
          {(st?.anytime.length ?? 0) > 0 && (
            <>Also on: {st!.anytime.map(triggerName).join(", ")}</>
          )}
        </div>
      )}
      {open && (
        <SessionWorkflowDialog
          session={s}
          onClose={() => {
            setOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

/**
 * A session's own workflow in the editor, full size: changes apply to this session only. A
 * template can replace it, and it can be saved as a new template.
 */
export function SessionWorkflowDialog({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const sid = session.sessionId;
  const [doc, setDoc] = useState<WorkflowDoc | null>(null);
  const [lib, setLib] = useState<{
    templates: WorkflowTemplate[];
    skills: Skill[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pick, setPick] = useState("");
  const [saveAs, setSaveAs] = useState<string | null>(null);
  // Remounts the editor when a template replaces the flow.
  const [gen, setGen] = useState(0);

  const load = useCallback(async () => {
    const [d, w] = await Promise.all([
      deck().sessionWorkflowGet(sid),
      deck().workflowGet(),
    ]);
    setDoc(d);
    setCustomTriggers(w.triggers);
    setMonitors(w.monitors);
    setLib({ templates: w.templates, skills: w.skills });
  }, [sid]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" &&
      !(e.target as HTMLElement).closest("input, textarea, select") &&
      onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fallback = lib?.templates.find((t) => t.id === DEFAULT_TEMPLATE);
  const flow: Flow | null = doc?.flow ?? fallback?.flow ?? null;
  const from = doc?.from ?? "Default";
  const save = async (next: Flow, source: string | null = from) => {
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
    if (!saveAs?.trim() || !flow) return;
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

  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog flow-dialog"
        role="dialog"
        aria-label={`Workflow of ${session.name}`}
      >
        <h3>
          Workflow · {session.name}
          <span className="muted small">this session only · from {from}</span>
          <span style={{ flex: 1 }} />
          {msg && (
            <span className={msg.ok ? "wf-ok" : "error"}>{msg.text}</span>
          )}
          {lib && (
            <>
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
            </>
          )}
          {saveAs === null ? (
            <button
              className="btn"
              disabled={busy || !flow}
              onClick={() => setSaveAs("")}
              title="Keep this workflow as a template for later sessions"
            >
              Save as template
            </button>
          ) : (
            <>
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
            </>
          )}
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </h3>
        {lib && flow ? (
          <FlowEditor
            key={gen}
            flow={flow}
            skills={lib.skills}
            onChange={onChange}
            toolbar={<SaveBadge state={saveState} />}
          />
        ) : (
          <div className="empty">Reading the workflow…</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

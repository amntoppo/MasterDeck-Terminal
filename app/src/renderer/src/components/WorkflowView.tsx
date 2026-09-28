import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TEMPLATE,
  STAGES,
  stageOf,
  TRIGGERS,
  type CustomStep,
  type HookEntry,
  type Stage,
  type StageId,
  type WorkflowTemplate,
} from "@shared/workflow";
import type { AppState } from "@shared/types";
import { deck } from "../deck";

type Data = {
  hooks: HookEntry[];
  skills: { name: string; description: string }[];
  steps: CustomStep[];
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

/**
 * The workflow a ticket goes through, with every hook Claude Code runs at each point (from your
 * settings, the workspace's repos and enabled plugins) and custom steps: a skill attached to a
 * point, run by a hook. Edits the default workflow (what new sessions copy) or a template; each
 * session then keeps its own copy (the Workflow panel on the Terminals screen).
 */
export function WorkflowView({ state }: { state: AppState }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tid, setTid] = useState<string>(DEFAULT_TEMPLATE);
  // Naming a new template (a copy of the one shown) or renaming the one shown.
  const [naming, setNaming] = useState<{
    mode: "new" | "rename";
    name: string;
  } | null>(null);

  const load = useCallback(async () => setData(await deck().workflowGet()), []);
  useEffect(() => void load(), [load]);

  const templates = data?.templates ?? [];
  const current = templates.find((t) => t.id === tid) ?? templates[0];
  useEffect(() => {
    if (data && !templates.some((t) => t.id === tid)) setTid(DEFAULT_TEMPLATE);
  }, [data, templates, tid]);

  const run = async (
    f: () => Promise<{ ok: boolean; message: string; id?: string }>,
  ) => {
    setBusy(true);
    const r = await f();
    setBusy(false);
    setMsg(r.message);
    if (r.ok) await load();
    return r;
  };
  const save = async (steps: CustomStep[]) => {
    if (!current) return false;
    const r = await run(() =>
      current.id === DEFAULT_TEMPLATE
        ? deck().workflowSave(steps)
        : deck().workflowTemplateSave(current.id, current.name, steps),
    );
    return r.ok;
  };
  const name = async () => {
    if (!naming || !current || !naming.name.trim()) return;
    const r = await run(() =>
      deck().workflowTemplateSave(
        naming.mode === "new" ? null : current.id,
        naming.name.trim(),
        current.steps,
      ),
    );
    if (r.ok) {
      if (r.id) setTid(r.id);
      setNaming(null);
    }
  };

  const byEvent = new Map<string, HookEntry[]>();
  for (const h of data?.hooks ?? [])
    byEvent.set(h.event, [...(byEvent.get(h.event) ?? []), h]);

  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>Workflow</h2>
        <span className="muted">
          what happens from an issue to a merged PR, the hooks that run at each
          point, and your own steps
        </span>
        <span style={{ flex: 1 }} />
        {msg && <span className="muted">{msg}</span>}
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      <div className="panel-body">
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
                  <span className="wf-count">{t.steps.length}</span>
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
                  onChange={(e) =>
                    setNaming({ ...naming, name: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void name();
                    if (e.key === "Escape") setNaming(null);
                  }}
                />
                <button
                  className="btn primary"
                  disabled={busy || !naming.name.trim()}
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
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          deck().workflowTemplateDelete(current.id),
                        )
                      }
                    >
                      Delete
                    </button>
                  </>
                )}
              </>
            )}
            <div className="meta wf-note">
              {current.id === DEFAULT_TEMPLATE
                ? "The default: every new session starts with a copy of it. Change one session’s copy from its Workflow panel (Terminals, top right)."
                : `A template: pick it in the Start dialog, or apply it from a session’s Workflow panel. Sessions already using it keep their own copy.`}
            </div>
          </div>
        )}
        <div className="flow-strip">
          {STAGES.map((s, i) => (
            <span key={s.id} className="flow-item">
              {i > 0 && <span className="flow-arrow">→</span>}
              <a
                className="flow-chip"
                href={`#stage-${s.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById(`stage-${s.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {s.title}
              </a>
            </span>
          ))}
        </div>

        {!data || !current ? (
          <div className="empty">Reading the hooks…</div>
        ) : (
          <WorkflowStages
            key={current.id}
            steps={current.steps}
            skills={data.skills}
            hooks={data.hooks}
            masterOn={state.config.masterEnabled}
            busy={busy}
            onSave={save}
          />
        )}

        {data && (
          <>
            <h3 className="sec">
              Every hook Claude Code runs ({data.hooks.length})
            </h3>
            <div className="meta">
              From <code>~/.claude/settings.json</code>, the{" "}
              <code>.claude/settings*.json</code> of the repos in your
              workspace, and your enabled plugins. Hooks in other repos run only
              in sessions there.
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
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The stages with their custom steps, editable: `onSave` gets the whole new list (true once saved).
 * `hooks` (the Workflow window) also lists the other hooks at each stage; `compact` (a session's
 * panel) leaves out what each stage does by itself.
 */
export function WorkflowStages(p: {
  steps: CustomStep[];
  skills: { name: string; description: string }[];
  hooks?: HookEntry[];
  masterOn: boolean;
  busy: boolean;
  compact?: boolean;
  onSave: (steps: CustomStep[]) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState<{
    stage: StageId;
    kind: CustomStep["kind"];
  } | null>(null);
  const hooksAt = (id: StageId) =>
    (p.hooks ?? []).filter(
      (h) => h.event !== "StatusLine" && stageOf(h, p.steps) === id,
    );
  return (
    <div className={`stages ${p.compact ? "compact" : ""}`}>
      {STAGES.filter((s) => !p.compact || s.trigger).map((s, i) => (
        <StageCard
          key={s.id}
          n={i + 1}
          stage={s}
          hooks={hooksAt(s.id)}
          steps={p.steps.filter(
            (x) => STAGES.find((st) => st.trigger === x.trigger)?.id === s.id,
          )}
          skills={p.skills}
          masterOn={p.masterOn}
          compact={p.compact}
          adding={adding?.stage === s.id ? adding.kind : null}
          busy={p.busy}
          onAdd={(kind) =>
            setAdding(
              adding?.stage === s.id && adding.kind === kind
                ? null
                : { stage: s.id, kind },
            )
          }
          onSave={async (step) =>
            (await p.onSave([...p.steps, step])) && setAdding(null)
          }
          onRemove={(id) => void p.onSave(p.steps.filter((x) => x.id !== id))}
          onUpdate={(id, step) =>
            p.onSave(p.steps.map((x) => (x.id === id ? step : x)))
          }
        />
      ))}
    </div>
  );
}

function StageCard(p: {
  n: number;
  stage: Stage;
  hooks: HookEntry[];
  steps: CustomStep[];
  skills: { name: string; description: string }[];
  masterOn: boolean;
  compact?: boolean;
  adding: CustomStep["kind"] | null;
  busy: boolean;
  onAdd: (kind: CustomStep["kind"]) => void;
  onSave: (s: CustomStep) => void;
  onRemove: (id: string) => void;
  /** Replace step `id` with its edited version; true once saved. */
  onUpdate: (id: string, step: CustomStep) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const s = p.stage;
  const trigger = TRIGGERS.find((t) => t.id === s.trigger);
  const others = p.hooks.filter(
    (h) =>
      !h.owner?.startsWith("custom step") &&
      !h.owner?.startsWith("workflow steps"),
  );
  return (
    <div className="stage" id={`stage-${s.id}`}>
      <div className="stage-n">{p.n}</div>
      <div className="stage-body">
        <div className="stage-head">
          <b>{s.title}</b>
          <span className="muted">
            · {p.compact ? trigger?.label.toLowerCase() : s.actor}
          </span>
        </div>
        {!p.compact && <div className="stage-what">{s.what}</div>}
        {!p.compact && (
          <ul className="stage-list">
            {s.builtin
              .filter((b) => p.masterOn || !b.startsWith("master-agent"))
              .map((b) => (
                <li key={b}>{b}</li>
              ))}
          </ul>
        )}
        {!p.compact && others.length > 0 && (
          <div className="stage-hooks">
            {others.map((h, i) => (
              <div key={i} className="hook-row" title={h.command}>
                <span className="ev">{h.event}</span>
                <span className={`src src-${h.source}`}>{whereLabel(h)}</span>
                <span className="grow">
                  {h.owner ?? (
                    <span className="mono muted">{short(h.command)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {p.steps.map((st) =>
          editing === st.id && trigger ? (
            st.kind === "instruction" ? (
              <AddInstruction
                key={st.id}
                trigger={trigger.id}
                busy={p.busy}
                initial={st}
                onCancel={() => setEditing(null)}
                onSave={async (next) =>
                  (await p.onUpdate(st.id, next)) && setEditing(null)
                }
              />
            ) : (
              <AddStep
                key={st.id}
                trigger={trigger.id}
                skills={p.skills}
                busy={p.busy}
                initial={st}
                onCancel={() => setEditing(null)}
                onSave={async (next) =>
                  (await p.onUpdate(st.id, next)) && setEditing(null)
                }
              />
            )
          ) : (
            <div
              key={st.id}
              className={`custom-step ${st.kind}`}
              title={st.instructions}
            >
              <span className="ev">
                {st.kind === "instruction" ? "your instruction" : "your skill"}
              </span>
              {st.kind === "instruction" ? (
                <span className="grow">{st.instructions}</span>
              ) : (
                <span className="grow">
                  <b>{st.skill}</b>{" "}
                  <span className="muted">
                    ·{" "}
                    {st.mode === "background"
                      ? "background subagent"
                      : "in the session"}
                  </span>
                  {st.instructions && (
                    <span className="muted"> · {st.instructions}</span>
                  )}
                </span>
              )}
              <button
                className="link-btn"
                disabled={p.busy}
                onClick={() => setEditing(st.id)}
              >
                Edit
              </button>
              <button
                className="link-btn"
                disabled={p.busy}
                onClick={() => p.onRemove(st.id)}
              >
                Remove
              </button>
            </div>
          ),
        )}
        {trigger && (
          <div className="add-row">
            <button
              className={`add-step ${p.adding === "skill" ? "on" : ""}`}
              onClick={() => p.onAdd("skill")}
            >
              {p.adding === "skill" ? "Cancel" : "+ Add a skill"}
            </button>
            <button
              className={`add-step ${p.adding === "instruction" ? "on" : ""}`}
              onClick={() => p.onAdd("instruction")}
            >
              {p.adding === "instruction" ? "Cancel" : "+ Add an instruction"}
            </button>
            <span className="muted small">{trigger.label}</span>
          </div>
        )}
        {p.adding === "skill" && trigger && (
          <AddStep
            trigger={trigger.id}
            skills={p.skills}
            busy={p.busy}
            onSave={p.onSave}
          />
        )}
        {p.adding === "instruction" && trigger && (
          <AddInstruction
            trigger={trigger.id}
            busy={p.busy}
            onSave={p.onSave}
          />
        )}
      </div>
    </div>
  );
}

/** A new id on every save: a changed step reaches sessions again (each hook runs once per id and session). */
const newId = (base: string) =>
  `${base
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`;

/** Add a skill step, or edit one (`initial`). */
function AddStep({
  trigger,
  skills,
  busy,
  onSave,
  initial,
  onCancel,
}: {
  trigger: CustomStep["trigger"];
  skills: { name: string; description: string }[];
  busy: boolean;
  onSave: (s: CustomStep) => void;
  initial?: CustomStep;
  onCancel?: () => void;
}) {
  const [skill, setSkill] = useState(initial?.skill ?? "");
  const [mode, setMode] = useState<CustomStep["mode"]>(
    initial?.mode ?? "background",
  );
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const picked = skills.find((s) => s.name === skill);
  return (
    <div className="add-form">
      <label>Skill</label>
      <select
        className="fsel full"
        value={skill}
        onChange={(e) => setSkill(e.target.value)}
      >
        <option value="">Choose a skill in ~/.claude/skills…</option>
        {skill && !skills.some((s) => s.name === skill) && (
          <option value={skill}>{skill} (not in ~/.claude/skills)</option>
        )}
        {skills.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      {picked?.description && <div className="meta">{picked.description}</div>}
      <label>How it runs</label>
      <div className="seg">
        <button
          className={mode === "background" ? "on" : ""}
          onClick={() => setMode("background")}
        >
          Background subagent (doesn't block)
        </button>
        <button
          className={mode === "session" ? "on" : ""}
          onClick={() => setMode("session")}
        >
          In the session
        </button>
      </div>
      <label>Extra instructions (optional)</label>
      <input
        value={instructions}
        placeholder="e.g. deploy to staging, then post the URL on the issue"
        onChange={(e) => setInstructions(e.target.value)}
      />
      <div className="meta">
        A MasterDeck hook tells the session to run it at this point. A skill you
        create later shows up here once it is in <code>~/.claude/skills</code>.
      </div>
      <div className="form-buttons">
        <button
          className="btn primary"
          disabled={!skill || busy}
          onClick={() =>
            onSave({
              id: newId(skill),
              trigger,
              kind: "skill",
              skill,
              mode,
              instructions,
            })
          }
        >
          {busy ? "Saving…" : initial ? "Save" : "Add to the workflow"}
        </button>
        {onCancel && (
          <button className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** Text the session is given at this point, as is: no skill. Saved when added, or when an edit (`initial`) is saved. */
function AddInstruction({
  trigger,
  busy,
  onSave,
  initial,
  onCancel,
}: {
  trigger: CustomStep["trigger"];
  busy: boolean;
  onSave: (s: CustomStep) => void;
  initial?: CustomStep;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial?.instructions ?? "");
  const changed = text.trim() !== (initial?.instructions ?? "").trim();
  const add = () => {
    if (!text.trim() || busy || !changed) return;
    onSave({
      id: newId("note"),
      trigger,
      kind: "instruction",
      skill: "",
      mode: "session",
      instructions: text.trim(),
    });
  };
  return (
    <div className="add-form">
      <label>Instruction for the session</label>
      <textarea
        value={text}
        autoFocus
        placeholder="e.g. After pushing, post the preview URL in the PR description."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
          if (e.key === "Escape" && onCancel) onCancel();
        }}
      />
      <div className="meta">
        At this point, the session gets it as a note from a MasterDeck hook,
        once per session
        {trigger === "session-start" || trigger === "linked"
          ? ""
          : " and commit"}
        .
        {initial
          ? " Once saved, the new text reaches sessions again, including ones that had the old text."
          : ""}
      </div>
      <div className="form-buttons">
        <button
          className="btn primary"
          disabled={!text.trim() || busy || !changed}
          title="⌘↵"
          onClick={add}
        >
          {busy ? "Saving…" : initial ? "Save" : "Add instruction"}
        </button>
        {onCancel && (
          <button
            className="btn"
            disabled={busy}
            title="Esc"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

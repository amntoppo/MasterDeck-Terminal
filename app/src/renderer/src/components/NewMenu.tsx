import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultModelLabel, MODELS } from "@shared/models";
import type { WorkflowTemplate } from "@shared/flow";
import { actionCount, DEFAULT_TEMPLATE } from "@shared/flow";
import { deck } from "../deck";

export type Repo = { name: string; path: string };

export type NewAction =
  | { kind: "terminal"; cwd?: string }
  | { kind: "claude" }
  | { kind: "issue" }
  | { kind: "resume" };

const isMac = () => deck().platform === "darwin";
const key = (k: string) =>
  isMac() ? k : k.replace("⌘", "Ctrl+").replace("⇧", "Shift+");

/**
 * The + in the Sessions column: a new terminal (in the workspace or a repo), a new Claude session,
 * a session from an issue, or a past session resumed. The menu is portalled to the end of the page:
 * the column's header is a window drag region, which would swallow its clicks.
 */
export function NewMenu({ onPick }: { onPick: (a: NewAction) => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sub, setSub] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const open = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    setAt({ x: r.right, y: r.bottom + 4 });
    setSub(false);
    void deck().workspaceRepos().then(setRepos);
  };
  useEffect(() => {
    if (!at) return;
    const close = (e: MouseEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !btn.current?.contains(e.target as Node)
      )
        setAt(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAt(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [at]);
  const pick = (a: NewAction) => {
    setAt(null);
    onPick(a);
  };
  const item = (label: string, hint: string, a: NewAction, title?: string) => (
    <button key={label} onClick={() => pick(a)} title={title}>
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );

  return (
    <>
      <button
        ref={btn}
        className={`col-btn new-btn ${at ? "on" : ""}`}
        onClick={() => (at ? setAt(null) : open())}
        title="New terminal, Claude session…"
        aria-haspopup="menu"
        aria-expanded={!!at}
      >
        +
      </button>
      {at &&
        createPortal(
          <div
            ref={menu}
            className="menu new-menu"
            role="menu"
            style={{
              position: "fixed",
              top: at.y,
              left: Math.max(8, at.x - 250),
              right: "auto",
            }}
          >
            {item(
              "New terminal",
              key("⌘T"),
              { kind: "terminal" },
              "A shell in the workspace",
            )}
            {item(
              "New Claude session…",
              "",
              { kind: "claude" },
              "A background Claude session in a folder, without a ticket",
            )}
            {repos.length > 1 && (
              <div
                className="new-sub-wrap"
                onMouseEnter={() => setSub(true)}
                onMouseLeave={() => setSub(false)}
              >
                <button
                  onClick={() => setSub((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={sub}
                >
                  <span>Terminal in a repo</span>
                  <kbd className="new-caret">›</kbd>
                </button>
                {sub && (
                  <div className="menu new-sub" role="menu">
                    {repos.map((r) =>
                      item(
                        r.name,
                        "",
                        { kind: "terminal", cwd: r.path },
                        r.path,
                      ),
                    )}
                  </div>
                )}
              </div>
            )}
            <hr />
            {item(
              "Start from an issue…",
              key("⌘K"),
              { kind: "issue" },
              "Find a ticket, then start a session on it",
            )}
            {item(
              "Resume a past session…",
              key("⌘⇧F"),
              { kind: "resume" },
              "Search earlier sessions and resume one",
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A name not taken yet: `<folder>-<n>`. */
export function nextName(base: string, taken: string[]): string {
  const b =
    base
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[-._]+$/, "")
      .slice(0, 50) || "session";
  const re = new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  const n = Math.max(0, ...taken.map((t) => Number(re.exec(t)?.[1] ?? 0)));
  return `${b}-${n + 1}`;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface NewSessionReq {
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  workflow?: string;
  mode?: string;
}

/** Permission modes offered (the ones that skip checks are left out). */
const MODES: [string, string][] = [
  ["", "As in your settings"],
  ["plan", "Plan first (read-only until you approve)"],
  ["acceptEdits", "Accept edits (asks before commands)"],
  ["auto", "Auto (Claude decides what is safe)"],
  ["manual", "Ask for everything"],
];

/**
 * New Claude session: a folder (the workspace, a repo, or any other), a name, an optional first
 * message (without one the session waits idle), the model and the workflow it starts with.
 */
export function NewSessionDialog({
  taken,
  onStart,
  onClose,
}: {
  taken: string[];
  onStart: (r: NewSessionReq) => void;
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [configured, setConfigured] = useState<string | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [workflow, setWorkflow] = useState(DEFAULT_TEMPLATE);
  const [mode, setMode] = useState("");
  useEffect(() => {
    void deck()
      .workspaceRepos()
      .then((r) => {
        setRepos(r);
        if (r[0]) setCwd((c) => c || r[0].path);
      });
    void deck().defaultModel().then(setConfigured);
    void deck()
      .workflowGet()
      .then((w) => setTemplates(w.templates));
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  // The name follows the folder until the user types one.
  useEffect(() => {
    if (!named && cwd)
      setName(nextName(cwd.split(/[\\/]/).pop() ?? "session", taken));
  }, [cwd, named, taken]);

  const other = cwd && !repos.some((r) => r.path === cwd);
  const nameOk = NAME_RE.test(name) && !taken.includes(name);
  const promptOk = !prompt.trim().startsWith("-");
  const start = () => {
    if (!cwd || !nameOk || !promptOk) return;
    onStart({
      name,
      cwd,
      prompt: prompt.trim() || undefined,
      model: model || undefined,
      workflow: workflow === DEFAULT_TEMPLATE ? undefined : workflow,
      mode: mode || undefined,
    });
    onClose();
  };

  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog new-session"
        role="dialog"
        aria-label="New Claude session"
      >
        <h3>New Claude session</h3>
        <label>Workspace</label>
        <div className="ns-row">
          <select
            className="fsel full"
            value={other ? "__other" : cwd}
            onChange={(e) =>
              e.target.value === "__other"
                ? void pickOther()
                : setCwd(e.target.value)
            }
          >
            {repos.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name}
              </option>
            ))}
            {other && <option value="__other">{cwd}</option>}
            <option value="__other">Other folder…</option>
          </select>
        </div>
        {cwd && <div className="meta mono">{cwd}</div>}
        <label>Name</label>
        <input
          value={name}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setNamed(true);
          }}
        />
        {!nameOk && name && (
          <div className="error small">
            {taken.includes(name)
              ? "A session has that name already."
              : "Letters, digits, dot, dash and underscore; up to 64 characters."}
          </div>
        )}
        <label>First message (optional)</label>
        <textarea
          value={prompt}
          autoFocus
          placeholder="What should it do? Leave empty to start it idle and type in its terminal."
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && (e.metaKey || e.ctrlKey) && start()
          }
        />
        {!promptOk && (
          <div className="error small">
            The first message can't start with “-”.
          </div>
        )}
        <div className="ns-grid">
          <div>
            <label>Model</label>
            <select
              className="fsel full"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{defaultModelLabel(configured)}</option>
              {MODELS.filter((m) => m.value !== configured).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Workflow</label>
            <select
              className="fsel full"
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({actionCount(t.flow)} blocks)
                </option>
              ))}
            </select>
          </div>
        </div>
        <label>Permissions</label>
        <select
          className="fsel full"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          {MODES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <div className="meta">
          It runs in the background (claude --bg): it keeps going when
          MasterDeck closes, and shows under Sessions.
        </div>
        <div className="form-buttons">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!cwd || !nameOk || !promptOk}
            onClick={start}
            title="⌘↵"
          >
            Start session
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );

  async function pickOther() {
    const p = await deck().pickFolder(cwd || undefined);
    if (p) setCwd(p);
  }
}

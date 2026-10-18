import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultModelLabel, MODELS } from "@shared/models";
import type { WorkflowTemplate } from "@shared/flow";
import { actionCount, DEFAULT_TEMPLATE } from "@shared/flow";
import type { AppState } from "@shared/types";
import { accountChoices, isMulti } from "@shared/accounts";
import {
  choiceFor,
  initialAccount,
  NEW_SESSION_PREFS_KEY,
  parseNewSessionPrefs,
  rememberChoice,
  resolveChoice,
  type ChoiceNotes,
  type NewSessionChoice,
  type NewSessionPrefs,
} from "@shared/newSessionPrefs";
import { AccountSelect } from "./AccountBits";
import { deck, load, save } from "../deck";
import { can, keyPlatform } from "../web";
import { RepoPicker } from "./RepoPicker";
import { PeerPicker } from "./PeerPicker";
import { peerFactsFor, type PeerSummaries } from "./peersView";
import { peersPromptBlock } from "@shared/prompt";
import { shownTab } from "@shared/sessionGroups";
import { SessionTabSelect } from "./SessionGroupBar";
import { pickedGroup } from "../sessionGroupPick";

export type Repo = { name: string; path: string };

export type NewAction =
  | { kind: "terminal"; cwd?: string }
  | { kind: "claude" }
  | { kind: "issue" }
  | { kind: "resume" };

const isMac = () => keyPlatform() === "darwin";
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
            {can("searchHistory") &&
              item(
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
  account?: string;
  /** Session keys to link the new session to (two-way). */
  peers?: string[];
  /** The session list's tab (#171) the new session goes into once listed; "all" or absent: none. */
  group?: string;
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
  state,
  taken,
  onStart,
  onClose,
}: {
  state: AppState;
  taken: string[];
  onStart: (r: NewSessionReq) => void;
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [peers, setPeers] = useState<string[]>([]);
  // The chosen peers' saved summaries, for the first prompt's linked-sessions block.
  const [peerSummaries, setPeerSummaries] = useState<PeerSummaries>({});
  useEffect(() => {
    let alive = true;
    const missing = peers.filter((k) => !(k in peerSummaries));
    for (const k of missing)
      void deck()
        .summaryGet(k)
        .then(({ summary }) => {
          if (alive) setPeerSummaries((m) => ({ ...m, [k]: summary ? { at: summary.at, text: summary.text } : null }));
        })
        .catch(() => {
          if (alive) setPeerSummaries((m) => ({ ...m, [k]: null }));
        });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [configured, setConfigured] = useState<string | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [workflow, setWorkflow] = useState(DEFAULT_TEMPLATE);
  const [mode, setMode] = useState("");
  // The session list's tab it goes into (#171): the one on screen unless picked here.
  const [group, setGroup] = useState(() => shownTab(state.sessionGroups, pickedGroup()));
  const [picking, setPicking] = useState(false);
  // Each account's last choices (#153): read once per dialog, written on Start.
  const multi = isMulti(state.config);
  const prefs = useRef<NewSessionPrefs | null>(null);
  prefs.current ??= parseNewSessionPrefs(load<unknown>(NEW_SESSION_PREFS_KEY, null));
  // The account opens on the last one started; without one it follows the folder (its origin
  // remote's account) until one is picked.
  const [account, setAccount] = useState<string | null>(() =>
    initialAccount(prefs.current!, multi, accountChoices(state.config, state.ghAccounts)),
  );
  const [accountPicked, setAccountPicked] = useState(account !== null);
  // Only a pick made in this dialog outlasts a folder change: a remembered account goes back to
  // the folder's once the user picks another folder, so a session never runs as the wrong account.
  const pickedHere = useRef(false);
  // Fields the user changed in this dialog: an account switch leaves them as they are.
  const touched = useRef(new Set<keyof NewSessionChoice>());
  const touch = (f: keyof NewSessionChoice) => {
    touched.current.add(f);
    setNotes(({ [f]: _gone, ...rest }) => rest);
    if (f === "cwd" && !pickedHere.current) setAccountPicked(false);
  };
  const [notes, setNotes] = useState<ChoiceNotes>({});
  const [ready, setReady] = useState(false);
  // Whose choices to put in the fields: the opening account, then each account the user picks.
  const [fillFor, setFillFor] = useState<{ login: string | null }>({ login: account });
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const c = choiceFor(prefs.current!, multi, fillFor.login);
    const known = !!c?.cwd && repos.some((r) => r.path === c.cwd);
    void (c?.cwd && !known ? deck().folderExists(c.cwd).catch(() => false) : Promise.resolve(known)).then((cwdExists) => {
      if (!alive) return;
      const r = resolveChoice(c, {
        defaultCwd: repos[0]?.path ?? "",
        cwdExists,
        models: MODELS.map((m) => m.value),
        configured,
        workflows: templates.map((t) => t.id),
        defaultWorkflow: DEFAULT_TEMPLATE,
        modes: MODES.map(([v]) => v),
      });
      const t = touched.current;
      if (!t.has("cwd")) setCwd(r.choice.cwd);
      if (!t.has("model")) setModel(r.choice.model);
      if (!t.has("workflow")) setWorkflow(r.choice.workflow);
      if (!t.has("mode")) setMode(r.choice.mode);
      setNotes(Object.fromEntries(Object.entries(r.notes).filter(([f]) => !t.has(f as keyof NewSessionChoice))));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fillFor]);
  useEffect(() => {
    if (!multi || accountPicked) return;
    setAccount(null);
    if (!cwd) return;
    let alive = true;
    void deck()
      .accountFor(cwd)
      .then((a) => alive && setAccount(a));
    return () => {
      alive = false;
    };
  }, [multi, accountPicked, cwd]);
  // The lists a remembered choice is checked against; the fields are filled once all are in.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      deck().workspaceRepos().catch(() => [] as Repo[]),
      deck().defaultModel().catch(() => null),
      can("workflowGet")
        ? deck()
            .workflowGet()
            .then((w) => w.templates)
            .catch(() => [] as WorkflowTemplate[])
        : Promise.resolve([] as WorkflowTemplate[]),
    ]).then(([r, m, t]) => {
      if (!alive) return;
      setRepos(r);
      setConfigured(m);
      setTemplates(t);
      setReady(true);
    });
    return () => {
      alive = false;
    };
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
    if (!cwd || !nameOk || !promptOk || (multi && !account)) return;
    const text = prompt.trim();
    const block = peers.length ? peersPromptBlock(peerFactsFor(state, peers, peerSummaries)) : "";
    onStart({
      name,
      cwd,
      // No prompt but linked peers: the peers block alone starts the session with their context.
      prompt: text
        ? block
          ? `${text}\n\n${block}`
          : text
        : block
          ? `Context from MasterDeck (linked sessions):\n\n${block}`
          : undefined,
      model: model || undefined,
      workflow: workflow === DEFAULT_TEMPLATE ? undefined : workflow,
      mode: mode || undefined,
      ...(account ? { account } : {}),
      ...(peers.length ? { peers } : {}),
      ...(state.sessionGroups?.groups.length ? { group: shownTab(state.sessionGroups, group) } : {}),
    });
    // These become the account's last choices; name, message and peers are this session's only.
    save(NEW_SESSION_PREFS_KEY, rememberChoice(prefs.current!, multi, account, { cwd, model, workflow, mode }));
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
        <AccountSelect
          state={state}
          value={account}
          onChange={(l) => {
            setAccount(l);
            setAccountPicked(true);
            pickedHere.current = true;
            setFillFor({ login: l });
          }}
        />
        {Object.keys(notes).length > 0 && (
          <div className="meta">
            {Object.values(notes).map((n) => (
              <div key={n}>{n}</div>
            ))}
          </div>
        )}
        <label>Workspace</label>
        <div className="ns-row">
          <select
            className="fsel full"
            value={other ? "__other" : cwd}
            onChange={(e) => {
              if (e.target.value === "__other") return void pickOther();
              touch("cwd");
              setCwd(e.target.value);
            }}
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
        <PeerPicker state={state} value={peers} onChange={setPeers} />
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
              onChange={(e) => {
                touch("model");
                setModel(e.target.value);
              }}
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
              onChange={(e) => {
                touch("workflow");
                setWorkflow(e.target.value);
              }}
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
          onChange={(e) => {
            touch("mode");
            setMode(e.target.value);
          }}
        >
          {MODES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <SessionTabSelect id="ns-group" groups={state.sessionGroups} value={group} onChange={setGroup} />
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
            disabled={!cwd || !nameOk || !promptOk || (multi && !account)}
            onClick={start}
            title="⌘↵"
          >
            Start session
          </button>
        </div>
      </div>
      {picking && (
        <RepoPicker
          start={cwd}
          onDone={(p) => {
            setPicking(false);
            if (!p) return;
            touch("cwd");
            setCwd(p);
          }}
        />
      )}
    </div>,
    document.body,
  );

  async function pickOther() {
    // The web cannot open the Mac's folder window: pick from the repos or type a path.
    if (!can("pickFolder")) return setPicking(true);
    const p = await deck().pickFolder(cwd || undefined);
    if (!p) return;
    touch("cwd");
    setCwd(p);
  }
}

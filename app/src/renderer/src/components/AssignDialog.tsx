import { actionCount, type WorkflowTemplate } from "@shared/flow";
import { useEffect, useRef, useState } from "react";
import { ticketKey, ticketLabel, ticketOf } from "@shared/ticket";
import { pendingAssign } from "@shared/derive";
import type { AssignRequest, Template } from "@shared/ipc";
import { defaultModelLabel, MODELS } from "@shared/models";
import { composePrompt, earlierBlock } from "@shared/prompt";
import type { AppState, DraftAssign, Issue } from "@shared/types";
import { formatAgo } from "@shared/format";
import { defaultAccount, accountOverride, resumeAccount } from "@shared/accounts";
import { isMulti } from "@shared/accounts";
import { adoptFresh, folderKind, folderOf, startChoice, swapPrompt as swapped, type StartFolder } from "@shared/startFolder";
import { AccountBadge, AccountSelect } from "./AccountBits";
import { deck } from "../deck";
import { can } from "../web";

interface Props {
  issue: Issue;
  state: AppState;
  onClose: () => void;
  /** Start is fire-and-forget: the caller switches to the terminal and tracks the spawn. */
  onStart: (req: AssignRequest) => void;
  /** Opens the Link dialog for this issue instead of starting a new session. */
  onLink: () => void;
  /** Pre-filled first instructions (e.g. "fix CI" routed from My PRs). */
  initialInstructions?: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function AssignDialog({
  issue,
  state,
  onClose,
  onStart,
  onLink,
  initialInstructions,
}: Props) {
  const pending = pendingAssign(state.proposals, ticketOf(issue));
  const approved =
    pending?.status === "approved" && pending.target.spawn ? pending : null;
  const [draft, setDraft] = useState<DraftAssign | null>(null);
  const [name, setName] = useState("");
  const [system, setSystem] = useState("");
  const [instructions, setInstructions] = useState(initialInstructions ?? "");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [savingAs, setSavingAs] = useState<string | null>(null);
  // '' = start without --model: Claude Code's default (the one in settings.json, if set).
  const [model, setModel] = useState("");
  const [configuredModel, setConfiguredModel] = useState<string | null>(null);
  // The workflow the new session starts with (a copy of it): the default, or a template.
  const [workflow, setWorkflow] = useState("default");
  // The issue's account by default; picking another starts (or resumes) as that one.
  const defAccount = defaultAccount({ issue: { repo: issue.repo ?? null } }, state.config);
  const [account, setAccount] = useState<string | null>(defAccount);
  const [accountPicked, setAccountPicked] = useState(false);
  const override = accountOverride(account, defAccount, state.config);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  useEffect(() => {
    void deck()
      .workflowGet()
      .then((w) => setWorkflows(w.templates));
  }, []);
  useEffect(() => {
    void deck().templates().then(setTemplates);
    void deck().defaultModel().then(setConfiguredModel);
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Where the session starts. The master CLI picks it (the repository's checkout under its
  // account's workspace, else that workspace); Choose folder… replaces it.
  const [folder, setFolder] = useState<StartFolder | null>(null);
  const [chosen, setChosen] = useState(false);
  const chosenPath = useRef<string | null>(null);
  // The prompts MasterDeck's drafts wrote: a new draft replaces the system prompt only while it
  // is one of them (never one the user edited, or one master wrote by hand in its proposal).
  const generic = useRef<string[]>([]);
  const learn = (d: DraftAssign) => {
    generic.current.push(d.prompt, ...(d.genericPrompt ? [d.genericPrompt] : []));
  };
  const swapPrompt = (d: DraftAssign) => {
    const known = [...generic.current];
    learn(d);
    setSystem((cur) => swapped(cur, known, d.prompt));
  };
  const choose = async () => {
    const p = await deck().pickFolder(folder?.cwd);
    if (!p) return;
    chosenPath.current = p;
    setChosen(true);
    setFolder((cur) => ({ ...cur, cwd: p, found: undefined }));
    // The same resolver says whether it is a checkout of the repository, and words the prompt for it.
    const r = await deck().draftAssign(ticketOf(issue), issue.title, issue.url, p);
    if (!r.ok || chosenPath.current !== p || r.draft.cwd !== p) return;
    setFolder(folderOf(r.draft));
    swapPrompt(r.draft);
  };
  // Stopped sessions that worked on this issue, newest first; resuming continues one instead.
  const past = state.pastSessions[ticketKey(issue.repo, issue.number)] ?? [];
  const [resuming, setResuming] = useState<string | null>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  // The ticket's GitHub description: null while loading; editable, and sent when `useDesc` is on.
  const [desc, setDesc] = useState<string | null>(null);
  const [descError, setDescError] = useState<string | null>(null);
  const [useDesc, setUseDesc] = useState(true);
  // What earlier sessions on this ticket did (their saved summaries): context for the new one.
  const [memory, setMemory] = useState<
    { name: string; at: number; text: string }[]
  >([]);
  const [useMemory, setUseMemory] = useState(true);
  useEffect(() => {
    void deck().ticketMemory(ticketOf(issue)).then(setMemory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number, issue.repo]);
  useEffect(() => {
    let alive = true;
    void deck()
      .issueBody(ticketOf(issue))
      .then((r) => {
        if (!alive) return;
        if (r.ok) setDesc(r.body);
        else {
          setDesc("");
          setDescError(r.message);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number, issue.repo]);

  useEffect(() => {
    let alive = true;
    const fromProposal = pending && pending.target.spawn ? pending : null;
    const use = (d: DraftAssign) => {
      setDraft(d);
      setName(d.name);
      setSystem(d.prompt);
      // A proposal's prompt may be master's own words: only a draft from the CLI is known to be generic.
      if (d.proposalId === null) learn(d);
      setFolder(folderOf(d));
      setLoading(false);
      setTimeout(() => instructionsRef.current?.focus(), 0);
    };
    if (fromProposal) {
      const sp = fromProposal.target.spawn!;
      use({
        issue: issue.number,
        repo: issue.repo ?? null,
        name: sp.name,
        cwd: sp.cwd ?? state.masterWorkspace,
        prompt: sp.prompt ?? fromProposal.message,
        summary: fromProposal.summary,
        title: issue.title,
        url: issue.url,
        proposalId: fromProposal.id,
      });
      // The proposal only has its folder: look the ticket up now, for where it would start today.
      void deck()
        .draftAssign(ticketOf(issue), issue.title, issue.url)
        .then((r) => {
          if (!alive || !r.ok || chosenPath.current) return;
          const was = sp.cwd ?? state.masterWorkspace;
          const now = adoptFresh(was, r.draft, state.config.workspace || state.masterWorkspace);
          setFolder(now);
          // Moved to a checkout: the prompt follows, when it is the generic one. Otherwise the
          // generic texts are only learnt (for Choose folder… later).
          if (now.cwd !== was) {
            if (r.draft.genericPrompt) generic.current.push(r.draft.genericPrompt);
            swapPrompt(r.draft);
          } else learn(r.draft);
        });
      return () => {
        alive = false;
      };
    }
    void deck()
      .draftAssign(ticketOf(issue), issue.title, issue.url)
      .then((r) => {
        if (!alive) return;
        if (r.ok) use(r.draft);
        else {
          setLoading(false);
          setError(r.message);
        }
      });
    return () => {
      alive = false;
    };
    // Load once per dialog; later ledger updates must not overwrite the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nameOk = NAME_RE.test(name);
  const prompt = composePrompt(
    system,
    instructions,
    useDesc ? (desc ?? "") : "",
    useMemory ? earlierBlock(memory) : "",
  );
  const promptOk = prompt.length > 0 && !prompt.startsWith("-");

  const start = () => {
    if (!draft || !nameOk || !promptOk) return;
    const cwd = folder?.cwd || draft.cwd;
    // Nothing differs from master's proposal: it is approved as it is. Otherwise a new one, which
    // keeps the model master named unless one was picked here.
    const choice = startChoice(
      draft,
      { name, prompt, cwd, model, override: !!override },
      draft.proposalId !== null ? pending?.target.spawn?.model : undefined,
    );
    const unchanged = !choice.edited;
    onStart({
      issue: issue.number,
      repo: issue.repo ?? null,
      name,
      cwd,
      prompt,
      proposalId: draft.proposalId,
      edited: !unchanged,
      approved:
        unchanged &&
        draft.proposalId !== null &&
        draft.proposalId === approved?.id,
      model: choice.model,
      workflow: workflow === "default" ? undefined : workflow,
      ...(override ? { account: override } : {}),
    });
    onClose();
  };

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog"
        role="dialog"
        aria-label={`Start a session for #${issue.number}`}
      >
        <h3>
          <span
            className="kind"
            style={{ ["--kind" as string]: "var(--purple)" }}
          >
            START
          </span>
          #{issue.number} {issue.title}
        </h3>
        <div className="meta">
          {issue.status ?? "No board status"}
          {issue.currentSprint ? " · current sprint" : ""} ·{" "}
          <button
            className="link-btn"
            onClick={() => deck().openExternal(issue.url)}
          >
            open on GitHub ↗
          </button>
          {draft?.proposalId != null && (
            <>
              {" "}
              · from master's proposal {draft.proposalId}
              {approved ? " (approved, not started yet)" : ""}
            </>
          )}
        </div>
        <AccountSelect state={state} value={account} onChange={(l) => {
            setAccount(l);
            setAccountPicked(true);
          }}
        />

        {past.length > 0 && (
          <div className="past">
            <label>
              Earlier sessions on #{issue.number}: resume one to carry on where
              it stopped
            </label>
            {past.map((p) => (
              <div key={p.sessionId} className="past-row">
                <span className="grow" title={`${p.sessionId}\n${p.cwd ?? ""}`}>
                  ⏸ {p.name}{" "}
                  <AccountBadge login={isMulti(state.config) ? resumeAccount(p.account, account, accountPicked, state.config) : null} />{" "}
                  <span className="muted">
                    · {formatAgo(Date.now() - p.lastActivity)} ago
                    {p.cwd ? ` · ${p.cwd.split("/").slice(-2).join("/")}` : ""}
                  </span>
                </span>
                <button
                  className="btn"
                  disabled={resuming !== null}
                  onClick={async () => {
                    setResuming(p.sessionId);
                    const r = await deck().resumeSession(
                      p.sessionId,
                      p.name,
                      p.cwd,
                      resumeAccount(p.account, account, accountPicked, state.config),
                    );
                    setResuming(null);
                    if (r.ok) onClose();
                    else setError(r.message);
                  }}
                >
                  {resuming === p.sessionId ? "Resuming…" : "Resume"}
                </button>
              </div>
            ))}
            <label>Or start a new session</label>
          </div>
        )}
        {loading ? (
          <p className="meta">Drafting…</p>
        ) : draft ? (
          <>
            {/* Near the top: the dialog scrolls on a short window, and "no checkout found" must be seen. */}
            <StartFolderLine
              folder={folder ?? { cwd: draft.cwd }}
              chosen={chosen}
              account={isMulti(state.config) ? account : null}
              onChoose={can("pickFolder") ? choose : undefined}
            />
            <label>Session name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
            {!nameOk && (
              <div className="error" style={{ fontSize: 11, marginTop: 3 }}>
                Letters, digits, dot, dash and underscore; up to 64 characters.
              </div>
            )}
            <label>Model</label>
            <select
              className="fsel full"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              title="claude --model for the new session"
            >
              <option value="">{defaultModelLabel(configuredModel)}</option>
              {MODELS.filter((m) => m.value !== configuredModel).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            {workflows.length > 1 && (
              <>
                <label>Workflow</label>
                <select
                  className="fsel full"
                  value={workflow}
                  onChange={(e) => setWorkflow(e.target.value)}
                  title="The session gets its own copy of this workflow; change it later from its Details (Workflow → Edit)"
                >
                  {workflows.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({actionCount(t.flow)} blocks)
                    </option>
                  ))}
                </select>
              </>
            )}
            <div className="label-row">
              <label>Ticket description</label>
              <span style={{ flex: 1 }} />
              <label
                className="check"
                title="Send the description (as edited here) with the first instructions"
              >
                <input
                  type="checkbox"
                  checked={useDesc && !!desc?.trim()}
                  disabled={!desc?.trim()}
                  onChange={(e) => setUseDesc(e.target.checked)}
                />
                Include as instructions
              </label>
            </div>
            {desc === null ? (
              <div className="meta">Loading the description from GitHub…</div>
            ) : (
              <textarea
                className={`desc${useDesc && desc.trim() ? "" : " off"}`}
                value={desc}
                placeholder={
                  descError
                    ? `Could not load the description: ${descError}`
                    : "This ticket has no description."
                }
                onChange={(e) => setDesc(e.target.value)}
                spellCheck={false}
              />
            )}
            {memory.length > 0 && (
              <label
                className="check memory-check"
                title={memory
                  .slice(0, 3)
                  .map((m) => `${m.name}: ${m.text.slice(0, 200)}…`)
                  .join("\n\n")}
              >
                <input
                  type="checkbox"
                  checked={useMemory}
                  onChange={(e) => setUseMemory(e.target.checked)}
                />
                Include what earlier sessions on{" "}
                {ticketLabel(issue.repo ?? null, issue.number)} did (
                {Math.min(3, memory.length)} summar
                {Math.min(3, memory.length) === 1 ? "y" : "ies"})
              </label>
            )}
            <label>System prompt</label>
            <textarea
              className="system"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              spellCheck={false}
            />
            <div className="label-row">
              <label>Your first instructions (optional)</label>
              <span style={{ flex: 1 }} />
              <select
                className="fsel"
                value=""
                onChange={(e) => {
                  const t = templates.find((x) => x.name === e.target.value);
                  if (t)
                    setInstructions((cur) =>
                      cur.trim() ? `${cur.trim()}\n\n${t.text}` : t.text,
                    );
                }}
                title="Insert a saved instruction snippet"
              >
                <option value="">Template…</option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.builtin ? "" : "★ "}
                    {t.name}
                  </option>
                ))}
              </select>
              {savingAs === null ? (
                <button
                  className="link-btn"
                  disabled={!instructions.trim()}
                  onClick={() => setSavingAs("")}
                >
                  Save as template
                </button>
              ) : (
                <>
                  <input
                    className="tpl-name"
                    autoFocus
                    placeholder="Template name"
                    value={savingAs}
                    onChange={(e) => setSavingAs(e.target.value)}
                  />
                  <button
                    className="link-btn"
                    disabled={!savingAs.trim()}
                    onClick={async () => {
                      setTemplates(
                        await deck().saveTemplate({
                          name: savingAs.trim(),
                          text: instructions.trim(),
                        }),
                      );
                      setSavingAs(null);
                    }}
                  >
                    Save
                  </button>
                </>
              )}
            </div>
            <textarea
              ref={instructionsRef}
              className="instructions"
              value={instructions}
              placeholder="e.g. Fix the web half only; keep native as is. Use the existing NotificationBell component."
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
              }}
            />
            <div className="meta" style={{ marginTop: 6 }}>
              {instructions.trim() || (useDesc && desc?.trim())
                ? "Sent after the system prompt; the session follows these instead of stopping to ask."
                : "Empty: the session sets up, then asks you for instructions."}
            </div>

            <div className="foot">
              <button
                className="btn"
                onClick={onLink}
                title="Link a session that already exists to this ticket"
              >
                Link session…
              </button>
              <span className="grow">
                {error && <span className="error">{error}</span>}
              </span>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!nameOk || !promptOk}
                onClick={start}
                title="⌘↵"
              >
                Start
              </button>
            </div>
          </>
        ) : (
          <div className="foot">
            <button className="btn" onClick={onLink}>
              Link session…
            </button>
            <span className="grow error">
              {error ?? "Could not draft this issue."}
            </span>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where the session starts and as whom. No checkout of the ticket's repository in its account's
 * workspace is said plainly; it never blocks the start. `onChoose` absent (the web app): no picker.
 */
function StartFolderLine({
  folder,
  chosen,
  account,
  onChoose,
}: {
  folder: StartFolder;
  chosen: boolean;
  account: string | null;
  onChoose?: () => void;
}) {
  const kind = folderKind(folder, chosen);
  const dir = <code className="mono">{folder.cwd}</code>;
  return (
    <div className={`start-folder${kind === "missing" || kind === "missing-partial" ? " missing" : ""}`}>
      <span>
        <span className="why">
        {kind === "missing-partial" ? (
          <>
            No checkout of {folder.checkoutOf} found — only the first{" "}
            {folder.searched} folders of{" "}
            <code className="mono">{folder.workspace || folder.cwd}</code> were
            searched. The session starts in that folder; if the repository is
            there, choose its folder.
          </>
        ) : kind === "missing" ? (
          <>
            No checkout of {folder.checkoutOf} found in{" "}
            <code className="mono">{folder.workspace || folder.cwd}</code>. The
            session starts in that folder and has to find the repository
            itself.
          </>
        ) : kind === "found" ? (
          <>
            Starts in {dir}, your checkout of {folder.checkoutOf}.
          </>
        ) : kind === "chosen-found" ? (
          <>
            Starts in {dir}, the folder you chose (a checkout of{" "}
            {folder.checkoutOf}).
          </>
        ) : kind === "chosen" ? (
          <>Starts in {dir}, the folder you chose.</>
        ) : (
          <>Starts in {dir}.</>
        )}
        </span>
        {account && (
          <>
            {" "}
            Runs as <AccountBadge login={account} />.
          </>
        )}
      </span>
      {onChoose && (
        <button className="link-btn" onClick={onChoose}>
          Choose folder…
        </button>
      )}
    </div>
  );
}

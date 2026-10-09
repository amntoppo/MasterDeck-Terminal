import { actionCount, type WorkflowTemplate } from "@shared/flow";
import { useEffect, useRef, useState } from "react";
import { sameTicket, ticketKey, ticketLabel, ticketOf } from "@shared/ticket";
import { pendingAssign } from "@shared/derive";
import type { AssignRequest, DeckApi, Template } from "@shared/ipc";
import { defaultModelLabel, MODELS } from "@shared/models";
import { composePrompt, earlierBlock, peersPromptBlock } from "@shared/prompt";
import type { AppState, DraftAssign, Issue } from "@shared/types";
import { formatAgo } from "@shared/format";
import { startAccount, accountOverride, resumeAccount } from "@shared/accounts";
import { isMulti } from "@shared/accounts";
import { adoptFresh, folderKind, folderOf, refindOnAccount, startChoice, swapPrompt as swapped, type StartFolder } from "@shared/startFolder";
import { startBlocked, startFlags, trustHeldAssign } from "@shared/trust";
import { baseError, branchError, parsePrefs, PERMISSION_MODES, prefsKey, ticketBranch, worktreeDir, worktreeNote, type StartPrefs } from "@shared/startOptions";
import { AccountBadge, AccountSelect } from "./AccountBits";
import { TrustNote, useTrust } from "./TrustFix";
import { MarkdownView } from "./MarkdownView";
import { PeerPicker } from "./PeerPicker";
import { peerFactsFor, type PeerSummaries } from "./peersView";
import { deck, load, save } from "../deck";
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
  // A start of this ticket that Claude Code refused for its folder and that is still held: the
  // dialog starts from it and, unchanged, tries that same proposal again instead of adding one.
  const held = pending ? null : trustHeldAssign(state.proposals, ticketOf(issue));
  const [draft, setDraft] = useState<DraftAssign | null>(null);
  const [name, setName] = useState("");
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
  const [system, setSystem] = useState("");
  const [instructions, setInstructions] = useState(initialInstructions ?? "");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [savingAs, setSavingAs] = useState<string | null>(null);
  // The choices kept for this repository by "Remember these choices"; none: today's defaults.
  // Never for a dialog that starts from a proposal (master's, or the ticket's refused start):
  // unchanged, that proposal is approved or tried again as it is, and a remembered model, mode
  // or worktree would make every such start a new proposal.
  const fromProposal = useRef(!!pending?.target.spawn || held !== null).current;
  const prefs = useRef(fromProposal ? null : parsePrefs(load<unknown>(prefsKey(issue.repo), null))).current;
  const [remember, setRemember] = useState(prefs !== null);
  // '' = start without --model: Claude Code's default (the one in settings.json, if set).
  const [model, setModel] = useState(prefs?.model ?? "");
  // '' = start without --permission-mode: Claude Code's default.
  const [permissionMode, setPermissionMode] = useState(prefs?.permissionMode ?? "");
  const [configuredModel, setConfiguredModel] = useState<string | null>(null);
  // The workflow the new session starts with (a copy of it): the default, or a template.
  const [workflow, setWorkflow] = useState(prefs?.workflow ?? "default");
  // The account of the repository the ticket's code is in (else the issue's) by default; picking
  // another starts (or resumes) as that one, and its workspace is looked in for the folder.
  const defAccount = startAccount(issue.repo ?? null, state.config);
  const [account, setAccount] = useState<string | null>(defAccount);
  const [accountPicked, setAccountPicked] = useState(false);
  const override = accountOverride(account, defAccount, state.config);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  useEffect(() => {
    void deck()
      .workflowGet()
      .then((w) => {
        setWorkflows(w.templates);
        // A remembered template that is gone: the default again.
        setWorkflow((cur) => (w.templates.some((t) => t.id === cur) ? cur : "default"));
      });
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
  // Claude Code starts a session only in a folder whose trust prompt was accepted. The draft says
  // whether this one is; a folder it says nothing about (the proposal's own) is asked about once.
  const trust = useTrust(folder?.cwd ?? null, folder ? folder.trusted : null);
  // Start regardless: what was read may be wrong, and Claude Code decides.
  const [anyway, setAnyway] = useState(false);
  const blocked = startBlocked(trust.trusted, { desktop: trust.desktop, anyway });
  // While the user answers Claude Code's prompt in the tab that opened, the dialog is out of the
  // way (it would cover the terminal) and keeps what was typed; it comes back once the folder is
  // trusted, or when the wait ends.
  const [away, setAway] = useState(false);
  useEffect(() => {
    if (trust.opened && trust.trusted !== true) setAway(true);
    else setAway(false);
  }, [trust.opened, trust.trusted]);
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
    // Nothing is known of the new folder yet, its trust included (asked about at once).
    setFolder((cur) => ({ ...cur, cwd: p, found: undefined, trusted: undefined }));
    setAnyway(false);
    // The same resolver says whether it is a checkout of the repository, and words the prompt for it.
    const r = await deck().draftAssign(ticketOf(issue), issue.title, issue.url, p);
    if (!r.ok || chosenPath.current !== p || r.draft.cwd !== p) return;
    setFolder(folderOf(r.draft));
    swapPrompt(r.draft);
  };
  // Another account picked: the folder is looked for again in its workspace (the latest pick wins).
  const refinding = useRef(0);
  const refind = async (login: string | null) => {
    if (!refindOnAccount(folder, chosen, !!held)) return;
    const n = ++refinding.current;
    const other = accountOverride(login, defAccount, state.config);
    const r = await deck().draftAssign(ticketOf(issue), issue.title, issue.url, undefined, other ?? undefined);
    if (!r.ok || n !== refinding.current || chosenPath.current) return;
    setFolder(folderOf(r.draft));
    setAnyway(false);
    swapPrompt(r.draft);
  };
  // Stopped sessions that worked on this issue, newest first; resuming continues one instead.
  const past = state.pastSessions[ticketKey(issue.repo, issue.number)] ?? [];
  const [resuming, setResuming] = useState<string | null>(null);
  // Create worktree: MasterDeck makes the ticket's worktree (a new branch from `base`) under the
  // checkout, and the session starts in it. Only the Mac's own window can (git runs on the Mac).
  // Not for the ticket's refused start: its folder and prompt are the whole start already.
  const canWorktree = can("worktreeCreate") && !(held !== null && !pending);
  const [worktree, setWorktree] = useState(!!prefs?.worktree);
  const [branch, setBranch] = useState(() => ticketBranch(issue.number, issue.title));
  const [base, setBase] = useState(prefs?.base ?? "");
  const baseTyped = useRef(!!prefs?.base);
  const [repoInfo, setRepoInfo] = useState<Awaited<ReturnType<DeckApi["worktreeInfo"]>> | null>(null);
  const startCwd = folder?.cwd ?? null;
  useEffect(() => {
    if (!canWorktree || !startCwd) return;
    let alive = true;
    setRepoInfo(null);
    void deck()
      .worktreeInfo(startCwd)
      .then((r) => {
        if (!alive) return;
        setRepoInfo(r);
        if (r.ok && !baseTyped.current) setBase(r.base);
      });
    return () => {
      alive = false;
    };
  }, [startCwd, canWorktree]);
  // Only in the ticket's own checkout or a folder chosen for it: in a workspace where no checkout
  // was found the session has to find the repository itself, and a worktree would pin it there.
  const startKind = folder ? folderKind(folder, chosen) : "plain";
  const worktreeHere = repoInfo?.ok === true && startKind !== "missing" && startKind !== "missing-partial";
  // Ticked and possible: a remembered tick does nothing in a folder that takes no worktree.
  const worktreeOn = canWorktree && worktree && worktreeHere;
  const worktreeError = worktreeOn ? (branchError(branch.trim()) ?? (base.trim() === "HEAD" ? null : baseError(base.trim()))) : null;
  // Assign me: only a ticket nobody has, and only when its assignees are known (a board card).
  const card = state.board?.cards.find((c) => sameTicket(c, issue));
  // "Me" is the account the session runs as (two or more), as on the Board; else my login.
  const meLogin = isMulti(state.config) ? account : state.me;
  const canAssignMe = !!meLogin && !!card && card.assignees.length === 0 && can("assignIssue");
  const [assignMe, setAssignMe] = useState(!!prefs?.assignMe);
  const assigned = useRef(false);
  // What Start is doing before the session is asked for (assigning, making the worktree).
  const [busy, setBusy] = useState<string | null>(null);
  // Start is on its way (assigning, making the worktree): the dialog stays until that is done or
  // has failed, so a start that was asked for is never half cancelled.
  const close = () => {
    if (!busy) onClose();
  };
  // The description as rendered Markdown instead of the text; the text itself is never touched.
  const [preview, setPreview] = useState(false);
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
    const fromProposal = pending && pending.target.spawn ? pending : held;
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
      // The refused start's prompt is the whole first message already (description and earlier
      // sessions included): sent again as it is, not wrapped a second time.
      if (fromProposal === held) {
        setUseDesc(false);
        setUseMemory(false);
      }
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
      // Out of the way: Escape belongs to the Claude the user is answering.
      if (e.key === "Escape" && !away) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, away, busy]);

  const nameOk = NAME_RE.test(name);
  // `setup`: what MasterDeck already did for the session (the worktree it made).
  const compose = (setup = "") =>
    composePrompt(
      system,
      instructions,
      useDesc ? (desc ?? "") : "",
      useMemory ? earlierBlock(memory) : "",
      setup,
      peersPromptBlock(peerFactsFor(state, peers, peerSummaries)),
    );
  const promptOk = compose().length > 0 && !compose().startsWith("-");
  const ready = !!draft && nameOk && promptOk && !blocked && !busy && !worktreeError;

  const start = async () => {
    if (!draft || !ready) return;
    setError(null);
    let cwd = folder?.cwd || draft.cwd;
    let setup = "";
    // A call that throws (main, or a dropped line to the Mac) is a failure like any other: the
    // dialog must never be left busy, since it cannot be closed while it is.
    const step = async <T extends { ok: boolean }>(label: string, call: () => Promise<T>): Promise<T | { ok: false; message: string }> => {
      setBusy(label);
      try {
        return await call();
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    };
    // Everything that can fail happens first and is said here: no session starts half set up.
    if (canAssignMe && assignMe && !assigned.current) {
      const a = await step("Assigning…", () => deck().assignIssue(ticketOf(issue), meLogin!, []));
      if (!a.ok) {
        setBusy(null);
        setError(`${a.message}. Untick "Assign to me" to start without it.`);
        return;
      }
      assigned.current = true;
    }
    if (worktreeOn) {
      const w = await step("Creating worktree…", () => deck().worktreeCreate(cwd, branch.trim(), base.trim() || "HEAD"));
      if (!w.ok) {
        setBusy(null);
        setError(w.message);
        return;
      }
      cwd = w.cwd;
      setup = worktreeNote(w);
    }
    const prompt = compose(setup);
    const kept: StartPrefs = {
      worktree,
      // The repository's own default is not kept as a name: it is looked up again next time.
      base: repoInfo?.ok && base.trim() === repoInfo.base ? "" : base.trim(),
      model,
      permissionMode,
      workflow,
      assignMe,
    };
    // Unticked in a dialog that never read them (it started from a proposal): they stay as they are.
    if (remember || !fromProposal) save(prefsKey(issue.repo), remember ? kept : null);
    // Nothing differs from master's proposal: it is approved as it is. Otherwise a new one, which
    // keeps the model master named unless one was picked here.
    const choice = startChoice(
      draft,
      { name, prompt, cwd, model, override: !!override, permissionMode },
      draft.proposalId !== null ? (pending ?? held)?.target.spawn?.model : undefined,
    );
    const unchanged = !choice.edited;
    // A new proposal keeps the mode the one it replaces named, as it keeps its model.
    const mode =
      permissionMode ||
      (draft.proposalId !== null && !unchanged ? (pending ?? held)?.target.spawn?.permissionMode : undefined);
    onStart({
      issue: issue.number,
      repo: issue.repo ?? null,
      name,
      cwd,
      prompt,
      proposalId: draft.proposalId,
      edited: !unchanged,
      ...startFlags({
        proposalId: draft.proposalId,
        edited: !unchanged,
        approvedId: approved?.id,
        heldId: held?.id,
      }),
      model: choice.model,
      ...(mode ? { permissionMode: mode } : {}),
      workflow: workflow === "default" ? undefined : workflow,
      ...(override ? { account: override } : {}),
      ...(peers.length ? { peers } : {}),
    });
    onClose();
  };

  const repoLabel = issue.repo ?? "this repository";
  return (
    <>
    {away && (
      <div className="trust-wait" role="status">
        <span>
          Starting #{issue.number}: accept Claude Code's prompt in this tab. The
          Start dialog comes back by itself.
        </span>
        <button className="btn" onClick={() => setAway(false)}>
          Back to the dialog
        </button>
      </div>
    )}
    <div
      className="backdrop"
      style={away ? { display: "none" } : undefined}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="dialog start"
        role="dialog"
        aria-modal="true"
        aria-label={`Start a session for #${issue.number}`}
        onKeyDown={(e) => {
          // Enter starts from a one-line text field; ⌘↵ / Ctrl+↵ from anywhere (the text boxes too).
          // Not from a tick box, the template's name, or the base branch (Enter there picks a suggestion).
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          const el = e.target as HTMLInputElement;
          const line = el.tagName === "INPUT" && el.type === "text" && !el.dataset.own && !el.list;
          if (e.metaKey || e.ctrlKey || line) {
            e.preventDefault();
            void start();
          }
        }}
      >
        <h3>
          <span
            className="kind"
            style={{ ["--kind" as string]: "var(--purple)" }}
          >
            START
          </span>
          <span className="sd-title">
            #{issue.number} {issue.title}
          </span>
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
              ·{" "}
              {held?.id === draft.proposalId
                ? `the start Claude Code refused (proposal ${draft.proposalId}); it is tried again`
                : `from master's proposal ${draft.proposalId}`}
              {approved ? " (approved, not started yet)" : ""}
            </>
          )}
        </div>

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
            <section className="sd-sec" aria-label="Ticket">
              <h4>Ticket</h4>
              <div className="label-row">
                <label htmlFor="sd-desc">Description</label>
                <div className="seg" role="group" aria-label="Description view">
                  <button
                    type="button"
                    className={preview ? undefined : "on"}
                    aria-pressed={!preview}
                    onClick={() => setPreview(false)}
                    title="The Markdown text, as it is sent; edit it here"
                  >
                    Text
                  </button>
                  <button
                    type="button"
                    className={preview ? "on" : undefined}
                    aria-pressed={preview}
                    onClick={() => setPreview(true)}
                    title="The description as GitHub shows it"
                  >
                    Preview
                  </button>
                </div>
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
              ) : preview ? (
                <div
                  className={`desc-preview${useDesc && desc.trim() ? "" : " off"}`}
                  tabIndex={0}
                  aria-label="Ticket description, rendered"
                >
                  {desc.trim() ? (
                    <MarkdownView text={desc} />
                  ) : (
                    <span className="muted">
                      {descError
                        ? `Could not load the description: ${descError}`
                        : "This ticket has no description."}
                    </span>
                  )}
                </div>
              ) : (
                <textarea
                  id="sd-desc"
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
            </section>

            <section className="sd-sec" aria-label="Where it runs">
              <h4>Where it runs</h4>
              <StartFolderLine
                folder={folder ?? { cwd: draft.cwd }}
                chosen={chosen}
                account={isMulti(state.config) ? account : null}
                onChoose={can("pickFolder") ? choose : undefined}
              />
              {/* Nothing for a trusted folder, or one nothing is known about. */}
              {(trust.trusted === false || trust.opened) && (
                <TrustNote trust={trust} />
              )}
              {canWorktree && (
                <>
                  <label
                    className="check sd-check"
                    title="MasterDeck makes a git worktree for the ticket (a new branch) and starts the session in it; the main checkout stays as it is"
                  >
                    <input
                      type="checkbox"
                      checked={worktreeOn}
                      disabled={!worktreeHere}
                      onChange={(e) => setWorktree(e.target.checked)}
                    />
                    Create worktree
                    <span className="sd-hint inline">
                      {repoInfo === null
                        ? "checking the folder…"
                        : !repoInfo.ok
                          ? "this folder is not a git checkout"
                          : !worktreeHere
                            ? "no checkout of the ticket's repository here: choose its folder first"
                          : worktreeOn
                            ? "the session starts in the worktree below, made from the folder above"
                            : "off: the session starts in the folder above and sets itself up"}
                    </span>
                  </label>
                  {worktreeOn && repoInfo?.ok && (
                    <div className="sd-sub">
                      <div className="sd-grid">
                        <div>
                          <label htmlFor="sd-branch">Branch name</label>
                          <input
                            id="sd-branch"
                            value={branch}
                            onChange={(e) => setBranch(e.target.value)}
                            spellCheck={false}
                            aria-invalid={!!branchError(branch.trim())}
                          />
                        </div>
                        <div>
                          <label htmlFor="sd-base">Base branch</label>
                          <input
                            id="sd-base"
                            list="sd-branches"
                            value={base}
                            onChange={(e) => {
                              baseTyped.current = true;
                              setBase(e.target.value);
                            }}
                            spellCheck={false}
                            title="The new branch starts from this one, as it is on this machine (nothing is fetched)"
                          />
                          <datalist id="sd-branches">
                            {repoInfo.branches.map((b) => (
                              <option key={b} value={b} />
                            ))}
                          </datalist>
                        </div>
                      </div>
                      {worktreeError ? (
                        <div className="sd-hint error">{worktreeError}</div>
                      ) : (
                        <div className="sd-hint">
                          Worktree:{" "}
                          <code className="mono">
                            {repoInfo.root}/.claude/worktrees/{worktreeDir(branch.trim())}
                          </code>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              <div className={`sd-grid${isMulti(state.config) ? "" : " one"}`}>
                <div>
                  <label htmlFor="sd-name">Session name</label>
                  <input
                    id="sd-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    spellCheck={false}
                    aria-invalid={!nameOk}
                  />
                </div>
                <div>
                  <AccountSelect state={state} value={account} onChange={(l) => {
                      setAccount(l);
                      setAccountPicked(true);
                      void refind(l);
                    }}
                  />
                </div>
              </div>
              {!nameOk && (
                <div className="sd-hint error">
                  Session name: letters, digits, dot, dash and underscore; up to 64 characters.
                </div>
              )}
              <PeerPicker state={state} value={peers} onChange={setPeers} />
            </section>

            <section className="sd-sec" aria-label="Options">
              <h4>Options</h4>
              <div className="sd-grid">
                <div>
                  <label htmlFor="sd-model">Model</label>
                  <select
                    id="sd-model"
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
                    {/* A remembered model that is no longer in the list is still the one chosen. */}
                    {model && !MODELS.some((m) => m.value === model && m.value !== configuredModel) && (
                      <option value={model}>{model}</option>
                    )}
                  </select>
                </div>
                <div>
                  <label htmlFor="sd-mode">Permission mode</label>
                  <select
                    id="sd-mode"
                    className="fsel full"
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value)}
                    title={`claude --permission-mode for the new session. ${PERMISSION_MODES.find((m) => m.value === permissionMode)?.hint ?? ""}`}
                  >
                    {PERMISSION_MODES.map((m) => (
                      <option key={m.value} value={m.value} title={m.hint}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                {workflows.length > 1 && (
                  <div>
                    <label htmlFor="sd-flow">Workflow</label>
                    <select
                      id="sd-flow"
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
                  </div>
                )}
              </div>
              <div className="sd-checks">
                {canAssignMe && (
                  <label
                    className="check"
                    title="Nobody is assigned: assign the ticket to you on GitHub before the session starts"
                  >
                    <input
                      type="checkbox"
                      checked={assignMe}
                      onChange={(e) => setAssignMe(e.target.checked)}
                    />
                    Assign to me ({meLogin})
                  </label>
                )}
                <label
                  className="check"
                  title="Use these as the defaults the next time a session is started for a ticket of this repository: worktree, base branch, model, permission mode, workflow, assign to me"
                >
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  Remember these choices for {repoLabel}
                </label>
              </div>
            </section>

            <section className="sd-sec" aria-label="Instructions">
              <h4>Instructions</h4>
              <div className="label-row">
                <label htmlFor="sd-instructions">Your first instructions (optional)</label>
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
                  aria-label="Insert a saved instruction snippet"
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
                      data-own="1"
                      autoFocus
                      placeholder="Template name"
                      aria-label="Template name"
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
                id="sd-instructions"
                ref={instructionsRef}
                className="instructions"
                value={instructions}
                placeholder="e.g. Fix the web half only; keep native as is. Use the existing NotificationBell component."
                onChange={(e) => setInstructions(e.target.value)}
              />
              <div className="sd-hint">
                {instructions.trim() || (useDesc && desc?.trim())
                  ? "Sent after the system prompt; the session follows these instead of stopping to ask."
                  : "Empty: the session sets up, then asks you for instructions."}
              </div>
              {/* Rarely edited: closed until asked for, open at once when it cannot be sent as it is. */}
              <details className="sd-more" open={!promptOk || undefined}>
                <summary>System prompt</summary>
                <textarea
                  className="system"
                  aria-label="System prompt"
                  value={system}
                  onChange={(e) => setSystem(e.target.value)}
                  spellCheck={false}
                />
              </details>
            </section>

            <div className="foot">
              <button
                className="btn"
                onClick={onLink}
                title="Link a session that already exists to this ticket"
              >
                Link session…
              </button>
              <span className="grow" role="alert">
                {error && <span className="error">{error}</span>}
              </span>
              <button className="btn" onClick={close} disabled={!!busy} title="Esc">
                Cancel
              </button>
              {blocked && (
                <button
                  className="link-btn"
                  onClick={() => setAnyway(true)}
                  title="Start without waiting: if Claude Code refuses the folder, the start can be tried again"
                >
                  Start anyway
                </button>
              )}
              <button
                className="btn primary"
                disabled={!ready}
                onClick={() => void start()}
                title={blocked ? "Claude Code has not been allowed to work in this folder yet" : "↵ in a field, ⌘↵ anywhere"}
              >
                {busy ?? "Start"}
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
    </>
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
            No checkout of {folder.checkoutOf}
            {folder.filedIn ? <> (where {folder.filedIn}'s code lives)</> : null} found in{" "}
            <code className="mono">{folder.workspace || folder.cwd}</code>. The
            session starts in that folder and has to find the repository
            itself.
          </>
        ) : kind === "found" ? (
          <>
            Starts in {dir}, your checkout of {folder.checkoutOf}
            {folder.filedIn ? <> (where {folder.filedIn}'s code lives)</> : null}.
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

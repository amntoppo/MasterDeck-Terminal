import { useRef, useState } from "react";
import { AskPanel } from "./AskPanel";
import { StatusDialog } from "./StatusDialog";
import {
  sameTicket,
  ticketLabel,
  ticketUrl,
  type Ticket,
} from "@shared/ticket";
import { sessionTicket } from "@shared/derive";
import { formatAgo, formatDiff, formatPct } from "@shared/format";
import { contextLevel } from "@shared/stats";
import { formatTokens, tokenSum, tokenTitle } from "@shared/tokens";
import { attentionFor, sessionStatus } from "@shared/review";
import { STEPS, taskStep } from "@shared/tasks";
import type { AppState, Session } from "@shared/types";
import { deck, useNow } from "../deck";
import { ticketNote } from "../notes";
import type { NoteMeta } from "@shared/notes";
import { can } from "../web";
import { toggleStar, useStars } from "../stars";
import { webConfirm } from "../webConfirm";
import { WorkflowWidget } from "./SessionWorkflow";
import { MonitorWidget } from "./MonitorWidget";
import { ScheduleWidget } from "./ScheduleWidget";
import { PeersDialog } from "./PeersDialog";
import { peerRows } from "./peersView";

interface Props {
  session: Session;
  state: AppState;
  /** Close its terminal (the session keeps running). */
  onDetach: () => void;
  onAskMaster: (s: Session) => void;
  masterAttached: boolean;
  notes?: NoteMeta[];
  /** Open the ticket's note (absent: Notes is not available here). */
  onNote?: (t: Ticket) => void;
}

/**
 * Everything about the open session, in the right panel's Details tab (it replaced the status bar
 * above the terminal): what waits on you, status, ticket and progress, PRs, branch and worktrees,
 * tokens, context, model, diff, and the session's actions.
 */
export function SessionDetails({
  session: s,
  state,
  onDetach,
  onAskMaster,
  masterAttached,
  notes,
  onNote,
}: Props) {
  const now = useNow(1000);
  const [note, setNote] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [peersOpen, setPeersOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const since = useStateSince(s);
  const starred = useStars().includes(s.key);
  const status = sessionStatus(
    s,
    state.prStage[s.key],
    attentionFor(s, state.proposals),
    state.manualStatus[s.key],
  );
  const step = taskStep(status.key, state.prStage[s.key], !!status.manual);
  const tokens = state.tokens[s.sessionId] ?? null;
  const flash = (t: string) => {
    setNote(t);
    setTimeout(() => setNote((cur) => (cur === t ? null : cur)), 2200);
  };
  const copy = (text: string, what: string) => {
    deck().copy(text);
    flash(`Copied ${what}`);
  };

  const peers = peerRows(state, s.key);
  const t = sessionTicket(s);
  const issue = t ? state.issues.find((i) => sameTicket(i, t)) : undefined;
  const issueLink = issue?.url ?? (t ? ticketUrl(t.repo, t.number) : null);
  // Every PR the session has (several, across repos), newest first; with none of its own, the PRs
  // that reference its issue.
  const linked = state.sessionPrs[s.sessionId] ?? [];
  const issuePrs = t
    ? state.prs
        .filter(
          (p) =>
            p.refsIssue !== null &&
            sameTicket({ repo: p.refsRepo, number: p.refsIssue }, t),
        )
        .map((p) => p.url)
    : [];
  const prUrls = [...new Set(linked.length ? linked : issuePrs)].reverse();
  const git = state.git[s.sessionId];
  const stats = state.stats[s.sessionId];
  const tail = state.tails[s.sessionId];
  const dir = stats?.currentDir ?? tail?.cwd ?? s.cwd;
  const branch = git?.branch ?? tail?.gitBranch ?? null;
  const level = contextLevel(stats?.contextPct ?? null);
  const worktrees = state.sessionWorktrees[s.key] ?? [];
  const hook = state.hookInfo[s.key];
  const menu = state.menus[s.key];
  const ask = state.asks[s.key];
  const waiting =
    s.state === "needs-input" ||
    !!menu ||
    !!s.asking ||
    status.key === "question" ||
    status.key === "blocked";
  const itemId = waiting
    ? [...state.inbox.open, ...state.inbox.snoozed].find(
        (e) =>
          e.item.sessionKey === s.key &&
          ["input", "menu", "question", "blocked"].includes(e.item.kind),
      )?.item.id
    : undefined;
  const openEditor = async (path: string) => {
    const r = await deck().openEditor(path);
    flash(r.ok ? r.message : `Editor: ${r.message}`);
  };

  return (
    <div className="details">
      {waiting && (
        <section className="dsec d-ask">
          <div className="eyebrow bad">
            {menu?.permission
              ? "Permission"
              : s.state === "needs-input"
                ? "Waiting on you"
                : "Asks you"}
          </div>
          <AskPanel
            session={s}
            ask={ask}
            menu={menu}
            fallback={status.why || null}
            full={false}
            itemId={itemId}
          />
        </section>
      )}
      {hook?.failure && (
        <section className="dsec">
          <div className="eyebrow bad">API error</div>
          <div className="d-text">
            {hook.failure.type.replace(/_/g, " ")}: {hook.failure.message}
          </div>
        </section>
      )}

      <section className="dsec">
        <div className="d-row">
          <button
            className={`d-status st-${status.key}`}
            onClick={() => setStatusOpen(true)}
            title={`${status.why ? `${status.text}: ${status.why}\n` : ""}Click to set the status by hand, or stop the session\nraw: ${s.rawState}`}
          >
            <span className={`dot st-${status.key}`} />
            {status.text}
            {status.manual && <span className="muted"> (set)</span>}
            {since !== null &&
              !status.manual &&
              (status.key === "working" ||
                status.key === "idle" ||
                status.key === "needs-input") && (
                <span className="muted"> · {formatAgo(now - since)}</span>
              )}
            <span className="muted"> ▾</span>
          </button>
          <span style={{ flex: 1 }} />
          {s.state !== "done" && s.state !== "suspended" && (
            <button
              className={`d-star ${starred ? "on" : ""}`}
              aria-pressed={starred}
              aria-label={starred ? "Unstar this session" : "Star this session"}
              title={starred ? "Unstar: back to its status group in the sidebar" : "Star: keep it in Starred at the top of the sidebar"}
              onClick={() => toggleStar(s.key)}
            >
              {starred ? "★ Starred" : "☆ Star"}
            </button>
          )}
          {hook?.compacting && <span className="d-tag">Compacting…</span>}
          {note && <span className="d-note">{note}</span>}
        </div>
        {statusOpen && (
          <StatusDialog
            session={s}
            state={state}
            onClose={() => setStatusOpen(false)}
            onStopped={onDetach}
          />
        )}
        {s.kind === "interactive" && (
          <div className="d-text muted">pid {s.pid} · runs outside the app</div>
        )}
      </section>

      <WorkflowWidget session={s} state={state} />
      <MonitorWidget session={s} state={state} />
      <ScheduleWidget session={s} state={state} />

      <section className="dsec">
        <div className="eyebrow">Ticket</div>
        {issueLink ? (
          <button
            className="d-link"
            onClick={() => deck().openExternal(issueLink)}
            title="Open on GitHub"
          >
            <span className="mono">
              {ticketLabel(s.issueRepo, s.issue ?? 0)}
            </span>{" "}
            {issue?.title ?? "Open the issue"} ↗
          </button>
        ) : (
          <div className="d-text muted">No issue linked</div>
        )}
        {t && issueLink && onNote && can("notesList") && (() => {
          const tn = ticketNote(notes ?? [], t.repo, t.number);
          return (
            <div className="d-note">
              {tn && <div className="d-note-text">{tn.preview}</div>}
              <button className="d-link" onClick={() => onNote(t)}>
                {tn ? "Edit note" : "Add note"}
              </button>
            </div>
          );
        })()}
        <div
          className={`d-steps tone-${step.tone}`}
          title={STEPS.map(
            (n, i) => `${i < step.at ? "✓" : i === step.at ? "▶" : "·"} ${n}`,
          ).join("\n")}
        >
          {STEPS.map((n, i) => (
            <i
              key={n}
              className={
                i < step.at || (i === step.at && step.tone === "done")
                  ? "past"
                  : i === step.at
                    ? "here"
                    : ""
              }
            />
          ))}
        </div>
        <div className={`d-stepname tone-${step.tone}`}>
          {step.at + 1}/5 {STEPS[step.at]}
          {step.note ? <span className="muted"> · {step.note}</span> : null}
        </div>
      </section>

      {(peers.length > 0 || peersOpen) && (
        <section className="dsec">
          <div className="eyebrow">Linked sessions</div>
          {peers.map((p) => (
            <div key={p.key} className="d-peer">
              <i className={`dot ${p.state}`} />
              <span className="d-peer-name">{p.name}</span>
              <span className="muted">
                {" "}
                {p.folder}
                {p.ticket ? ` · ${p.ticket}` : ""}
              </span>
              {can("peersSet") && (
                <button
                  className="d-x"
                  title="Unlink"
                  onClick={async () => {
                    const r = await deck().peersSet(s.key, p.key, false);
                    if (!r.ok) flash(r.message);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <div className="d-actions-inline">
            {can("peersSet") && (
              <button className="d-link" onClick={() => setPeersOpen(true)}>
                Add…
              </button>
            )}
            {peers.length > 0 && can("peersSync") && (
              <button
                className="d-link"
                disabled={syncing}
                onClick={async () => {
                  setSyncing(true);
                  const r = await deck().peersSync(s.key);
                  setSyncing(false);
                  flash(r.ok ? "Synced" : r.message);
                }}
              >
                {syncing ? "Syncing…" : "Sync now"}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="dsec">
        <div className="eyebrow">Pull requests</div>
        {prUrls.length === 0 && <div className="d-text muted">No PR yet</div>}
        {prUrls.map((u) => (
          <PrLine key={u} url={u} state={state} />
        ))}
      </section>

      <section className="dsec">
        <div className="eyebrow">Worktrees</div>
        {worktrees.map((w) => (
          <div key={w.path} className="d-wt">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="d-wt-name">
                {w.repo} / {w.path.split(/[\\/]/).pop()}
              </div>
              <button
                className="d-path mono"
                onClick={() => copy(w.path, "path")}
                title={`${w.path}\nClick to copy`}
              >
                {w.branch ? `⎇ ${w.branch}` : w.path}
              </button>
            </div>
            {can("openEditor") && (
              <button className="btn" onClick={() => void openEditor(w.path)}>
                Open in editor
              </button>
            )}
          </div>
        ))}
        {worktrees.length === 0 && (
          <div className="d-wt">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="d-wt-name muted">Works in its folder</div>
              <button
                className="d-path mono"
                onClick={() => copy(dir, "path")}
                title={`${dir}\nClick to copy`}
              >
                {dir}
              </button>
              {branch && (
                <button
                  className="d-path mono"
                  onClick={() => copy(branch, "branch")}
                  title="Click to copy the branch"
                >
                  ⎇ {branch}
                  {git && (git.ahead > 0 || git.behind > 0)
                    ? ` ↑${git.ahead} ↓${git.behind}`
                    : ""}
                </button>
              )}
            </div>
            {can("openEditor") && (
              <button className="btn" onClick={() => void openEditor(dir)}>
                Open in editor
              </button>
            )}
          </div>
        )}
      </section>

      <section className="dsec">
        <div className="eyebrow">Session</div>
        <div className="d-grid">
          <div
            title={`Context used${stats?.source === "transcript" ? " (estimated from the transcript)" : ""}`}
          >
            Context <b>{formatPct(stats?.contextPct ?? null)}</b>
            <span
              className={`bar ${level}`}
              style={{ display: "block", marginTop: 4 }}
            >
              <i
                style={{ width: `${Math.min(100, stats?.contextPct ?? 0)}%` }}
              />
            </span>
          </div>
          <div
            title={
              tokens
                ? `${tokenTitle(tokens)}\n(this session and its subagents, from the transcript)`
                : "Counting tokens…"
            }
          >
            Tokens <b>{formatTokens(tokens ? tokenSum(tokens) : null)}</b>
          </div>
          <div>
            Model <b>{stats?.model ?? tail?.model ?? "—"}</b>
          </div>
          {s.account && (
            <div title="The GitHub account this session works as (its commits, PRs and gh calls); to change it, stop it and resume it as another">
              Account <b>{s.account}</b>
            </div>
          )}
          {s.ghActive && !s.account && (
            <div title="This session was started without an account, so its commits, PRs and gh calls use gh's active account (gh auth status). To give it one, stop it and resume it with an account picked.">
              Account <b>gh&apos;s active account</b> (started without an account)
            </div>
          )}
          <div>
            Diff <b>{git ? formatDiff(git) : "—"}</b>
          </div>
          <div>
            Started{" "}
            <b>{s.startedAt ? `${formatAgo(now - s.startedAt)} ago` : "—"}</b>
          </div>
          {hook?.compactedAt && (
            <div>
              Compacted <b>{formatAgo(now - hook.compactedAt)} ago</b>
            </div>
          )}
          {state.modLive?.[s.key] && (
            <div title="The MasterDeck mod runs inside this session: it shows the ticket above the prompt and adds /md-note and /md-ticket">
              Mod <b>live</b> (v{state.modLive[s.key].version}, Claude Code {state.modLive[s.key].claude || "?"})
            </div>
          )}
        </div>
        <div className="d-actions">
          <button
            className={`btn ${(stats?.contextPct ?? 0) >= state.settings.contextWarnPct ? "danger" : ""}`}
            title="Types /compact into the session"
            onClick={async () => {
              const r = await deck().sendText(s.key, "/compact");
              flash(r.ok ? "Compacting…" : r.message);
            }}
          >
            {(stats?.contextPct ?? 0) >= state.settings.contextWarnPct
              ? "Compact now"
              : "Compact"}
          </button>
          {state.config.masterEnabled && (
            <button
              className="btn"
              disabled={!masterAttached}
              title={
                masterAttached
                  ? "Types the question into master (only when master is idle)"
                  : "master-agent is not attached here"
              }
              onClick={() => onAskMaster(s)}
            >
              Ask master
            </button>
          )}
          <button
            className="btn"
            onClick={() =>
              copy(`claude --resume ${s.sessionId}`, "resume command")
            }
          >
            Copy resume command
          </button>
          {s.bgId && (
            <button
              className="btn"
              onClick={() => copy(`claude attach ${s.bgId}`, "attach command")}
            >
              Copy attach command
            </button>
          )}
          {peers.length === 0 && can("peersSet") && (
            <button className="btn" onClick={() => setPeersOpen(true)}>
              Link sessions…
            </button>
          )}
          <button
            className="btn"
            onClick={onDetach}
            title="Close its terminal here; the session keeps running"
          >
            Close terminal
          </button>
          {s.kind === "background" && s.bgId && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await webConfirm(`Stop ${s.name}?`, { confirmLabel: "Stop", danger: true })))
                  return;
                const r = await deck().stopSession(s.bgId!, s.name);
                if (r.message !== "cancelled")
                  flash(r.ok ? "Stopped" : r.message);
              }}
            >
              Stop session…
            </button>
          )}
        </div>
      </section>
      {peersOpen && (
        <PeersDialog
          state={state}
          session={s}
          onClose={() => setPeersOpen(false)}
        />
      )}
    </div>
  );
}

/** When the session entered its current state, as seen by this window. */
function useStateSince(s: Session): number | null {
  const ref = useRef<{ id: string; state: string; since: number } | null>(null);
  if (
    !ref.current ||
    ref.current.id !== s.sessionId ||
    ref.current.state !== s.state
  ) {
    ref.current = { id: s.sessionId, state: s.state, since: Date.now() };
  }
  return ref.current.since;
}

/** One of the session's PRs: repo#number, CI, review threads, review, state. */
function PrLine({ url, state }: { url: string; state: AppState }) {
  const live = state.prLive[url];
  const snap = state.prs.find((p) => p.url === url);
  const ci =
    live?.ci ??
    (snap?.ci === "success"
      ? "success"
      : snap?.ci === "failure" || snap?.ci === "error"
        ? "failure"
        : snap?.ci
          ? "pending"
          : null);
  const threads = snap?.unresolvedThreads ?? 0;
  const prState = live?.state ?? null;
  const done = prState === "MERGED" || prState === "CLOSED";
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return (
    <button
      className={`d-pr ${done ? "done" : ""}`}
      onClick={() => deck().openExternal(url)}
      title={`${live?.title ?? snap?.title ?? ""}\n${url}`}
    >
      <span className="mono">{m ? `${m[1]}#${m[2]}` : url} ↗</span>
      <span style={{ flex: 1 }} />
      {!done && ci === "success" && <span className="ok">CI passed</span>}
      {!done && ci === "failure" && <span className="bad">CI failing</span>}
      {!done && ci === "pending" && <span className="wait">CI running</span>}
      {!done && threads > 0 && (
        <span className="wait">
          {threads} thread{threads === 1 ? "" : "s"}
        </span>
      )}
      {!done && live?.reviewDecision === "APPROVED" && (
        <span className="ok">approved</span>
      )}
      {!done && live?.reviewDecision === "CHANGES_REQUESTED" && (
        <span className="bad">changes</span>
      )}
      {prState === "MERGED" && <span className="merged">merged</span>}
      {prState === "CLOSED" && <span className="muted">closed</span>}
    </button>
  );
}

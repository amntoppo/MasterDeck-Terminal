import { useRef, useState, type ReactNode } from "react";
import { AskPanel } from "./AskPanel";
import { StatusDialog } from "./StatusDialog";
import type { Ticket } from "@shared/ticket";
import { sessionTicket } from "@shared/derive";
import { formatAgo, formatDiff, formatPct } from "@shared/format";
import { contextLevel } from "@shared/stats";
import { formatTokens, tokenSum, tokenTitle } from "@shared/tokens";
import { attentionFor, sessionStatus } from "@shared/review";
import type { AppState, Session } from "@shared/types";
import { deck, load, save, useNow } from "../deck";
import type { NoteMeta } from "@shared/notes";
import { can } from "../web";
import { toggleStar, useStars } from "../stars";
import { webConfirm } from "../webConfirm";
import { WorkflowWidget } from "./SessionWorkflow";
import { ScheduleWidget } from "./ScheduleWidget";
import { PeersDialog } from "./PeersDialog";
import { SessionMods } from "./SessionMods";
import { GitHubDetails, prLineOf, sessionPrUrls } from "./GitHubDetails";
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

type DetailsTab = "session" | "github" | "mods";
const TAB_KEY = "md.detailsTab";
const asTab = (v: unknown): DetailsTab => (v === "github" || v === "mods" ? v : "session");

/**
 * Everything about the open session, in the right panel's Details tab (it replaced the status bar
 * above the terminal), in three tabs (#103): Session (what waits on you, status, workflow, linked
 * sessions, branch and worktrees, tokens, context, model, diff, and the session's actions), GitHub
 * (ticket, PRs, monitors: GitHubDetails) and Mods. The picked tab is kept across sessions and restarts.
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
  const [tab, setTabState] = useState<DetailsTab>(() => asTab(load(TAB_KEY, "session")));
  const setTab = (t: DetailsTab) => {
    setTabState(t);
    save(TAB_KEY, t);
  };
  const since = useStateSince(s);
  const starred = useStars().includes(s.key);
  const status = sessionStatus(
    s,
    state.prStage[s.key],
    attentionFor(s, state.proposals),
    state.manualStatus[s.key],
  );
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
  const prLines = sessionPrUrls(s, state, sessionTicket(s)).map((u) => prLineOf(u, state));
  const ghAlert = prLines.some((l) => !l.done && (l.ci === "failure" || l.review === "CHANGES_REQUESTED"));
  const monitorCount = (state.watches ?? []).filter((w) => w.sessionId === s.sessionId && !w.id.startsWith("pr:")).length;
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

  const tabButton = (t: DetailsTab, label: ReactNode) => (
    <button role="tab" aria-selected={tab === t} className={tab === t ? "on" : undefined} onClick={() => setTab(t)}>
      {label}
    </button>
  );
  const tabs = (
    <div className="d-tabs">
      <div className="seg" role="tablist" aria-label="Details">
        {tabButton("session", "Session")}
        {tabButton(
          "github",
          <>
            GitHub
            {prLines.length + monitorCount > 0 && (
              <span className={`d-tab-count${ghAlert ? " bad" : ""}`}> {prLines.length + monitorCount}</span>
            )}
          </>,
        )}
        {tabButton(
          "mods",
          <>
            Mods
            {state.modOff?.[s.key]?.length ? <span className="d-tab-count"> {state.modOff[s.key].length} off</span> : null}
          </>,
        )}
      </div>
    </div>
  );
  if (tab === "github")
    return (
      <div className="details">
        {tabs}
        <GitHubDetails session={s} state={state} notes={notes} onNote={onNote} />
      </div>
    );
  if (tab === "mods")
    return (
      <div className="details">
        {tabs}
        {note && (
          <section className="dsec">
            <span className="d-note">{note}</span>
          </section>
        )}
        <SessionMods session={s} state={state} onMessage={flash} />
      </div>
    );

  return (
    <div className="details">
      {tabs}
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
      <ScheduleWidget session={s} state={state} />

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

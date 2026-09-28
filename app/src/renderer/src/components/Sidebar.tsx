import { sameTicket, ticketLabel, ticketUrl } from "@shared/ticket";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  MASTER_NAME,
  proposalTicket,
  sessionForIssue,
  sessionForProposal,
} from "@shared/derive";
import { inOrder, moveBefore, trimOrder, withNew } from "@shared/sessionOrder";
import { StatusDialog } from "./StatusDialog";
import { SessionMenu } from "./SessionMenu";
import { attentionFor, sessionStatus } from "@shared/review";
import { LANES, laneOf } from "@shared/tasks";
import { canStop, cleanupDefaults } from "@shared/cleanup";
import { formatAgo, formatGhCache, formatRefreshed } from "@shared/format";
import type { InboxEntry, InboxKind } from "@shared/inbox";
import type { AppState, Issue, Proposal, Session } from "@shared/types";
import { deck, KIND_COLOR, load, save, useNow } from "../deck";
import type { PaletteAction } from "./CommandPalette";
import { OfferRow } from "./PrsView";
import { AskPanel } from "./AskPanel";
import { Markdown } from "./SummaryPanel";

export type View =
  | "terminals"
  | "board"
  | "prs"
  | "tasks"
  | "settings"
  | "costs"
  | "janitor"
  | "history"
  | "workflow";

interface Props {
  state: AppState;
  activeKey: string | null;
  onOpenSession: (s: Session) => void;
  onIssue: (issue: Issue) => void;
  onNewShell: () => void;
  needsYouRef: React.RefObject<HTMLDivElement | null>;
  /** Open this Needs-you item's popup (a notification was clicked); `at` makes each click count. */
  showItem?: { id: string; at: number } | null;
  view: View;
  onView: (v: View) => void;
  /** Footer tools and the palette's actions. */
  onTool: (a: PaletteAction) => void;
  onStartWith: (issue: Issue, instructions: string) => void;
  /** Session actions that live in the app: its Summary panel, closing its tab (after a stop). */
  onSessionAction: (s: Session, a: SessionAction) => void;
  /** Open terminals that are not sessions (shells, sessions starting), listed under the sessions. */
  others?: ColumnTab[];
  /** Two terminals side by side. */
  split?: boolean;
  onToggleSplit?: () => void;
}

/** A shell or a starting session in the column (the tab strip is gone). */
export interface ColumnTab {
  id: string;
  kind: "shell" | "pending";
  label: string;
  sub: string;
  active: boolean;
  error?: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export type SessionAction = "summary" | "close-tab";

const ORDER_KEY = "sessionOrder";

const STATE_LABEL: Record<string, string> = {
  working: "working",
  idle: "idle",
  "needs-input": "needs input",
  suspended: "suspended",
  done: "done",
};

export function Sidebar({
  state,
  activeKey,
  onOpenSession,
  onIssue,
  onNewShell,
  needsYouRef,
  showItem,
  onStartWith,
  onSessionAction,
  others,
  split,
  onToggleSplit,
}: Props) {
  const now = useNow();
  const [showSuspended, setShowSuspended] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // The user's order (drag, Move to top/bottom); activity never reorders. New sessions go on top once.
  const [order, setOrder] = useState<string[]>(() =>
    load<string[]>(ORDER_KEY, []),
  );
  const shownSessions = useMemo(
    () =>
      state.sessions.filter(
        (s) => s.name !== MASTER_NAME && s.state !== "done",
      ),
    [state.sessions],
  );
  useEffect(() => {
    const next = withNew(order, shownSessions);
    if (next !== order)
      setOrder(trimOrder(next, new Set(shownSessions.map((s) => s.key))));
  }, [shownSessions, order]);
  useEffect(() => save(ORDER_KEY, order), [order]);
  const sessions = useMemo(
    () => inOrder(shownSessions, order),
    [shownSessions, order],
  );
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const move = (key: string, before: string | null) =>
    setOrder((o) => moveBefore(withNew(o, shownSessions), key, before));
  const [menu, setMenu] = useState<{ s: Session; x: number; y: number } | null>(
    null,
  );
  const [statusFor, setStatusFor] = useState<Session | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const flash = (m: string) => {
    setNote(m);
    setTimeout(() => setNote((cur) => (cur === m ? null : cur)), 3500);
  };
  const rowProps = (s: Session) => ({
    dragging: dragKey === s.key,
    dropBefore: dropKey === s.key && dragKey !== s.key,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData("text/masterdeck-session", s.key);
      e.dataTransfer.effectAllowed = "move";
      setDragKey(s.key);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragKey) return;
      e.preventDefault();
      setDropKey(s.key);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const k = e.dataTransfer.getData("text/masterdeck-session");
      if (k) move(k, s.key);
      setDragKey(null);
      setDropKey(null);
    },
    onDragEnd: () => {
      setDragKey(null);
      setDropKey(null);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ s, x: e.clientX, y: e.clientY });
    },
  });
  const statusOf = (s: Session) =>
    sessionStatus(
      s,
      state.prStage[s.key],
      attentionFor(s, state.proposals),
      state.manualStatus[s.key],
    );
  const live = sessions.filter((s) => s.state !== "suspended");
  const suspended = sessions.filter((s) => s.state === "suspended");

  // Cleanup: rows become selectable (merged ones picked); Stop ends the picked sessions.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [stopping, setStopping] = useState(false);
  const startCleanup = () =>
    setPicked(cleanupDefaults(sessions, state.prStage));
  const togglePick = (key: string) =>
    setPicked((p) => {
      if (!p) return p;
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toStop = picked
    ? sessions.filter((s) => picked.has(s.key) && canStop(s))
    : [];
  const stopPicked = async () => {
    setStopping(true);
    const r = await deck().stopSessions(toStop.map((s) => s.key));
    setStopping(false);
    if (r.message === "cancelled") return;
    for (const s of sessions)
      if (r.stopped?.includes(s.key)) onSessionAction(s, "close-tab");
    flash(r.message);
    if (r.ok) setPicked(null);
  };
  const rowFor = (s: Session, status?: ReturnType<typeof sessionStatus>) =>
    picked ? (
      <SessionRow
        key={s.key}
        s={s}
        active={false}
        now={now}
        status={status}
        pick={canStop(s) ? picked.has(s.key) : null}
        onClick={() => canStop(s) && togglePick(s.key)}
      />
    ) : (
      <SessionRow
        key={s.key}
        s={s}
        active={s.key === activeKey}
        now={now}
        status={status}
        onClick={() => onOpenSession(s)}
        {...rowProps(s)}
      />
    );

  const refresh = async () => {
    setRefreshing(true);
    await deck().refresh();
    setRefreshing(false);
  };

  // Needs you: the inbox main builds (shared/inbox.ts); every card acts through deck().inboxAct.
  const open = state.inbox.open;
  const offerCount = open.filter((e) => e.item.detail.type === "offer").length;
  const prAttention =
    offerCount + state.prs.filter((p) => p.reviewRequested).length;
  const hot = open.filter(
    (e) => e.item.kind !== "held" && e.item.kind !== "idle",
  ).length;
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // The Needs-you popup: which item, by id; it closes by itself when the item goes (answered, dismissed).
  const [detail, setDetail] = useState<string | null>(null);

  const cardFor = (id: string, full: boolean): ReactNode => {
    const e = open.find((x) => x.item.id === id);
    if (!e) return null;
    return (
      <InboxCard
        entry={e}
        state={state}
        onOpenSession={onOpenSession}
        onIssue={onIssue}
        onStartWith={onStartWith}
        onDetails={full ? undefined : () => setDetail(id)}
        full={full}
      />
    );
  };
  useEffect(() => {
    if (!showItem) return;
    needsYouRef.current?.scrollIntoView({ behavior: "smooth" });
    if (open.some((e) => e.item.id === showItem.id)) setDetail(showItem.id);
    // Only when a notification is clicked, not as the list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showItem]);
  const detailCard = detail ? cardFor(detail, true) : null;
  useEffect(() => {
    if (detail && !detailCard) setDetail(null);
  }, [detail, detailCard]);

  return (
    <aside className="sidebar">
      <div className="col-head">
        <b>Sessions</b>
        <span style={{ flex: 1 }} />
        {note && <span className="sub session-note">{note}</span>}
        {onToggleSplit && (
          <button
            className="col-btn"
            onClick={onToggleSplit}
            title={
              split
                ? "Close the split  ⌘\\"
                : "Show two terminals side by side  ⌘\\"
            }
            aria-pressed={!!split}
          >
            {split ? "Unsplit" : "Split"}
          </button>
        )}
        <button
          className="col-btn"
          onClick={onNewShell}
          title="New shell in the workspace  ⌘T"
        >
          + Shell
        </button>
      </div>
      <div className="scroll">
        <div className="section" ref={needsYouRef}>
          <div className="section-head">
            Needs you{" "}
            <span className={`count ${hot ? "hot" : ""}`}>{open.length}</span>
          </div>
          {open.length === 0 && (
            <div className="empty">Nothing waiting on you.</div>
          )}
          {open.map((e) => (
            <div key={e.item.id}>{cardFor(e.item.id, false)}</div>
          ))}
          {state.inbox.snoozed.length > 0 && (
            <div
              className="row inbox-fold"
              onClick={() => setShowSnoozed(!showSnoozed)}
            >
              <span className="mark">{showSnoozed ? "▾" : "▸"}</span>
              <span className="label sub">
                {state.inbox.snoozed.length} snoozed
              </span>
            </div>
          )}
          {showSnoozed &&
            state.inbox.snoozed.map((e) => (
              <div
                key={e.item.id}
                className="row inbox-line"
                title={e.item.body}
              >
                <span className="kind-tag">{KIND_TAG[e.item.kind]}</span>
                <span className="label">{e.item.title}</span>
                <span className="sub">
                  {e.snoozedUntil
                    ? `until ${new Date(e.snoozedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : ""}
                </span>
                <button
                  className="link-btn"
                  onClick={() => void deck().inboxAct(e.item.id, "wake")}
                >
                  Show
                </button>
              </div>
            ))}
          {state.inbox.history.length > 0 && (
            <div
              className="row inbox-fold"
              onClick={() => setShowHistory(!showHistory)}
            >
              <span className="mark">{showHistory ? "▾" : "▸"}</span>
              <span className="label sub">
                Done today · {state.inbox.history.length}
              </span>
            </div>
          )}
          {showHistory &&
            state.inbox.history.map((e) => (
              <div
                key={`${e.item.id}:${e.resolvedAt}`}
                className="row inbox-line"
                title={`${e.item.title}\n${e.item.body}`}
              >
                <span className="kind-tag">{KIND_TAG[e.item.kind]}</span>
                <span className="label">{e.item.title}</span>
                <span className="sub">{e.resolvedHow}</span>
                <span className="sub">
                  {e.resolvedAt ? formatAgo(now - e.resolvedAt) : ""}
                </span>
              </div>
            ))}
        </div>

        {live.length === 0 && !others?.length && (
          <div className="empty" style={{ padding: "10px 14px" }}>
            No live sessions. Start one from the board, or open a shell.
          </div>
        )}
        {LANES.filter((l) => l.id !== "parked").map((l) => {
          const list = live.filter((s) => laneOf(statusOf(s).key) === l.id);
          if (!list.length) return null;
          return (
            <div className="section" key={l.id}>
              <div className={`section-head lane-${l.id}`} title={l.hint}>
                {l.title} <span className="count">{list.length}</span>
              </div>
              {list.map((s) => rowFor(s, statusOf(s)))}
            </div>
          );
        })}
        {dragKey && (
          // Drop here: to the end of the list.
          <div
            className={`row drop-end ${dropKey === "" ? "drop-before" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDropKey("");
            }}
            onDrop={(e) => {
              e.preventDefault();
              const k = e.dataTransfer.getData("text/masterdeck-session");
              if (k) move(k, null);
              setDragKey(null);
              setDropKey(null);
            }}
          />
        )}
        {others && others.length > 0 && (
          <div className="section">
            <div className="section-head">
              Shells &amp; starting{" "}
              <span className="count">{others.length}</span>
            </div>
            {others.map((t) => (
              <div
                key={t.id}
                className={`srow ${t.active ? "active" : ""}`}
                onClick={t.onOpen}
                title={t.sub}
              >
                <div className="srow-top">
                  <span
                    className={`dot ${t.kind === "pending" ? (t.error ? "st-blocked" : "st-waiting") : "st-shell"}`}
                  />
                  <span className="label">{t.label}</span>
                  <button
                    className="srow-x"
                    aria-label={`Close ${t.label}`}
                    title="Close"
                    onClick={(e) => {
                      e.stopPropagation();
                      t.onClose();
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className={`srow-sub ${t.error ? "st-blocked" : ""}`}>
                  {t.sub}
                </div>
              </div>
            ))}
          </div>
        )}
        {suspended.length > 0 && (
          <div className="section">
            <div
              className="row"
              onClick={() => setShowSuspended(!showSuspended)}
            >
              <span className="mark">{showSuspended ? "▾" : "▸"}</span>
              <span className="label sub">Parked · {suspended.length}</span>
            </div>
            {showSuspended && suspended.map((s) => rowFor(s))}
          </div>
        )}
        {menu && (
          <SessionMenu
            s={menu.s}
            x={menu.x}
            y={menu.y}
            state={state}
            onClose={() => setMenu(null)}
            onOpen={() => onOpenSession(menu.s)}
            onStatus={() => setStatusFor(menu.s)}
            onAction={(a) => onSessionAction(menu.s, a)}
            onMove={() =>
              move(menu.s.key, inOrder(shownSessions, order)[0]?.key ?? null)
            }
            flash={flash}
          />
        )}
        {statusFor && (
          <StatusDialog
            session={statusFor}
            state={state}
            onClose={() => setStatusFor(null)}
            onStopped={() => onSessionAction(statusFor, "close-tab")}
          />
        )}
      </div>
      <div className="sidebar-footer">
        {state.missingBinaries.length > 0 && (
          <div className="err">
            Not found on PATH: {state.missingBinaries.join(", ")}
          </div>
        )}
        {state.errors.slice(0, 3).map((e) => (
          <div key={e} className="err" title={e}>
            {e.length > 90 ? e.slice(0, 90) + "…" : e}
          </div>
        ))}
        {formatGhCache(state.ghCache, now) && (
          <div
            className={state.ghCache?.pausedUntil ? "err" : "line"}
            title={
              state.ghCache?.pauseReason ??
              "One cache (~/.claude/gh-cache) shared by MasterDeck, master and the babysit skills"
            }
          >
            {formatGhCache(state.ghCache, now)}
          </div>
        )}
        {picked ? (
          <div className="cleanup-bar">
            <div className="line">
              <span>
                {toStop.length} selected · click sessions to pick them
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="link-btn"
                onClick={() =>
                  setPicked(
                    toStop.length
                      ? new Set()
                      : new Set(sessions.filter(canStop).map((s) => s.key)),
                  )
                }
              >
                {toStop.length ? "None" : "All"}
              </button>
            </div>
            <div className="cleanup-actions">
              <button
                className="btn"
                onClick={() => setPicked(null)}
                disabled={stopping}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => void stopPicked()}
                disabled={stopping || !toStop.length}
                title="Stop the selected sessions. Their conversations are kept: resume one later from its ticket on the Board."
              >
                {stopping
                  ? "Stopping…"
                  : `Stop session${toStop.length === 1 ? "" : "s"}${toStop.length ? ` (${toStop.length})` : ""}`}
              </button>
            </div>
          </div>
        ) : null}
        <div className="line">
          <span
            title={
              state.githubRefreshedAt
                ? new Date(state.githubRefreshedAt).toLocaleString()
                : ""
            }
          >
            {state.githubRefreshing
              ? "Refreshing from GitHub…"
              : state.githubRefreshedAt
                ? `Refreshed ${formatRefreshed(now - state.githubRefreshedAt)}`
                : "Not refreshed yet"}
          </span>
          <span style={{ flex: 1 }} />
          {!picked && (
            <button
              className="link-btn"
              onClick={startCleanup}
              title="Pick sessions to stop (merged ones are picked for you)"
            >
              Cleanup
            </button>
          )}
          <button
            className="link-btn"
            onClick={refresh}
            disabled={refreshing || state.githubRefreshing}
          >
            {refreshing || state.githubRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      {detailCard && (
        <NeedsDialog onClose={() => setDetail(null)}>{detailCard}</NeedsDialog>
      )}
    </aside>
  );
}

/**
 * The popup for a Needs-you card: the same card with nothing clipped (the whole question, message
 * and options). Portalled to the end of the page, after every window drag region, so it is clickable.
 */
function NeedsDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog wide needs-full"
        role="dialog"
        aria-label="Needs you"
      >
        <h3>
          Needs you
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A click on a card's text (not its buttons or fields, and not a text selection) opens the popup. */
function detailsClick(open?: () => void) {
  return (e: React.MouseEvent) => {
    if (!open) return;
    if (
      (e.target as HTMLElement).closest(
        "button, a, textarea, input, select, label",
      )
    )
      return;
    if (window.getSelection()?.toString()) return;
    open();
  };
}

/** Short labels for a Needs-you item's kind (the snoozed and history lists). */
const KIND_TAG: Record<InboxKind, string> = {
  input: "INPUT",
  menu: "QUESTION",
  question: "QUESTION",
  blocked: "BLOCKED",
  held: "HELD",
  proposal: "PROPOSAL",
  ci: "CI",
  review: "THREADS",
  budget: "BUDGET",
  context: "CONTEXT",
  idle: "IDLE",
  waiting: "WAITING",
  error: "API ERROR",
};

/** Minutes from now until 9:00 tomorrow. */
function untilTomorrow(): number {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return Math.max(60, Math.round((t.getTime() - Date.now()) / 60_000));
}

/** Snooze (⏾) and dismiss (×) on a Needs-you card: both through the inbox. Dismissed items come back
 * when the situation changes (a new question, more context used…). */
function ItemControls({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const act =
    (type: string, payload?: Record<string, unknown>) =>
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setOpen(false);
      void deck().inboxAct(itemId, type, payload);
    };
  return (
    <span className="card-ctl" onClick={(e) => e.stopPropagation()}>
      <button
        className="card-x"
        title="Snooze"
        aria-label="Snooze"
        onClick={() => setOpen(!open)}
      >
        ⏾
      </button>
      <button
        className="card-x"
        title="Dismiss (it comes back if the situation changes)"
        aria-label="Dismiss"
        onClick={act("dismiss")}
      >
        ×
      </button>
      {open && (
        <span className="menu snooze-menu">
          <button onClick={act("snooze", { minutes: 60 })}>For an hour</button>
          <button onClick={act("snooze", { minutes: 240 })}>For 4 hours</button>
          <button onClick={act("snooze", { minutes: untilTomorrow() })}>
            Until tomorrow
          </button>
        </span>
      )}
    </span>
  );
}

/** One Needs-you item as its card: the card for its kind, acting through the inbox. */
function InboxCard({
  entry,
  state,
  onOpenSession,
  onIssue,
  onStartWith,
  onDetails,
  full,
}: {
  entry: InboxEntry;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onIssue: (i: Issue) => void;
  onStartWith: (issue: Issue, instructions: string) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const i = entry.item;
  const d = i.detail;
  if (d.type === "proposal")
    return (
      <ProposalCard
        itemId={i.id}
        proposal={d.proposal}
        attention={i.kind !== "proposal"}
        state={state}
        onOpenSession={onOpenSession}
        onIssue={onIssue}
        onDetails={onDetails}
        full={full}
      />
    );
  if (d.type === "offer")
    return (
      <div
        className={`card ${onDetails ? "clickable" : ""}`}
        style={{
          ["--kind" as string]:
            i.kind === "ci" ? "var(--red)" : "var(--accent)",
        }}
        onClick={detailsClick(onDetails)}
      >
        {!full && <ItemControls itemId={i.id} />}
        <OfferRow
          o={d.offer}
          itemId={i.id}
          state={state}
          onDismiss={() => void deck().inboxAct(i.id, "dismiss")}
          onStartWith={onStartWith}
          onOpenSession={onOpenSession}
        />
      </div>
    );
  const s = i.sessionKey
    ? state.sessions.find((x) => x.key === i.sessionKey)
    : undefined;
  if (d.type === "session" && s && i.kind !== "error")
    return (
      <NeedsCard
        itemId={i.id}
        session={s}
        state={state}
        onOpenSession={onOpenSession}
        onDetails={onDetails}
        full={full}
      />
    );
  return (
    <ExtraCard
      entry={entry}
      session={s}
      state={state}
      onOpenSession={onOpenSession}
      onDetails={onDetails}
      full={full}
    />
  );
}

/** `status`: the session's status (see `sessionStatus`); a parked session keeps its plain state. */
function SessionRow({
  s,
  active,
  now,
  status,
  onClick,
  pick,
  dragging,
  dropBefore,
  ...drag
}: {
  s: Session;
  active: boolean;
  now: number;
  status?: ReturnType<typeof sessionStatus>;
  onClick: () => void;
  /** Cleanup: picked or not; null when it can't be stopped. Undefined outside Cleanup. */
  pick?: boolean | null;
  dragging?: boolean;
  dropBefore?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const text = status ? status.text.toLowerCase() : STATE_LABEL[s.state];
  // "ext" (a session in another terminal) only when there is nothing more to say.
  const plain = !status || status.key === "idle" || status.key === "working";
  return (
    <div
      className={`srow ${active ? "active" : ""} ${pick ? "picked" : ""} ${pick === null ? "unpickable" : ""} ${dragging ? "dragging" : ""} ${dropBefore ? "drop-before" : ""}`}
      onClick={onClick}
      draggable={!!drag.onDragStart}
      {...drag}
      title={`${s.name}\n${s.cwd}\n${s.kind} · ${s.rawState}${status?.why ? `\n${status.text}: ${status.why}` : ""}\nDrag to reorder · right-click for more`}
    >
      <div className="srow-top">
        {pick !== undefined && (
          <input
            type="checkbox"
            className="srow-pick"
            checked={!!pick}
            disabled={pick === null}
            readOnly
            tabIndex={-1}
            aria-label={`Select ${s.name}`}
          />
        )}
        <span className={`dot st-${status?.key ?? s.state}`} />
        <span className="label">{s.name}</span>
        {s.issue !== null && (
          <span className="num">{ticketLabel(s.issueRepo, s.issue)}</span>
        )}
      </div>
      <div className="srow-sub">
        <span className={`st-${status?.key ?? s.state}`}>
          {s.kind === "interactive" && plain ? "another terminal" : text}
        </span>
        {s.startedAt ? <span> · {formatAgo(now - s.startedAt)}</span> : null}
        {s.busyWith && <span title={s.busyWith}> · {s.busyWith}</span>}
        {s.waitingOn && <span title={s.waitingOn}> · {s.waitingOn}</span>}
      </div>
    </div>
  );
}

/** A session waiting on a prompt, or on the menu on its screen (answered right here). */
function NeedsCard({
  itemId,
  session: s,
  state,
  onOpenSession,
  onDetails,
  full,
}: {
  itemId: string;
  session: Session;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const ask = state.asks[s.key];
  const menu = state.menus[s.key];
  const tool = state.tails[s.sessionId]?.lastTool;
  const open = (
    <button className="btn" onClick={() => onOpenSession(s)}>
      Open
    </button>
  );
  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{ ["--kind" as string]: menu ? "var(--purple)" : "var(--red)" }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={itemId} />}
      <div className="top">
        <span className="kind">
          {menu?.permission ? "PERMISSION" : menu ? "QUESTION" : "INPUT"}
        </span>
        <span className="title">{s.name}</span>
        {s.issue !== null && (
          <span className="num">{ticketLabel(s.issueRepo, s.issue)}</span>
        )}
      </div>
      {menu ? (
        <AskPanel
          session={s}
          ask={ask}
          menu={menu}
          fallback={null}
          full={full}
          actions={open}
          itemId={itemId}
        />
      ) : (
        <>
          <div className="body">
            Waiting on a prompt or permission{tool ? ` (${tool})` : ""}. Open it
            to answer.
          </div>
          {full && ask?.said && (
            <div className="ask-text full">
              <Markdown text={ask.said.text} />
            </div>
          )}
          <div className="actions">{open}</div>
        </>
      )}
    </div>
  );
}

function ProposalCard({
  itemId,
  proposal: p,
  attention,
  state,
  onOpenSession,
  onIssue,
  onDetails,
  full,
}: {
  itemId: string;
  proposal: Proposal;
  attention: boolean;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onIssue: (i: Issue) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = sessionForProposal(p, state.sessions);
  const dest = p.target.session
    ? `→ ${p.target.session}`
    : p.target.spawn
      ? `→ spawn ${p.target.spawn.name}`
      : "";
  const question = attention && p.status === "question";

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    const r = await deck().inboxAct(itemId, approve ? "approve" : "reject");
    setBusy(false);
    if (!r.ok) setError(r.message);
  };
  const openBtn = target && (
    <button className="btn" onClick={() => onOpenSession(target)}>
      Open
    </button>
  );

  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{
        ["--kind" as string]: question
          ? "var(--purple)"
          : (KIND_COLOR[p.kind] ?? "var(--accent)"),
      }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={itemId} />}
      <div className="top">
        <span className="kind">
          {attention ? p.status.toUpperCase() : p.kind}
        </span>
        <span
          className="title"
          title={`${ticketLabel(p.repo, p.issue)} ${dest}`}
        >
          {ticketLabel(p.repo, p.issue)}{" "}
          {question && target ? target.name : dest}
        </span>
        {!full && !question && (
          <button
            className="icon-btn"
            onClick={() => setOpen(!open)}
            title={open ? "Hide message" : "Show the message master will send"}
          >
            {open ? "▴" : "▾"}
          </button>
        )}
      </div>
      {question ? (
        <AskPanel
          session={target}
          ask={target ? state.asks[target.key] : undefined}
          fallback={p.note ?? p.summary}
          full={full}
          actions={openBtn}
          itemId={itemId}
        />
      ) : (
        <div className="body">{attention && p.note ? p.note : p.summary}</div>
      )}
      {full && !question && attention && p.note && (
        <div className="body">{p.summary}</div>
      )}
      {(open || full) && p.message && (
        <>
          {full && (
            <div className="ask-note">
              {attention
                ? "What master sent the session"
                : "The message master will send"}
            </div>
          )}
          <pre>{p.message}</pre>
        </>
      )}
      {!question && (
        <div className="actions">
          {error && <span className="error">{error}</span>}
          {openBtn}
          {!attention && (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => decide(false)}
              >
                Reject
              </button>
              {p.kind === "ASSIGN" && p.target.spawn ? (
                // Opens the Start dialog: review the prompt, add first instructions, start now.
                <button
                  className="btn primary"
                  onClick={() =>
                    onIssue(
                      state.issues.find((i) =>
                        sameTicket(i, proposalTicket(p)),
                      ) ?? {
                        number: p.issue,
                        repo: p.repo ?? null,
                        title: p.summary.replace(/^"|"$/g, ""),
                        url: ticketUrl(p.repo, p.issue),
                        status: null,
                        currentSprint: true,
                        assignedToMe: true,
                      },
                    )
                  }
                >
                  Start…
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => decide(true)}
                >
                  Approve
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Idle and waiting nudges, context and budget warnings. */
function ExtraCard({
  entry,
  session: s,
  state,
  onOpenSession,
  onDetails,
  full,
}: {
  entry: InboxEntry;
  session: Session | undefined;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const i = entry.item;
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (type: string) => {
    setBusy(true);
    const r = await deck().inboxAct(i.id, type);
    setBusy(false);
    setMsg(r.ok ? "Sent" : r.message);
  };
  const kind =
    i.kind === "error"
      ? "API ERROR"
      : i.detail.type === "nudge"
        ? `${i.kind === "idle" ? "IDLE" : "WAITING"} ${i.detail.minutes}M`
        : i.detail.type === "context"
          ? `CONTEXT ${Math.round(i.detail.pct)}%`
          : "BUDGET";
  const owner =
    s ?? (i.ticket ? sessionForIssue(state.sessions, i.ticket) : null);
  const primary = i.actions.find(
    (a) => a.type === "continue" || a.type === "compact",
  );
  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{
        ["--kind" as string]:
          i.kind === "idle" || i.kind === "waiting"
            ? "var(--amber)"
            : "var(--red)",
      }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={i.id} />}
      <div className="top">
        <span className="kind">{kind}</span>
        <span className="title">{i.title}</span>
      </div>
      <div className="body">{i.body}</div>
      <div className="actions">
        {msg && (
          <span
            className="error"
            style={{ color: msg === "Sent" ? "var(--green)" : undefined }}
          >
            {msg}
          </span>
        )}
        {owner && (
          <button className="btn" onClick={() => onOpenSession(owner)}>
            {i.detail.type === "budget" ? `Open ${owner.name}` : "Open"}
          </button>
        )}
        {primary && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void act(primary.type)}
          >
            {primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

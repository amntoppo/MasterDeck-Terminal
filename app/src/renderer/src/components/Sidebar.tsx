import { ticketLabel } from "@shared/ticket";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MASTER_NAME } from "@shared/derive";
import { inOrder, moveBefore, trimOrder, withNew } from "@shared/sessionOrder";
import { pruneStars, splitStarred } from "@shared/stars";
import { setStars, toggleStar, useStars } from "../stars";
import { pickGroup, usePickedGroup } from "../sessionGroupPick";
import { NewMenu, type NewAction } from "./NewMenu";
import { StatusDialog } from "./StatusDialog";
import { SessionMenu } from "./SessionMenu";
import { attentionFor, sessionStatus } from "@shared/review";
import { LANES, laneOf, type Lane } from "@shared/tasks";
import {
  accountChoicesFor,
  cleanFilter,
  filterSessions,
  folderChoices,
  isFiltered,
  NO_FILTER,
  parkedForced,
  shellsShown,
  type SessionFilter,
} from "@shared/sessionFilter";
import { SessionFilterBar } from "./SessionFilterBar";
import { SessionGroupBar } from "./SessionGroupBar";
import { ALL, emptyGroups, inGroup, shownTab } from "@shared/sessionGroups";
import { canStop, cleanupDefaults } from "@shared/cleanup";
import { formatAgo, formatGhCache, formatRefreshed } from "@shared/format";
import type { InboxKind } from "@shared/inbox";
import type { AppState, Issue, Session } from "@shared/types";
import { deck, load, save, useNow } from "../deck";
import { can } from "../web";
import { webConfirm } from "../webConfirm";
import type { PaletteAction } from "./CommandPalette";
import { InboxCard } from "./InboxCard";
import { AccountBadge } from "./AccountBits";
import { isMulti } from "@shared/accounts";
import { rowLoop } from "@shared/loops";

export type View =
  | "dashboard"
  | "terminals"
  | "board"
  | "prs"
  | "tasks"
  | "settings"
  | "costs"
  | "janitor"
  | "history"
  | "workflow"
  | "schedules"
  | "meetings";

interface Props {
  state: AppState;
  activeKey: string | null;
  onOpenSession: (s: Session) => void;
  onIssue: (issue: Issue) => void;
  onNewShell: () => void;
  /** The + menu (new terminal, Claude session, from an issue, resume). */
  onNew?: (a: NewAction) => void;
  needsYouRef: React.RefObject<HTMLDivElement | null>;
  /** Open this Needs-you item's popup (a notification was clicked); `at` makes each click count. */
  showItem?: { id: string; at: number } | null;
  view: View;
  onView: (v: View) => void;
  /** Footer tools and the palette's actions. */
  onTool: (a: PaletteAction) => void;
  onStartWith: (issue: Issue, instructions: string) => void;
  /** Open a meeting (its Needs-you item's Open). */
  onOpenMeeting?: (id: string) => void;
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

export type SessionAction = "summary" | "close-tab" | "clone";

const ORDER_KEY = "sessionOrder";
const FILTER_KEY = "sessionFilter";
const FILTER_OPEN_KEY = "sessionFilterOpen";
/** When each starred session was first missing from the list (see pruneStars). */
const starsMissingSince = new Map<string, number>();

const EMPTY_GROUPS = emptyGroups();

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
  onNew,
  needsYouRef,
  showItem,
  onStartWith,
  onOpenMeeting,
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
  const everySession = useMemo(
    () => inOrder(shownSessions, order),
    [shownSessions, order],
  );
  // The tab on screen: everything below (Starred, groups, filters, Parked, Cleanup) lists its sessions.
  const groups = state.sessionGroups ?? EMPTY_GROUPS;
  const tab = shownTab(groups, usePickedGroup());
  const pickTab = pickGroup;
  const sessions = useMemo(
    () => inGroup(everySession, groups, tab),
    [everySession, groups, tab],
  );
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const move = (key: string, before: string | null) =>
    setOrder((o) => moveBefore(withNew(o, shownSessions), key, before));
  const [menu, setMenu] = useState<{ s: Session; x: number; y: number } | null>(
    null,
  );
  const [statusFor, setStatusFor] = useState<Session | null>(null);
  const assignTab = async (key: string, group: string | null) => {
    const s = everySession.find((x) => x.key === key);
    if ((groups.of[key] ?? null) === group) return;
    const r = await deck().sessionGroupsAct({ op: "assign", key, group });
    const name = groups.groups.find((g) => g.id === group)?.name;
    if (!r.ok) flash(r.message);
    else if (s) flash(name ? `${s.name} is in ${name}.` : `${s.name} is out of its tab (in All only).`);
  };
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
  // Starred: pinned above the status groups, whatever their status; an ended one loses its star.
  const stars = useStars();
  useEffect(
    () => setStars(pruneStars(stars, state.sessions, starsMissingSince)),
    [stars, state.sessions],
  );
  // Filters (kept across restarts): everything below lists only the sessions that match.
  const [filter, setFilterState] = useState<SessionFilter>(() =>
    cleanFilter(load<unknown>(FILTER_KEY, NO_FILTER)),
  );
  const [filterOpen, setFilterOpenState] = useState(() =>
    load<boolean>(FILTER_OPEN_KEY, false) === true,
  );
  const setFilter = (f: SessionFilter) => {
    setFilterState(f);
    save(FILTER_KEY, f);
  };
  const setFilterOpen = (o: boolean) => {
    setFilterOpenState(o);
    save(FILTER_OPEN_KEY, o);
  };
  const multi = isMulti(state.config);
  const filtered = isFiltered(filter, multi);
  // The lane a row is listed under: Parked for a suspended session, whatever its status says.
  const laneFor = (s: Session): Lane =>
    s.state === "suspended" ? "parked" : laneOf(statusOf(s).key);
  // The rows keep the sessions themselves; only the keys come back from the filter.
  const kept = filtered
    ? new Set(
        filterSessions(
          sessions.map((s) => ({
            ...s,
            ticket: s.issue !== null ? ticketLabel(s.issueRepo, s.issue) : null,
            lane: laneFor(s),
          })),
          filter,
          { stars, multi },
        ).map((s) => s.key),
      )
    : null;
  const visible = kept ? sessions.filter((s) => kept.has(s.key)) : sessions;
  const shells = shellsShown(others ?? [], filter, multi);
  const allLive = sessions.filter((s) => s.state !== "suspended");
  const live = visible.filter((s) => s.state !== "suspended");
  const { starred, rest: unstarred } = splitStarred(live, stars);
  const suspended = visible.filter((s) => s.state === "suspended");
  const parkedHeld = parkedForced(filter);
  const parkedOpen = showSuspended || parkedHeld;

  // Cleanup: rows become selectable (merged ones picked); Stop ends the picked sessions.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [stopping, setStopping] = useState(false);
  const startCleanup = () =>
    setPicked(cleanupDefaults(visible, state.prStage));
  const togglePick = (key: string) =>
    setPicked((p) => {
      if (!p) return p;
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  // Only what is listed: a filter never hides a session that is about to be stopped.
  const toStop = picked
    ? visible.filter((s) => picked.has(s.key) && canStop(s))
    : [];
  const stopPicked = async () => {
    const n = toStop.length;
    if (!(await webConfirm(`Stop ${n} session${n === 1 ? "" : "s"}?`, { confirmLabel: "Stop", danger: true })))
      return;
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
        starred={stars.includes(s.key)}
        onStar={() => toggleStar(s.key)}
        loop={rowLoop(state.loops?.[s.sessionId], now)}
        sched={state.schedRuns?.[s.key]?.name ?? null}
        held={(state.held ?? []).filter((m) => m.sessionKey === s.key).length}
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
  // Each tab's sessions and how many of them need you (held and idle items left out, as in `hot`).
  const hotKeys = new Set(
    open
      .filter((e) => e.item.kind !== "held" && e.item.kind !== "idle")
      .map((e) => e.item.sessionKey),
  );
  const tabCounts: Record<string, number> = { [ALL]: everySession.length };
  const tabHot: Record<string, number> = { [ALL]: 0 };
  for (const s of everySession) {
    const g = groups.of[s.key];
    const h = hotKeys.has(s.key) ? 1 : 0;
    tabHot[ALL] += h;
    if (!g) continue;
    tabCounts[g] = (tabCounts[g] ?? 0) + 1;
    tabHot[g] = (tabHot[g] ?? 0) + h;
  }
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
        onOpenMeeting={onOpenMeeting}
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
        {onNew ? (
          <NewMenu onPick={onNew} />
        ) : (
          <button
            className="col-btn"
            onClick={onNewShell}
            title="New shell in the workspace  ⌘T"
          >
            +
          </button>
        )}
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

        <SessionGroupBar
          groups={groups}
          tab={tab}
          onTab={pickTab}
          counts={tabCounts}
          hot={tabHot}
          draggingSession={!!dragKey}
          onAssign={(k, g) => {
            // The row may leave this tab's list before its dragend arrives.
            setDragKey(null);
            setDropKey(null);
            void assignTab(k, g);
          }}
          onDragOverBar={() => setDropKey(null)}
          flash={flash}
        />
        {tab !== ALL && sessions.length === 0 && (
          <div className="empty sgroup-empty">
            No sessions in this tab. Drag one onto it, or right-click a session → Move to tab.
          </div>
        )}
        {sessions.length > 0 && (
          <SessionFilterBar
            filter={filter}
            onFilter={setFilter}
            open={filterOpen}
            onOpen={setFilterOpen}
            multi={multi}
            accounts={accountChoicesFor(
              state.config.accounts.map((a) => a.login),
              sessions,
              filter.accounts,
            )}
            folders={folderChoices(sessions, filter.folders)}
          />
        )}
        {tab === ALL && allLive.length === 0 && !others?.length && (
          <div className="empty" style={{ padding: "10px 14px" }}>
            No live sessions. Start one from the board, or open a shell.
          </div>
        )}
        {filtered && sessions.length > 0 && visible.length === 0 && (
          <div className="empty sfilter-empty">
            No sessions match the filters.{" "}
            <button className="link-btn" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </button>
          </div>
        )}
        {starred.length > 0 && (
          <div className="section">
            <div
              className="section-head lane-starred"
              title="Sessions you starred stay here whatever their status. Unstar to send one back to its group."
            >
              Starred <span className="count">{starred.length}</span>
            </div>
            {starred.map((s) => rowFor(s, statusOf(s)))}
          </div>
        )}
        {LANES.filter((l) => l.id !== "parked").map((l) => {
          const list = unstarred.filter((s) => laneOf(statusOf(s).key) === l.id);
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
        {shells.length > 0 && (
          <div className="section">
            <div className="section-head">
              Shells &amp; starting{" "}
              <span className="count">{shells.length}</span>
            </div>
            {shells.map((t) => (
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
              className={`row ${parkedHeld ? "held" : ""}`}
              onClick={() => !parkedHeld && setShowSuspended(!showSuspended)}
              title={parkedHeld ? "Open while the Parked filter is on" : undefined}
            >
              <span className="mark">{parkedOpen ? "▾" : "▸"}</span>
              <span className="label sub">Parked · {suspended.length}</span>
            </div>
            {parkedOpen && suspended.map((s) => rowFor(s))}
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
            starred={stars.includes(menu.s.key)}
            onStar={() => toggleStar(menu.s.key)}
            groups={groups.groups}
            group={groups.of[menu.s.key] ?? null}
            onGroup={(g) => void assignTab(menu.s.key, g)}
            onClone={() => onSessionAction(menu.s, "clone")}
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
              "One cache (~/.claude/gh-cache) shared by MasterDeck, master and the skills"
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
                      : new Set(visible.filter(canStop).map((s) => s.key)),
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
          {can("refresh") && (
            <button
              className="link-btn"
              onClick={refresh}
              disabled={refreshing || state.githubRefreshing}
            >
              {refreshing || state.githubRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
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
  account: "GITHUB",
  waiting: "WAITING",
  error: "API ERROR",
  external: "ASKED",
  mods: "MODS",
  loop: "LOOP",
  "loop-paused": "LOOP",
  meeting: "MEETING",
  notice: "NOTICE",
};


/** `status`: the session's status (see `sessionStatus`); a parked session keeps its plain state. */
export function SessionRow({
  s,
  active,
  now,
  status,
  onClick,
  pick,
  starred,
  onStar,
  loop,
  sched,
  held,
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
  /** Starred or not, and its toggle; absent (Cleanup) shows no star. */
  starred?: boolean;
  onStar?: () => void;
  /** Its workflow loop's badge and line (`rowLoop`); none without a loop to show. */
  loop?: { badge: string; line: string } | null;
  /** The schedule that started it (#140), if one did. */
  sched?: string | null;
  /** MasterDeck messages waiting for its prompt to be empty (#123). */
  held?: number;
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
        {/* The name keeps the first line; the ticket and account wrap below it when the rail is narrow. */}
        <span className="srow-name">
          <span className="label">{s.name}</span>
          {s.issue !== null && (
            <span className="num">{ticketLabel(s.issueRepo, s.issue)}</span>
          )}
          <AccountBadge login={s.account} ghActive={s.ghActive} />
          {sched && (
            <span className="srow-sched" title={`Started by the schedule "${sched}" (Schedules)`}>
              ⏱ {sched}
            </span>
          )}
        </span>
        {loop && (
          <span
            className={`srow-loop ${loop.badge.endsWith("!") ? "limit" : loop.badge.endsWith("✓") ? "met" : ""}`}
            title={loop.line}
          >
            {loop.badge}
          </span>
        )}
        {!!held && (
          <span className="srow-held" title={`${held} MasterDeck message${held === 1 ? "" : "s"} waiting for its prompt to be empty`}>
            ✉ {held}
          </span>
        )}
        {onStar && (
          <button
            className={`srow-star ${starred ? "on" : ""}`}
            aria-label={starred ? `Unstar ${s.name}` : `Star ${s.name}`}
            aria-pressed={!!starred}
            title={starred ? "Unstar: back to its status group" : "Star: keep it in Starred at the top"}
            onClick={(e) => {
              e.stopPropagation();
              onStar();
            }}
          >
            {starred ? "★" : "☆"}
          </button>
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

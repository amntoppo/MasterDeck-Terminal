import {
  getConfig,
  projectByKey,
  statusGroup,
  statusRank,
  type StatusGroup,
} from "@shared/appConfig";
import { nextTabName, ViewTabs } from "./ViewTabs";
import { fullRepo, ticketKey, ticketLabel, ticketOf } from "@shared/ticket";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cardBadge,
  cardsIn,
  moveColumn,
  orderColumns,
  saveColumnOrder,
  visibleColumns,
} from "@shared/board";
import { createPortal } from "react-dom";
import type { PastSession } from "@shared/pastSessions";
import {
  applyFilters,
  cardAction,
  defaultFilters,
  filterOptions,
  normalizeFilters,
  repoOptions,
  UNASSIGNED,
  type BoardTab,
  type FilterState,
} from "@shared/boardFilter";
import { ticketSpend } from "@shared/costs";
import { sessionForIssue } from "@shared/derive";
import {
  formatAgo,
  formatCost,
  formatPct,
  formatRefreshed,
} from "@shared/format";
import type {
  AppState,
  Badge,
  BoardCard,
  BoardPr,
  Session,
} from "@shared/types";
import { deck, load, save, useNow } from "../deck";
import {
  boardFor,
  ClaudeMark,
  NewTicketDialog,
  type TicketContext,
} from "./NewTicket";
import { TerminalView } from "./TerminalView";
import type { NewTicket } from "@shared/ipc";

interface Props {
  state: AppState;
  onOpenSession: (s: Session) => void;
  /** My card without a session: the Start dialog. */
  onStart: (card: BoardCard) => void;
  /** Someone else's card with a PR. */
  onPr: (card: BoardCard) => void;
  /** Someone else's (or nobody's) card without a PR. */
  onAssign: (card: BoardCard) => void;
  onSummary: () => void;
}

const BADGE_ICON: Record<Badge["kind"], string> = {
  question: "❓",
  blocked: "⛔",
  "needs-input": "✋",
  onboarding: "⏳",
  working: "⚙️",
  merged: "🟣",
  rework: "🔁",
  approved: "👍",
  changes: "✏️",
  "ci-failing": "❌",
  ready: "👀",
  "in-review": "🔍",
  done: "✅",
  waiting: "📡",
  idle: "💤",
  stopped: "⏸",
  none: "○",
};

const COLUMN_COLOR: Record<string, string> = {
  "To Do": "var(--grey)",
  "Ready For Dev": "var(--accent)",
  "In Dev": "var(--amber)",
  "PR Raised": "var(--amber)",
  "Dev Done": "#f28b50",
  "In QA": "var(--purple)",
  "QA Done": "var(--green)",
  "Re-Open": "var(--red)",
  Blocked: "var(--red)",
};

const TABS_KEY = "boardTabs";
const TAB_KEY = "boardTab";
const MINE_TAB = "board-mine";

/** The saved tabs; before any are saved, Mine (my issues, selected) and Everyone. */
function loadTabs(me: string | null): BoardTab[] {
  const saved = load<BoardTab[] | null>(TABS_KEY, null);
  if (Array.isArray(saved) && saved.length)
    return saved
      .filter((t) => t && typeof t.id === "string")
      .map((t) => ({
        id: t.id,
        name: typeof t.name === "string" && t.name ? t.name : "Board",
        filters: normalizeFilters(t.filters, me),
      }));
  return [
    { id: MINE_TAB, name: "Mine", filters: defaultFilters(me) },
    {
      id: "board-everyone",
      name: "Everyone",
      filters: { ...defaultFilters(me), assignees: [] },
    },
  ];
}

const GROUP_COLOR: Record<StatusGroup, string> = {
  todo: "var(--grey)",
  progress: "var(--amber)",
  review: "var(--amber)",
  done: "var(--green)",
  blocked: "var(--red)",
  other: "var(--purple)",
};

function columnColor(col: string): string {
  const s = getConfig().statuses;
  if (col === s.ready) return "var(--accent)";
  if (col === s.devDone) return "#f28b50";
  return COLUMN_COLOR[col] ?? GROUP_COLOR[statusGroup(col)];
}

const COL_ORDER_KEY = "boardColumnOrder";

/** A column being moved: where it would land, and where its lifted heading is drawn. */
interface ColDrag {
  col: string;
  to: number;
  x: number;
  y: number;
  w: number;
}

export function BoardView({
  state,
  onOpenSession,
  onStart,
  onPr,
  onAssign,
  onSummary,
}: Props) {
  const now = useNow(15_000);
  const [refreshing, setRefreshing] = useState(false);
  // Drag and drop: a card shows in its new column at once; this is dropped when GitHub confirms or fails.
  // By ticketKey: two repos can each have a #12.
  const [moving, setMoving] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    card: BoardCard;
    to: string;
  } | null>(null);
  const [moveMsg, setMoveMsg] = useState<string | null>(null);
  const [ticketCtx, setTicketCtx] = useState<TicketContext | null>(null);
  // Kept across visits to the Board: the session keeps running while another view shows.
  const [claude, setClaudeRaw] = useState<TicketSession | null>(
    () => keptSession,
  );
  const setClaude = (c: TicketSession | null) => {
    keptSession = c;
    setClaudeRaw(c);
  };
  const [panelW, setPanelW] = useState<number>(() =>
    load<number>("ticketPanelW", 520),
  );
  useEffect(() => save("ticketPanelW", panelW), [panelW]);
  const [created, setCreated] = useState<string | null>(null);
  // Column order: long-press a column's heading, then drag it; saved for every tab.
  const [colOrder, setColOrder] = useState<string[]>(() =>
    load<string[]>(COL_ORDER_KEY, []),
  );
  useEffect(() => save(COL_ORDER_KEY, colOrder), [colOrder]);
  const [colDrag, setColDrag] = useState<ColDrag | null>(null);
  const colsEl = useRef<HTMLDivElement>(null);
  const shownCols = useRef<string[]>([]);
  useEffect(
    () =>
      deck().onTicketsCreated((t) => {
        const m = `Claude created ${t.map((x) => `#${x.number}`).join(", ")}`;
        setCreated(m);
        setTimeout(() => setCreated((c) => (c === m ? null : c)), 6000);
      }),
    [],
  );
  const spend = useMemo(() => ticketSpend(state.costBook), [state.costBook]);

  const doMove = async (card: BoardCard, to: string) => {
    const k = ticketKey(card.repo, card.number);
    const lab = ticketLabel(card.repo, card.number);
    setMoving((m) => ({ ...m, [k]: to }));
    setMoveMsg(`Moving ${lab} to ${to}…`);
    const r = await deck().setStatus(ticketOf(card), to);
    setMoving((m) => {
      const n = { ...m };
      delete n[k];
      return n;
    });
    setMoveMsg(r.ok ? r.message : `Could not move ${lab}: ${r.message}`);
    setTimeout(() => setMoveMsg(null), 5000);
  };
  const drop = (col: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const k = e.dataTransfer.getData("text/masterdeck-card");
    const card = state.board?.cards.find(
      (c) => ticketKey(c.repo, c.number) === k,
    );
    // Only statuses babysit-ticket can set on the card's own board (a column GitHub added later, or
    // another board's column, would fail as "unknown status").
    const cols = projectByKey(card?.project)?.columns ?? state.config.columns;
    if (!card || !cols.includes(col) || (moving[k] ?? card.status) === col)
      return;
    const back =
      statusRank(col, undefined, card.project) <
      statusRank(card.status ?? "", undefined, card.project);
    if (back) setPendingMove({ card, to: col });
    else void doMove(card, col);
  };
  const me = state.me;
  // Tabs: each its own name and filters over the one board fetched from GitHub.
  const [tabs, setTabs] = useState<BoardTab[]>(() => loadTabs(me));
  const [tabId, setTabId] = useState<string>(() => load<string>(TAB_KEY, ""));
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];
  // First run: the Mine tab filters to me once my login is known.
  const [meFilled, setMeFilled] = useState(
    () => load<BoardTab[] | null>(TABS_KEY, null) !== null,
  );
  useEffect(() => {
    if (meFilled || !me) return;
    setMeFilled(true);
    setTabs((ts) =>
      ts.map((t) =>
        t.id === MINE_TAB && t.filters.assignees.length === 0
          ? { ...t, filters: { ...t.filters, assignees: [me] } }
          : t,
      ),
    );
  }, [me, meFilled]);
  useEffect(() => save(TABS_KEY, tabs), [tabs]);
  useEffect(() => save(TAB_KEY, tab.id), [tab.id]);
  const f = tab.filters;
  const setFilters = (next: FilterState) =>
    setTabs((ts) =>
      ts.map((t) => (t.id === tab.id ? { ...t, filters: next } : t)),
    );
  const set = (patch: Partial<FilterState>) => setFilters({ ...f, ...patch });
  const addTab = () => {
    const id = `board-${Date.now().toString(36)}`;
    setTabs([
      ...tabs,
      {
        id,
        name: nextTabName(tabs, "Board"),
        filters: { ...defaultFilters(me), assignees: [] },
      },
    ]);
    setTabId(id);
    return id;
  };
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) return;
    setTabs(rest);
    if (id === tab.id)
      setTabId(rest[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)].id);
  };
  const renameTab = (id: string, name: string) =>
    setTabs((ts) =>
      ts.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)),
    );

  const rawBoard = state.board;
  const b = useMemo(
    () =>
      rawBoard && Object.keys(moving).length
        ? {
            ...rawBoard,
            cards: rawBoard.cards.map((c) =>
              moving[ticketKey(c.repo, c.number)]
                ? { ...c, status: moving[ticketKey(c.repo, c.number)] }
                : c,
            ),
          }
        : rawBoard,
    [rawBoard, moving],
  );
  const shown = useMemo(() => (b ? applyFilters(b, f) : null), [b, f]);
  const options = useMemo(
    () =>
      b
        ? filterOptions(b, me, state.users)
        : { assignees: [], labels: [], milestones: [] },
    [b, me, state.users],
  );

  const refresh = async () => {
    setRefreshing(true);
    await deck().refresh();
    setRefreshing(false);
  };

  const onCard = (card: BoardCard) => {
    const action = cardAction(card, me, state.sessions);
    if (action === "session") {
      const s = sessionForIssue(state.sessions, ticketOf(card));
      if (s) onOpenSession(s);
    } else if (action === "start") onStart(card);
    else if (action === "pr") onPr(card);
    else onAssign(card);
  };

  const loading = state.boardLoading || state.githubRefreshing || refreshing;
  const current = state.sprints.find(
    (s) => !s.completed && inSprint(s.startDate, s.duration, now),
  );
  const columns = shown
    ? orderColumns(
        visibleColumns(shown, f.projects).filter(
          (c) => !f.hiddenColumns.includes(c),
        ),
        colOrder,
      )
    : [];
  shownCols.current = columns;
  const laidOut = colDrag ? moveColumn(columns, colDrag.col, colDrag.to) : columns;

  // Long press (350ms, without moving) lifts a column; it then follows the pointer, and the
  // board scrolls when the pointer nears its left or right edge. Esc puts it back.
  const pressColumn = (e: React.PointerEvent<HTMLDivElement>, col: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const head = e.currentTarget.getBoundingClientRect();
    const off = { x: e.clientX - head.left, y: e.clientY - head.top };
    const start = { x: e.clientX, y: e.clientY };
    let at = start;
    let lifted = false;
    let to = shownCols.current.indexOf(col);
    let frame = 0;
    const slot = () => {
      const box = colsEl.current;
      const els = box?.querySelectorAll<HTMLElement>(":scope > .board-col");
      if (!box || !els?.length) return to;
      const first = els[0].getBoundingClientRect().left;
      const pitch =
        els.length > 1
          ? els[1].getBoundingClientRect().left - first
          : els[0].offsetWidth;
      const i = Math.floor((at.x - off.x + head.width / 2 - first) / pitch);
      return Math.max(0, Math.min(i, shownCols.current.length - 1));
    };
    const update = () => {
      to = slot();
      setColDrag({ col, to, x: at.x - off.x, y: at.y - off.y, w: head.width });
    };
    const scroll = () => {
      const box = colsEl.current;
      if (box) {
        const r = box.getBoundingClientRect();
        const edge = Math.min(80, r.width / 4);
        const left = at.x - r.left;
        const right = r.right - at.x;
        const step =
          left < edge
            ? -Math.ceil(((edge - left) / edge) * 22)
            : right < edge
              ? Math.ceil(((edge - right) / edge) * 22)
              : 0;
        if (step) {
          box.scrollLeft += step;
          update();
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    const lift = () => {
      lifted = true;
      document.body.classList.add("col-dragging");
      update();
      frame = requestAnimationFrame(scroll);
    };
    const timer = window.setTimeout(lift, 350);
    const move = (ev: PointerEvent) => {
      at = { x: ev.clientX, y: ev.clientY };
      if (lifted) update();
      else if (Math.hypot(at.x - start.x, at.y - start.y) > 6) end(false);
    };
    const end = (keep: boolean) => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc, true);
      document.body.classList.remove("col-dragging");
      if (!lifted) return;
      setColDrag(null);
      if (keep)
        setColOrder((o) =>
          saveColumnOrder(o, moveColumn(shownCols.current, col, to)),
        );
      // The release would otherwise count as a click on whatever is under it.
      const swallow = (ev: MouseEvent) => (
        ev.stopPropagation(),
        ev.preventDefault()
      );
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc, true);
  };
  const boards = b?.projects?.length
    ? b.projects
    : state.config.projects.map((p) => ({
        key: `${p.owner}/${p.number}`,
        title: p.title,
        columns: p.columns,
      }));
  const repos = repoOptions(b, state.config.repos);

  // New ticket (+ on a column) and Create with Claude (a session on the right, on the Board only).
  const ctxFor = (col: string): TicketContext => ({
    status: col,
    project: boardFor(state, col, f),
    filters: f,
    sprint: state.selectedSprint,
    tab: tab.name,
  });
  // `restart`: a new conversation. Otherwise an open session keeps going: its context.json now
  // says where this + was, and what was typed in the dialog is sent to it as a message.
  const openClaude = async (
    ctx: TicketContext,
    draft?: NewTicket,
    restart = false,
  ) => {
    const r = await deck().ticketBuilderPrepare({
      ...ctx,
      ...(draft ? { draft } : {}),
    });
    if (!r.ok) return setMoveMsg(r.message);
    setTicketCtx(null);
    const typed = draft && (draft.title.trim() || draft.body.trim());
    const prompt = typed
      ? `Write this ticket for ${ctx.status}: ${draft!.title.trim()}${draft!.body.trim() ? `. ${draft!.body.trim()}` : ""} (the rest of what I picked is in context.json's draft). Show it to me first; create it once I say so.`.replace(
          /\s*\n+\s*/g,
          " ",
        )
      : undefined;
    if (claude && !restart) {
      setClaude({ ...claude, ctx });
      if (prompt) {
        deck().ptyWrite(`ticket-builder:${claude.gen}`, prompt);
        setTimeout(
          () => deck().ptyWrite(`ticket-builder:${claude.gen}`, "\r"),
          150,
        );
      }
      return;
    }
    if (claude) deck().ptyClose(`ticket-builder:${claude.gen}`);
    setClaude({
      gen: (claude?.gen ?? 0) + 1,
      resume: !restart && !prompt && r.canContinue,
      prompt,
      ctx,
    });
  };
  const closeClaude = () => {
    if (claude) deck().ptyClose(`ticket-builder:${claude.gen}`);
    setClaude(null);
  };
  const dragPanel = (e: React.MouseEvent) => {
    e.preventDefault();
    const right = (e.currentTarget.parentElement?.getBoundingClientRect()
      .right ?? window.innerWidth) as number;
    const move = (ev: MouseEvent) =>
      setPanelW(
        Math.round(
          Math.min(Math.max(right - ev.clientX, 340), window.innerWidth * 0.6),
        ),
      );
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      <section
        className="board-view"
        style={
          claude
            ? { right: `calc(var(--right-w, 0px) + ${panelW + 6}px)` }
            : undefined
        }
      >
        <ViewTabs
          tabs={tabs}
          activeId={tab.id}
          onSelect={setTabId}
          onAdd={addTab}
          onClose={closeTab}
          onRename={renameTab}
          addTitle="Another board tab, with its own repos, boards and filters"
        />
        <header className="board-head">
          <select
            className="sprint-pick"
            value={state.selectedSprint}
            onChange={(e) => deck().setSprint(e.target.value)}
            title="Sprint"
          >
            <option value="@current">
              Current sprint{current ? ` (${current.title})` : ""}
            </option>
            {state.sprints
              .filter((s) => s.title !== current?.title)
              .map((s) => (
                <option key={s.id} value={s.title}>
                  {s.title} · {s.startDate}
                  {s.completed
                    ? ""
                    : new Date(s.startDate).getTime() > now
                      ? " (upcoming)"
                      : ""}
                </option>
              ))}
            <option value="none">No sprint</option>
          </select>
          <span className="muted">
            {b && shown
              ? `${shown.cards.length} of ${b.cards.length} issues`
              : ""}
          </span>
          {state.boardError && (
            <span className="board-error" title={state.boardError}>
              {state.boardError.length > 100
                ? state.boardError.slice(0, 100) + "…"
                : state.boardError}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {moveMsg && <span className="muted">{moveMsg}</span>}
          <button
            className="btn"
            onClick={onSummary}
            title="Done, in progress, blocked and burndown"
          >
            Summary
          </button>
          <span
            className="muted"
            title={
              state.githubRefreshedAt
                ? new Date(state.githubRefreshedAt).toLocaleString()
                : ""
            }
          >
            {loading
              ? "refreshing from GitHub…"
              : state.githubRefreshedAt
                ? `refreshed ${formatRefreshed(now - state.githubRefreshedAt)}`
                : "not refreshed yet"}
          </span>
          <button className="btn" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        <div className="filter-bar">
          {repos.length > 1 && (
            <MultiPick
              label="Repos"
              all="All repos"
              values={f.repos}
              options={repos.map((r) => ({
                value: r,
                label: r.split("/")[1] ?? r,
              }))}
              onChange={(v) =>
                set({ repos: v.length === repos.length ? [] : v })
              }
              quick={[{ label: "Select all", values: [] }]}
            />
          )}
          {boards.length > 1 && (
            <MultiPick
              label="Boards"
              all="All boards"
              values={f.projects}
              options={boards.map((p) => ({ value: p.key, label: p.title }))}
              onChange={(v) =>
                set({
                  projects: v.length === boards.length ? [] : v,
                  hiddenColumns: [],
                })
              }
              quick={[{ label: "Select all", values: [] }]}
            />
          )}
          <MultiPick
            label="Assignee"
            all="Everyone"
            values={f.assignees}
            options={[
              ...options.assignees.map((u) => ({
                value: u,
                label: u === me ? `${u} (me)` : u,
              })),
              { value: UNASSIGNED, label: "Unassigned" },
            ]}
            onChange={(assignees) => set({ assignees })}
            quick={
              me
                ? [
                    { label: "Me", values: [me] },
                    { label: "Everyone", values: [] },
                  ]
                : []
            }
          />
          <MultiPick
            label="Labels"
            all="Any label"
            values={f.labels}
            options={options.labels.map((l) => ({ value: l, label: l }))}
            onChange={(labels) => set({ labels })}
          />
          <select
            className="fsel"
            value={f.milestone ?? ""}
            onChange={(e) => set({ milestone: e.target.value || null })}
          >
            <option value="">Any milestone</option>
            {options.milestones.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <select
            className="fsel"
            value={f.hasPr}
            onChange={(e) =>
              set({ hasPr: e.target.value as FilterState["hasPr"] })
            }
          >
            <option value="any">PR: any</option>
            <option value="with">Has a PR</option>
            <option value="without">No PR</option>
          </select>
          <MultiPick
            label="Columns"
            all="All columns"
            values={
              shown
                ? visibleColumns(shown, f.projects).filter(
                    (c) => !f.hiddenColumns.includes(c),
                  )
                : []
            }
            options={(shown ? visibleColumns(shown, f.projects) : []).map(
              (c) => ({ value: c, label: c }),
            )}
            onChange={(vis) =>
              set({
                hiddenColumns: (shown
                  ? visibleColumns(shown, f.projects)
                  : []
                ).filter((c) => !vis.includes(c)),
              })
            }
            invertAll
          />
          <input
            className="filter search"
            placeholder="Search title or #number"
            value={f.search}
            onChange={(e) => set({ search: e.target.value })}
          />
          {(f.labels.length > 0 ||
            f.milestone ||
            f.hasPr !== "any" ||
            f.search ||
            f.hiddenColumns.length > 0 ||
            f.repos.length > 0 ||
            f.projects.length > 0 ||
            f.assignees.join() !== (me ?? "")) && (
            <button
              className="link-btn"
              onClick={() => setFilters(defaultFilters(me))}
            >
              Reset filters
            </button>
          )}
        </div>

        {!b || !shown ? (
          <div className="welcome">
            {loading ? (
              <div>Loading board…</div>
            ) : (
              <>
                <h2>Board not loaded</h2>
                <div>{state.boardError ?? "No data yet."}</div>
                <button className="btn primary" onClick={refresh}>
                  Retry
                </button>
              </>
            )}
          </div>
        ) : shown.cards.length === 0 ? (
          <div className="welcome">
            <h2>No issues match</h2>
            <div>
              {b.cards.length} issues in this sprint; the filters hide all of
              them.
            </div>
            <button
              className="btn"
              onClick={() =>
                setFilters({ ...defaultFilters(me), assignees: [] })
              }
            >
              Show everyone's issues
            </button>
          </div>
        ) : (
          <div className="board-cols" ref={colsEl}>
            {laidOut.map((col) => {
              const cards = cardsIn(shown, col);
              return (
                <div
                  key={col}
                  className={`board-col ${dragOver === col ? "drop" : ""} ${colDrag?.col === col ? "lifted" : ""}`}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes("text/masterdeck-card"))
                      return;
                    e.preventDefault();
                    setDragOver(col);
                  }}
                  onDragLeave={() => setDragOver((d) => (d === col ? null : d))}
                  onDrop={(e) => drop(col, e)}
                >
                  <div
                    className="board-col-head"
                    onPointerDown={(e) => pressColumn(e, col)}
                    title="Hold to move this column"
                  >
                    <span
                      className="ring"
                      style={{ borderColor: columnColor(col) }}
                    />
                    <strong>{col}</strong>
                    <span className="count">{cards.length}</span>
                    <span style={{ flex: 1 }} />
                    <button
                      className="col-add"
                      onClick={() => setTicketCtx(ctxFor(col))}
                      title={`New ticket in ${col}`}
                      aria-label={`New ticket in ${col}`}
                    >
                      +
                    </button>
                  </div>
                  <div className="board-col-body">
                    {cards.map((c) => (
                      <Card
                        key={ticketKey(c.repo, c.number)}
                        card={c}
                        state={state}
                        me={me}
                        now={now}
                        spend={spend[ticketKey(c.repo, c.number)] ?? 0}
                        moving={!!moving[ticketKey(c.repo, c.number)]}
                        onClick={() => onCard(c)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {pendingMove && (
          <div className="move-confirm">
            Move {ticketLabel(pendingMove.card.repo, pendingMove.card.number)}{" "}
            back from <b>{pendingMove.card.status}</b> to{" "}
            <b>{pendingMove.to}</b>?
            <button className="btn" onClick={() => setPendingMove(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                const m = pendingMove;
                setPendingMove(null);
                void doMove(m.card, m.to);
              }}
            >
              Move back
            </button>
          </div>
        )}
        {created && <div className="ticket-toast">{created}</div>}
        {colDrag &&
          createPortal(
            <div
              className="col-ghost"
              style={{ left: colDrag.x, top: colDrag.y, width: colDrag.w }}
            >
              <span
                className="ring"
                style={{ borderColor: columnColor(colDrag.col) }}
              />
              <strong>{colDrag.col}</strong>
              <span className="count">
                {shown ? cardsIn(shown, colDrag.col).length : 0}
              </span>
            </div>,
            document.body,
          )}
      </section>
      {ticketCtx && (
        <NewTicketDialog
          state={state}
          ctx={ticketCtx}
          onClose={() => setTicketCtx(null)}
          onWithClaude={(ctx, draft) => void openClaude(ctx, draft)}
        />
      )}
      {claude && (
        <>
          <div
            className="ticket-split"
            style={{ right: `calc(var(--right-w, 0px) + ${panelW}px)` }}
            onMouseDown={dragPanel}
            onDoubleClick={() => setPanelW(520)}
            title="Drag to resize · double-click to reset"
          />
          <aside
            className="ticket-panel"
            style={{ width: panelW }}
            aria-label="Create tickets with Claude"
          >
            <div className="wf-builder-head">
              <b>
                <ClaudeMark /> Tickets with Claude
              </b>
              <span
                className="muted small"
                title="Where new tickets go; + on another column changes it"
              >
                {claude.ctx.status}
                {claude.ctx.tab ? ` · ${claude.ctx.tab}` : ""}
                {claude.ctx.sprint && claude.ctx.sprint !== "none"
                  ? ` · ${claude.ctx.sprint === "@current" ? "current sprint" : claude.ctx.sprint}`
                  : ""}
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="btn"
                onClick={() => void openClaude(claude.ctx, undefined, true)}
                title="Start a new conversation"
              >
                New chat
              </button>
              <button
                className="insp-hide"
                onClick={closeClaude}
                aria-label="Close"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="wf-builder-term">
              <TerminalView
                key={claude.gen}
                paneId={`ticket-builder:${claude.gen}`}
                spec={{
                  kind: "ticket-builder",
                  resume: claude.resume,
                  prompt: claude.prompt,
                }}
                visible
                focusOnShow
              />
            </div>
            <div className="wf-builder-tip muted">
              Describe what you need (“a bug: report sharing fails for B2B
              orgs”, “split this into tickets…”). It creates them on the board,
              in the column you clicked, with the tab's people, labels and
              sprint.
            </div>
          </aside>
        </>
      )}
    </>
  );
}

type TicketSession = {
  gen: number;
  resume: boolean;
  prompt?: string;
  ctx: TicketContext;
};
/** The Board's Claude session, kept while another view shows (its terminal keeps running). */
let keptSession: TicketSession | null = null;

function inSprint(start: string, days: number, now: number): boolean {
  const t = Date.parse(start);
  return Number.isFinite(t) && now >= t && now < t + days * 86_400_000;
}

function Card({
  card,
  state,
  me,
  now,
  spend,
  moving,
  onClick,
}: {
  card: BoardCard;
  state: AppState;
  me: string | null;
  now: number;
  spend: number;
  moving: boolean;
  onClick: () => void;
}) {
  const t = ticketOf(card);
  const s = sessionForIssue(state.sessions, t);
  const mine = me !== null && card.assignees.includes(me);
  // Stopped sessions that worked on this issue: the newest can be resumed from the card.
  const past = s ? [] : (state.pastSessions[ticketKey(t.repo, t.number)] ?? []);
  const badge =
    mine || s || past.length
      ? cardBadge(
          t,
          state.sessions,
          state.proposals,
          past,
          state.prStage,
          state.manualStatus,
        )
      : null;
  const action = cardAction(card, me, state.sessions);
  const stats = s ? state.stats[s.sessionId] : undefined;
  return (
    <div
      className={`bcard ${mine ? "mine" : ""} ${moving ? "moving" : ""}`}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "text/masterdeck-card",
          ticketKey(card.repo, card.number),
        );
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      title={
        action === "session"
          ? `Open ${s?.name}`
          : action === "start"
            ? "Start a session"
            : action === "pr"
              ? "See the PR and review it"
              : "Assign it"
      }
    >
      <div className="bcard-top">
        <span className="issue-ico">⊙</span>
        <span className="muted" title={fullRepo(card.repo)}>
          {fullRepo(card.repo).split("/")[1]} #{card.number}
        </span>
        <span style={{ flex: 1 }} />
        {badge ? (
          <span
            className={`badge ${badge.kind}`}
            title={badge.detail ?? badge.label}
          >
            {BADGE_ICON[badge.kind]} {badge.label}
          </span>
        ) : (
          <span className="badge none">
            {action === "pr" ? "🔍 Review PR" : "👤 Assign"}
          </span>
        )}
      </div>
      <div className="bcard-title">{card.title}</div>
      {(card.labels.length > 0 || card.type) && (
        <div className="bcard-labels">
          {card.type && <span className="lbl type">{card.type}</span>}
          {card.labels.map((l) => (
            <span key={l} className="lbl">
              {l}
            </span>
          ))}
        </div>
      )}
      {card.prs.length > 0 && (
        <div className="bcard-prs">
          {card.prs.map((p) => (
            <PrChip key={p.url} pr={p} />
          ))}
        </div>
      )}
      <div className="bcard-foot">
        {s ? (
          <>
            <span className={`dot ${s.state}`} />
            <span className="label">{s.name}</span>
            {stats?.costUsd != null && <span>{formatCost(stats.costUsd)}</span>}
            {stats?.contextPct != null && (
              <span>ctx {formatPct(stats.contextPct)}</span>
            )}
            {s.startedAt > 0 && <span>{formatAgo(now - s.startedAt)}</span>}
          </>
        ) : past.length ? (
          <>
            <span
              className="label"
              title={`${past[0].name}\n${past[0].cwd ?? ""}${past.length > 1 ? `\n+${past.length - 1} earlier session(s): open the card to see them` : ""}`}
            >
              ⏸ {past[0].name}
            </span>
            <span>{formatAgo(now - past[0].lastActivity)}</span>
            <ResumeButton p={past[0]} />
          </>
        ) : (
          <span className="label" />
        )}
        {spend > 0.005 && (
          <span
            className={`spend ${state.settings.budgetPerTicketUsd > 0 && spend > state.settings.budgetPerTicketUsd ? "over" : ""}`}
            title="Spent by this ticket's sessions"
          >
            {formatCost(spend)}
          </span>
        )}
        <Assignees logins={card.assignees} me={me} />
      </div>
    </div>
  );
}

/** Continue a stopped session in the background (same conversation and id); it shows up in the sidebar. */
function ResumeButton({ p }: { p: PastSession }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <button
      className="mini-btn"
      disabled={busy}
      title={msg ?? `claude --bg --resume ${p.sessionId}`}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        const r = await deck().resumeSession(p.sessionId, p.name, p.cwd);
        setBusy(false);
        setMsg(r.ok ? "Resumed" : r.message);
      }}
    >
      {busy ? "Resuming…" : msg === "Resumed" ? "Resumed" : "Resume"}
    </button>
  );
}

function Assignees({ logins, me }: { logins: string[]; me: string | null }) {
  if (logins.length === 0)
    return (
      <span className="avatar none" title="Unassigned">
        —
      </span>
    );
  return (
    <span className="avatars">
      {logins.slice(0, 3).map((l) => (
        <span key={l} className={`avatar ${l === me ? "me" : ""}`} title={l}>
          {initials(l)}
        </span>
      ))}
      {logins.length > 3 && (
        <span className="avatar">+{logins.length - 3}</span>
      )}
    </span>
  );
}

function initials(login: string): string {
  const parts = login.split(/[-_.]/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : login.slice(0, 2);
  return s.toUpperCase();
}

/** A dropdown of checkboxes. `invertAll` means an empty selection shows nothing (used for columns). */
function MultiPick(p: {
  label: string;
  all: string;
  values: string[];
  options: { value: string; label: string }[];
  onChange: (v: string[]) => void;
  quick?: { label: string; values: string[] }[];
  invertAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const summary = p.invertAll
    ? p.values.length === p.options.length
      ? p.all
      : `${p.label}: ${p.values.length}/${p.options.length}`
    : p.values.length === 0
      ? p.all
      : p.values.length === 1
        ? `${p.label}: ${p.options.find((o) => o.value === p.values[0])?.label ?? p.values[0]}`
        : `${p.label}: ${p.values.length}`;
  const toggle = (v: string) =>
    p.onChange(
      p.values.includes(v) ? p.values.filter((x) => x !== v) : [...p.values, v],
    );
  return (
    <div className="mpick" ref={ref}>
      <button
        className={`fsel ${p.values.length && !p.invertAll ? "active" : ""}`}
        onClick={() => setOpen(!open)}
      >
        {summary} ▾
      </button>
      {open && (
        <div className="menu mpick-menu">
          {p.quick?.map((q) => (
            <button key={q.label} onClick={() => p.onChange(q.values)}>
              {q.label}
            </button>
          ))}
          {p.quick && p.quick.length > 0 && <hr />}
          {p.options.length === 0 && (
            <div className="empty">Nothing to filter</div>
          )}
          {p.options.map((o) => (
            <label key={o.value} className="mpick-row">
              <input
                type="checkbox"
                checked={p.values.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const PR_STATE_CLASS: Record<string, string> = {
  OPEN: "open",
  DRAFT: "draft",
  MERGED: "merged",
  CLOSED: "closed",
};

function PrChip({ pr }: { pr: BoardPr }) {
  const cls = PR_STATE_CLASS[pr.state ?? ""] ?? "unknown";
  const live = pr.state === "OPEN" || pr.state === "DRAFT";
  return (
    <span
      className={`prchip ${cls}`}
      title={`${pr.repo}#${pr.number} · ${pr.state?.toLowerCase() ?? "unknown"}${pr.ci ? ` · CI ${pr.ci}` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        deck().openExternal(pr.url);
      }}
    >
      <PrIcon />#{pr.number}
      {live && pr.ci === "success" && <span className="ok">✓</span>}
      {live && pr.ci === "failure" && <span className="bad">✗</span>}
      {live && pr.ci === "pending" && <span className="wait">●</span>}
      {live && pr.unresolved > 0 && (
        <span className="wait">💬 {pr.unresolved}</span>
      )}
    </span>
  );
}

/** GitHub's git-pull-request octicon. */
export function PrIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

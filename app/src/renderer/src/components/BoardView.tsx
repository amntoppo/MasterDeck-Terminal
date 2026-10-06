import {
  getConfig,
  projectByKey,
  statusGroup,
  statusRank,
  type StatusGroup,
} from "@shared/appConfig";
import { nextTabName, ViewTabs } from "./ViewTabs";
import { isMulti, primaryLogin } from "@shared/accounts";
import {
  fullRepo,
  ticketKey,
  ticketLabel,
  ticketOf,
  type Ticket,
} from "@shared/ticket";
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
import { can, usePhone } from "../web";
import { ticketNote } from "../notes";
import { RailIcon } from "./Rail";
import type { NoteMeta } from "@shared/notes";
import { PhoneFilters } from "./PhoneFilters";
import type { PastSession } from "@shared/pastSessions";
import {
  activeBoardFilterCount,
  applyFilters,
  cardAction,
  defaultFilters,
  filterOptions,
  tabFilterUsers,
  parseSavedTabs,
  sprintsForAccount,
  tabAccount,
  withAccountTabs,
  normalizeFilters,
  UNASSIGNED,
  type BoardTab,
  type FilterState,
} from "@shared/boardFilter";
import {
  awaitingRead,
  boardEmpty,
  boardless,
  boardsOf,
  canMove,
  DERIVED_COLUMNS,
  derivedNotes,
  reposOf,
  tabBoard,
  unreadRepos,
} from "@shared/derivedBoard";
import {
  boardChips,
  repoAskEvery,
  repoChoices,
  reposFilterOffered,
  repoViewBoard,
  repoViewEmpty,
  repoViewOn,
  reposFilterPick,
  withMoving,
  repoViewStatus,
  repoViewTitle,
} from "@shared/repoView";
import { CreateBoardDialog } from "./CreateBoardDialog";
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
  boardTicketContext,
  ticketDefaults,
  claudePrompt,
  ClaudeMark,
  NewTicketDialog,
  type TicketContext,
} from "./NewTicket";
import { TerminalView } from "./TerminalView";
import { SessionAccount } from "./AccountBits";
import type { NewTicket } from "@shared/ipc";
import { whileBusy } from "@shared/busy";

interface Props {
  state: AppState;
  onOpenSession: (s: Session) => void;
  /** My card without a session: the Start dialog. */
  onStart: (card: BoardCard) => void;
  /** Someone else's card with a PR. */
  onPr: (card: BoardCard) => void;
  /** Someone else's (or nobody's) card without a PR; `me`: the tab's account (two or more), else my login. */
  onAssign: (card: BoardCard, me: string | null) => void;
  onSummary: () => void;
  /** Open Setup (an account with nothing selected, or no board). */
  onSetup: () => void;
  notes?: NoteMeta[];
  /** Open a ticket's note (absent: Notes is not available here). */
  onNote?: (t: Ticket) => void;
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
  const saved = parseSavedTabs(load<unknown>(TABS_KEY, null), me);
  if (saved) return saved;
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

/** MasterDeck's own columns (an account with no board). */
const DERIVED_COLOR: Record<string, string> = {
  Todo: "var(--grey)",
  "In Dev": "var(--amber)",
  "PR Raised": "var(--amber)",
  Done: "var(--green)",
};

function columnColor(col: string, derived = false): string {
  if (derived) return DERIVED_COLOR[col] ?? "var(--grey)";
  const s = getConfig().statuses;
  if (col === s.ready) return "var(--accent)";
  if (col === s.devDone) return "#f28b50";
  return COLUMN_COLOR[col] ?? GROUP_COLOR[statusGroup(col)];
}

const COL_ORDER_KEY = "boardColumnOrder";

/** How far to scroll this frame when `pos` is within `edge` px of `start` or `end`: faster nearer. */
function edgeStep(pos: number, start: number, end: number, edge = 80): number {
  const e = Math.min(edge, (end - start) / 4);
  if (pos - start < e)
    return -Math.ceil(((e - Math.max(0, pos - start)) / e) * 22);
  if (end - pos < e) return Math.ceil(((e - Math.max(0, end - pos)) / e) * 22);
  return 0;
}

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
  onSetup,
  notes,
  onNote,
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
  // Kept across visits to the Board: the sessions keep running while another view shows.
  const [claudes, setClaudesRaw] = useState<Record<string, TicketSession>>(
    () => keptSessions,
  );
  const setClaudeOf = (key: string, c: TicketSession | null) => {
    const next = { ...keptSessions };
    if (c) next[key] = c;
    else delete next[key];
    keptSessions = next;
    setClaudesRaw(next);
  };
  const [panelW, setPanelW] = useState<number>(() =>
    load<number>("ticketPanelW", 520),
  );
  useEffect(() => save("ticketPanelW", panelW), [panelW]);
  const [created, setCreated] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
    // An issue of an account with no board has no status on GitHub: nothing to write.
    if (!canMove(card, worked)) return;
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
    // Only statuses MasterDeck can set on the card's own board (a column GitHub added later, or
    // another board's column, would fail as "unknown status").
    const cols = projectByKey(card?.project)?.columns ?? state.config.columns;
    if (
      !card ||
      !canMove(card, worked) ||
      !cols.includes(col) ||
      (moving[k] ?? card.status) === col
    )
      return;
    const back =
      statusRank(col, undefined, card.project) <
      statusRank(card.status ?? "", undefined, card.project);
    if (back) setPendingMove({ card, to: col });
    else void doMove(card, col);
  };
  const primaryMe = state.me;
  const phone = usePhone();
  // Tabs: each its own name and filters over the one board fetched from GitHub.
  const [tabs, setTabs] = useState<BoardTab[]>(() => loadTabs(primaryMe));
  const [tabId, setTabId] = useState<string>(() => load<string>(TAB_KEY, ""));
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];
  // First run: the Mine tab filters to me once my login is known.
  const [meFilled, setMeFilled] = useState(
    () => load<BoardTab[] | null>(TABS_KEY, null) !== null,
  );
  useEffect(() => {
    if (meFilled || !primaryMe) return;
    setMeFilled(true);
    setTabs((ts) =>
      ts.map((t) =>
        t.id === MINE_TAB && t.filters.assignees.length === 0
          ? { ...t, filters: { ...t.filters, assignees: [primaryMe] } }
          : t,
      ),
    );
  }, [primaryMe, meFilled]);
  // Two or more GitHub accounts: each tab shows one account's boards; "Mine" is that account's login.
  const cfg = state.config;
  const multi = isMulti(cfg);
  const logins = cfg.accounts.map((a) => a.login);
  const primary = primaryLogin(cfg);
  const acct = multi ? (tabAccount(tab, logins) ?? primary) : null;
  const me = acct ?? state.me;
  // The tab's account has repositories but no GitHub board: its issues in MasterDeck's own
  // columns, read-only (shared/derivedBoard.ts). With a board everything below is as before.
  const fallback = boardless(acct, cfg);
  // Repositories picked in a tab whose account has a board: the repository view. Every issue of
  // those repositories, on a board or not, in MasterDeck's columns (shared/repoView.ts).
  const repoMode = repoViewOn(acct, cfg, tab.filters.repos);
  // MasterDeck's own four columns, either way: nothing is dragged, reordered or summarised.
  const worked = fallback || repoMode;
  // No sprint picker where there are no sprints: no board, the repository view, or only boards MasterDeck created.
  const tabBoards = boardsOf(acct, cfg);
  const noSprints =
    worked || (tabBoards.length > 0 && tabBoards.every((p) => p.sprintless));
  // Create with Claude: one session for the Board with one account; one per tab (as its account) with several.
  const claudeKey = multi ? tab.id : "";
  const claude = claudes[claudeKey] ?? null;
  const setClaude = (c: TicketSession | null) => setClaudeOf(claudeKey, c);
  const closeClaudeOf = (key: string) => {
    const c = keptSessions[key];
    if (c) deck().ptyClose(ticketPaneId(key, c.gen));
    setClaudeOf(key, null);
  };
  // A tab whose account changed (picked, or disconnected): its session ran as the old one.
  useEffect(() => {
    if (multi && claude && claude.account !== acct) closeClaudeOf(claudeKey);
  }, [multi, claudeKey, acct]); // eslint-disable-line react-hooks/exhaustive-deps
  // A second account connected or the last one removed: the other mode's sessions go.
  useEffect(() => {
    for (const k of Object.keys(keptSessions)) if ((k === "") === multi) closeClaudeOf(k);
  }, [multi]); // eslint-disable-line react-hooks/exhaustive-deps
  // Connecting another account adds a "Mine" tab for it, once.
  useEffect(() => {
    const added = load<string[]>("boardTabAccounts", []);
    const make = (l: string) => ({
      id: `board-mine-${l}`,
      name: "Mine",
      account: l,
      filters: defaultFilters(l),
    });
    const r = withAccountTabs(tabs, logins, primary, added, make);
    if (r.added === added) return;
    save("boardTabAccounts", r.added);
    // Functional, so it cannot undo another update (the first-run Mine fill).
    setTabs((ts) => withAccountTabs(ts, logins, primary, added, make).tabs);
  }, [logins.join(), primary]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => save(TABS_KEY, tabs), [tabs]);
  useEffect(() => save(TAB_KEY, tab.id), [tab.id]);
  const f = tab.filters;
  const setFilters = (next: FilterState) =>
    setTabs((ts) =>
      ts.map((t) => (t.id === tab.id ? { ...t, filters: next } : t)),
    );
  const set = (patch: Partial<FilterState>) => setFilters({ ...f, ...patch });
  const reposKey = f.repos.join("\n");
  // The repository view has its own reasons for an empty tab (still loading, a repository not read).
  const repoStatus = useMemo(
    () => repoViewStatus(state.repoView, f.repos, cfg),
    [state.repoView, reposKey, cfg], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Tell main which repositories are on screen. It reads the ones it does not hold (or holds for
  // over an hour) and keeps them in its refreshes while a tab goes on asking: again every 20
  // minutes, and every 5 while a picked repository was never read (a failed first read, no room).
  const askTick = Math.floor(now / repoAskEvery(repoStatus));
  useEffect(() => {
    if (repoMode) deck().boardRepos(f.repos);
  }, [repoMode, reposKey, askTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const addTab = () => {
    const id = `board-${Date.now().toString(36)}`;
    setTabs([
      ...tabs,
      {
        id,
        name: nextTabName(tabs, "Board"),
        filters: { ...defaultFilters(me), assignees: [] },
        ...(tabAccount(tab, logins) ? { account: tabAccount(tab, logins) } : {}),
      },
    ]);
    setTabId(id);
    return id;
  };
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) return;
    // Its ticket session goes with it; the folder stays (reopening the tab can continue it).
    if (multi) closeClaudeOf(id);
    setTabs(rest);
    if (id === tab.id)
      setTabId(rest[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)].id);
  };
  const renameTab = (id: string, name: string) =>
    setTabs((ts) =>
      ts.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)),
    );

  const rawBoard = useMemo(
    () =>
      repoMode
        ? repoViewBoard(state.repoView, f.repos)
        : tabBoard(state.board, acct, cfg),
    [state.board, state.repoView, acct, cfg, repoMode, reposKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const b = useMemo(
    () => withMoving(rawBoard, moving, repoMode),
    [rawBoard, moving, repoMode],
  );
  const shown = useMemo(
    () =>
      // No board, or the repository view (its cards are on no board): a Boards filter would hide every issue.
      b ? applyFilters(b, worked && f.projects.length ? { ...f, projects: [] } : f) : null,
    [b, f, worked],
  );
  const options = useMemo(
    () =>
      b
        ? filterOptions(b, me, tabFilterUsers(acct, primary, state.users))
        : { assignees: [], labels: [], milestones: [] },
    [b, me, state.users, acct, primary],
  );

  // A refresh that rejects must not leave the tab on "Loading board…".
  const refresh = () => whileBusy(setRefreshing, () => deck().refresh());

  const onCard = (card: BoardCard) => {
    const action = cardAction(card, me, state.sessions);
    if (action === "session") {
      const s = sessionForIssue(state.sessions, ticketOf(card));
      if (s) onOpenSession(s);
    } else if (action === "start") onStart(card);
    else if (action === "pr") onPr(card);
    else onAssign(card, me);
  };

  const loading = state.boardLoading || state.githubRefreshing || refreshing;
  const sprints = sprintsForAccount(state.sprints, acct, cfg);
  const current = sprints.find(
    (s) => !s.completed && inSprint(s.startDate, s.duration, now),
  );
  // Every column the tab can show: without a board, MasterDeck's four in their fixed order.
  const allColumns: string[] = !shown
    ? []
    : worked
      ? [...DERIVED_COLUMNS]
      : visibleColumns(shown, f.projects);
  const unhidden = allColumns.filter((c) => !f.hiddenColumns.includes(c));
  const columns = worked ? unhidden : orderColumns(unhidden, colOrder);
  // Why the tab shows no card, when it shows none. Nothing selected for its account: also before
  // any board was read (none is asked for then).
  const tabRepoList = reposOf(acct, cfg);
  // The repositories the read did not get: "no open issues" is not said of them.
  const unread = unreadRepos(state.board, acct, cfg);
  const repoEmpty =
    repoMode && b && shown
      ? repoViewEmpty(
          { cards: b.cards.length, shown: shown.cards.length },
          repoStatus,
        )
      : null;
  const repoNames = f.repos.map((r) => r.split("/")[1] ?? r);
  const empty = repoMode
    ? null
    : b && shown
      ? boardEmpty(
          {
            login: acct,
            total: b.cards.length,
            shown: shown.cards.length,
            unread,
            // Its first read is still under way: loading, not "could not read".
            loading: awaitingRead(state.board, acct, cfg, loading),
          },
          cfg,
        )
      : tabBoards.length === 0 && tabRepoList.length === 0
        ? "nothing-selected"
        : null;
  const hintNotes = derivedNotes(state.board, acct);
  const tabRepos = tabRepoList.map((r) => r.split("/")[1] ?? r);
  shownCols.current = columns;
  // A card dragged near the board's left or right edge scrolls it sideways, and near the top or
  // bottom of a column scrolls that column. Native drags send no pointer moves, so the position
  // comes from dragover; the loop stops once they stop coming (the drag ended or left the window).
  useEffect(() => {
    let at: { x: number; y: number } | null = null;
    let last = 0;
    let frame = 0;
    const tick = () => {
      frame = 0;
      if (!at || performance.now() - last > 400) return (at = null);
      const box = colsEl.current;
      if (box) {
        const r = box.getBoundingClientRect();
        box.scrollLeft += edgeStep(at.x, r.left, r.right);
        const body = document
          .elementFromPoint(at.x, at.y)
          ?.closest<HTMLElement>(".board-col-body");
        if (body) {
          const b = body.getBoundingClientRect();
          body.scrollTop += edgeStep(at.y, b.top, b.bottom, 60);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/masterdeck-card")) return;
      at = { x: e.clientX, y: e.clientY };
      last = performance.now();
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      at = null;
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragend", stop);
    window.addEventListener("drop", stop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragend", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
  const laidOut = colDrag
    ? moveColumn(columns, colDrag.col, colDrag.to)
    : columns;

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
        const step = edgeStep(at.x, r.left, r.right);
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
  const boards = worked
    ? []
    : b?.projects?.length
      ? b.projects
      : state.config.projects.map((p) => ({
          key: `${p.owner}/${p.number}`,
          title: p.title,
          columns: p.columns,
        }));
  // The Repos filter offers the account's ticked repositories (also ones with no card on the
  // board), then any other its board's cards name.
  const boardRepos = useMemo(
    () =>
      (tabBoard(state.board, acct, cfg)?.cards ?? []).map((c) =>
        fullRepo(c.repo),
      ),
    [state.board, acct, cfg],
  );
  const repos = repoChoices(acct, cfg, boardRepos, f.repos);
  // Where a new ticket of the repository view goes on the board: the tab's first board, in its "ready" column.
  const readyCol = tabBoards[0]?.statuses.ready ?? cfg.statuses.ready;

  // New ticket (+ on a column) and Create with Claude (a session on the right, on the Board only).
  const ctxFor = (col: string): TicketContext =>
    boardTicketContext({
      state,
      col,
      filters: f,
      selectedSprint: state.selectedSprint,
      tab: tab.name,
      fallback,
      repoMode,
      readyCol,
      account: acct ?? undefined,
      ...(multi ? { tabId: tab.id } : {}),
    });
  // The repository a + of the repository view creates in: the one the dialog will open with.
  const plusRepo = repoMode
    ? (ticketDefaults(state, ctxFor("Todo")).repo.split("/")[1] ?? "")
    : "";
  // `restart`: a new conversation. Otherwise an open session keeps going: its context.json now
  // says where this + was, and what was typed in the dialog is sent to it as a message.
  const openClaude = async (
    picked: TicketContext,
    draft?: NewTicket,
    restart = false,
  ) => {
    // Two or more accounts: the tab's session works as the tab's account, and creates as it too.
    const ctx = multi ? { ...picked, account: acct ?? undefined } : picked;
    const r = await deck().ticketBuilderPrepare({
      ...ctx,
      ...(draft ? { draft } : {}),
    });
    if (!r.ok) return setMoveMsg(r.message);
    setTicketCtx(null);
    const prompt = claudePrompt(ctx.status, draft);
    if (claude && !restart) {
      setClaude({ ...claude, ctx });
      if (prompt) {
        deck().ptyWrite(ticketPaneId(claudeKey, claude.gen), prompt);
        setTimeout(
          () => deck().ptyWrite(ticketPaneId(claudeKey, claude.gen), "\r"),
          150,
        );
      }
      return;
    }
    if (claude) deck().ptyClose(ticketPaneId(claudeKey, claude.gen));
    setClaude({
      gen: (claude?.gen ?? 0) + 1,
      resume: !restart && !prompt && r.canContinue,
      prompt,
      ctx,
      ...(acct ? { account: acct } : {}),
    });
  };
  const closeClaude = () => closeClaudeOf(claudeKey);
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

  // The filter row: inline on a wide screen; on a phone, behind a "Filters (n)" button.
  const filterControls = (
    <>
    {multi && (
      <select
        className="fsel"
        value={acct ?? ""}
        title="The GitHub account this tab shows"
        onChange={(e) => {
          const l = e.target.value;
          setTabs((ts) =>
            ts.map((t) =>
              t.id === tab.id
                ? {
                    ...t,
                    account: l === primary ? undefined : l,
                    // Its own repos and boards; "Mine" follows the account.
                    filters: { ...t.filters, repos: [], projects: [], labels: [], milestone: null, assignees: t.filters.assignees.length === 1 && t.filters.assignees[0] === me ? [l] : [] },
                  }
                : t,
            ),
          );
        }}
      >
        {logins.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    )}
    {reposFilterOffered(repos.length, fallback) && (
      <MultiPick
        label="Repos"
        all="All repos"
        values={f.repos}
        options={repos.map((r) => ({
          value: r,
          label: r.split("/")[1] ?? r,
        }))}
        // With a board, picking repositories (even all of them) is the repository view; none is the board.
        onChange={(v) =>
          set({ repos: reposFilterPick(v, repos.length, fallback) })
        }
        quick={[
          {
            label: fallback ? "All repos" : "The board (no repository)",
            values: [],
          },
        ]}
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
      values={unhidden}
      options={allColumns.map((c) => ({ value: c, label: c }))}
      onChange={(vis) =>
        set({ hiddenColumns: allColumns.filter((c) => !vis.includes(c)) })
      }
      invertAll
    />
    </>
  );
  const filterSearch = (
    <input
      className="filter search"
      placeholder="Search title or #number"
      value={f.search}
      onChange={(e) => set({ search: e.target.value })}
    />
  );
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
        <header className="board-head">
          <h2>Board</h2>
          {!noSprints && (
            <select
              className="sprint-pick"
              value={state.selectedSprint}
              onChange={(e) => deck().setSprint(e.target.value)}
              title="Sprint"
            >
              <option value="@current">
                Current sprint{current ? ` (${current.title})` : ""}
              </option>
              {sprints
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
          )}
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
          {!worked && (
            <button
              className="btn"
              onClick={onSummary}
              title="Done, in progress, blocked and burndown"
            >
              Summary
            </button>
          )}
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
        <ViewTabs
          tabs={multi ? tabs.map((t) => ({ ...t, badge: tabAccount(t, logins) ?? primary ?? undefined })) : tabs}
          activeId={tab.id}
          onSelect={setTabId}
          onAdd={addTab}
          onClose={closeTab}
          onRename={renameTab}
          addTitle="Another board tab, with its own repos, boards and filters"
        />
        {fallback && (
          <div className="board-hint">
            <span>
              This account has no GitHub board. Columns are worked out by
              MasterDeck.
            </span>
            {can("boardCreate") ? (
              <button className="link-btn" onClick={() => setCreating(true)}>
                Create a GitHub board
              </button>
            ) : (
              <span>Create one from MasterDeck on your Mac.</span>
            )}
            {hintNotes.map((n, i) => (
              <div key={i} className="board-note">
                {n}
              </div>
            ))}
          </div>
        )}

        {repoMode && (
          <div className="board-hint repo-view">
            <span>{repoViewTitle(f.repos)} — not the board.</span>
            <button className="link-btn" onClick={() => set({ repos: [] })}>
              Back to board
            </button>
            {repoStatus.notes.map((n, i) => (
              <div key={i} className="board-note">
                {n}
              </div>
            ))}
          </div>
        )}

        {phone ? (
          <PhoneFilters
            count={activeBoardFilterCount({ ...f, search: "" }, me)}
            search={filterSearch}
            onReset={() =>
              setFilters({ ...defaultFilters(me), search: f.search })
            }
          >
            {filterControls}
          </PhoneFilters>
        ) : (
          <div className="filter-bar">
            {filterControls}
            {filterSearch}
            {activeBoardFilterCount(f, me) > 0 && (
              <button
                className="link-btn"
                onClick={() => setFilters(defaultFilters(me))}
              >
                Reset filters
              </button>
            )}
          </div>
        )}

        {repoEmpty === "loading" ? (
          <div className="welcome">
            <div>Loading issues…</div>
          </div>
        ) : repoEmpty === "not-read" ? (
          <div className="welcome">
            <h2>Could not read {repoStatus.failed.map((r) => r.split("/")[1] ?? r).join(", ")}</h2>
            <div>The lines above say why.</div>
            <div className="form-buttons">
              <button className="btn" onClick={() => set({ repos: [] })}>
                Back to board
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  // The forced read first (it skips the caches, also the CLI's memory of "Not found");
                  // then a repository MasterDeck had no room for is asked for again.
                  void Promise.resolve(refresh()).finally(() => deck().boardRepos(f.repos));
                }}
                disabled={loading}
              >
                {loading ? "Refreshing…" : "Retry"}
              </button>
            </div>
          </div>
        ) : repoEmpty === "no-issues" ? (
          <div className="welcome">
            <h2>No open issues</h2>
            <div>
              {repoNames.join(", ")} {repoNames.length === 1 ? "has" : "have"}{" "}
              no open issues, and none closed in the last 14 days.
            </div>
            <button className="btn" onClick={() => set({ repos: [] })}>
              Back to board
            </button>
          </div>
        ) : repoEmpty === "filtered" ? (
          <div className="welcome">
            <h2>No issues match</h2>
            <div>
              {b?.cards.length ?? 0} issues in {repoNames.join(", ")}; the
              filters hide all of them.
            </div>
            <button
              className="btn"
              onClick={() =>
                // Everyone's, in the same repositories: clearing them would leave the repository view.
                setFilters({
                  ...defaultFilters(me),
                  assignees: [],
                  repos: f.repos,
                })
              }
            >
              Show everyone's issues
            </button>
          </div>
        ) : empty === "nothing-selected" ? (
          <div className="welcome">
            <h2>Nothing selected{acct ? ` for ${acct}` : ""}</h2>
            <div>Pick its repositories and boards in Setup.</div>
            <button className="btn primary" onClick={onSetup}>
              Open Setup
            </button>
          </div>
        ) : !b || !shown || empty === "loading" ? (
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
        ) : empty === "not-read" ? (
          <div className="welcome">
            <h2>
              Could not read{" "}
              {(unread ?? []).map((r) => r.split("/")[1] ?? r).join(", ")}
            </h2>
            <div>
              {state.boardError ??
                (hintNotes.length
                  ? "The lines above say why."
                  : "GitHub gave no issues for it.")}
            </div>
            <div className="form-buttons">
              <button className="btn" onClick={onSetup}>
                Open Setup
              </button>
              <button
                className="btn primary"
                onClick={refresh}
                disabled={loading}
              >
                {loading ? "Refreshing…" : "Retry"}
              </button>
            </div>
          </div>
        ) : empty === "no-issues" ? (
          <div className="welcome">
            <h2>No open issues</h2>
            <div>
              {acct ?? "This account"} has no GitHub board, and{" "}
              {tabRepos.join(", ")} {tabRepos.length === 1 ? "has" : "have"} no
              open issues.
            </div>
            <div className="form-buttons">
              <button className="btn" onClick={onSetup}>
                Open Setup
              </button>
              {can("boardCreate") && (
                <button
                  className="btn primary"
                  onClick={() => setCreating(true)}
                >
                  Create a GitHub board
                </button>
              )}
            </div>
          </div>
        ) : empty === "filtered" ? (
          <div className="welcome">
            <h2>No issues match</h2>
            {fallback ? (
              <div>
                {b.cards.length} issues; the filters hide all of them.
              </div>
            ) : (
              <div>
                {b.cards.length} issues in this sprint; the filters hide all of
                them.
              </div>
            )}
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
                    // No board, or the repository view: the columns are worked out, nothing can be dropped on them.
                    if (
                      worked ||
                      !e.dataTransfer.types.includes("text/masterdeck-card")
                    )
                      return;
                    e.preventDefault();
                    setDragOver(col);
                  }}
                  onDragLeave={() => setDragOver((d) => (d === col ? null : d))}
                  onDrop={(e) => {
                    if (!worked) drop(col, e);
                  }}
                >
                  <div
                    className="board-col-head"
                    onPointerDown={
                      worked ? undefined : (e) => pressColumn(e, col)
                    }
                    title={worked ? undefined : "Hold to move this column"}
                  >
                    <span
                      className="ring"
                      style={{ borderColor: columnColor(col, worked) }}
                    />
                    <strong>{col}</strong>
                    <span className="count">{cards.length}</span>
                    <span style={{ flex: 1 }} />
                    {(!worked || col === "Todo") && (
                      <button
                        className="col-add"
                        onClick={() => setTicketCtx(ctxFor(col))}
                        title={`New ticket in ${repoMode ? plusRepo : col}`}
                        aria-label={`New ticket in ${repoMode ? plusRepo : col}`}
                      >
                        +
                      </button>
                    )}
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
                        readOnly={!canMove(c, worked)}
                        onClick={() => onCard(c)}
                        noted={!!ticketNote(notes ?? [], c.repo, c.number)}
                        onNote={
                          onNote && can("notesList")
                            ? () => onNote(ticketOf(c))
                            : undefined
                        }
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
      {creating && (
        // Keyed by account: another tab's account never sees this one's plan or result.
        <CreateBoardDialog
          key={acct ?? ""}
          account={acct}
          onClose={() => setCreating(false)}
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
              <SessionAccount login={multi ? claude.account : null} />
              <span
                className="muted small"
                title="Where new tickets go; + on another column changes it"
              >
                {claude.ctx.status || "no board"}
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
                key={`${claudeKey}:${claude.gen}`}
                paneId={ticketPaneId(claudeKey, claude.gen)}
                spec={{
                  kind: "ticket-builder",
                  resume: claude.resume,
                  prompt: claude.prompt,
                  ...(multi && claude.account
                    ? { tab: claudeKey, account: claude.account }
                    : {}),
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
  /** The tab's account it runs as (two or more accounts). */
  account?: string;
};
/** The Board's Claude sessions by tab id ("" with one account), kept while another view shows (their terminals keep running). */
let keptSessions: Record<string, TicketSession> = {};
/** One account: `ticket-builder:<gen>` as before; several: `ticket-builder:<tabId>:<gen>`. */
const ticketPaneId = (key: string, gen: number) =>
  key ? `ticket-builder:${key}:${gen}` : `ticket-builder:${gen}`;

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
  readOnly,
  onClick,
  noted,
  onNote,
}: {
  card: BoardCard;
  state: AppState;
  me: string | null;
  now: number;
  spend: number;
  moving: boolean;
  /** An issue of an account with no board: it cannot be dragged to another column. */
  readOnly: boolean;
  onClick: () => void;
  /** This ticket has a note. */
  noted: boolean;
  /** Open the ticket's note (absent: Notes is not available here). */
  onNote?: () => void;
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
  // Repository view: the selected boards that hold this issue, and its column on each.
  const chips = boardChips(card, state.config);
  const stats = s ? state.stats[s.sessionId] : undefined;
  return (
    <div
      className={`bcard ${mine ? "mine" : ""} ${moving ? "moving" : ""}`}
      role="button"
      tabIndex={0}
      draggable={!readOnly}
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
        {onNote && (
          <button
            className={`bcard-note ${noted ? "has" : ""}`}
            title={noted ? "Open the note" : "Add a note"}
            aria-label={noted ? "Open the note" : "Add a note"}
            draggable={false}
            // A press on the mark must not start the draggable card's drag.
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            // The card is a button itself: the mark must not run the card's click or its Enter.
            onClick={(e) => {
              e.stopPropagation();
              onNote();
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <RailIcon name="notes" size={13} />
          </button>
        )}
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
      {(card.labels.length > 0 || card.type || chips.length > 0) && (
        <div className="bcard-labels">
          {chips.map((ch) => (
            <span key={ch.key} className="lbl on-board" title={ch.title}>
              ▦ {ch.text}
            </span>
          ))}
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

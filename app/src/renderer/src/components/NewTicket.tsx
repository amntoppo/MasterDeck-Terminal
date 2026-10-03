import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { FilterState } from "@shared/boardFilter";
import { UNASSIGNED } from "@shared/boardFilter";
import type { NewTicket } from "@shared/ipc";
import type { AppState } from "@shared/types";
import { deck } from "../deck";

/** Where a + was clicked on the Board: the column (status), its board, the tab's filters, the sprint shown. */
export interface TicketContext {
  status: string;
  project: string;
  filters: FilterState;
  sprint: string;
  /** The tab's name (e.g. "Mine"). */
  tab: string;
  /** The tab's GitHub account (two or more). */
  account?: string;
}

/** The board a column belongs to: the one the tab filters to, else the first board that has the column. */
export function boardFor(
  state: AppState,
  status: string,
  filters: FilterState,
): string {
  const boards = state.config.projects.map((p) => ({
    key: `${p.owner}/${p.number}`,
    columns: p.columns,
  }));
  const pick = (list: typeof boards) =>
    list.find((b) => b.columns.includes(status))?.key;
  const filtered = boards.filter((b) => filters.projects.includes(b.key));
  return pick(filtered) ?? pick(boards) ?? boards[0]?.key ?? "";
}

/** The defaults a new ticket takes from where it was asked for. */
export function ticketDefaults(state: AppState, ctx: TicketContext): NewTicket {
  const primary =
    state.config.repos[0] ?? `${state.config.owner}/${state.config.issueRepo}`;
  const people = ctx.filters.assignees.filter((a) => a !== UNASSIGNED);
  const board = state.config.projects.find(
    (p) => `${p.owner}/${p.number}` === ctx.project,
  );
  return {
    repo: ctx.filters.repos.length === 1 ? ctx.filters.repos[0] : primary,
    title: "",
    body: "",
    project: ctx.project,
    status: ctx.status,
    assignees: people.length ? people : state.me ? [state.me] : [],
    labels: [...ctx.filters.labels],
    milestone: ctx.filters.milestone ?? "",
    sprint: ctx.sprint === "none" ? "" : ctx.sprint,
    sprintField: board?.sprintField ?? state.config.sprintField ?? "Sprint",
  };
}

/** Several values from a list: chips, and "Add…" for the rest. */
function MultiPick({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const rest = options.filter((o) => !value.includes(o));
  return (
    <div className="mp">
      {value.map((v) => (
        <span key={v} className="mp-chip">
          {v}
          <button
            onClick={() => onChange(value.filter((x) => x !== v))}
            aria-label={`Remove ${v}`}
          >
            ×
          </button>
        </span>
      ))}
      <select
        className="mp-add"
        value=""
        onChange={(e) => e.target.value && onChange([...value, e.target.value])}
      >
        <option value="">
          {rest.length
            ? placeholder
            : value.length
              ? "All added"
              : "None available"}
        </option>
        {rest.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * New ticket: an issue created in a repo and put on the board, in the column its + was clicked
 * in. Defaults come from that column and the tab's filters (people, labels, milestone, repo) and
 * the sprint shown. Create with Claude hands the same context to the Board's Claude session.
 */
export function NewTicketDialog({
  state,
  ctx,
  onClose,
  onWithClaude,
}: {
  state: AppState;
  ctx: TicketContext;
  onClose: () => void;
  onWithClaude: (ctx: TicketContext, draft: NewTicket) => void;
}) {
  const [t, setT] = useState<NewTicket>(() => ticketDefaults(state, ctx));
  const [meta, setMeta] = useState<{
    labels: string[];
    milestones: string[];
    assignees: string[];
  }>({ labels: [], milestones: [], assignees: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{
    text: string;
    ok: boolean;
    url?: string;
  } | null>(null);
  const set = (p: Partial<NewTicket>) => setT((x) => ({ ...x, ...p }));
  useEffect(() => {
    let alive = true;
    void deck()
      .ticketRepoMeta(t.repo)
      .then((m) => alive && setMeta(m));
    return () => {
      alive = false;
    };
  }, [t.repo]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, busy]);

  const boards = state.config.projects;
  const board = boards.find((p) => `${p.owner}/${p.number}` === t.project);
  const columns = board?.columns ?? state.config.columns;
  // People: the repo's assignable ones, and anyone on the board, the chosen ones first.
  const people = useMemo(
    () => [
      ...new Set([
        ...(state.me ? [state.me] : []),
        ...meta.assignees,
        ...(state.board?.cards.flatMap((c) => c.assignees) ?? []),
      ]),
    ],
    [meta.assignees, state.me, state.board],
  );
  const labels = useMemo(
    () => [...new Set([...meta.labels, ...t.labels])],
    [meta.labels, t.labels],
  );
  const current = state.sprints.find(
    (s) =>
      !s.completed &&
      new Date(s.startDate).getTime() <= Date.now() &&
      new Date(s.startDate).getTime() + s.duration * 86_400_000 > Date.now(),
  );

  const create = async () => {
    if (!t.title.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    const r = await deck().ticketCreate(t);
    setBusy(false);
    setMsg({ text: r.message, ok: r.ok, url: r.url });
  };
  const done = msg?.ok;

  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog new-ticket" role="dialog" aria-label="New ticket">
        <h3>
          New ticket
          <span className="muted small">
            in <b>{t.status}</b>
            {board ? ` · ${board.title}` : ""}
          </span>
        </h3>
        {done ? (
          <div className="nt-done">
            <div className="wf-ok">✓ {msg.text}</div>
            {msg.url && (
              <a
                href={msg.url}
                onClick={(e) => (
                  e.preventDefault(),
                  void deck().openExternal(msg.url!)
                )}
              >
                {msg.url}
              </a>
            )}
            <div className="form-buttons">
              <button className="btn" onClick={onClose}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setT((x) => ({ ...x, title: "", body: "" }));
                  setMsg(null);
                }}
              >
                Create another
              </button>
            </div>
          </div>
        ) : (
          <>
            <label>Title</label>
            <input
              autoFocus
              value={t.title}
              placeholder="What needs doing"
              onChange={(e) => set({ title: e.target.value })}
              onKeyDown={(e) =>
                e.key === "Enter" && (e.metaKey || e.ctrlKey) && void create()
              }
            />
            <label>Description</label>
            <textarea
              value={t.body}
              placeholder={
                "Markdown. Context, steps to reproduce, acceptance criteria…"
              }
              onChange={(e) => set({ body: e.target.value })}
              onKeyDown={(e) =>
                e.key === "Enter" && (e.metaKey || e.ctrlKey) && void create()
              }
            />
            <div className="ns-grid">
              <div>
                <label>Repository</label>
                <select
                  className="fsel full"
                  value={t.repo}
                  onChange={(e) => set({ repo: e.target.value, milestone: "" })}
                >
                  {state.config.repos.map((r) => (
                    <option key={r} value={r}>
                      {r.split("/")[1]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Status</label>
                <select
                  className="fsel full"
                  value={t.status}
                  onChange={(e) => set({ status: e.target.value })}
                >
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              {boards.length > 1 && (
                <div>
                  <label>Board</label>
                  <select
                    className="fsel full"
                    value={t.project}
                    onChange={(e) => {
                      const p = boards.find(
                        (x) => `${x.owner}/${x.number}` === e.target.value,
                      );
                      set({
                        project: e.target.value,
                        status: p?.columns.includes(t.status)
                          ? t.status
                          : (p?.columns[0] ?? ""),
                        sprintField: p?.sprintField ?? t.sprintField,
                      });
                    }}
                  >
                    {boards.map((p) => (
                      <option
                        key={`${p.owner}/${p.number}`}
                        value={`${p.owner}/${p.number}`}
                      >
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label>Sprint</label>
                <select
                  className="fsel full"
                  value={t.sprint}
                  onChange={(e) => set({ sprint: e.target.value })}
                >
                  <option value="@current">
                    Current sprint{current ? ` (${current.title})` : ""}
                  </option>
                  {state.sprints
                    .filter((s) => !s.completed && s.title !== current?.title)
                    .map((s) => (
                      <option key={s.id} value={s.title}>
                        {s.title}
                      </option>
                    ))}
                  <option value="">No sprint</option>
                </select>
              </div>
              <div>
                <label>Milestone</label>
                <select
                  className="fsel full"
                  value={t.milestone}
                  onChange={(e) => set({ milestone: e.target.value })}
                >
                  <option value="">None</option>
                  {[
                    ...new Set([
                      ...meta.milestones,
                      ...(t.milestone ? [t.milestone] : []),
                    ]),
                  ].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label>Assignees</label>
            <MultiPick
              value={t.assignees}
              options={people}
              onChange={(v) => set({ assignees: v })}
              placeholder="Add someone…"
            />
            <label>Labels</label>
            <MultiPick
              value={t.labels}
              options={labels}
              onChange={(v) => set({ labels: v })}
              placeholder="Add a label…"
            />
            {msg && !msg.ok && <div className="error">{msg.text}</div>}
            <div className="form-buttons nt-buttons">
              <button
                className="btn nt-claude"
                onClick={() => onWithClaude(ctx, t)}
                title="Describe what you need; Claude writes the ticket(s) and creates them on this board"
              >
                <ClaudeMark /> Create with Claude
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!t.title.trim() || busy}
                onClick={() => void create()}
                title="⌘↵"
              >
                {busy ? "Creating…" : "Create ticket"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Claude's mark (a simple sunburst). */
export function ClaudeMark({ size = 14 }: { size?: number }) {
  const rays = Array.from({ length: 8 }, (_, i) => i * 22.5);
  return (
    <svg
      width={size}
      height={size}
      viewBox="-12 -12 24 24"
      aria-hidden="true"
      className="claude-mark"
    >
      {rays.map((a) => (
        <rect
          key={a}
          x={-1.3}
          y={-11}
          width={2.6}
          height={22}
          rx={1.3}
          transform={`rotate(${a})`}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { AppState } from "@shared/types";
import { settingsSummary, type TicketSettings } from "@shared/ticketSettings";
import { deck } from "../deck";
import {
  accountScope,
  boardSprints,
  changeSettings,
  MultiPick,
} from "./NewTicket";

/**
 * Create with Claude's settings bar, below the chat (#68): what every ticket the session creates
 * gets. Collapsed it is one line of the values; expanded, each one is a picker. MasterDeck applies
 * them to each create (ticketSettings.ts), so they win over what Claude was told in the chat.
 */
export function TicketSettingsBar({
  state,
  account,
  value,
  onChange,
}: {
  state: AppState;
  /** The tab's account (two or more accounts); its repositories and boards are offered. */
  account?: string;
  value: TicketSettings;
  onChange: (s: TicketSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState<{
    labels: string[];
    milestones: string[];
    assignees: string[];
  }>({ labels: [], milestones: [], assignees: [] });
  useEffect(() => {
    let alive = true;
    // Only when open: the collapsed line needs nothing from GitHub.
    if (open && value.repo)
      void deck()
        .ticketRepoMeta(value.repo)
        .then((m) => alive && setMeta(m));
    return () => {
      alive = false;
    };
  }, [open, value.repo]);

  const { repos, boards } = accountScope(state, account);
  const board = boards.find((p) => `${p.owner}/${p.number}` === value.project);
  const sprints = boardSprints(state.sprints, board);
  const now = Date.now();
  const current = sprints.find((s) => {
    const t = new Date(s.startDate).getTime();
    return t <= now && t + s.duration * 86_400_000 > now;
  });
  const people = useMemo(
    () => [
      ...new Set([
        ...(account ? [account] : state.me ? [state.me] : []),
        ...meta.assignees,
        ...(state.board?.cards.flatMap((c) => c.assignees) ?? []),
      ]),
    ],
    [account, meta.assignees, state.me, state.board],
  );
  const set = (p: Partial<TicketSettings>) =>
    onChange(changeSettings(value, p, boards, state.sprints));
  const summary = settingsSummary(
    value,
    boards.length > 1 ? board?.title : undefined,
  );

  return (
    <div className={`tsb${open ? " open" : ""}`} aria-label="Ticket settings">
      <button
        className="tsb-line"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={
          open
            ? "Hide the ticket settings"
            : "Every ticket Claude creates here gets these values. Click to change them"
        }
      >
        <span className="tsb-icon" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="tsb-sum">
          {summary.map((x, i) => (
            <span key={i}>{x}</span>
          ))}
        </span>
      </button>
      {open && (
        <div className="tsb-grid">
          <div>
            <label>Repository</label>
            <select
              className="fsel full"
              value={value.repo}
              onChange={(e) => set({ repo: e.target.value })}
            >
              {!repos.includes(value.repo) && (
                <option value={value.repo}>{value.repo.split("/")[1]}</option>
              )}
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r.split("/")[1]}
                </option>
              ))}
            </select>
          </div>
          {boards.length > 1 && (
            <div>
              <label>Board</label>
              <select
                className="fsel full"
                value={value.project}
                onChange={(e) => set({ project: e.target.value })}
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
          {board && (
            <div>
              <label>Status</label>
              <select
                className="fsel full"
                value={value.status}
                onChange={(e) => set({ status: e.target.value })}
              >
                {board.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
          {board && (
            <div>
              <label>Sprint</label>
              <select
                className="fsel full"
                value={value.sprint}
                onChange={(e) => set({ sprint: e.target.value })}
              >
                {!board.sprintless && (
                  <option value="@current">
                    Current sprint{current ? ` (${current.title})` : ""}
                  </option>
                )}
                {sprints
                  .filter((s) => s.title !== current?.title)
                  .map((s) => (
                    <option key={s.id} value={s.title}>
                      {s.title}
                    </option>
                  ))}
                <option value="">No sprint</option>
              </select>
            </div>
          )}
          <div>
            <label>Milestone</label>
            <select
              className="fsel full"
              value={value.milestone}
              onChange={(e) => set({ milestone: e.target.value })}
            >
              <option value="">None</option>
              {[
                ...new Set([
                  ...meta.milestones,
                  ...(value.milestone ? [value.milestone] : []),
                ]),
              ].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="tsb-wide">
            <label>Assignees</label>
            <MultiPick
              value={value.assignees}
              options={people}
              onChange={(v) => set({ assignees: v })}
              placeholder="Add someone…"
            />
          </div>
          <div className="tsb-wide">
            <label>Labels</label>
            <MultiPick
              value={value.labels}
              options={[...new Set([...meta.labels, ...value.labels])]}
              onChange={(v) => set({ labels: v })}
              placeholder="Add a label…"
            />
          </div>
          <div className="tsb-wide muted small">
            Every ticket Claude creates here gets these values, from the next
            one on; asked for something else in the chat, it says to change it
            here.
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { jobName, type ScheduleInfo } from "@shared/schedules";
import type { AppState, Session } from "@shared/types";
import { formatAgo } from "@shared/format";
import { useNow } from "../deck";

/**
 * Details: the jobs this session scheduled with CronCreate (read from its transcript), with when
 * each runs next. One shows inline; several open as a list. Click a job for its whole prompt.
 */
export function ScheduleWidget({
  session: s,
  state,
}: {
  session: Session;
  state: AppState;
}) {
  const now = useNow(15_000);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  const jobs = state.schedules?.[s.sessionId] ?? [];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) =>
      !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (!jobs.length) return null;

  const row = (j: ScheduleInfo) => (
    <div key={j.id} className="mon-row sched-row">
      <span className="sched-dot" aria-hidden="true">
        ⏱
      </span>
      <div
        className="mon-main"
        onClick={() => setShown((x) => (x === j.id ? null : j.id))}
        title={shown === j.id ? "Show less" : "Show the whole prompt"}
      >
        <div className="mon-name">{jobName(j.prompt)}</div>
        <div className="muted small">
          {j.recurring ? j.when : `Once, ${j.when}`}
          {j.nextAt
            ? ` · next ${j.nextAt <= now ? "now" : `in ${formatAgo(j.nextAt - now)}`}`
            : ""}
          {j.expiresAt ? ` · ends in ${formatAgo(j.expiresAt - now)}` : ""}
          {j.sessionOnly ? " · ends with the session" : ""}
        </div>
        {shown === j.id && (
          <pre className="sched-prompt">
            <span className="muted">{j.cron} · job {j.id}</span>
            {"\n"}
            {j.prompt}
          </pre>
        )}
      </div>
    </div>
  );

  return (
    <section className="dsec mon" ref={box}>
      <div className="wfw-head">
        <span className="eyebrow">
          {jobs.length === 1 ? "Scheduled" : `Scheduled (${jobs.length})`}
        </span>
        <span
          className="muted wfw-from"
          title="Made with CronCreate; the session cancels one with CronDelete"
        >
          by Claude Code
        </span>
      </div>
      {jobs.length === 1 ? (
        row(jobs[0])
      ) : (
        <>
          <button
            className="mon-pick"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <span className="sched-dot" aria-hidden="true">
              ⏱
            </span>
            <span className="mon-name">
              {jobs.map((j) => jobName(j.prompt)).join(" · ")}
            </span>
            <span className="muted">{open ? "▴" : "▾"}</span>
          </button>
          {open && <div className="mon-list">{jobs.map(row)}</div>}
        </>
      )}
    </section>
  );
}

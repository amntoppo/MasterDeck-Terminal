import { useEffect, useRef, useState } from "react";
import type { WatchInfo } from "@shared/watches";
import type { AppState, Session } from "@shared/types";
import { formatAgo } from "@shared/format";
import { deck, useNow } from "../deck";

/**
 * Details: the monitors MasterDeck runs for this session (Settings → Monitors run by: MasterDeck),
 * with a blinking dot while they run. One shows inline; several open as a list.
 */
export function MonitorWidget({
  session: s,
  state,
}: {
  session: Session;
  state: AppState;
}) {
  const now = useNow(15_000);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLElement>(null);
  const mine = (state.watches ?? []).filter((w) => w.sessionId === s.sessionId);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) =>
      !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (!mine.length) return null;

  const row = (w: WatchInfo) => (
    <div key={w.id} className="mon-row" title={w.command}>
      <span className="mon-dot" aria-hidden="true" />
      <div className="mon-main">
        <div className="mon-name">{w.description}</div>
        <div className="muted small">
          {w.events} event{w.events === 1 ? "" : "s"}
          {w.lastEventAt ? ` · last ${formatAgo(now - w.lastEventAt)} ago` : ""}
          {` · on for ${formatAgo(now - w.startedAt)}`}
          {w.queued ? ` · ${w.queued} waiting for its turn to end` : ""}
        </div>
      </div>
      <button
        className="link-btn"
        onClick={() => void deck().watchStop(w.id)}
        title="Stop this monitor (the session is told)"
      >
        Stop
      </button>
    </div>
  );

  return (
    <section className="dsec mon" ref={box}>
      <div className="wfw-head">
        <span className="eyebrow">
          {mine.length === 1 ? "Monitor" : `Monitors (${mine.length})`}
        </span>
        <span className="muted wfw-from" title="Runs in MasterDeck, with no time limit">
          by MasterDeck
        </span>
      </div>
      {mine.length === 1 ? (
        row(mine[0])
      ) : (
        <>
          <button
            className="mon-pick"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <span className="mon-dot" aria-hidden="true" />
            <span className="mon-name">
              {mine.map((w) => w.description).join(" · ")}
            </span>
            <span className="muted">{open ? "▴" : "▾"}</span>
          </button>
          {open && <div className="mon-list">{mine.map(row)}</div>}
        </>
      )}
    </section>
  );
}

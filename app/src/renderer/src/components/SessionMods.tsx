import { useState } from "react";
import { modRows, type ModRow } from "@shared/modBand";
import type { AppState, Session } from "@shared/types";
import { deck } from "../deck";

/** Where a mod comes from, in words: its marketplace, a folder given with --plugin-dir, or Claude Code. */
function source(r: ModRow): string {
  const from = r.provenance.split("@")[1] ?? "";
  if (from === "builtin") return "built into Claude Code";
  if (from === "inline") return "from a folder (--plugin-dir)";
  return from ? `from ${from}` : "";
}

function statusText(r: ModRow): string {
  if (r.isMasterDeck)
    return r.status === "not-seen" ? "Not running in this session (not installed?)" : r.isOff ? "Off" : "On";
  switch (r.status) {
    case "on":
      return "On";
    case "off":
      return "Off: not loaded in this session";
    case "off-next-start":
      return "Off from the session's next start (it is running now)";
    case "turning-on":
      return "Turning on: it loads when Claude Code reloads its plugins";
    case "not-seen":
      return r.isOff ? "Off: it will not load in this session" : "Not loaded in this session";
  }
}

function title(r: ModRow): string {
  if (r.locked && r.isMasterDeck) return "Needed for these switches: it does the switching";
  if (r.locked) return "Managed by your organization or built into Claude Code: not switched from MasterDeck";
  if (r.isOff) return "Turn it on in this session";
  return r.isMasterDeck
    ? "Turn it off in this session, at once"
    : "Turn it off in this session: it stops loading here (at once if it is not running, else from the session's next start)";
}

function Row({ r, busy, onFlip }: { r: ModRow; busy: boolean; onFlip: () => void }) {
  return (
    <div className="d-mod">
      <div className="d-mod-text">
        <div className="d-mod-name">
          {r.title}
          {r.version && <span className="muted mono"> {r.version}</span>}
        </div>
        {r.about && <div className="d-text">{r.about}</div>}
        <div className="d-text muted">
          {r.isMasterDeck ? r.name : source(r)} · {statusText(r)}
        </div>
      </div>
      <button
        className={`switch ${r.isOff ? "" : "on"}`}
        role="switch"
        aria-checked={!r.isOff}
        aria-label={`${r.title} in this session`}
        disabled={r.locked || busy || (r.isMasterDeck && r.status === "not-seen")}
        title={title(r)}
        onClick={onFlip}
      />
    </div>
  );
}

/**
 * Session details → Mods: MasterDeck's mods (its core, which does the switching, and one mod per
 * feature), then every other mod MasterDeck has seen, with a switch per mod for this session. The
 * core does the switching inside the session, so nothing can be switched where it does not run.
 */
export function SessionMods({ session: s, state, onMessage }: { session: Session; state: AppState; onMessage: (text: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const live = state.modLive?.[s.key];
  if (!live)
    return (
      <section className="dsec">
        <div className="eyebrow">Mods</div>
        <div className="d-text muted">
          MasterDeck's core mod is not running in this session, so its mods cannot be seen or switched here.
          Run /reload-plugins in the session, or start it again.
        </div>
      </section>
    );
  const rows = modRows(state.modCatalog ?? [], live, state.modOff?.[s.key] ?? []);
  const flip = async (r: ModRow) => {
    setBusy(r.name);
    const res = await deck().modSet(s.key, r.name, r.isOff);
    setBusy(null);
    if (!res.ok) onMessage(res.message);
  };
  const ours = rows.filter((r) => r.isMasterDeck);
  const others = rows.filter((r) => !r.isMasterDeck);
  return (
    <>
      <section className="dsec">
        <div className="eyebrow">MasterDeck</div>
        <div className="d-mods">
          {ours.map((r) => (
            <Row key={r.name} r={r} busy={busy === r.name} onFlip={() => flip(r)} />
          ))}
        </div>
      </section>
      <section className="dsec">
        <div className="eyebrow">Other mods</div>
        {others.length === 0 && <div className="d-text muted">No other mod has run in your sessions yet.</div>}
        <div className="d-mods">
          {others.map((r) => (
            <Row key={r.name} r={r} busy={busy === r.name} onFlip={() => flip(r)} />
          ))}
        </div>
        <div className="d-text muted">
          Switches are for this session only. MasterDeck's mods switch at once; another mod that is running
          stays until the session starts again.
        </div>
      </section>
    </>
  );
}

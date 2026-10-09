import { useState } from "react";
import { modRows, type ModRow } from "@shared/modBand";
import type { AppState, Session } from "@shared/types";
import { deck } from "../deck";

/** Where a mod comes from, in words: its marketplace, a folder given with --plugin-dir, or Claude Code. */
function source(r: ModRow): string {
  const from = r.provenance.split("@")[1] ?? "";
  if (r.isSelf) return "MasterDeck";
  if (from === "builtin") return "built into Claude Code";
  if (from === "inline") return "from a folder (--plugin-dir)";
  return from ? `from ${from}` : "";
}

function statusText(r: ModRow): string {
  switch (r.status) {
    case "on":
      return "On";
    case "off":
      return r.isSelf ? "Off: nothing of MasterDeck shows in this session" : "Off: not loaded in this session";
    case "off-next-start":
      return "Off from the session's next start (it is running now)";
    case "turning-on":
      return "Turning on: it loads when Claude Code reloads its plugins";
    case "not-seen":
      return r.isOff ? "Off: it will not load in this session" : "Not loaded in this session";
  }
}

/**
 * Session details → Mods: every mod MasterDeck has seen (the MasterDeck mod reports them), and a
 * switch per mod for this session. The MasterDeck mod does the switching inside the session, so
 * nothing can be switched where it does not run.
 */
export function SessionMods({ session: s, state, onMessage }: { session: Session; state: AppState; onMessage: (text: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const live = state.modLive?.[s.key];
  if (!live)
    return (
      <section className="dsec">
        <div className="eyebrow">Mods</div>
        <div className="d-text muted">
          MasterDeck's mod is not running in this session, so its mods cannot be seen or switched here. Run
          /reload-plugins in the session, or start it again.
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
  return (
    <section className="dsec">
      <div className="eyebrow">Mods in this session</div>
      <div className="d-mods">
        {rows.map((r) => (
          <div key={r.name} className="d-mod">
            <div className="d-mod-text">
              <div className="d-mod-name">
                {r.isSelf ? "MasterDeck" : r.name}
                {r.version && <span className="muted mono"> {r.version}</span>}
              </div>
              <div className="d-text muted">
                {source(r)} · {statusText(r)}
              </div>
            </div>
            <button
              className={`switch ${r.isOff ? "" : "on"}`}
              role="switch"
              aria-checked={!r.isOff}
              aria-label={`${r.name} in this session`}
              disabled={r.locked || busy === r.name}
              title={
                r.locked
                  ? "Managed by your organization or built into Claude Code: not switched from MasterDeck"
                  : r.isOff
                    ? "Turn it on in this session"
                    : r.isSelf
                      ? "Turn it off in this session: no ticket line, toasts or /md- commands"
                      : "Turn it off in this session: it stops loading here (at once if it is not running, else from the session's next start)"
              }
              onClick={() => flip(r)}
            />
          </div>
        ))}
      </div>
      <div className="d-text muted">
        Mods load in every session unless switched off here. A mod that is running stays until the session
        starts again; MasterDeck's own goes quiet at once.
      </div>
    </section>
  );
}

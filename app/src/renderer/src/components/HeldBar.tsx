import { useState } from "react";
import { heldReasonText, type HeldView } from "@shared/heldMessages";
import { deck } from "../deck";

/**
 * MasterDeck messages waiting for this session's prompt to be empty (#123): the first one, who sent
 * it, why it waits, Send now (never over text in the prompt: it says so) and Discard.
 */
export function HeldBar({ held }: { held: HeldView[] }) {
  const [busy, setBusy] = useState(false);
  // A failed Send now's answer, for the message it was about.
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  if (!held.length) return null;
  const m = held[0];
  const act = async (f: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    const r = await f();
    setBusy(false);
    setNote(r.ok ? null : { id: m.id, text: r.message });
  };
  return (
    <div className="held-bar" role="status">
      <span className="held-kind">✉ {held.length > 1 ? `${held.length} MasterDeck messages waiting` : "MasterDeck message waiting"}</span>
      <span className="held-text" title={m.preview}>
        <b>{m.from}:</b> {m.preview}
      </span>
      <span className="held-why muted">{note?.id === m.id ? note.text : heldReasonText(m.reason)}</span>
      <span className="held-actions">
        <button className="btn primary" disabled={busy} onClick={() => act(() => deck().heldSend(m.id))}>
          Send now
        </button>
        <button className="btn" disabled={busy} onClick={() => act(() => deck().heldDrop(m.id))}>
          Discard
        </button>
      </span>
    </div>
  );
}

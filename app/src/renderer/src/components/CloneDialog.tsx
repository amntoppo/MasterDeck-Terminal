import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { checkFirstMessage, cloneName, cloneNameError } from "@shared/clone";
import { ticketLabel } from "@shared/ticket";
import type { CloneRequest } from "@shared/ipc";
import type { AppState, Session } from "@shared/types";
import { isWeb } from "../web";

/**
 * Clone… (#136): a new background session that goes on from a copy of this one's conversation, in
 * its folder, as its account. The original keeps running, with its name, ticket and PRs.
 */
export function CloneDialog({
  session: s,
  state,
  onClone,
  onClose,
}: {
  session: Session;
  state: AppState;
  onClone: (req: CloneRequest) => void;
  onClose: () => void;
}) {
  const taken = useMemo(
    () => state.sessions.filter((x) => x.state !== "done").map((x) => x.name),
    [state.sessions],
  );
  const [name, setName] = useState(() => cloneName(s.name, taken));
  const [prompt, setPrompt] = useState("");
  const [keepTicket, setKeepTicket] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const nameErr = taken.includes(name.trim())
    ? "A session has that name already."
    : cloneNameError(name.trim());
  const first = checkFirstMessage(prompt, isWeb());
  const ok = !nameErr && first.ok;
  const clone = () => {
    if (!ok) return;
    onClone({
      key: s.key,
      name: name.trim(),
      ...(first.text ? { prompt: first.text } : {}),
      ...(keepTicket ? { keepTicket: true } : {}),
    });
    onClose();
  };

  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog new-session clone-dialog"
        role="dialog"
        aria-label={`Clone ${s.name}`}
      >
        <h3>Clone {s.name}</h3>
        <div className="meta">
          A new background session that goes on from a copy of this
          conversation, in the same folder
          {s.account ? `, as ${s.account}` : ""}. {s.name} keeps running as it
          is.
        </div>
        <div className="meta mono">{s.cwd}</div>
        <label>Name</label>
        <input
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        {nameErr && name && <div className="error small">{nameErr}</div>}
        <label>First message (optional)</label>
        <textarea
          value={prompt}
          autoFocus
          placeholder="What should the clone do next? Leave empty to start it idle."
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && (e.metaKey || e.ctrlKey) && clone()
          }
        />
        {!first.ok && <div className="error small">{first.message}</div>}
        {s.issue !== null && (
          <label
            className="check"
            title="Off: the board and the PR watch stay with the original session only"
          >
            <input
              type="checkbox"
              checked={keepTicket}
              onChange={(e) => setKeepTicket(e.target.checked)}
            />
            Keep ticket link ({ticketLabel(s.issueRepo ?? null, s.issue)})
          </label>
        )}
        <div className="form-buttons">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!ok}
            onClick={clone}
            title="⌘↵"
          >
            Clone
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

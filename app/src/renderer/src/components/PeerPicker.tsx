import { useState } from "react";
import { MAX_PEERS } from "@shared/peers";
import type { AppState } from "@shared/types";
import { pickable } from "./peersView";

interface Props {
  state: AppState;
  value: string[];
  onChange: (keys: string[]) => void;
}

/** "Link to sessions": chosen sessions as chips and a filter box to add more (two-way links). */
export function PeerPicker({ state, value, onChange }: Props) {
  const [text, setText] = useState("");
  const full = value.length >= MAX_PEERS;
  const suggestions = full || !text.trim() ? [] : pickable(state, value, text);
  const add = (key: string) => {
    if (full || value.includes(key)) return;
    onChange([...value, key]);
    setText("");
  };
  const nameOf = (key: string) => state.sessions.find((s) => s.key === key)?.name ?? key;
  return (
    <div className="peer-picker">
      <label>Link to sessions</label>
      {value.length > 0 && (
        <div className="chips" style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
          {value.map((k) => (
            <span key={k} className="chip">
              {nameOf(k)}
              <button type="button" className="btn" aria-label={`Unlink ${nameOf(k)}`} onClick={() => onChange(value.filter((x) => x !== k))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={text}
        disabled={full}
        placeholder={full ? `At most ${MAX_PEERS} linked sessions` : "Filter by name or session id"}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          // Enter adds a chip here; it must not submit the dialog.
          e.preventDefault();
          e.stopPropagation();
          if (suggestions[0]) add(suggestions[0].key);
        }}
      />
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((s) => (
            <div key={s.key} className="row" onClick={() => add(s.key)} title={s.sessionId}>
              <span className={`dot ${s.state}`} />
              <span className="label">{s.name}</span>
              <span className="sub mono">{s.sessionId.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="sd-hint">They will see this session's summary, and it theirs.</div>
    </div>
  );
}

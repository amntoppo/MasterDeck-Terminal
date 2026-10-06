import { QueuePanel } from "./QueuePanel";
import { SessionDetails } from "./SessionDetails";
import { SummaryPanel } from "./SummaryPanel";
import type { AppState, Session } from "@shared/types";
import type { NoteMeta } from "@shared/notes";
import type { Ticket } from "@shared/ticket";

export type InspectorTab = "details" | "queue" | "summary";

interface Props {
  state: AppState;
  /** The open session (null: a shell, or nothing open). */
  session: Session | null;
  activeKey: string | null;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  onHide: () => void;
  onDetach: () => void;
  onAskMaster: (s: Session) => void;
  masterAttached: boolean;
  notes?: NoteMeta[];
  onNote?: (t: Ticket) => void;
}

/**
 * The Terminals screen's right panel: Details (everything the status bar used to show), Queue and
 * Summary. Master has its own column (App), on every screen.
 */
export function Inspector({
  state,
  session,
  activeKey,
  tab,
  onTab,
  onHide,
  onDetach,
  onAskMaster,
  masterAttached,
  notes,
  onNote,
}: Props) {
  const tabs: [InspectorTab, string][] = [
    ["details", "Details"],
    ["queue", "Queue"],
    ["summary", "Summary"],
  ];
  const shown = tabs.some(([k]) => k === tab) ? tab : "details";
  return (
    <aside className="inspector" aria-label="Session panel">
      <div className="insp-head">
        <div className="seg" role="tablist">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={shown === k}
              className={shown === k ? "on" : ""}
              onClick={() => onTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="insp-hide"
          onClick={onHide}
          title="Hide the panel (the master stays attached)"
          aria-label="Hide the panel"
        >
          ›
        </button>
      </div>
      <div className="insp-body">
        {shown === "details" &&
          (session ? (
            <SessionDetails
              session={session}
              state={state}
              onDetach={onDetach}
              onAskMaster={onAskMaster}
              masterAttached={masterAttached}
              notes={notes}
              onNote={onNote}
            />
          ) : (
            <div className="insp-empty">
              Open a session to see its details. Shells have none.
            </div>
          ))}
        {shown === "queue" && (
          <QueuePanel
            state={state}
            activeKey={activeKey}
            onClose={() => onTab("details")}
          />
        )}
        {shown === "summary" && (
          <SummaryPanel
            state={state}
            activeKey={activeKey}
            onClose={() => onTab("details")}
          />
        )}
      </div>
    </aside>
  );
}

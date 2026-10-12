import { useState } from "react";
import type { AppState, Session } from "@shared/types";
import { load, save } from "../deck";
import { can } from "../web";
import { QueuePanel } from "./QueuePanel";
import { SessionBtw } from "./SessionBtw";

export type ToolsTab = "queue" | "btw";
const TOOLS: ToolsTab[] = ["queue", "btw"];
const TAB_KEY = "md.toolsTab";

/**
 * The right panel's Tools tab: things to do with the open session beside its terminal, one sub-tab
 * each. Queue (prompts its Stop hook runs) and BTW (side questions, as `/btw`). A new one is a
 * ToolsTab, a button and a branch below. The picked one is kept across sessions and restarts.
 */
export function SessionTools({
  state,
  session,
  activeKey,
}: {
  state: AppState;
  session: Session | null;
  activeKey: string | null;
}) {
  const [tab, setTabState] = useState<ToolsTab>(() => {
    const t = load<string>(TAB_KEY, "queue");
    return TOOLS.includes(t as ToolsTab) ? (t as ToolsTab) : "queue";
  });
  const setTab = (t: ToolsTab) => {
    setTabState(t);
    save(TAB_KEY, t);
  };
  const [note, setNote] = useState<string | null>(null);
  const flash = (t: string) => {
    setNote(t);
    setTimeout(() => setNote((cur) => (cur === t ? null : cur)), 2200);
  };
  const btw = can("btwList");
  const shown: ToolsTab = tab === "btw" && !btw ? "queue" : tab;
  const tabButton = (t: ToolsTab, label: string, title: string) => (
    <button role="tab" aria-selected={shown === t} className={shown === t ? "on" : undefined} onClick={() => setTab(t)} title={title}>
      {label}
    </button>
  );
  return (
    <div className="details tools">
      <div className="d-tabs">
        <div className="seg" role="tablist" aria-label="Tools">
          {tabButton("queue", "Queue", "Prompts the session runs after each response (/queue)")}
          {btw && tabButton("btw", "BTW", "Side questions about the session (/btw)")}
        </div>
      </div>
      {shown === "queue" && <QueuePanel state={state} activeKey={activeKey} />}
      {shown === "btw" &&
        (session ? (
          <>
            {note && (
              <section className="dsec">
                <span className="d-note">{note}</span>
              </section>
            )}
            <SessionBtw session={session} onMessage={flash} />
          </>
        ) : (
          <div className="insp-empty">Open a session to ask a side question about it. Shells have none.</div>
        ))}
    </div>
  );
}

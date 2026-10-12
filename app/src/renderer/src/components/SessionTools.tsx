import { useState, type ReactNode } from "react";
import type { AppState, Session } from "@shared/types";
import { load, save } from "../deck";
import { can } from "../web";
import { QueuePanel } from "./QueuePanel";
import { SessionBtw } from "./SessionBtw";
import { SessionMods } from "./SessionMods";

export type ToolsTab = "queue" | "btw" | "mods";
const TOOLS: ToolsTab[] = ["queue", "btw", "mods"];
const TAB_KEY = "md.toolsTab";

/**
 * The right panel's Tools tab: things to do with the open session beside its terminal, one sub-tab
 * each. Queue (prompts its Stop hook runs), BTW (side questions, as `/btw`) and Mods (Claude Code
 * mods switched on or off for this session). A new one is a
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
  const tabButton = (t: ToolsTab, label: ReactNode, title: string) => (
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
          {tabButton(
            "mods",
            <>
              Mods
              {session && state.modOff?.[session.key]?.length ? (
                <span className="d-tab-count"> {state.modOff[session.key].length} off</span>
              ) : null}
            </>,
            "Claude Code mods in this session: switch each on or off",
          )}
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
      {shown === "mods" &&
        (session ? (
          <>
            {note && (
              <section className="dsec">
                <span className="d-note">{note}</span>
              </section>
            )}
            <SessionMods session={session} state={state} onMessage={flash} />
          </>
        ) : (
          <div className="insp-empty">Open a session to switch its mods. Shells have none.</div>
        ))}
    </div>
  );
}

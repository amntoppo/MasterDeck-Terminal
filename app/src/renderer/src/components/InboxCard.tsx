import { sameTicket, ticketLabel, ticketUrl } from "@shared/ticket";
import { useState } from "react";
import {
  proposalLabel,
  proposalTicket,
  sessionForIssue,
  sessionForProposal,
} from "@shared/derive";
import type { InboxEntry } from "@shared/inbox";
import type { ExternalItem } from "@shared/remote";
import type { AppState, Issue, Proposal, Session } from "@shared/types";
import { deck, KIND_COLOR } from "../deck";
import { can, isWeb } from "../web";
import { webConfirm } from "../webConfirm";
import { OfferRow } from "./PrsView";
import { AskPanel } from "./AskPanel";
import { Markdown } from "./SummaryPanel";
import { AccountBadge } from "./AccountBits";
import { isMulti } from "@shared/accounts";
import { heldForTrust, isNotTrusted } from "@shared/trust";
import { TrustNote, useTrust } from "./TrustFix";

/** A click on a card's text (not its buttons or fields, and not a text selection) opens the popup. */
function detailsClick(open?: () => void) {
  return (e: React.MouseEvent) => {
    if (!open) return;
    if (
      (e.target as HTMLElement).closest(
        "button, a, textarea, input, select, label",
      )
    )
      return;
    if (window.getSelection()?.toString()) return;
    open();
  };
}

/** Minutes from now until 9:00 tomorrow. */
function untilTomorrow(): number {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return Math.max(60, Math.round((t.getTime() - Date.now()) / 60_000));
}

/** Snooze (⏾) and dismiss (×) on a Needs-you card: both through the inbox. Dismissed items come back
 * when the situation changes (a new question, more context used…). */
function ItemControls({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const act =
    (type: string, payload?: Record<string, unknown>) =>
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setOpen(false);
      void deck().inboxAct(itemId, type, payload);
    };
  return (
    <span className="card-ctl" onClick={(e) => e.stopPropagation()}>
      <button
        className="card-x"
        title="Snooze"
        aria-label="Snooze"
        onClick={() => setOpen(!open)}
      >
        ⏾
      </button>
      <button
        className="card-x"
        title="Dismiss (it comes back if the situation changes)"
        aria-label="Dismiss"
        onClick={act("dismiss")}
      >
        ×
      </button>
      {open && (
        <span className="menu snooze-menu">
          <button onClick={act("snooze", { minutes: 60 })}>For an hour</button>
          <button onClick={act("snooze", { minutes: 240 })}>For 4 hours</button>
          <button onClick={act("snooze", { minutes: untilTomorrow() })}>
            Until tomorrow
          </button>
        </span>
      )}
    </span>
  );
}

/** One Needs-you item as its card: the card for its kind, acting through the inbox. */
export function InboxCard({
  entry,
  state,
  onOpenSession,
  onIssue,
  onStartWith,
  onOpenMeeting,
  onDetails,
  full,
}: {
  entry: InboxEntry;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onIssue: (i: Issue) => void;
  onStartWith: (issue: Issue, instructions: string) => void;
  onOpenMeeting?: (id: string) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const i = entry.item;
  const d = i.detail;
  if (d.type === "meeting")
    return (
      <MeetingCard
        entry={entry}
        meetingId={d.meetingId}
        onOpenMeeting={onOpenMeeting}
        onDetails={onDetails}
        full={full}
      />
    );
  if (d.type === "proposal")
    return (
      <ProposalCard
        itemId={i.id}
        proposal={d.proposal}
        attention={i.kind !== "proposal"}
        state={state}
        onOpenSession={onOpenSession}
        onIssue={onIssue}
        onDetails={onDetails}
        full={full}
      />
    );
  if (d.type === "offer")
    return (
      <div
        className={`card ${onDetails ? "clickable" : ""}`}
        style={{
          ["--kind" as string]:
            i.kind === "ci" ? "var(--red)" : "var(--accent)",
        }}
        onClick={detailsClick(onDetails)}
      >
        {!full && <ItemControls itemId={i.id} />}
        <OfferRow
          o={d.offer}
          itemId={i.id}
          state={state}
          onDismiss={() => void deck().inboxAct(i.id, "dismiss")}
          onStartWith={onStartWith}
          onOpenSession={onOpenSession}
        />
      </div>
    );
  if (d.type === "external")
    return (
      <ExternalCard itemId={i.id} item={d.item} full={full} onDetails={onDetails} />
    );
  const s = i.sessionKey
    ? state.sessions.find((x) => x.key === i.sessionKey)
    : undefined;
  if (d.type === "session" && s && i.kind !== "error")
    return (
      <NeedsCard
        itemId={i.id}
        session={s}
        state={state}
        onOpenSession={onOpenSession}
        onDetails={onDetails}
        full={full}
      />
    );
  return (
    <ExtraCard
      entry={entry}
      session={s}
      state={state}
      onOpenSession={onOpenSession}
      onDetails={onDetails}
      full={full}
    />
  );
}

/** A session waiting on a prompt, or on the menu on its screen (answered right here). */
function NeedsCard({
  itemId,
  session: s,
  state,
  onOpenSession,
  onDetails,
  full,
}: {
  itemId: string;
  session: Session;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const ask = state.asks[s.key];
  const menu = state.menus[s.key];
  const tool = state.tails[s.sessionId]?.lastTool;
  const open = (
    <button className="btn" onClick={() => onOpenSession(s)}>
      Open
    </button>
  );
  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{ ["--kind" as string]: menu ? "var(--purple)" : "var(--red)" }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={itemId} />}
      <div className="top">
        <span className="kind">
          {menu?.permission ? "PERMISSION" : menu ? "QUESTION" : "INPUT"}
        </span>
        <span className="title">{s.name}</span>
        {s.issue !== null && (
          <span className="num">{ticketLabel(s.issueRepo, s.issue)}</span>
        )}
      </div>
      {menu ? (
        <AskPanel
          session={s}
          ask={ask}
          menu={menu}
          fallback={null}
          full={full}
          actions={open}
          itemId={itemId}
        />
      ) : (
        <>
          <div className="body">
            Waiting on a prompt or permission{tool ? ` (${tool})` : ""}. Open it
            to answer.
          </div>
          {full && ask?.said && (
            <div className="ask-text full">
              <Markdown text={ask.said.text} />
            </div>
          )}
          <div className="actions">{open}</div>
        </>
      )}
    </div>
  );
}

function ProposalCard({
  itemId,
  proposal: p,
  attention,
  state,
  onOpenSession,
  onIssue,
  onDetails,
  full,
}: {
  itemId: string;
  proposal: Proposal;
  attention: boolean;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onIssue: (i: Issue) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = sessionForProposal(p, state.sessions);
  const dest = p.target.session
    ? `→ ${p.target.session}`
    : p.target.spawn
      ? `→ spawn ${p.target.spawn.name}`
      : "";
  const question = attention && p.status === "question";
  // A start Claude Code refused for its folder: the card fixes it and starts the same proposal again.
  const refused = attention ? heldForTrust(p) : null;
  const trust = useTrust(
    refused?.folder ?? null,
    refused ? undefined : null,
    () => deck().inboxAct(itemId, "trust"),
  );

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    const r = await deck().inboxAct(itemId, approve ? "approve" : "reject");
    setBusy(false);
    if (!r.ok) setError(r.message);
  };
  const openBtn = target && (
    <button className="btn" onClick={() => onOpenSession(target)}>
      Open
    </button>
  );

  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{
        ["--kind" as string]: question
          ? "var(--purple)"
          : (KIND_COLOR[p.kind] ?? "var(--accent)"),
      }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={itemId} />}
      <div className="top">
        <span className="kind">
          {attention ? p.status.toUpperCase() : p.kind}
        </span>
        <span
          className="title"
          title={`${proposalLabel(p)} ${dest}`}
        >
          {proposalLabel(p)}{" "}
          {question && target ? target.name : dest}
          <AccountBadge login={isMulti(state.config) ? p.target.spawn?.account : null} />
        </span>
        {!full && !question && (
          <button
            className="icon-btn"
            onClick={() => setOpen(!open)}
            title={open ? "Hide message" : "Show the message master will send"}
          >
            {open ? "▴" : "▾"}
          </button>
        )}
      </div>
      {question ? (
        <AskPanel
          session={target}
          ask={target ? state.asks[target.key] : undefined}
          fallback={p.note ?? p.summary}
          full={full}
          actions={openBtn}
          itemId={itemId}
        />
      ) : refused ? (
        <div title={p.note ?? undefined}>
          <TrustNote trust={trust} />
        </div>
      ) : (
        <div className="body">{attention && p.note ? p.note : p.summary}</div>
      )}
      {full && !question && attention && p.note && (
        <div className="body">{p.summary}</div>
      )}
      {(open || full) && p.message && (
        <>
          {full && (
            <div className="ask-note">
              {attention
                ? "What master sent the session"
                : "The message master will send"}
            </div>
          )}
          <pre>{p.message}</pre>
        </>
      )}
      {!question && (
        <div className="actions">
          {error && (
            <span className="error">
              {refused && isNotTrusted(error)
                ? "Claude Code still refuses that folder."
                : error}
            </span>
          )}
          {openBtn}
          {refused && (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => decide(true)}
            >
              {trust.trusted === true ? "Start now" : "Try again"}
            </button>
          )}
          {!attention && (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => decide(false)}
              >
                Reject
              </button>
              {p.kind === "ASSIGN" && p.target.spawn ? (
                // Opens the Start dialog: review the prompt, add first instructions, start now.
                <button
                  className="btn primary"
                  onClick={() =>
                    onIssue(
                      state.issues.find((i) =>
                        sameTicket(i, proposalTicket(p)),
                      ) ?? {
                        number: p.issue,
                        repo: p.repo ?? null,
                        title: p.summary.replace(/^"|"$/g, ""),
                        url: ticketUrl(p.repo, p.issue),
                        status: null,
                        currentSprint: true,
                        assignedToMe: true,
                      },
                    )
                  }
                >
                  Start…
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => decide(true)}
                >
                  Approve
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A Needs-you item someone asked through the remote API: its options as buttons, or a text answer. */
function ExternalCard({
  itemId,
  item,
  full,
  onDetails,
}: {
  itemId: string;
  item: ExternalItem;
  full: boolean;
  onDetails?: () => void;
}) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const answer = async (type: "option" | "reply", value: string, key?: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    const r = await deck().inboxAct(
      itemId,
      type,
      type === "option" ? { key, text: value } : { text: value },
    );
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? "Answered" : r.message });
  };
  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{ ["--kind" as string]: "var(--accent)" }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={itemId} />}
      <div className="top">
        <span className="kind">ASKED</span>
        <span className="title">{item.title}</span>
      </div>
      {item.body && <div className="body">{item.body}</div>}
      {(item.options ?? []).length > 0 && (
        <div className="ask" onClick={(e) => e.stopPropagation()}>
          <div className="ask-opts">
            {(item.options ?? []).map((o, n) => (
              <button
                key={n}
                className="ask-opt"
                disabled={busy}
                onClick={() => void answer("option", o, String(n + 1))}
              >
                <span className="ask-key">{n + 1}</span>
                {o}
              </button>
            ))}
          </div>
        </div>
      )}
      {item.allowText && (
        <div className="quick-reply" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={text}
            placeholder="Answer…"
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey) &&
              void answer("reply", text)
            }
          />
          <div className="actions">
            <button
              className="btn primary"
              disabled={busy || !text.trim()}
              onClick={() => void answer("reply", text)}
            >
              Answer
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        {msg && (
          <span
            className="error"
            style={{ color: msg.ok ? "var(--green)" : undefined }}
          >
            {msg.text}
          </span>
        )}
        <span className="muted small">asked by {item.by}</span>
      </div>
    </div>
  );
}

/**
 * A meeting's item: notes added (Open), matching failed (Match again), transcription failed (Try
 * again). Every action goes through the inbox; a browser only reads it (meetings are the Mac's).
 */
function MeetingCard({
  entry,
  meetingId,
  onOpenMeeting,
  onDetails,
  full,
}: {
  entry: InboxEntry;
  meetingId: string;
  onOpenMeeting?: (id: string) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const i = entry.item;
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const primary = i.actions.find((a) => a.primary);
  const act = async (type: string) => {
    setBusy(true);
    const r = await deck().inboxAct(i.id, type);
    setBusy(false);
    if (!r.ok) return setMsg(r.message);
    setMsg(null);
    if (type === "open") onOpenMeeting?.(meetingId);
  };
  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{ ["--kind" as string]: i.detail.type === "meeting" && i.detail.notice === "added" ? "var(--accent)" : "var(--red)" }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={i.id} />}
      <div className="top">
        <span className="kind">MEETING</span>
        <span className="title">{i.title}</span>
      </div>
      <div className="body">{i.body}</div>
      <div className="actions">
        {msg && <span className="error">{msg}</span>}
        <button className="btn" disabled={busy} onClick={() => void deck().inboxAct(i.id, "dismiss")}>
          Dismiss
        </button>
        {isWeb() ? (
          <span className="muted">Open MasterDeck on the Mac for this.</span>
        ) : (
          primary && (
            <button className="btn primary" disabled={busy} onClick={() => void act(primary.type)}>
              {primary.label}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Idle and waiting nudges, context and budget warnings. */
function ExtraCard({
  entry,
  session: s,
  state,
  onOpenSession,
  onDetails,
  full,
}: {
  entry: InboxEntry;
  session: Session | undefined;
  state: AppState;
  onOpenSession: (s: Session) => void;
  onDetails?: () => void;
  full: boolean;
}) {
  const i = entry.item;
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (type: string) => {
    setBusy(true);
    const r = await deck().inboxAct(i.id, type);
    setBusy(false);
    setMsg(r.ok ? "Sent" : r.message);
  };
  const kind =
    i.kind === "account"
      ? "GITHUB"
      : i.kind === "mods"
      ? "MODS"
      : i.kind === "loop"
      ? "LOOP AT ITS LIMIT"
      : i.kind === "loop-paused"
      ? "LOOP PAUSED"
      : i.kind === "error"
      ? "API ERROR"
      : i.kind === "notice"
      ? "NOTICE"
      : i.detail.type === "nudge"
        ? `${i.kind === "idle" ? "IDLE" : "WAITING"} ${i.detail.minutes}M`
        : i.detail.type === "context"
          ? `CONTEXT ${Math.round(i.detail.pct)}%`
          : "BUDGET";
  const owner =
    s ?? (i.ticket ? sessionForIssue(state.sessions, i.ticket) : null);
  const primary = i.actions.find(
    (a) =>
      a.type === "continue" ||
      a.type === "compact" ||
      a.type === "login" ||
      a.type === "loop-more" ||
      a.type === "loop-continue" ||
      a.type === "reload",
  );
  const leave = i.actions.find((a) => a.type === "dismiss");
  const stopLoop = i.actions.find((a) => a.type === "loop-stop");
  const askStop = async () => {
    // A stopped loop cannot be given more: the web asks here, the window natively in main.
    const ask = "Stop the loop? The session does not go on with it, and it can't be given more.";
    if (!(await webConfirm(ask, { confirmLabel: "Stop loop", danger: true }))) return;
    await act("loop-stop");
  };
  return (
    <div
      className={`card ${onDetails ? "clickable" : ""}`}
      style={{
        ["--kind" as string]:
          i.kind === "idle" ||
          i.kind === "waiting" ||
          i.kind === "loop" ||
          i.kind === "loop-paused" ||
          i.kind === "mods"
            ? "var(--amber)"
            : "var(--red)",
      }}
      onClick={detailsClick(onDetails)}
    >
      {!full && <ItemControls itemId={i.id} />}
      <div className="top">
        <span className="kind">{kind}</span>
        <span className="title">{i.title}</span>
      </div>
      <div className="body">{i.body}</div>
      <div className="actions">
        {msg && (
          <span
            className="error"
            style={{ color: msg === "Sent" ? "var(--green)" : undefined }}
          >
            {msg}
          </span>
        )}
        {i.detail.type === "notice" && i.detail.url && (
          <button className="btn" onClick={() => deck().openExternal((i.detail as { url: string }).url)}>
            View on GitHub
          </button>
        )}
        {owner && (
          <button className="btn" onClick={() => onOpenSession(owner)}>
            {i.detail.type === "budget" ? `Open ${owner.name}` : "Open"}
          </button>
        )}
        {leave && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void deck().inboxAct(i.id, "dismiss")}
          >
            {leave.label}
          </button>
        )}
        {stopLoop && (
          <button
            className="btn danger"
            disabled={busy}
            onClick={() => void askStop()}
          >
            {stopLoop.label}
          </button>
        )}
        {primary && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void act(primary.type)}
          >
            {primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { sameTicket, ticketLabel, ticketUrl, type Ticket } from "@shared/ticket";
import { sessionTicket } from "@shared/derive";
import { formatAgo } from "@shared/format";
import { attentionFor, sessionStatus } from "@shared/review";
import { STEPS, taskStep } from "@shared/tasks";
import { subIssueProgress, subIssueRows } from "@shared/subIssues";
import {
  checkCounts,
  worstPrStatus,
  type PrDetail,
  type PrStatusLine,
  type PrWorst,
} from "@shared/prDetail";
import type { WatchEvent, WatchInfo } from "@shared/watches";
import type { NoteMeta } from "@shared/notes";
import type { NoteTarget } from "@shared/noteEditor";
import type { AppState, Session } from "@shared/types";
import { deck, useNow } from "../deck";
import { ticketNote } from "../notes";
import { can } from "../web";
import { useSubIssues } from "./SubIssues";

interface Props {
  session: Session;
  state: AppState;
  notes?: NoteMeta[];
  onNote?: (t: NoteTarget) => void;
}

/** Which rows are open, per session (Session.key): kept while the window lives, across tab and session switches. */
const openRows = new Map<string, Set<string>>();

function useOpenRows(key: string): [(id: string) => boolean, (id: string) => void] {
  const [, redraw] = useState(0);
  const set = openRows.get(key) ?? openRows.set(key, new Set()).get(key)!;
  return [
    (id) => set.has(id),
    (id) => {
      if (!set.delete(id)) set.add(id);
      redraw((n) => n + 1);
    },
  ];
}

type Tone = "ok" | "bad" | "wait" | "done" | "off" | "info";
const Badge = ({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) => (
  <span className={`gh-badge tone-${tone}`} title={title}>
    {children}
  </span>
);

const out = (url: string | null | undefined) => url && deck().openExternal(url);

function OutLink({ url, what = "Open on GitHub" }: { url: string | null | undefined; what?: string }) {
  if (!url) return null;
  return (
    <button className="gh-out" title={what} aria-label={what} onClick={() => out(url)}>
      ↗
    </button>
  );
}

/** A row that opens to its children: a summary (title, badges) while closed, a link out beside it. */
function GhRow({
  id,
  isOpen,
  toggle,
  title,
  badges,
  url,
  actions,
  children,
}: {
  id: string;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  title: ReactNode;
  badges?: ReactNode;
  url?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const open = isOpen(id);
  return (
    <div className={`gh-row${open ? " open" : ""}`}>
      <div className="gh-head">
        <button className="gh-toggle" aria-expanded={open} onClick={() => toggle(id)}>
          <span className="gh-caret" aria-hidden="true">
            ▸
          </span>
          <span className="gh-sum">
            <span className="gh-title">{title}</span>
            {badges && <span className="gh-badges">{badges}</span>}
          </span>
        </button>
        {actions}
        <OutLink url={url} />
      </div>
      {open && <div className="gh-kids">{children}</div>}
    </div>
  );
}

/** One leaf line: who/what, a line of text, when, and its page on GitHub. */
function GhItem({
  lead,
  text,
  at,
  url,
  now,
  tone,
}: {
  lead: ReactNode;
  text?: string;
  at?: number | null;
  url?: string | null;
  now: number;
  tone?: Tone;
}) {
  return (
    <div className={`gh-item${tone ? ` tone-${tone}` : ""}`}>
      <div className="gh-item-main">
        <div className="gh-item-lead">
          {tone && <i className="gh-dot" aria-hidden="true" />}
          {lead}
          {at ? (
            <span className="muted" title={new Date(at).toLocaleString()}>
              {lead ? " · " : ""}
              {formatAgo(now - at)} ago
            </span>
          ) : null}
        </div>
        {text ? <div className="gh-item-text">{text}</div> : null}
      </div>
      <OutLink url={url} />
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div className="gh-empty muted">{children}</div>;

/**
 * Session details → GitHub (#103): the session's ticket, PRs and monitors, each a row that opens to
 * what is behind it (sub-issues; checks, reviews, threads, comments and the PR watch's finds; a
 * monitor's lines). What is not in AppState is read when a row opens and again when the state says
 * it changed.
 */
export function GitHubDetails({ session: s, state, notes, onNote }: Props) {
  const now = useNow(15_000);
  const [isOpen, toggle] = useOpenRows(s.key);
  const t = sessionTicket(s);
  const prUrls = sessionPrUrls(s, state, t);
  const watches = (state.watches ?? []).filter((w) => w.sessionId === s.sessionId);
  const monitors = watches.filter((w) => !w.id.startsWith("pr:"));
  const rowProps = { isOpen, toggle };

  return (
    <div className="gh-tab">
      {(s.account || s.ghActive) && (
        <section className="dsec">
          <div
            className="d-text"
            title="The GitHub account this session works as (its commits, PRs and gh calls); to change it, stop it and resume it as another"
          >
            Works as <b>{s.account ?? "gh's active account"}</b>
            {!s.account && <span className="muted"> (started without an account)</span>}
          </div>
        </section>
      )}
      <section className="dsec gh-list">
        <TicketRow session={s} state={state} ticket={t} notes={notes} onNote={onNote} {...rowProps} />
        <PrsRow urls={prUrls} state={state} watches={watches} now={now} {...rowProps} />
        {monitors.length > 0 && <MonitorsRow monitors={monitors} now={now} {...rowProps} />}
        {!t && !prUrls.length && !monitors.length && (
          <Empty>Nothing on GitHub for this session yet: no ticket, PR or monitor.</Empty>
        )}
      </section>
    </div>
  );
}

/** Every PR the session has (several, across repos), newest first; with none of its own, the PRs that reference its issue. */
export function sessionPrUrls(s: Session, state: AppState, t: Ticket | null): string[] {
  const linked = state.sessionPrs[s.sessionId] ?? [];
  const issuePrs = t
    ? state.prs
        .filter((p) => p.refsIssue !== null && sameTicket({ repo: p.refsRepo, number: p.refsIssue }, t))
        .map((p) => p.url)
    : [];
  return [...new Set(linked.length ? linked : issuePrs)].reverse();
}

type RowProps = { isOpen: (id: string) => boolean; toggle: (id: string) => void };

function TicketRow({
  session: s,
  state,
  ticket: t,
  notes,
  onNote,
  ...row
}: RowProps & { session: Session; state: AppState; ticket: Ticket | null; notes?: NoteMeta[]; onNote?: (t: NoteTarget) => void }) {
  if (!t)
    return (
      <div className="gh-row">
        <div className="gh-head">
          <span className="gh-toggle static">
            <span className="gh-caret" aria-hidden="true" />
            <span className="gh-sum">
              <span className="gh-title">
                <b>Ticket</b> <span className="muted">No issue linked</span>
              </span>
            </span>
          </span>
        </div>
      </div>
    );
  const issue = state.issues.find((i) => sameTicket(i, t));
  const url = issue?.url ?? ticketUrl(t.repo, t.number);
  const status = sessionStatus(s, state.prStage[s.key], attentionFor(s, state.proposals), state.manualStatus[s.key]);
  const step = taskStep(status.key, state.prStage[s.key], !!status.manual);
  const tn = onNote && can("notesList") ? ticketNote(notes ?? [], t.repo, t.number) : null;
  return (
    <GhRow
      id="ticket"
      {...row}
      url={url}
      title={
        <>
          <b>Ticket</b> <span className="mono gh-ref">{ticketLabel(t.repo, t.number)}</span> {issue?.title ?? ""}
        </>
      }
      badges={
        <>
          <span className={`gh-badge tone-${step.tone}`} title={STEPS.map((n, i) => `${i < step.at ? "✓" : i === step.at ? "▶" : "·"} ${n}`).join("\n")}>
            {step.at + 1}/5 {STEPS[step.at]}
          </span>
          {issue?.status && <Badge tone="info">{issue.status}</Badge>}
        </>
      }
    >
      <div className={`d-steps tone-${step.tone}`}>
        {STEPS.map((n, i) => (
          <i key={n} className={i < step.at || (i === step.at && step.tone === "done") ? "past" : i === step.at ? "here" : ""} />
        ))}
      </div>
      <div className={`d-stepname tone-${step.tone}`}>
        {step.at + 1}/5 {STEPS[step.at]}
        {step.note ? <span className="muted"> · {step.note}</span> : null}
      </div>
      {onNote && can("notesList") && (
        <div className="d-note">
          {tn && <div className="d-note-text">{tn.preview}</div>}
          <button className="d-link" onClick={() => onNote({ ticket: t })}>
            {tn ? "Edit note" : "Add note"}
          </button>
        </div>
      )}
      <SubIssuesRow ticket={t} state={state} {...row} />
    </GhRow>
  );
}

/** Mounted only while the ticket is open: the sub-issues are read then. */
function SubIssuesRow({ ticket, state, ...row }: RowProps & { ticket: Ticket; state: AppState }) {
  const { subs, error } = useSubIssues(ticket);
  const rows = subIssueRows(subs ?? [], [...(state.repoView?.cards ?? []), ...(state.board?.cards ?? [])]);
  return (
    <GhRow
      id="ticket/subs"
      {...row}
      title="Sub-issues"
      badges={
        subs === null ? (
          <Badge tone="off">…</Badge>
        ) : error ? (
          <Badge tone="bad">not read</Badge>
        ) : rows.length ? (
          <Badge tone={rows.every((r) => r.done) ? "done" : "info"}>{subIssueProgress(rows)}</Badge>
        ) : (
          <Badge tone="off">none</Badge>
        )
      }
    >
      {subs === null && <Empty>Reading from GitHub…</Empty>}
      {error && <Empty>Could not read the sub-issues: {error}</Empty>}
      {subs !== null && !error && !rows.length && <Empty>No sub-issues.</Empty>}
      {rows.map((r) => (
        <div key={`${r.repo ?? ""}#${r.number}`} className={`gh-item${r.done ? " done" : ""}`}>
          <div className="gh-item-main">
            <div className="gh-item-lead">
              <span className="mono gh-ref">{ticketLabel(r.repo, r.number)}</span> <span className="gh-sub-title">{r.title}</span>
            </div>
          </div>
          <Badge tone={r.done ? "done" : "off"}>{r.status}</Badge>
          <OutLink url={r.url || ticketUrl(r.repo, r.number)} />
        </div>
      ))}
    </GhRow>
  );
}

/** One PR's line as prLive and the snapshot give it. */
export function prLineOf(url: string, state: AppState): PrStatusLine & { prState: string | null } {
  const live = state.prLive[url];
  const snap = state.prs.find((p) => p.url === url);
  const ci =
    live?.ci ??
    (snap?.ci === "success" ? "success" : snap?.ci === "failure" || snap?.ci === "error" ? "failure" : snap?.ci ? "pending" : null);
  const prState = live?.state ?? null;
  return {
    done: prState === "MERGED" || prState === "CLOSED",
    ci,
    threads: snap?.unresolvedThreads ?? 0,
    review: live?.reviewDecision ?? null,
    prState,
  };
}

function PrBadges({ line }: { line: ReturnType<typeof prLineOf> }) {
  const { done, ci, threads, review, prState } = line;
  return (
    <>
      {!done && ci === "success" && <Badge tone="ok">CI passed</Badge>}
      {!done && ci === "failure" && <Badge tone="bad">CI failing</Badge>}
      {!done && ci === "pending" && <Badge tone="wait">CI running</Badge>}
      {!done && threads > 0 && (
        <Badge tone="wait">
          {threads} thread{threads === 1 ? "" : "s"}
        </Badge>
      )}
      {!done && review === "APPROVED" && <Badge tone="ok">approved</Badge>}
      {!done && review === "CHANGES_REQUESTED" && <Badge tone="bad">changes</Badge>}
      {prState === "MERGED" && <Badge tone="done">merged</Badge>}
      {prState === "CLOSED" && <Badge tone="off">closed</Badge>}
    </>
  );
}

const WORST: Record<Exclude<PrWorst, null>, [Tone, string]> = {
  "ci-failing": ["bad", "CI failing"],
  changes: ["bad", "changes asked"],
  threads: ["wait", "open threads"],
  "ci-running": ["wait", "CI running"],
  ok: ["ok", "all good"],
  done: ["done", "all ended"],
};

function PrsRow({ urls, state, watches, now, ...row }: RowProps & { urls: string[]; state: AppState; watches: WatchInfo[]; now: number }) {
  const lines = urls.map((u) => prLineOf(u, state));
  const worst = worstPrStatus(lines);
  return (
    <GhRow
      id="prs"
      {...row}
      title={<b>Pull requests</b>}
      badges={
        <>
          <Badge tone={urls.length ? "info" : "off"}>{urls.length}</Badge>
          {worst && <Badge tone={WORST[worst][0]}>{WORST[worst][1]}</Badge>}
        </>
      }
    >
      {!urls.length && <Empty>No PR yet.</Empty>}
      {urls.map((u, i) => (
        <PrRow key={u} url={u} line={lines[i]} state={state} watch={watches.find((w) => w.id === `pr:${u}`)} now={now} {...row} />
      ))}
    </GhRow>
  );
}

function PrRow({
  url,
  line,
  state,
  watch,
  now,
  ...row
}: RowProps & { url: string; line: ReturnType<typeof prLineOf>; state: AppState; watch?: WatchInfo; now: number }) {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  const title = state.prLive[url]?.title ?? state.prs.find((p) => p.url === url)?.title ?? "";
  return (
    <GhRow
      id={`pr:${url}`}
      {...row}
      url={url}
      title={
        <>
          <span className={`mono gh-ref${line.done ? " muted" : ""}`}>{m ? `${m[1]}#${m[2]}` : url}</span> {title}
        </>
      }
      badges={<PrBadges line={line} />}
    >
      <PrDetailRows url={url} state={state} watch={watch} now={now} {...row} />
    </GhRow>
  );
}

/** A PR's detail, read when its row opens, again when its live state changes and each minute. */
function usePrDetail(url: string, changed: string): { detail: PrDetail | null; error: string | null } {
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let alive = true;
    // The last answer stays on screen while this one is read.
    Promise.resolve(deck().prDetail(url)).then(
      (r) => {
        if (!alive) return;
        if (r.ok) {
          setDetail(r.detail);
          setError(null);
        } else setError(r.message);
      },
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [url, changed, tick]);
  return { detail, error };
}

const REVIEW: Record<string, [Tone, string]> = {
  APPROVED: ["ok", "approved"],
  CHANGES_REQUESTED: ["bad", "changes requested"],
  COMMENTED: ["off", "commented"],
  DISMISSED: ["off", "dismissed"],
};
const CHECK_TONE: Record<string, Tone> = { success: "ok", failure: "bad", pending: "wait", neutral: "off" };

function PrDetailRows({ url, state, watch, now, ...row }: RowProps & { url: string; state: AppState; watch?: WatchInfo; now: number }) {
  const { detail, error } = usePrDetail(url, JSON.stringify(state.prLive[url] ?? null));
  const id = (k: string) => `pr:${url}/${k}`;
  const head = !detail ? (
    <Empty>{error ? `Could not read the PR from GitHub: ${error}` : "Reading from GitHub…"}</Empty>
  ) : error ? (
    <Empty>Showing the last read; the newest failed: {error}</Empty>
  ) : null;
  const n = detail ? checkCounts(detail.checks) : null;
  const decided = detail?.reviews.filter((r) => r.state !== "COMMENTED") ?? [];
  return (
    <>
      {head}
      {detail && n && (
        <>
          <GhRow
            id={id("checks")}
            {...row}
            url={`${url}/checks`}
            title="Checks"
            badges={
              detail.checks.length ? (
                <>
                  {n.failed > 0 && <Badge tone="bad">{n.failed} failed</Badge>}
                  {n.pending > 0 && <Badge tone="wait">{n.pending} running</Badge>}
                  {n.passed > 0 && <Badge tone="ok">{n.passed} passed</Badge>}
                </>
              ) : (
                <Badge tone="off">none</Badge>
              )
            }
          >
            {!detail.checks.length && <Empty>No checks on the latest commit.</Empty>}
            {detail.checks.map((c, i) => (
              <GhItem key={`${c.name}-${i}`} lead={c.name} url={c.url} now={now} tone={CHECK_TONE[c.state]} text={c.state === "neutral" ? "skipped or neutral" : c.state === "pending" ? "running" : c.state === "failure" ? "failed" : "passed"} />
            ))}
          </GhRow>
          <GhRow
            id={id("reviews")}
            {...row}
            url={url}
            title="Reviews"
            badges={
              detail.reviews.length ? (
                <>
                  {decided.map((r) => (
                    <Badge key={r.author} tone={(REVIEW[r.state] ?? ["off"])[0]} title={`${r.author}: ${(REVIEW[r.state] ?? ["", r.state])[1]}`}>
                      {r.author}
                    </Badge>
                  ))}
                  <Badge tone="off">{detail.reviews.length}</Badge>
                </>
              ) : (
                <Badge tone="off">none</Badge>
              )
            }
          >
            {!detail.reviews.length && <Empty>No reviews yet.</Empty>}
            {detail.reviews.map((r) => (
              <GhItem key={r.author} lead={<b>{r.author}</b>} text={(REVIEW[r.state] ?? ["", r.state.toLowerCase()])[1]} at={r.at} url={r.url} now={now} tone={(REVIEW[r.state] ?? ["off"])[0]} />
            ))}
          </GhRow>
          <GhRow
            id={id("threads")}
            {...row}
            url={`${url}/files`}
            title="Open threads"
            badges={<Badge tone={detail.threads.length ? "wait" : "off"}>{detail.threads.length}</Badge>}
          >
            {!detail.threads.length && <Empty>No unresolved threads.</Empty>}
            {detail.threads.map((th, i) => (
              <GhItem
                key={i}
                lead={
                  <>
                    <span className="mono gh-path">{th.path}</span> <span className="muted">· {th.author}</span>
                  </>
                }
                text={th.text}
                url={th.url}
                now={now}
              />
            ))}
          </GhRow>
          <GhRow id={id("comments")} {...row} url={url} title="Comments" badges={<Badge tone="off">{detail.comments.length}</Badge>}>
            {!detail.comments.length && <Empty>No comments.</Empty>}
            {detail.comments.map((c, i) => (
              <GhItem key={i} lead={<b>{c.author}</b>} text={c.text} at={c.at} url={c.url} now={now} />
            ))}
          </GhRow>
        </>
      )}
      {watch && <WatchRow watch={watch} title="PR watch" now={now} {...row} />}
    </>
  );
}

function MonitorsRow({ monitors, now, ...row }: RowProps & { monitors: WatchInfo[]; now: number }) {
  const last = Math.max(0, ...monitors.map((w) => w.lastEventAt ?? 0));
  return (
    <GhRow
      id="monitors"
      {...row}
      title={
        <>
          <span className="mon-dot gh-mon-dot" aria-hidden="true" />
          <b>Monitors</b>
        </>
      }
      badges={
        <>
          <Badge tone="info">{monitors.length}</Badge>
          {last > 0 && <Badge tone="off">last event {formatAgo(now - last)} ago</Badge>}
        </>
      }
    >
      {monitors.map((w) => (
        <WatchRow key={w.id} watch={w} title={w.description} now={now} {...row} />
      ))}
    </GhRow>
  );
}

/** A monitor or a PR watch: its counts, Stop, and its events newest first when open. */
function WatchRow({ watch: w, title, now, ...row }: RowProps & { watch: WatchInfo; title: string; now: number }) {
  return (
    <GhRow
      id={`watch:${w.id}`}
      {...row}
      title={<span title={w.command}>{title}</span>}
      badges={
        <>
          <Badge tone={w.events ? "info" : "off"}>
            {w.events} event{w.events === 1 ? "" : "s"}
          </Badge>
          {w.queued > 0 && (
            <Badge tone="wait" title="Waiting for the session's turn to end">
              {w.queued} waiting
            </Badge>
          )}
          {w.lastEventAt && <Badge tone="off">{formatAgo(now - w.lastEventAt)} ago</Badge>}
        </>
      }
      actions={
        <button className="link-btn gh-stop" onClick={() => void deck().watchStop(w.id)} title="Stop it (the session is told)">
          Stop
        </button>
      }
    >
      <div className="gh-meta muted">
        On for {formatAgo(now - w.startedAt)} · runs in MasterDeck, with no time limit
      </div>
      <WatchEvents watch={w} now={now} />
    </GhRow>
  );
}

const KIND: Record<string, string> = {
  thread: "review thread",
  comment: "comment",
  review: "review",
  conflict: "conflict",
  stall: "review stalled",
  merged: "merged",
  closed: "closed",
  note: "MasterDeck",
};

/** A watch's events, read when it opens and again when its count or last event changes. */
function WatchEvents({ watch: w, now }: { watch: WatchInfo; now: number }) {
  const [events, setEvents] = useState<WatchEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve(deck().watchEvents(w.id)).then(
      (r) => alive && setEvents(Array.isArray(r) ? r : []),
      () => alive && setEvents([]),
    );
    return () => {
      alive = false;
    };
  }, [w.id, w.events, w.lastEventAt, w.queued]);
  if (events === null) return <Empty>Reading…</Empty>;
  return (
    <div className="gh-events">
      {!events.length && <Empty>{w.events ? "Its earlier events were before MasterDeck started." : "No events yet."}</Empty>}
      {events.map((e, i) => (
        <GhItem
          key={`${e.at}-${i}`}
          lead={
            e.kind ? (
              <>
                <b>{KIND[e.kind] ?? e.kind}</b>
                {e.by ? <span className="muted"> · {e.by}</span> : null}
              </>
            ) : null
          }
          text={e.text}
          at={e.at}
          now={now}
        />
      ))}
      {events.length > 0 && events.length < w.events && (
        <Empty>
          The last {events.length} of {w.events}; earlier ones are not kept.
        </Empty>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { applyBtwEvent, BTW_QUESTION_MAX, type BtwEntry, type BtwEvent } from "@shared/btw";
import { formatAgo } from "@shared/format";
import type { Session } from "@shared/types";
import { deck, useNow } from "../deck";
import { can } from "../web";
import { MarkdownView } from "./MarkdownView";

/** What was typed and not sent, per session, so switching tabs or sessions keeps it. */
const drafts = new Map<string, string>();

/** A session's side questions, oldest first, kept current by the btw events. */
function useBtw(key: string): { list: BtwEntry[]; loaded: boolean } {
  const [list, setList] = useState<BtwEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!can("btwList")) return;
    let live = true;
    setList([]);
    setLoaded(false);
    // Events that land while the first read is on its way are applied on top of it.
    let early: BtwEvent[] | null = [];
    const off = deck().onBtwEvent((ev) => {
      if (ev.key !== key) return;
      if (early) early.push(ev);
      else setList((l) => applyBtwEvent(l, ev));
    });
    void deck()
      .btwList(key)
      .then((l) => {
        if (!live) return;
        setList((early ?? []).reduce(applyBtwEvent, l));
        early = null;
        setLoaded(true);
      })
      .catch(() => {
        early = null;
        setLoaded(true);
      });
    return () => {
      live = false;
      off();
    };
  }, [key]);
  return { list, loaded };
}

function exact(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The right panel's Tools → BTW: side questions about the session, as Claude Code's `/btw` asks them
 * (answered from the conversation, no tools, nothing added to it, the running work untouched), and
 * every earlier one, newest first, also those typed as `/btw` in the session's terminal.
 */
export function SessionBtw({ session: s, onMessage }: { session: Session; onMessage: (text: string) => void }) {
  const now = useNow(30_000);
  const { list, loaded } = useBtw(s.key);
  const [text, setText] = useState(() => drafts.get(s.key) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText(drafts.get(s.key) ?? "");
    setError(null);
  }, [s.key]);
  const asking = list.find((e) => e.status === "asking" && e.source === "panel");
  const edit = (v: string) => {
    setText(v);
    if (v) drafts.set(s.key, v);
    else drafts.delete(s.key);
  };

  const ask = async (question: string) => {
    if (!question.trim() || sending || asking) return;
    setSending(true);
    setError(null);
    try {
      const r = await deck().btwAsk(s.key, question);
      if (r.ok) {
        if (question === text) edit("");
      } else setError(r.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };
  const copy = (t: string) => {
    deck().copy(t);
    onMessage("Copied the answer");
  };
  const askHere = (q: string) => {
    edit(q);
    box.current?.focus();
  };
  const remove = async (id: string) => {
    if (!(await deck().btwRemove(s.key, id))) onMessage("Could not remove it");
  };

  const newest = [...list].reverse();
  return (
    <>
      <section className="dsec btw-ask">
        <div className="eyebrow">Side question</div>
        <div className="d-text muted">
          Ask about this session without interrupting it, as <span className="mono">/btw</span> does. The answer comes
          from the conversation so far and is not added to it.
        </div>
        <textarea
          ref={box}
          className="btw-input"
          rows={3}
          maxLength={BTW_QUESTION_MAX}
          value={text}
          placeholder="Ask a side question…"
          aria-label="Side question"
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask(text);
            }
          }}
        />
        <div className="btw-bar">
          <span className="muted">Enter to send · Shift+Enter for a new line</span>
          {asking ? (
            <button className="btn" onClick={() => void deck().btwStop(s.key, asking.id)}>
              Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!text.trim() || sending} onClick={() => void ask(text)}>
              Ask
            </button>
          )}
        </div>
        {error && (
          <div className="btw-error" role="alert">
            {error}
          </div>
        )}
      </section>
      <section className="dsec">
        <div className="eyebrow">History{list.length ? ` · ${list.length}` : ""}</div>
        {loaded && !list.length && (
          <div className="d-text muted">
            No side questions yet. Ask one above, or type <span className="mono">/btw</span> in the session's terminal:
            it shows here too.
          </div>
        )}
        {newest.map((e) => (
          <BtwItem
            key={e.id}
            e={e}
            now={now}
            busy={!!asking}
            onCopy={copy}
            onAgain={() => void ask(e.question)}
            onAskHere={() => askHere(e.question)}
            onRemove={() => void remove(e.id)}
            onStop={() => void deck().btwStop(s.key, e.id)}
          />
        ))}
      </section>
    </>
  );
}

function BtwItem({
  e,
  now,
  busy,
  onCopy,
  onAgain,
  onAskHere,
  onRemove,
  onStop,
}: {
  e: BtwEntry;
  now: number;
  busy: boolean;
  onCopy: (t: string) => void;
  onAgain: () => void;
  onAskHere: () => void;
  onRemove: () => void;
  onStop: () => void;
}) {
  const terminal = e.source === "terminal";
  const unread = terminal && e.status === "done" && e.captured === false;
  return (
    <article className={`btw-item st-${e.status}`} aria-busy={e.status === "asking"}>
      <div className="btw-q">{e.question}</div>
      <div className="btw-meta muted">
        <time dateTime={new Date(e.at).toISOString()} title={exact(e.at)}>
          {formatAgo(Math.max(0, now - e.at))} ago
        </time>
        {terminal && <span className="btw-tag" title="Typed as /btw in the session's terminal">terminal</span>}
        {e.costUsd !== undefined && <span title="What this answer cost">${e.costUsd.toFixed(e.costUsd < 0.01 ? 4 : 2)}</span>}
      </div>
      {e.status === "asking" && !e.answer && (
        <div className="btw-loading">
          <span className="btw-spin" aria-hidden />
          {terminal ? "Reading the answer from the terminal…" : "Answering…"}
        </div>
      )}
      {e.answer && <MarkdownView text={e.answer} html={false} className="btw-answer" />}
      {e.status === "error" && (
        <div className="btw-error" role="alert">
          Could not answer: {e.error ?? "unknown error"}
        </div>
      )}
      {e.status === "stopped" && <div className="d-text muted">Stopped{e.answer ? " before the answer was complete" : ""}.</div>}
      {unread && <div className="d-text muted">Answered in the terminal. MasterDeck could not read that answer.</div>}
      {terminal && e.partial && <div className="d-text muted">Only what fit in the terminal's box was read.</div>}
      <div className="btw-actions">
        {e.status === "asking" && !terminal && (
          <button className="btn" onClick={onStop}>
            Stop
          </button>
        )}
        {e.answer && e.status !== "asking" && (
          <button className="btn" onClick={() => onCopy(e.answer)} title="Copy the answer (Markdown)">
            Copy
          </button>
        )}
        {(e.status === "error" || e.status === "stopped") && !terminal && (
          <button className="btn" disabled={busy} onClick={onAgain}>
            Try again
          </button>
        )}
        {(unread || (terminal && e.partial)) && (
          <button className="btn" onClick={onAskHere} title="Put the question in the box above, to ask it from here">
            Ask here
          </button>
        )}
        {e.status !== "asking" && (
          <button className="btn subtle" onClick={onRemove} title="Remove it from this history">
            Remove
          </button>
        )}
      </div>
    </article>
  );
}

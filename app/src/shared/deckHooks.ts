/**
 * MasterDeck's own Claude Code hooks (main/deckHooks.ts writes the script and reads what it
 * leaves): permission requests to answer from MasterDeck, and events that tell exactly what a
 * session is doing: a notification (waiting on a permission, idle), an API error that stopped
 * it, a compaction, a change of folder. This file holds the pure parts.
 */
import type { AskQuestion, PermissionPrompt, ScreenMenu } from "./ask";

/** Events the hook is registered for. */
export const DECK_EVENTS = [
  "PermissionRequest",
  "Notification",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "CwdChanged",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
] as const;
export type DeckEvent = (typeof DECK_EVENTS)[number];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A permission a session is waiting on, as the hook left it in `pending/<id>.json`. */
export interface HookRequest {
  id: string;
  /** The hook process: gone means the request is over. */
  pid: number;
  at: number;
  sessionId: string;
  tool: string;
  input: Obj;
  /** The rules the terminal's "don't ask again" option would add. */
  suggestions: unknown[];
}

export function parseRequest(text: string): HookRequest | null {
  try {
    const r = obj(JSON.parse(text));
    const d = obj(r.data);
    const id = str(r.id);
    const sessionId = str(d.session_id);
    if (!/^[\w.-]{1,80}$/.test(id) || !sessionId || !str(d.tool_name))
      return null;
    return {
      id,
      pid: typeof r.pid === "number" ? r.pid : 0,
      at: typeof r.at === "number" ? r.at : 0,
      sessionId,
      tool: str(d.tool_name),
      input: obj(d.tool_input),
      suggestions: Array.isArray(d.permission_suggestions)
        ? d.permission_suggestions
        : [],
    };
  } catch {
    return null;
  }
}

/** "Bash(npm test)" style text for the rules a "don't ask again" answer adds. */
export function ruleText(suggestions: unknown[]): string | null {
  const out: string[] = [];
  for (const s of suggestions) {
    const o = obj(s);
    if (o.type === "setMode" && str(o.mode))
      out.push(`switch to ${str(o.mode)} mode`);
    for (const r of Array.isArray(o.rules) ? o.rules.map(obj) : []) {
      const tool = str(r.toolName);
      if (tool)
        out.push(r.ruleContent ? `${tool}(${str(r.ruleContent)})` : tool);
    }
  }
  return out.length ? out.join(", ") : null;
}

const TITLES: Record<string, string> = {
  Bash: "Bash command",
  Edit: "Edit file",
  MultiEdit: "Edit file",
  Write: "Write file",
  NotebookEdit: "Edit notebook",
  Read: "Read file",
  WebFetch: "Fetch",
  WebSearch: "Web search",
};

/** The request as the permission card shows it: what it wants, and Yes / Always / No. */
export function requestPrompt(r: HookRequest): PermissionPrompt {
  const i = r.input;
  const lines: string[] = [];
  if (str(i.command)) lines.push(str(i.command));
  if (str(i.file_path) || str(i.notebook_path))
    lines.push(str(i.file_path) || str(i.notebook_path));
  if (str(i.url)) lines.push(str(i.url));
  if (str(i.query)) lines.push(str(i.query));
  if (str(i.description)) lines.push(str(i.description));
  if (!lines.length) {
    const json = JSON.stringify(i);
    if (json && json !== "{}")
      lines.push(json.length > 600 ? `${json.slice(0, 600)}…` : json);
  }
  const rule = ruleText(r.suggestions);
  return {
    title: TITLES[r.tool] ?? r.tool,
    lines,
    reason: null,
    question: "Do you want to proceed?",
    options: [
      "Yes",
      ...(rule ? [`Yes, and don't ask again: ${rule}`] : []),
      "No",
    ],
    requestId: r.id,
  };
}

/**
 * The hook's answer for option `n` of `requestPrompt(r).options`: allow, allow and keep the
 * suggested rules, or deny (with the user's note, which Claude sees).
 */
export function decisionFor(
  r: HookRequest,
  n: number,
  note?: string,
): object | null {
  const options = requestPrompt(r).options;
  if (!Number.isInteger(n) || n < 0 || n >= options.length) return null;
  const out = (decision: object) => ({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  });
  if (n === options.length - 1)
    return out({
      behavior: "deny",
      message: note?.trim() || "Denied from MasterDeck.",
    });
  if (n === 1 && options.length === 3)
    return out({ behavior: "allow", updatedPermissions: r.suggestions });
  return out({ behavior: "allow" });
}

/**
 * Whether a pending request is over although the hook still waits (answered in the terminal: the
 * hook is not stopped then). Its session showed a prompt since the request, and shows none now;
 * or it never did and the request is well past the time `claude agents` takes to notice.
 */
export function requestOver(
  r: HookRequest,
  now: number,
  blockedNow: boolean,
  seenBlocked: boolean,
  turnEndedAt: number | null,
): boolean {
  if (turnEndedAt !== null && turnEndedAt > r.at) return true;
  if (blockedNow) return false;
  return seenBlocked || now - r.at > 20_000;
}

/** What the hook's events say about one session. */
export interface HookSessionState {
  lastAt: number;
  /** The latest notification ("Claude needs your permission", idle…) and when. */
  notice: { type: string; message: string; at: number } | null;
  /** The API error that ended its last turn, until it works again. */
  failure: { type: string; message: string; at: number } | null;
  compacting: boolean;
  compactedAt: number | null;
  cwd: string | null;
  /** When its last turn ended (Stop). */
  stoppedAt: number | null;
}

export const emptyHookState = (): HookSessionState => ({
  lastAt: 0,
  notice: null,
  failure: null,
  compacting: false,
  compactedAt: null,
  cwd: null,
  stoppedAt: null,
});

/** One line of `events.jsonl`: `{"at": ms, "event": name, "data": the hook's input}`. */
export function applyEventLine(
  states: Record<string, HookSessionState>,
  line: string,
): string | null {
  let e: Obj;
  try {
    e = obj(JSON.parse(line));
  } catch {
    return null;
  }
  const d = obj(e.data);
  const sid = str(d.session_id);
  const at = typeof e.at === "number" ? e.at : Date.now();
  if (!sid) return null;
  const s = (states[sid] ??= emptyHookState());
  s.lastAt = Math.max(s.lastAt, at);
  switch (str(e.event)) {
    case "Notification":
      s.notice = {
        type: str(d.notification_type),
        message: str(d.message),
        at,
      };
      break;
    case "StopFailure":
      s.failure = {
        type: str(d.error_type) || "error",
        message:
          str(d.error_message) || str(d.error) || "the API returned an error",
        at,
      };
      s.stoppedAt = at;
      break;
    case "PreCompact":
      s.compacting = true;
      break;
    case "PostCompact":
      s.compacting = false;
      s.compactedAt = at;
      break;
    case "CwdChanged":
      if (str(d.cwd)) s.cwd = str(d.cwd);
      break;
    case "SessionStart":
      if (str(d.cwd)) s.cwd = str(d.cwd);
      if (str(d.source) === "compact") {
        s.compacting = false;
        s.compactedAt = at;
      }
      break;
    case "Stop":
      s.stoppedAt = at;
      // A turn that ends normally means the error (if any) is behind it.
      s.failure = null;
      s.compacting = false;
      break;
    default:
      return null;
  }
  return sid;
}

/**
 * What a session is told at SessionStart (resume, compaction, /clear): its ticket and what earlier
 * sessions on it did, from their saved summaries. The hook prints this JSON as it is.
 */
export function ticketContext(
  ticket: { label: string; title: string | null; url: string | null },
  earlier: { name: string; at: number; text: string }[],
): object {
  const parts = [
    `This session works on ${ticket.label}${ticket.title ? ` (${ticket.title})` : ""}.${ticket.url ? ` ${ticket.url}` : ""}`,
  ];
  if (earlier.length) {
    parts.push(
      "Earlier sessions on this ticket, newest first (from their summaries):",
    );
    for (const e of earlier.slice(0, 3))
      parts.push(
        `### ${e.name} (${new Date(e.at).toISOString().slice(0, 10)})\n${clip(e.text, 2500)}`,
      );
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: parts.join("\n\n"),
    },
  };
}

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/**
 * Claude Code sends AskUserQuestion through the permission hook. Its questions, when the request is
 * one (null otherwise): they are shown as questions, not as "run this tool?".
 */
export function requestQuestions(r: HookRequest): AskQuestion[] | null {
  if (r.tool !== "AskUserQuestion" || !Array.isArray(r.input.questions))
    return null;
  const qs = r.input.questions.map(obj).map((q) => ({
    question: str(q.question),
    header: str(q.header),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options.map(obj) : [])
      .map((o) => ({ label: str(o.label), description: str(o.description) }))
      .filter((o) => o.label),
  }));
  return qs.length && qs.every((q) => q.question) ? qs : null;
}

/** The menu a held request shows: its questions, or a permission. */
export function requestMenu(r: HookRequest): ScreenMenu {
  const questions = requestQuestions(r);
  if (questions)
    return {
      tabs: questions.map((q) => ({
        label: q.header || q.question,
        answered: false,
      })),
      question: null,
      checked: [],
      review: null,
      asked: { requestId: r.id, questions },
    };
  return {
    tabs: [],
    question: null,
    checked: [],
    review: null,
    permission: requestPrompt(r),
  };
}

/**
 * The hook's answer to an AskUserQuestion: allow it with the answers (by question text; a
 * multi-select's labels joined with ", "), which Claude Code hands the session as the user's.
 */
export function answersDecision(
  r: HookRequest,
  answers: Record<string, string>,
): object | null {
  const questions = requestQuestions(r);
  if (!questions) return null;
  const clean: Record<string, string> = {};
  for (const q of questions) {
    const a = answers[q.question]?.trim();
    if (!a) return null;
    clean[q.question] = a.slice(0, 2000);
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: { ...r.input, answers: clean },
      },
    },
  };
}

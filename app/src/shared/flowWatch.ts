/**
 * The workflow triggers MasterDeck runs itself: "needs you" (a session waits on a prompt, a
 * permission or a question) and "idle for N minutes". Each fires once per spell: it can fire
 * again after the session did something else.
 */
import type { CompiledStep } from "./flow";
import type { StatusKey } from "./review";

export type WatchGroup = "needs" | "idle" | "other";

export interface WatchState {
  group: WatchGroup;
  since: number;
  /** Steps already run in this spell. */
  fired: string[];
}

export interface WatchAction {
  key: string;
  step: string;
  notify: string[];
  /** Idle: the message to send the session. */
  message: string | null;
}

export const groupOf = (k: StatusKey): WatchGroup =>
  k === "needs-input" || k === "question"
    ? "needs"
    : k === "idle"
      ? "idle"
      : "other";

export function flowActions(
  prev: Record<string, WatchState>,
  sessions: { key: string; status: StatusKey }[],
  stepsFor: (key: string) => CompiledStep[],
  now: number,
): { next: Record<string, WatchState>; actions: WatchAction[] } {
  const next: Record<string, WatchState> = {};
  const actions: WatchAction[] = [];
  for (const s of sessions) {
    const group = groupOf(s.status);
    const p = prev[s.key];
    const st: WatchState =
      p && p.group === group
        ? { ...p, fired: [...p.fired] }
        : { group, since: now, fired: [] };
    next[s.key] = st;
    if (group === "other") continue;
    for (const step of stepsFor(s.key)) {
      if (st.fired.includes(step.id)) continue;
      const due =
        (group === "needs" && step.trigger === "needs-you") ||
        (group === "idle" &&
          step.trigger === "idle" &&
          now - st.since >= (step.minutes ?? 15) * 60_000);
      if (!due) continue;
      st.fired.push(step.id);
      actions.push({
        key: s.key,
        step: step.id,
        notify: step.notify ?? [],
        message: step.trigger === "idle" && step.note.trim() ? step.note : null,
      });
    }
  }
  return { next, actions };
}

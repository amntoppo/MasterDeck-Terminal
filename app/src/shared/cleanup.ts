/**
 * Cleanup (the Sessions column): pick sessions and stop them in one go. Stopping keeps each
 * conversation, so it can be resumed later from its ticket on the Board.
 */
import type { PrStage } from "./review";
import type { Session } from "./types";

/** A session MasterDeck can stop: a background one (by id) or a claude process in another terminal. */
export const canStop = (s: Session): boolean =>
  s.state !== "done" &&
  s.state !== "suspended" &&
  ((s.kind === "background" && !!s.bgId) || s.pid !== null);

/** What Cleanup selects to begin with: the stoppable sessions whose PRs are merged. */
export function cleanupDefaults(
  sessions: Session[],
  prStage: Record<string, PrStage | undefined>,
): Set<string> {
  return new Set(
    sessions
      .filter((s) => canStop(s) && prStage[s.key]?.kind === "merged")
      .map((s) => s.key),
  );
}

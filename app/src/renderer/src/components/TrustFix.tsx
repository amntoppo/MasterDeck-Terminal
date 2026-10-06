import { useCallback, useEffect, useRef, useState } from "react";
import type { CliResult } from "@shared/types";
import { trustView, waitForTrust, type Trusted } from "@shared/trust";
import { deck } from "../deck";
import { can } from "../web";

export interface TrustState {
  folder: string | null;
  trusted: Trusted;
  /** Open Claude there… was pressed here and it is still being waited for. */
  opened: boolean;
  /** The tab could not be opened. */
  error: string | null;
  /** The desktop window: a tab can open. A browser or a phone says to do it on the Mac. */
  desktop: boolean;
  open: () => void;
}

/**
 * Whether Claude Code may work in a folder, for the Start dialog, a start that failed and a held
 * Needs-you item. `known`: what the draft said (true, false, or null for not known); undefined asks
 * the master CLI once. After **Open Claude there…** it looks again by itself (`waitForTrust`) until
 * the folder is trusted, the caller goes away, or ten minutes passed. `opener`: how the tab is
 * opened (a Needs-you item acts through the inbox). A trusted folder costs nothing here.
 */
export function useTrust(
  folder: string | null,
  known: Trusted,
  opener?: () => Promise<CliResult>,
): TrustState {
  const desktop = can("openClaudeIn");
  const [got, setGot] = useState<{ folder: string | null; trusted: Trusted }>({ folder: null, trusted: undefined });
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Another folder (Choose folder…): what was found out about the old one is gone.
  const trusted = got.folder === folder ? (got.trusted ?? known) : known;
  useEffect(() => {
    setOpened(false);
    setError(null);
  }, [folder]);
  useEffect(() => {
    if (!folder || known !== undefined || !can("trust")) return;
    let alive = true;
    void deck()
      .trust(folder)
      .then((t) => alive && setGot({ folder, trusted: t }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [folder, known]);
  useEffect(() => {
    if (!folder || !opened || trusted === true) return;
    let alive = true;
    void waitForTrust((s) => deck().trust(folder, s), { alive: () => alive }).then((ok) => {
      if (!alive) return;
      if (ok) setGot({ folder, trusted: true });
      else setOpened(false);
    });
    return () => {
      alive = false;
    };
    // `trusted` turning true ends the wait through `alive`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, opened]);
  const run = useRef(opener);
  run.current = opener;
  const open = useCallback(() => {
    if (!folder) return;
    setError(null);
    void (run.current ? run.current() : deck().openClaudeIn(folder)).then((r) => {
      if (r.ok) setOpened(true);
      else setError(r.message);
    });
  }, [folder]);
  return { folder, trusted, opened, error, desktop, open };
}

/**
 * "Claude Code has not been allowed to work in <folder> yet." with **Open Claude there…**: a tab
 * running `claude` in that folder, where the user answers Claude Code's own prompt. MasterDeck never
 * answers it. Once the folder is trusted: that it can start, and that the tab can be closed.
 */
export function TrustNote({ trust }: { trust: TrustState }) {
  const v = trustView(trust.folder, trust);
  return (
    <div className={`trust-note ${v.step}`} role="status">
      <span>
        <span className="why">{v.line}</span>
        {v.hint && <> {v.hint}</>}
        {trust.error && <span className="error"> {trust.error}</span>}
      </span>
      {v.open && (
        <button className="btn" onClick={trust.open}>
          Open Claude there…
        </button>
      )}
    </div>
  );
}

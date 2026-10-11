import { modsStale, MOD_VERSION, type ModSeen } from "./modBand";
import type { Session } from "./types";

/**
 * MasterDeck installing its own Claude Code mods (mods/, issue #93): what "installed" means in
 * Claude Code's user settings, the Claude Code version they need, where `prependPlugins` is not
 * honoured, and which running sessions still run older mods. The side that runs `claude plugin` and
 * copies the folder is main/mods.ts.
 */

/** The local-folder marketplace's name (mods/.claude-plugin/marketplace.json). */
export const MODS_MARKETPLACE = "masterdeck";
/** The core mod: it must load first (`prependPlugins`) to switch the others per session. */
export const MODS_CORE = `masterdeck@${MODS_MARKETPLACE}`;
/** Mods (the plugin API MasterDeck's use) need this Claude Code or later. */
export const MODS_MIN_CLAUDE = "2.1.287";

export interface ModsStatus {
  /** installed: the marketplace, every mod and `prependPlugins`; partial: some of it; off: none. */
  state: "installed" | "partial" | "off";
  /** What is missing while partial: "marketplace", a mod's name, "prependPlugins". */
  missing: string[];
  /** Claude Code's version on this Mac; null: not found (yet). */
  claude: string | null;
  /** The mods' version in MasterDeck's folder (the core's plugin.json); null: not copied yet. */
  version: string | null;
  /** Why Claude Code may ignore `prependPlugins` here; null: nothing known. */
  prependNote: string | null;
  /** Why this app cannot install mods at all (an isolated test app, no bundled mods); null: it can. */
  unavailable: string | null;
}

export const MODS_OFF: ModsStatus = {
  state: "off",
  missing: [],
  claude: null,
  version: null,
  prependNote: null,
  unavailable: null,
};

/** "2.1.296 (Claude Code)" → "2.1.296"; null when there is no version in it. */
export function parseClaudeVersion(out: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(out)?.[0] ?? null;
}

/** a >= b, comparing dotted numbers. */
export function versionAtLeast(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/** Why mods cannot be installed with this Claude Code, or null when they can. */
export function claudeRefusal(version: string | null): string | null {
  if (!version) return "Claude Code was not found on this Mac.";
  if (!versionAtLeast(version, MODS_MIN_CLAUDE))
    return `Mods need Claude Code ${MODS_MIN_CLAUDE} or later; this Mac has ${version}. Update Claude Code (claude update), then try again.`;
  return null;
}

type Settings = Record<string, unknown>;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Folders compared as written by `claude plugin marketplace add` (no trailing separator). */
const samePath = (a: unknown, b: string): boolean =>
  typeof a === "string" && a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

/**
 * What of the mods Claude Code's user settings have: the marketplace pointing at MasterDeck's folder,
 * each mod on, and the core first in `prependPlugins`.
 */
export function modsInSettings(
  s: Settings,
  folder: string,
  names: readonly string[],
): Pick<ModsStatus, "state" | "missing"> {
  const src = obj(obj(obj(s.extraKnownMarketplaces)[MODS_MARKETPLACE]).source);
  const parts: [string, boolean][] = [
    ["marketplace", src.source === "directory" && samePath(src.path, folder)],
    ...names.map((n): [string, boolean] => [n, obj(s.enabledPlugins)[`${n}@${MODS_MARKETPLACE}`] === true]),
    ["prependPlugins", Array.isArray(s.prependPlugins) && s.prependPlugins.includes(MODS_CORE)],
  ];
  const missing = parts.filter(([, ok]) => !ok).map(([n]) => n);
  return {
    state: missing.length === 0 ? "installed" : missing.length === parts.length ? "off" : "partial",
    missing,
  };
}

/** The settings with the core first in `prependPlugins` (on) or out of it (off, and the key gone
 * when empty); null when nothing changes. */
export function withPrepend(s: Settings, on: boolean): Settings | null {
  const was = Array.isArray(s.prependPlugins) ? (s.prependPlugins as unknown[]) : null;
  const rest = (was ?? []).filter((x) => x !== MODS_CORE);
  const next = on ? [MODS_CORE, ...rest] : rest;
  if (was && was.length === next.length && was.every((x, i) => x === next[i])) return null;
  if (!was && !next.length) return null;
  const out = { ...s };
  if (next.length) out.prependPlugins = next;
  else delete out.prependPlugins;
  return out;
}

/**
 * Where Claude Code ignores `prependPlugins` in the user's settings: under managed settings (unless
 * they list the core themselves) and when signed in with a Team or Enterprise plan. The mods still
 * load there, but the core may load after them and cannot switch them.
 */
export function prependNote(x: {
  managed: boolean;
  managedPrepends: boolean;
  subscription: string | null;
}): string | null {
  const after =
    "so MasterDeck's core mod may load after the other mods and cannot switch them per session. " +
    `Ask your admin to list ${MODS_CORE} in prependPlugins in the managed settings.`;
  if (x.managed && !x.managedPrepends)
    return `Your organization's managed settings are in place: Claude Code ignores prependPlugins in your own settings, ${after}`;
  if (!x.managed && /^(team|enterprise)$/i.test(x.subscription ?? ""))
    return `You are signed in to Claude Code with a Team or Enterprise plan: Claude Code ignores prependPlugins in your own settings, ${after}`;
  return null;
}

export interface ModsReloadOffer {
  /** Running sessions on older mods (or none, started before MasterDeck installed them). */
  keys: string[];
  /** Those of them waiting for the user at an empty prompt: a reload can be typed there now. */
  idle: string[];
}

/**
 * Running sessions that should reload their plugins: their core reports older mods than this app
 * ships (`modsStale`), or it does not run in them and they started before MasterDeck installed the
 * mods. Null when the mods are not installed or none is behind.
 */
export function modsReloadOffer(
  sessions: readonly Session[],
  beats: Readonly<Record<string, { version: string; mods: readonly ModSeen[] }>>,
  installed: boolean,
  installedAt: number | null,
): ModsReloadOffer | null {
  if (!installed) return null;
  const behind = sessions.filter((s) => {
    if (s.state === "done" || s.state === "suspended") return false;
    const b = beats[s.sessionId];
    return b ? modsStale(b) : installedAt !== null && s.startedAt < installedAt;
  });
  if (!behind.length) return null;
  return {
    keys: behind.map((s) => s.key),
    // Only an empty prompt: typed into a question or a permission, it would answer it.
    idle: behind.filter((s) => s.state === "idle" && !s.busyWith).map((s) => s.key),
  };
}

/** The Needs-you text for an offer. */
export function modsReloadText(o: ModsReloadOffer): string {
  const n = o.keys.length;
  const idle = o.idle.length;
  const head = `${n} running session${n === 1 ? "" : "s"} still use${n === 1 ? "s" : ""} MasterDeck's mods from before ${MOD_VERSION} (or none).`;
  const later = "when reloaded from Session details → Mods, or at the next start.";
  if (idle === n) return `${head} ${n === 1 ? "It is" : "All are"} idle: reload ${n === 1 ? "it" : "them"} now.`;
  if (idle === 0) return `${head} None is idle now: ${n === 1 ? "it takes" : "they take"} the new mods ${later}`;
  return `${head} ${idle} ${idle === 1 ? "is" : "are"} idle and can reload now; the others take the new mods ${later}`;
}

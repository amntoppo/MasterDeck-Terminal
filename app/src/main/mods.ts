import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CliResult } from "@shared/types";
import {
  claudeRefusal,
  MODS_MARKETPLACE,
  modsInSettings,
  parseClaudeVersion,
  prependNote,
  MODS_CORE,
  withPrepend,
  type ModsStatus,
} from "@shared/mods";
import { backupSettings, readSettings, writeSettings } from "./hooks";
import type { Runner } from "./run";

/**
 * MasterDeck's Claude Code mods (issue #93). The app ships `mods/` and keeps a copy in
 * `<home>/mods`, a local-folder marketplace that Claude Code reads in place: an app update rewrites
 * the folder and running sessions take it at `/reload-plugins`. Installing adds the marketplace and
 * each mod with the claude CLI (user scope) and puts the core first in `prependPlugins`;
 * uninstalling takes all three out. settings.json is backed up before the CLI touches it and again
 * before MasterDeck's own write (atomic, as for hooks).
 */

const MARKER = ".masterdeck-mods.json";

/** Not copied: tests, and what only the repository uses (the shared source the mods copy in). */
function skipped(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  const name = parts[parts.length - 1];
  return (
    name === ".DS_Store" ||
    name === MARKER ||
    parts.includes("node_modules") ||
    /\.test\.tsx?$/.test(name) ||
    (parts.length === 1 && (name === "shared" || name === "sync-shared.sh"))
  );
}

function files(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = relative(root, p);
    if (skipped(rel)) continue;
    if (statSync(p).isDirectory()) out.push(...files(p, root));
    else out.push(rel);
  }
  return out;
}

/** Content hash of a mods folder (paths and bytes of what is copied). */
export function hashMods(dir: string): string {
  const h = createHash("sha256");
  for (const f of files(dir)) {
    h.update(f.replaceAll("\\", "/"));
    h.update("\0");
    h.update(readFileSync(join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

const readJson = (p: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** The mods a marketplace folder lists, in its order. */
export function modNames(folder: string): string[] {
  const m = readJson(join(folder, ".claude-plugin", "marketplace.json"));
  const list = Array.isArray(m?.plugins) ? (m.plugins as { name?: unknown }[]) : [];
  return list.map((p) => p.name).filter((n): n is string => typeof n === "string" && /^[a-z0-9-]+$/.test(n));
}

/** The version of the mods in a folder (the core's plugin.json). */
export function modsVersion(folder: string): string | null {
  const v = readJson(join(folder, "masterdeck", ".claude-plugin", "plugin.json"))?.version;
  return typeof v === "string" ? v : null;
}

/**
 * Make `dest` the bundled mods: copied to `<dest>.new`, then swapped in, only when the content
 * differs from what the marker says was copied last. The folder is MasterDeck's own (a hand copy
 * there is replaced too).
 */
export function syncModsFolder(bundled: string, dest: string): { changed: boolean; error?: string } {
  try {
    if (!existsSync(join(bundled, ".claude-plugin", "marketplace.json")))
      return { changed: false, error: `no mods in ${bundled}` };
    const hash = hashMods(bundled);
    if (existsSync(dest) && readJson(join(dest, MARKER))?.hash === hash) return { changed: false };
    const next = `${dest}.new`;
    const old = `${dest}.old`;
    rmSync(next, { recursive: true, force: true });
    for (const f of files(bundled)) {
      mkdirSync(dirname(join(next, f)), { recursive: true });
      writeFileSync(join(next, f), readFileSync(join(bundled, f)));
    }
    writeFileSync(join(next, MARKER), JSON.stringify({ hash, version: modsVersion(bundled) }, null, 2) + "\n");
    // ponytail: two renames leave a moment with no folder; a session loading its plugins then
    // finds none and takes them at its next reload. A symlink swap would close it (not on Windows).
    rmSync(old, { recursive: true, force: true });
    if (existsSync(dest)) renameSync(dest, old);
    renameSync(next, dest);
    rmSync(old, { recursive: true, force: true });
    return { changed: true };
  } catch (e) {
    return { changed: false, error: `could not copy MasterDeck's mods: ${String(e)}` };
  }
}

/** Where Claude Code reads managed settings (organization policy), per platform. */
export function managedSettingsFiles(platform = process.platform): string[] {
  const dirs =
    platform === "darwin"
      ? ["/Library/Application Support/ClaudeCode"]
      : platform === "win32"
        ? ["C:\\Program Files\\ClaudeCode", "C:\\ProgramData\\ClaudeCode"]
        : ["/etc/claude-code"];
  const out: string[] = [];
  for (const d of dirs) {
    out.push(join(d, "managed-settings.json"));
    try {
      for (const f of readdirSync(join(d, "managed-settings.d")).sort())
        if (f.endsWith(".json")) out.push(join(d, "managed-settings.d", f));
    } catch {
      // no drop-in folder
    }
  }
  return out;
}

export interface ModsDeps {
  run: Runner;
  claude: () => string;
  /** The mods the app ships (resources/mods, or the repository's mods/ in development). */
  bundled: string;
  /** MasterDeck's copy, the marketplace Claude Code reads: `<home>/mods`. */
  folder: string;
  /** Claude Code's user settings, the file `claude plugin` writes; null: refused (see `refused`). */
  settings: string | null;
  refused: string | null;
  backupDir: string;
  /** `<home>/mods-installed.json`: when MasterDeck last installed them (sessions older than that reload). */
  installedFile: string;
  managedFiles?: string[];
  now?: () => number;
}

type Step = { outcome?: string; failureCode?: string; message?: string };

/** The last JSON line `claude plugin … --json` printed. */
function stepOf(stdout: string): Step | null {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") return v as Step;
    } catch {
      // not the result line
    }
  }
  return null;
}

export class ModsInstaller {
  private claudeVersion: string | null = null;
  private subscription: string | null = null;
  private busy = false;

  constructor(private readonly d: ModsDeps) {}

  /** Ask Claude Code its version and plan again (launch, before an install, Settings opening). */
  async refresh(): Promise<void> {
    const v = await this.d.run(this.d.claude(), ["--version"], { timeoutMs: 15_000 });
    this.claudeVersion = v.code === 0 ? parseClaudeVersion(v.stdout) : null;
    const a = await this.d.run(this.d.claude(), ["auth", "status", "--json"], { timeoutMs: 15_000 });
    try {
      const s = JSON.parse(a.stdout)?.subscriptionType;
      this.subscription = typeof s === "string" ? s : null;
    } catch {
      this.subscription = null;
    }
  }

  installedAt(): number | null {
    const at = readJson(this.d.installedFile)?.at;
    return typeof at === "number" ? at : null;
  }

  status(): ModsStatus {
    const managed = (this.d.managedFiles ?? managedSettingsFiles()).map(readJson).filter((m): m is Record<string, unknown> => !!m);
    let inSettings: Pick<ModsStatus, "state" | "missing"> = { state: "off", missing: [] };
    if (this.d.settings)
      try {
        inSettings = modsInSettings(readSettings(this.d.settings), this.d.folder, modNames(this.d.folder));
      } catch {
        // unreadable settings.json: shown as not installed; install says why
      }
    return {
      ...inSettings,
      claude: this.claudeVersion,
      version: modsVersion(this.d.folder),
      prependNote: prependNote({
        managed: managed.length > 0,
        managedPrepends: managed.some((m) => Array.isArray(m.prependPlugins) && m.prependPlugins.includes(MODS_CORE)),
        subscription: this.subscription,
      }),
      unavailable: this.d.refused ?? (existsSync(join(this.d.bundled, ".claude-plugin")) ? null : "This build has no mods."),
    };
  }

  /** Copy the bundled mods over MasterDeck's folder when they changed (every launch). */
  syncFolder(): { changed: boolean; error?: string } {
    return syncModsFolder(this.d.bundled, this.d.folder);
  }

  private async plugin(args: string[], ok: string[] = []): Promise<string | null> {
    const r = await this.d.run(this.d.claude(), ["plugin", ...args, "--json"], { timeoutMs: 120_000 });
    const s = stepOf(r.stdout);
    if (r.code === 0 && s?.outcome !== "failed") return null;
    if (s?.failureCode && ok.includes(s.failureCode)) return null;
    return `claude plugin ${args.join(" ")}: ${s?.message ?? (r.stderr.trim() || `exit ${r.code}`)}`;
  }

  private async once(f: () => Promise<CliResult>): Promise<CliResult> {
    if (this.busy) return { ok: false, message: "MasterDeck is already changing the mods" };
    this.busy = true;
    try {
      return await f();
    } finally {
      this.busy = false;
    }
  }

  /** The marketplace, every mod (user scope) and the core first in prependPlugins. */
  install(): Promise<CliResult> {
    return this.once(async () => {
      const settings = this.d.settings;
      if (!settings) return { ok: false, message: this.d.refused ?? "mods cannot be installed here" };
      await this.refresh();
      const refusal = claudeRefusal(this.claudeVersion);
      if (refusal) return { ok: false, message: refusal };
      const copied = this.syncFolder();
      if (copied.error) return { ok: false, message: copied.error };
      const names = modNames(this.d.folder);
      if (!names.length) return { ok: false, message: `no mods listed in ${this.d.folder}` };
      try {
        readSettings(settings);
        backupSettings(settings, this.d.backupDir, "before-mods");
      } catch (e) {
        return { ok: false, message: `could not read ${settings}: ${String(e)}` };
      }
      // Added again when present: that points it at this folder (a hand copy elsewhere included).
      const err =
        (await this.plugin(["marketplace", "add", this.d.folder, "--scope", "user"])) ??
        (await this.each(names, (n) => this.plugin(["install", `${n}@${MODS_MARKETPLACE}`, "--scope", "user"])));
      if (err) return { ok: false, message: err };
      try {
        const next = withPrepend(readSettings(settings), true);
        if (next) writeSettings(settings, this.d.backupDir, next);
        writeFileSync(this.d.installedFile, JSON.stringify({ at: (this.d.now ?? Date.now)(), version: modsVersion(this.d.folder) }, null, 2) + "\n");
      } catch (e) {
        return { ok: false, message: `could not add prependPlugins to ${settings}: ${String(e)}` };
      }
      return { ok: true, message: `Installed ${names.length} mods. New sessions load them; running ones at a reload.` };
    });
  }

  /** Every mod, the marketplace and prependPlugins out; MasterDeck's folder stays (it is its own). */
  uninstall(): Promise<CliResult> {
    return this.once(async () => {
      const settings = this.d.settings;
      if (!settings) return { ok: false, message: this.d.refused ?? "mods cannot be changed here" };
      try {
        readSettings(settings);
        backupSettings(settings, this.d.backupDir, "before-mods-off");
      } catch (e) {
        return { ok: false, message: `could not read ${settings}: ${String(e)}` };
      }
      const err =
        (await this.each(modNames(this.d.folder), (n) =>
          this.plugin(["uninstall", `${n}@${MODS_MARKETPLACE}`, "--scope", "user"], ["not_installed"]),
        )) ?? (await this.plugin(["marketplace", "remove", MODS_MARKETPLACE], ["not_configured"]));
      if (err) return { ok: false, message: err };
      try {
        const next = withPrepend(readSettings(settings), false);
        if (next) writeSettings(settings, this.d.backupDir, next);
        rmSync(this.d.installedFile, { force: true });
      } catch (e) {
        return { ok: false, message: `could not take prependPlugins out of ${settings}: ${String(e)}` };
      }
      return { ok: true, message: "Removed MasterDeck's mods. Running sessions keep them until they reload or start again." };
    });
  }

  /** One at a time (each writes settings.json); the first error stops. */
  private async each(names: string[], f: (n: string) => Promise<string | null>): Promise<string | null> {
    for (const n of names) {
      const e = await f(n);
      if (e) return e;
    }
    return null;
  }
}

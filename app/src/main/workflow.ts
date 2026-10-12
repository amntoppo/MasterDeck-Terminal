import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  appendFileSync,
  chmodSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  hookOwner,
  parseSteps,
  type CustomStep,
  type HookEntry,
} from "@shared/workflow";
import { loopScript, loopScriptPath } from "@shared/loopHook";
import {
  compileFlow,
  parseCustomTrigger,
  parseMonitor,
  type CustomTrigger,
  type MonitorDef,
  DEFAULT_TEMPLATE,
  defaultFlow,
  docJson,
  parseDoc,
  BUILTINS,
  templateId,
  validSessionId,
  type BuiltinId,
  type CompiledStep,
  type Flow,
  type WorkflowDoc,
  type WorkflowTemplate,
} from "@shared/flow";
import {
  BUILTIN_WORKFLOWS,
  flowHash,
  markFor,
  sameAsMark,
  type BuiltinMark,
  type BuiltinWorkflow,
} from "@shared/builtinWorkflows";

/**
 * What the Workflow view shows: every hook Claude Code runs (user settings, the workspace's
 * repos' project settings, enabled plugins), the skills that can be attached to a stage, and the
 * custom steps.
 */

type HookBlock = Record<
  string,
  { matcher?: string; hooks?: { type?: string; command?: string }[] }[]
>;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function entries(
  block: unknown,
  source: HookEntry["source"],
  where: string | null,
): HookEntry[] {
  const out: HookEntry[] = [];
  if (!block || typeof block !== "object") return out;
  for (const [event, list] of Object.entries(block as HookBlock)) {
    if (!Array.isArray(list)) continue;
    for (const m of list)
      for (const h of m?.hooks ?? [])
        if (typeof h?.command === "string")
          out.push({
            source,
            where,
            event,
            matcher: m.matcher ?? null,
            command: h.command,
            owner: hookOwner(h.command),
          });
  }
  return out;
}

/** Hooks from ~/.claude/settings.json, the repos' .claude/settings(.local).json, and enabled plugins. */
export function collectHooks(claudeDir: string, repos: string[]): HookEntry[] {
  const out: HookEntry[] = [];
  const settings = readJson(join(claudeDir, "settings.json"));
  out.push(...entries(settings?.hooks, "user", null));
  const line = (settings?.statusLine as { command?: unknown } | undefined)
    ?.command;
  if (typeof line === "string")
    out.push({
      source: "user",
      where: null,
      event: "StatusLine",
      matcher: null,
      command: line,
      owner: hookOwner(line) ?? "status line",
    });

  // The workspace is often one of the repos too: each folder once.
  for (const repo of [...new Set(repos.map((r) => resolve(r)))])
    for (const f of ["settings.json", "settings.local.json"])
      out.push(
        ...entries(
          readJson(join(repo, ".claude", f))?.hooks,
          "project",
          basename(repo),
        ),
      );

  // Plugins: the enabled ones, where installed_plugins.json says they are.
  const enabled = Object.entries(
    (settings?.enabledPlugins as Record<string, unknown>) ?? {},
  )
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const installed = (readJson(
    join(claudeDir, "plugins", "installed_plugins.json"),
  )?.plugins ?? {}) as Record<string, unknown>;
  for (const id of enabled) {
    const rec = installed[id];
    const path = (Array.isArray(rec) ? rec[0] : rec) as
      { installPath?: string } | undefined;
    if (!path?.installPath) continue;
    const name = id.split("@")[0];
    const manifest = readJson(
      join(path.installPath, ".claude-plugin", "plugin.json"),
    );
    const file = readJson(join(path.installPath, "hooks", "hooks.json"));
    const block =
      manifest?.hooks && typeof manifest.hooks === "object"
        ? manifest.hooks
        : file
          ? (file.hooks ?? file)
          : null;
    out.push(...entries(block, "plugin", name));
  }
  return out;
}

export interface SkillChoice {
  /** As Claude Code names it: `name`, or `plugin:name` for a plugin's skill. */
  name: string;
  description: string;
  /** Where it comes from: "yours", "synced", "plugin <name>" or "project <repo>". */
  source: string;
}

/** The skill folders under `dir`: each folder with a SKILL.md, `depth` levels down at most. */
function skillFiles(dir: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(d).filter(
        (n) => !n.startsWith(".") && n !== "node_modules",
      );
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const sub = join(d, n);
      const f = join(sub, "SKILL.md");
      if (existsSync(f)) out.push(f);
      else if (left > 1) walk(sub, left - 1);
    }
  };
  walk(dir, depth);
  return out;
}

function readSkill(file: string, prefix: string, source: string): SkillChoice {
  const text = readFileSync(file, "utf8").slice(0, 4000);
  const dir = basename(join(file, ".."));
  const name =
    /^name:\s*(.+)$/m
      .exec(text)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "") || dir;
  const description =
    /^description:\s*(.+)$/m
      .exec(text)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "") ?? "";
  return {
    name: `${prefix}${name}`,
    description: description.slice(0, 240),
    source,
  };
}

/** Enabled plugins and where they are installed. */
function enabledPlugins(claudeDir: string): { name: string; path: string }[] {
  const settings = readJson(join(claudeDir, "settings.json"));
  const enabled = Object.entries(
    (settings?.enabledPlugins as Record<string, unknown>) ?? {},
  )
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const installed = (readJson(
    join(claudeDir, "plugins", "installed_plugins.json"),
  )?.plugins ?? {}) as Record<string, unknown>;
  const out: { name: string; path: string }[] = [];
  for (const id of enabled) {
    const rec = installed[id];
    const path = (Array.isArray(rec) ? rec[0] : rec) as
      { installPath?: string } | undefined;
    if (path?.installPath)
      out.push({ name: id.split("@")[0], path: path.installPath });
  }
  return out;
}

/**
 * Every skill Claude Code offers, as /skills lists them: yours in ~/.claude/skills (and the synced
 * ones under it), your enabled plugins' (named `plugin:skill`), and the workspace repos'
 * `.claude/skills` (those run only in sessions in that repo). The first of a name wins.
 */
export function listSkills(
  skillsDir: string,
  claudeDir?: string,
  repos: string[] = [],
): SkillChoice[] {
  const out: SkillChoice[] = [];
  const seen = new Set<string>();
  const push = (s: SkillChoice) => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    out.push(s);
  };
  for (const f of skillFiles(skillsDir, 3))
    push(
      readSkill(
        f,
        "",
        f.startsWith(join(skillsDir, "synced")) ? "synced" : "yours",
      ),
    );
  if (claudeDir)
    for (const p of enabledPlugins(claudeDir)) {
      const dir = existsSync(join(p.path, "skills"))
        ? join(p.path, "skills")
        : p.path;
      for (const f of skillFiles(dir, 3))
        push(readSkill(f, `${p.name}:`, `plugin ${p.name}`));
    }
  for (const repo of [...new Set(repos.map((r) => resolve(r)))])
    for (const f of skillFiles(join(repo, ".claude", "skills"), 2))
      push(readSkill(f, "", `project ${basename(repo)}`));
  return out;
}

export function readSteps(file: string): CustomStep[] {
  try {
    return parseSteps(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

export function writeFlow(
  file: string,
  flow: Flow,
  name?: string,
  extra?: Record<string, unknown>,
): void {
  writeAtomic(file, docJson({ flow, from: null, at: null }, name, extra));
}

/** The mark of a template file `id`; a mark naming another id is no mark (a hand-made copy). */
function markOf(raw: unknown, id: string): BuiltinMark | null {
  const b = (raw as { builtin?: unknown } | null)?.builtin as
    | { id?: unknown; hash?: unknown; raw?: unknown }
    | undefined;
  return b &&
    typeof b === "object" &&
    b.id === id &&
    typeof b.hash === "string" &&
    b.hash
    ? {
        id,
        hash: b.hash,
        ...(typeof b.raw === "string" && b.raw ? { raw: b.raw } : {}),
      }
    : null;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

const readRaw = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * The workflows on disk, under MasterDeck's home: the default (`workflow.json`, what new sessions
 * copy), templates (`workflows/templates/<id>.json`), each session's copy
 * (`workflows/sessions/<session id>.json`) and the template picked for a session being started
 * (`workflows/pending.json`, by session name).
 */
export interface WorkflowRun {
  at: number;
  trigger: string;
  /** The compiled steps it handed over. */
  ids: string[];
}

export class WorkflowStore {
  /** Sessions already given their copy (or found with one) in this run. */
  private seen = new Set<string>();
  /**
   * `hash` is the parsed-flow fingerprint of built-in marks; tests pass another to stand in for a
   * later parseFlow that reads the same files differently.
   */
  constructor(
    private home: string,
    private hash: (f: Flow) => string = flowHash,
  ) {}

  get defaultFile(): string {
    return join(this.home, "workflow.json");
  }
  private get templatesDir(): string {
    return join(this.home, "workflows", "templates");
  }
  private get sessionsDir(): string {
    return join(this.home, "workflows", "sessions");
  }
  private get pendingFile(): string {
    return join(this.home, "workflows", "pending.json");
  }
  /** The built-ins the user deleted (`{removed: [...]}`), so a launch does not bring them back. */
  get builtinsFile(): string {
    return join(this.home, "workflows", "builtins.json");
  }
  private templateFile(id: string): string | null {
    if (id === DEFAULT_TEMPLATE) return this.defaultFile;
    return /^[a-z0-9-]{1,48}$/.test(id)
      ? join(this.templatesDir, `${id}.json`)
      : null;
  }

  /** The default as a flow (a missing file: the starting flow). */
  private defaultDoc(): WorkflowDoc {
    return existsSync(this.defaultFile)
      ? parseDoc(readRaw(this.defaultFile))
      : { flow: defaultFlow(), from: null, at: null };
  }

  /**
   * Files from before flows (a list of steps): rewrite them as flows, so the hooks read compiled
   * plans and the built-ins list. Files are rewritten as they are: a flow file stays the same.
   */
  migrate(): void {
    const redo = (f: string, name?: string) => {
      const raw = readRaw(f) as { flow?: unknown; name?: unknown } | null;
      if (raw && !raw.flow) {
        const d = parseDoc(raw);
        writeAtomic(
          f,
          docJson(
            d,
            name ?? (typeof raw.name === "string" ? raw.name : undefined),
          ),
        );
      }
    };
    if (existsSync(this.defaultFile)) redo(this.defaultFile);
    else writeFlow(this.defaultFile, defaultFlow());
    for (const dir of [this.templatesDir, this.sessionsDir])
      try {
        for (const f of readdirSync(dir))
          if (f.endsWith(".json")) redo(join(dir, f));
      } catch {
        /* none yet */
      }
  }

  /**
   * Write the loop hook (`workflows/loop.sh`, run by its Stop hook entry) when its text is not
   * what this MasterDeck generates: an unchanged file is left alone.
   */
  setupLoopHook(): void {
    const file = loopScriptPath(this.home);
    const text = loopScript(this.home);
    let cur: string | null = null;
    try {
      cur = readFileSync(file, "utf8");
    } catch {
      /* not written yet */
    }
    if (cur === text) return;
    writeAtomic(file, text);
    chmodSync(file, 0o755);
  }

  private removed(): string[] {
    const r = (readRaw(this.builtinsFile) as { removed?: unknown } | null)
      ?.removed;
    return Array.isArray(r)
      ? [
          ...new Set(
            r.filter(
              (x): x is string =>
                typeof x === "string" && /^[a-z0-9-]{1,48}$/.test(x),
            ),
          ),
        ]
      : [];
  }

  private setRemoved(ids: string[]): void {
    writeAtomic(
      this.builtinsFile,
      JSON.stringify({ removed: [...new Set(ids)] }, null, 2) + "\n",
    );
  }

  /** Write a built-in as shipped: its flow, name and mark. */
  private writeBuiltin(b: BuiltinWorkflow, name = b.name): void {
    const file = this.templateFile(b.id);
    if (file)
      writeFlow(file, b.flow, name, { builtin: markFor(b, this.hash) });
  }

  /** Whether a template file still holds the flow its mark was written with. */
  private unedited(raw: unknown, mark: BuiltinMark): boolean {
    return sameAsMark(mark, (raw as { flow?: unknown } | null)?.flow, this.hash);
  }

  /** Whether a mark was written from the flow `b` ships now. */
  private current(mark: BuiltinMark, b: BuiltinWorkflow): boolean {
    return sameAsMark(mark, b.flow, this.hash);
  }

  /**
   * Bring the shipped built-ins into the templates (at launch, after `migrate()`). A missing one is
   * written unless the user deleted it; an unedited one whose shipped flow changed is rewritten;
   * an edited one, and any file without the mark (the user's), is left as it is. Returns how many
   * files were written.
   */
  seedBuiltins(list: BuiltinWorkflow[] = BUILTIN_WORKFLOWS): number {
    const removed = new Set(this.removed());
    let wrote = 0;
    for (const b of list) {
      const file = this.templateFile(b.id);
      if (!file || b.id === DEFAULT_TEMPLATE) continue;
      if (!existsSync(file)) {
        if (removed.has(b.id)) continue;
        this.writeBuiltin(b);
        wrote++;
        continue;
      }
      const raw = readRaw(file);
      const mark = markOf(raw, b.id);
      if (!mark || this.current(mark, b)) continue;
      if (!this.unedited(raw, mark)) continue; // edited: the user's now
      // The update brings the flow; a name is the user's choice, kept (Restore original resets it).
      const name = (raw as { name?: unknown } | null)?.name;
      this.writeBuiltin(
        b,
        typeof name === "string" && name.trim() ? name.slice(0, 60) : b.name,
      );
      wrote++;
    }
    return wrote;
  }

  /**
   * Write a built-in back as shipped (Restore original), or, with null, every deleted one
   * (Restore built-ins) and clear the list. A file at its id without the mark is the user's and
   * is never written over. False when nothing could be restored.
   */
  restoreBuiltin(
    id: string | null,
    list: BuiltinWorkflow[] = BUILTIN_WORKFLOWS,
  ): boolean {
    const removed = this.removed();
    const ids = id === null ? removed : [id];
    let wrote = 0;
    for (const bid of ids) {
      const b = list.find((x) => x.id === bid);
      const file = b ? this.templateFile(b.id) : null;
      if (!b || !file || b.id === DEFAULT_TEMPLATE) continue;
      if (existsSync(file) && !markOf(readRaw(file), b.id)) continue;
      this.writeBuiltin(b);
      wrote++;
    }
    if (id === null) {
      if (removed.length) this.setRemoved([]);
    } else if (wrote && removed.includes(id))
      this.setRemoved(removed.filter((r) => r !== id));
    return wrote > 0;
  }

  /** The deleted built-ins that can be written back (Restore built-ins (n)). */
  builtinsRemoved(list: BuiltinWorkflow[] = BUILTIN_WORKFLOWS): string[] {
    return this.removed().filter((id) => {
      const file = list.some((b) => b.id === id) ? this.templateFile(id) : null;
      return !!file && !existsSync(file);
    });
  }

  templates(list: BuiltinWorkflow[] = BUILTIN_WORKFLOWS): WorkflowTemplate[] {
    const out: WorkflowTemplate[] = [
      { id: DEFAULT_TEMPLATE, name: "Default", flow: this.defaultDoc().flow },
    ];
    let files: string[] = [];
    try {
      files = readdirSync(this.templatesDir).filter((f) => f.endsWith(".json"));
    } catch {
      /* none yet */
    }
    for (const f of files.sort()) {
      const raw = readRaw(join(this.templatesDir, f)) as {
        name?: unknown;
      } | null;
      const id = f.slice(0, -5);
      const flow = parseDoc(raw).flow;
      const mark = markOf(raw, id);
      // A mark naming no shipped built-in (one dropped from a later release) is a plain template.
      const b = mark ? list.find((x) => x.id === mark.id) : undefined;
      const edited = !!mark && !this.unedited(raw, mark);
      const name =
        typeof raw?.name === "string" && raw.name.trim()
          ? raw.name.slice(0, 60)
          : id;
      out.push({
        id,
        name,
        flow,
        ...(mark && b
          ? {
              builtin: {
                id: b.id,
                edited,
                renamed: name !== b.name,
                updated: edited && !this.current(mark, b),
                description: b.description,
                whenToUse: b.whenToUse,
              },
            }
          : {}),
      });
    }
    return out;
  }

  template(id: string): WorkflowTemplate | null {
    return this.templates().find((t) => t.id === id) ?? null;
  }

  /** Save a template (a new one when `id` is null); returns its id. */
  saveTemplate(id: string | null, name: string, flow: Flow): string | null {
    const clean = name.trim().slice(0, 60);
    if (id === DEFAULT_TEMPLATE) {
      writeFlow(this.defaultFile, flow);
      return id;
    }
    if (!clean) return null;
    // A new template never takes a built-in's id, even a deleted one's: it stays restorable.
    const taken = new Set([
      ...this.templates().map((t) => t.id),
      ...BUILTIN_WORKFLOWS.map((b) => b.id),
    ]);
    let tid = id ?? templateId(clean);
    if (!id)
      while (taken.has(tid))
        tid = `${tid.slice(0, 40)}-${Math.random().toString(36).slice(2, 5)}`;
    const file = this.templateFile(tid);
    if (!file) return null;
    // A deleted built-in is not written back by a save (a late autosave, a stale tab): it would
    // come back without its mark. Restore built-ins brings it back.
    if (id && !existsSync(file) && BUILTIN_WORKFLOWS.some((b) => b.id === id))
      return null;
    // Saving a built-in (an edit, a rename) keeps its mark as written, so seeding sees the edit;
    // a new template (a Duplicate) never carries one.
    const mark = id ? markOf(readRaw(file), tid) : null;
    writeFlow(file, flow, clean, mark ? { builtin: mark } : undefined);
    return tid;
  }

  deleteTemplate(id: string): boolean {
    const file = id === DEFAULT_TEMPLATE ? null : this.templateFile(id);
    if (!file || !existsSync(file)) return false;
    const mark = markOf(readRaw(file), id);
    unlinkSync(file);
    if (mark) this.setRemoved([...this.removed(), id]);
    return true;
  }

  /** A session's own workflow; null while it follows the default (no copy yet). */
  sessionDoc(sessionId: string): WorkflowDoc | null {
    if (!validSessionId(sessionId)) return null;
    const f = join(this.sessionsDir, `${sessionId}.json`);
    return existsSync(f) ? parseDoc(readRaw(f)) : null;
  }

  saveSession(sessionId: string, doc: WorkflowDoc): boolean {
    if (!validSessionId(sessionId)) return false;
    writeAtomic(join(this.sessionsDir, `${sessionId}.json`), docJson(doc));
    this.seen.add(sessionId);
    return true;
  }

  /** Start the session named `name` from this template (Start dialog). */
  setPending(name: string, templateId: string): void {
    const p = (readRaw(this.pendingFile) ?? {}) as Record<string, unknown>;
    p[name] = { template: templateId, at: Date.now() };
    // Old picks for sessions that never started go after a day.
    for (const [k, v] of Object.entries(p))
      if (
        !v ||
        typeof v !== "object" ||
        Date.now() - Number((v as { at?: unknown }).at ?? 0) > 86_400_000
      )
        delete p[k];
    writeAtomic(this.pendingFile, JSON.stringify(p, null, 2) + "\n");
  }

  /**
   * Give every session that has no workflow yet its copy: the template picked when it was started,
   * else the default. Returns how many were made.
   */
  snapshot(
    sessions: { sessionId: string; name: string }[],
    now = Date.now(),
  ): number {
    const fresh = sessions.filter(
      (s) => validSessionId(s.sessionId) && !this.seen.has(s.sessionId),
    );
    if (!fresh.length) return 0;
    const pending = (readRaw(this.pendingFile) ?? {}) as Record<
      string,
      { template?: unknown }
    >;
    let made = 0;
    let usedPending = false;
    for (const s of fresh) {
      this.seen.add(s.sessionId);
      if (existsSync(join(this.sessionsDir, `${s.sessionId}.json`))) continue;
      const pick =
        typeof pending[s.name]?.template === "string"
          ? (pending[s.name].template as string)
          : DEFAULT_TEMPLATE;
      const t = this.template(pick) ?? this.template(DEFAULT_TEMPLATE)!;
      if (pending[s.name]) {
        delete pending[s.name];
        usedPending = true;
      }
      this.saveSession(s.sessionId, { flow: t.flow, from: t.name, at: now });
      made++;
    }
    if (usedPending)
      writeAtomic(this.pendingFile, JSON.stringify(pending, null, 2) + "\n");
    return made;
  }

  private compiled = new Map<
    string,
    { mtime: number; steps: CompiledStep[] }
  >();
  /** What a session's workflow compiles to (its copy, else the default); cached by file time. */
  compiledFor(sessionId: string): CompiledStep[] {
    const own = validSessionId(sessionId)
      ? join(this.sessionsDir, `${sessionId}.json`)
      : null;
    const f = own && existsSync(own) ? own : this.defaultFile;
    let mtime = 0;
    try {
      mtime = statSync(f).mtimeMs;
    } catch {
      return [];
    }
    const hit = this.compiled.get(f);
    if (hit && hit.mtime === mtime) return hit.steps;
    const steps = compileFlow(parseDoc(readRaw(f)).flow).steps;
    this.compiled.set(f, { mtime, steps });
    return steps;
  }

  private builtinCache = new Map<string, { mtime: number; ids: BuiltinId[] }>();
  /** The built-ins a session's workflow keeps (its copy, else the default); all of them when none can be read. */
  builtinsFor(sessionId: string): BuiltinId[] {
    const own = validSessionId(sessionId)
      ? join(this.sessionsDir, `${sessionId}.json`)
      : null;
    const f = own && existsSync(own) ? own : this.defaultFile;
    let mtime = 0;
    try {
      mtime = statSync(f).mtimeMs;
    } catch {
      return BUILTINS.map((b) => b.id);
    }
    const hit = this.builtinCache.get(f);
    if (hit && hit.mtime === mtime) return hit.ids;
    const ids = compileFlow(parseDoc(readRaw(f)).flow).builtins;
    this.builtinCache.set(f, { mtime, ids });
    return ids;
  }

  private get runsFile(): string {
    return join(this.home, "workflows", "runs.jsonl");
  }
  private runs: { mtime: number; last: Map<string, WorkflowRun> } = {
    mtime: -1,
    last: new Map(),
  };

  /** Record a step MasterDeck ran itself (needs you, idle). */
  logRun(sessionId: string, trigger: string, ids: string[]): void {
    if (!validSessionId(sessionId)) return;
    mkdirSync(join(this.home, "workflows"), { recursive: true });
    appendFileSync(
      this.runsFile,
      JSON.stringify({
        at: Date.now(),
        sid: sessionId,
        trigger,
        ids: ids.join(" "),
      }) + "\n",
    );
  }

  /** The last workflow step that ran for a session (hooks and MasterDeck log each run). */
  lastRun(sessionId: string): WorkflowRun | null {
    let mtime = 0;
    try {
      const st = statSync(this.runsFile);
      mtime = st.mtimeMs;
      // Kept short: the newest lines are all that matter.
      if (st.size > 1_000_000) {
        const lines = readFileSync(this.runsFile, "utf8")
          .trim()
          .split("\n")
          .slice(-2000);
        writeAtomic(this.runsFile, lines.join("\n") + "\n");
        mtime = statSync(this.runsFile).mtimeMs;
      }
    } catch {
      return null;
    }
    if (mtime !== this.runs.mtime) {
      const last = new Map<string, WorkflowRun>();
      for (const line of readFileSync(this.runsFile, "utf8").split("\n")) {
        try {
          const r = JSON.parse(line) as {
            at?: unknown;
            sid?: unknown;
            trigger?: unknown;
            ids?: unknown;
          };
          if (
            typeof r.sid !== "string" ||
            typeof r.at !== "number" ||
            typeof r.trigger !== "string" ||
            // A loop's rounds (loop.sh) are not a workflow step: the line stays on the step
            // that armed the loop.
            r.trigger === "loop"
          )
            continue;
          last.set(r.sid, {
            at: r.at,
            trigger: r.trigger,
            ids: String(r.ids ?? "")
              .split(" ")
              .filter(Boolean),
          });
        } catch {
          /* a partial line */
        }
      }
      this.runs = { mtime, last };
    }
    return this.runs.last.get(sessionId) ?? null;
  }

  private get triggersDir(): string {
    return join(this.home, "workflows", "triggers");
  }

  /** The custom trigger library (workflows/triggers/<id>.json). */
  triggers(): CustomTrigger[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.triggersDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    return files
      .sort()
      .map((f) => parseCustomTrigger(readRaw(join(this.triggersDir, f))))
      .filter((t): t is CustomTrigger => !!t);
  }

  saveTrigger(t: CustomTrigger): void {
    writeAtomic(
      join(this.triggersDir, `${t.id}.json`),
      JSON.stringify(t, null, 2) + "\n",
    );
  }

  deleteTrigger(id: string): boolean {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return false;
    const f = join(this.triggersDir, `${id}.json`);
    if (!existsSync(f)) return false;
    unlinkSync(f);
    return true;
  }

  private get monitorsDir(): string {
    return join(this.home, "workflows", "monitors");
  }

  /** The monitor library (workflows/monitors/<id>.json with its script <id>.sh). */
  monitors(): MonitorDef[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.monitorsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    return files
      .sort()
      .map((f) => {
        const script = join(this.monitorsDir, `${f.slice(0, -5)}.sh`);
        return existsSync(script)
          ? parseMonitor(readRaw(join(this.monitorsDir, f)), script)
          : null;
      })
      .filter((m): m is MonitorDef => !!m);
  }

  /** Install a monitor: its definition and its script (made executable). */
  saveMonitor(m: MonitorDef, script: string): void {
    const path = join(this.monitorsDir, `${m.id}.sh`);
    writeAtomic(path, script.endsWith("\n") ? script : `${script}\n`);
    chmodSync(path, 0o755);
    const { path: _p, ...def } = m;
    writeAtomic(
      join(this.monitorsDir, `${m.id}.json`),
      JSON.stringify(def, null, 2) + "\n",
    );
  }

  deleteMonitor(id: string): boolean {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return false;
    let gone = false;
    for (const f of [`${id}.json`, `${id}.sh`])
      try {
        unlinkSync(join(this.monitorsDir, f));
        gone = true;
      } catch {
        /* not there */
      }
    return gone;
  }
}

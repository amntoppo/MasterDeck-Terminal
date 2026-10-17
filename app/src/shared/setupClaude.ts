/**
 * Setup's "Let Claude do it" (#156): a Claude session in its own folder that walks the user through
 * setup in conversation. MasterDeck briefs it (CLAUDE.md), answers its helper script (md-setup.sh:
 * tools, gh accounts, what an account can reach), and checks the draft it hands back (review.json)
 * before the Setup window fills the wizard with it and shows the summary. Only the user's Save in
 * the window writes the config, through the wizard's own path.
 */
import type { DetectAll } from "./detect";
import { INSTALLABLE } from "./install";

export const SETUP_CLAUDE_NAME = "md-setup";
/** The Setup window's pane for the session. */
export const SETUP_CLAUDE_PANE = "setup:claude";
/** A request id the helper makes (`<epoch>-<pid>-<random>`), as the ticket builder's. */
export const SETUP_REQ_ID = /^[0-9]+-[0-9]+-[0-9]+$/;
/** What the helper may ask. */
export const SETUP_COMMANDS = ["tools", "accounts", "discover", "gh-login", "review"] as const;
export type SetupCommand = (typeof SETUP_COMMANDS)[number];

/** A helper request only the Setup window can answer (`review`: the parsed review.json). */
export type SetupWindowRequest = { id: string; cmd: "review"; draft: unknown } | { id: string; cmd: "gh-login" };

export interface SetupDraftAccount {
  /** As gh spells it. */
  login: string;
  primary: boolean;
  /** Every repository discovered for it (`"all"`), or the ones picked. */
  repos: string[];
  allRepos: boolean;
  /** Its main repository (the primary account's: where a plain #12 points). */
  primaryRepo: string;
  /** owner/number keys of its boards. */
  boards: string[];
  allBoards: boolean;
  /** Its own workspace (another account than the primary); "" none. */
  workspace: string;
}

/** A checked draft; an absent setting keeps what the wizard has. */
export interface SetupDraft {
  /** The primary first. */
  accounts: SetupDraftAccount[];
  workspace?: string;
  masterEnabled?: boolean;
  notifications?: boolean;
  mods?: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const low = (s: string) => s.toLowerCase();
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A folder as typed: one short line, or "" for none. */
function folder(v: unknown, what: string, errors: string[]): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || v.length > 500 || CONTROL.test(v)) {
    errors.push(`${what} must be a folder path on one line.`);
    return "";
  }
  return v.trim();
}

function flag(v: unknown, what: string, errors: string[]): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") errors.push(`${what} must be true or false.`);
  return typeof v === "boolean" ? v : undefined;
}

/**
 * The session's draft checked against what MasterDeck knows: `logins` gh is logged in to, `found`
 * what discover read for each (keyed by login, any case). Repositories and boards picked by name
 * are claimed first; an account with `"all"` takes what is left (primary first), as the wizard's
 * Select all skips what another account has. Errors say what to change.
 */
export function readSetupDraft(
  raw: unknown,
  ctx: { logins: string[]; found: Record<string, DetectAll> },
): { ok: true; draft: SetupDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const d = obj(raw);
  if (!d) return { ok: false, errors: ["review.json must be one JSON object."] };
  const list = Array.isArray(d.accounts) ? d.accounts : null;
  if (!list?.length) return { ok: false, errors: ['"accounts" must list at least one GitHub account.'] };
  const foundOf = (login: string): DetectAll | null =>
    Object.entries(ctx.found).find(([l]) => low(l) === low(login))?.[1] ?? null;

  type Raw = { login: string; primary: boolean; repos: unknown; primaryRepo: unknown; boards: unknown; workspace: string };
  const rows: Raw[] = [];
  for (const [i, v] of list.entries()) {
    const a = obj(v);
    const name = typeof a?.login === "string" ? a.login : "";
    const login = ctx.logins.find((l) => low(l) === low(name));
    if (!a || !name) {
      errors.push(`accounts[${i}] needs a "login".`);
      continue;
    }
    if (!login) {
      errors.push(`gh is not logged in to ${name} (logged in: ${ctx.logins.join(", ") || "none"}).`);
      continue;
    }
    if (rows.some((r) => r.login === login)) {
      errors.push(`${login} is listed twice.`);
      continue;
    }
    if (!foundOf(login)) {
      errors.push(`Run ./md-setup.sh discover ${login} first.`);
      continue;
    }
    rows.push({
      login,
      primary: a.primary === true,
      repos: a.repos,
      primaryRepo: a.primaryRepo,
      boards: a.boards,
      workspace: folder(a.workspace, `${login}'s workspace`, errors),
    });
  }
  if (errors.length) return { ok: false, errors };

  const primaries = rows.filter((r) => r.primary);
  if (rows.length === 1) rows[0].primary = true;
  else if (primaries.length !== 1) errors.push("Mark exactly one account as primary (ask the user which).");
  rows.sort((a, b) => Number(b.primary) - Number(a.primary));

  const reposOf = (f: DetectAll) => f.owners.flatMap((o) => o.repos.map((x) => x.repo));
  const boardsOf = (f: DetectAll) => f.owners.flatMap((o) => o.projects.map((p) => ({ key: `${p.owner}/${p.number}`, closed: p.closed })));
  const claimedRepo = new Map<string, string>();
  const claimedBoard = new Map<string, string>();
  const picked = new Map<string, { repos: string[]; boards: string[] }>();

  // Named picks first.
  for (const r of rows) {
    const f = foundOf(r.login)!;
    const repos: string[] = [];
    const boards: string[] = [];
    if (r.repos !== "all") {
      if (!Array.isArray(r.repos)) errors.push(`${r.login}: "repos" must be "all" or a list of owner/name.`);
      else
        for (const x of r.repos) {
          const real = typeof x === "string" ? reposOf(f).find((y) => low(y) === low(x)) : undefined;
          if (!real) errors.push(`${r.login} cannot reach the repository ${typeof x === "string" && REPO.test(x) ? x : JSON.stringify(x)} (not in its discover list).`);
          else if (claimedRepo.has(low(real)) && claimedRepo.get(low(real)) !== r.login) errors.push(`${real} is picked for both ${claimedRepo.get(low(real))} and ${r.login}; a repository belongs to one account.`);
          else if (!repos.includes(real)) {
            repos.push(real);
            claimedRepo.set(low(real), r.login);
          }
        }
    }
    if (r.boards !== "all" && r.boards !== undefined) {
      if (!Array.isArray(r.boards)) errors.push(`${r.login}: "boards" must be "all" or a list of {"owner", "number"}.`);
      else
        for (const x of r.boards) {
          const b = obj(x);
          const key = b && typeof b.owner === "string" && typeof b.number === "number" ? `${b.owner}/${b.number}` : "";
          const real = boardsOf(f).find((y) => low(y.key) === low(key))?.key;
          if (!real) errors.push(`${r.login} has no board ${key || JSON.stringify(x)} (not in its discover list).`);
          else if (claimedBoard.has(low(real)) && claimedBoard.get(low(real)) !== r.login) errors.push(`The board ${real} is picked for both ${claimedBoard.get(low(real))} and ${r.login}; a board belongs to one account.`);
          else if (!boards.includes(real)) {
            boards.push(real);
            claimedBoard.set(low(real), r.login);
          }
        }
    }
    picked.set(r.login, { repos, boards });
  }
  // Then "all": what is left, primary first.
  for (const r of rows) {
    const f = foundOf(r.login)!;
    const p = picked.get(r.login)!;
    if (r.repos === "all")
      for (const x of reposOf(f))
        if (!claimedRepo.has(low(x))) {
          p.repos.push(x);
          claimedRepo.set(low(x), r.login);
        }
    if (r.boards === "all")
      for (const x of boardsOf(f).filter((b) => !b.closed))
        if (!claimedBoard.has(low(x.key))) {
          p.boards.push(x.key);
          claimedBoard.set(low(x.key), r.login);
        }
  }

  const accounts: SetupDraftAccount[] = rows.map((r) => {
    const p = picked.get(r.login)!;
    let main = p.repos[0] ?? "";
    if (r.primaryRepo !== undefined && r.primaryRepo !== "") {
      const want = typeof r.primaryRepo === "string" ? p.repos.find((x) => low(x) === low(r.primaryRepo as string)) : undefined;
      if (want) main = want;
      else errors.push(`${r.login}: "primaryRepo" must be one of its repositories.`);
    }
    return {
      login: r.login,
      primary: r.primary,
      repos: main ? [main, ...p.repos.filter((x) => x !== main)] : p.repos,
      allRepos: r.repos === "all",
      primaryRepo: main,
      boards: p.boards,
      allBoards: r.boards === "all",
      workspace: r.primary ? "" : r.workspace,
    };
  });
  // Only once a primary is settled: without one, the first account is not the primary yet.
  if (accounts[0]?.primary && !accounts[0].repos.length) errors.push(`The primary account ${accounts[0].login} needs at least one repository.`);
  const primaryWs = rows.find((r) => r.primary)?.workspace;
  const workspace = d.workspace !== undefined ? folder(d.workspace, '"workspace"', errors) : primaryWs || undefined;
  const masterEnabled = flag(d.masterEnabled, '"masterEnabled"', errors);
  const notifications = flag(d.notifications, '"notifications"', errors);
  const mods = flag(d.mods, '"mods"', errors);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      accounts,
      ...(workspace ? { workspace } : {}),
      ...(masterEnabled !== undefined ? { masterEnabled } : {}),
      ...(notifications !== undefined ? { notifications } : {}),
      ...(mods !== undefined ? { mods } : {}),
    },
  };
}

/** The summary Setup shows before Save (and after it): one line each. */
export function draftSummary(d: SetupDraft, found: Record<string, DetectAll> = {}): string[] {
  const foundOf = (login: string) => Object.entries(found).find(([l]) => low(l) === low(login))?.[1];
  const lines: string[] = [];
  const many = d.accounts.length > 1;
  lines.push(
    many
      ? `GitHub accounts: ${d.accounts.map((a) => (a.primary ? `${a.login} (primary)` : a.login)).join(", ")}`
      : `GitHub account: ${d.accounts[0]?.login ?? "none"}`,
  );
  for (const a of d.accounts) {
    const who = many ? `${a.login}: ` : "";
    const repos = `${a.allRepos ? "all " : ""}${a.repos.length} ${a.repos.length === 1 ? "repository" : "repositories"}`;
    lines.push(`${who}${repos}${a.primaryRepo ? `, main ${a.primaryRepo}` : ""}`);
    const titles = a.boards.map((k) => {
      const [owner, n] = k.split("/");
      const p = foundOf(a.login)?.owners.flatMap((o) => o.projects).find((x) => low(x.owner) === low(owner) && String(x.number) === n);
      return p ? `${p.title} (${p.columns.join(" → ") || "no columns"})` : k;
    });
    lines.push(`${who}${titles.length ? `${a.allBoards ? "all boards: " : titles.length === 1 ? "board " : "boards: "}${titles.join("; ")}` : "no project board (issues and PRs only)"}`);
    if (a.workspace) lines.push(`${who}workspace ${a.workspace}`);
  }
  if (d.workspace) lines.push(`Workspace: ${d.workspace}`);
  if (d.masterEnabled !== undefined) lines.push(`master-agent: ${d.masterEnabled ? "on" : "off"}`);
  if (d.notifications !== undefined) lines.push(`Notifications: ${d.notifications ? "on" : "off"}`);
  if (d.mods !== undefined) lines.push(`MasterDeck's mods: ${d.mods ? "install" : "not now"}`);
  return lines;
}

/** How the session installs a missing tool on this platform (the installer session's own way). */
function installHow(platform: string): string {
  const tools = Object.values(INSTALLABLE);
  if (platform === "win32")
    return `Use winget: \`winget install --id <id> -e\` (${tools.map((t) => `${t.name}: \`${t.winget}\``).join(", ")}).`;
  if (platform === "darwin")
    return `Use Homebrew: \`brew install <formula>\` (${tools.map((t) => `${t.name}: \`${t.brew}\``).join(", ")}). If \`brew\` itself is missing, install it with the official installer from https://brew.sh and tell the user any step it prints for them (such as adding it to the PATH).`;
  return "Use this system's package manager (apt, dnf, pacman...).";
}

/** The session's CLAUDE.md. */
export function setupBriefing(platform: string): string {
  return `# MasterDeck: setting up with the user

You set up MasterDeck (an app that puts all of the user's Claude Code sessions in one window) for
the user, in conversation. The user pressed **Let Claude do it** on MasterDeck's Setup screen and
sees this chat inside it. They may be new to all of this: be friendly and brief, one question at a
time, and propose a sensible default whenever there is one.

Everything goes through \`./md-setup.sh\` in this folder (MasterDeck answers it; each command
prints JSON). Run \`discover\` with a Bash timeout of 300000 ms (it reads GitHub); the others
answer in seconds.

## 1. Tools

Run \`./md-setup.sh tools\`. MasterDeck uses \`claude\`, \`gh\` (GitHub CLI), \`python\` (Python 3),
\`git\` and \`jq\`. Say in one line what is there. For anything missing, offer to install it:
${installHow(platform)}
Install nothing else and change no other settings. If a step needs the user's password or approval,
say so and wait. Run \`./md-setup.sh tools\` again afterwards. \`discover\` needs Python 3 and gh.

## 2. GitHub accounts

Run \`./md-setup.sh accounts\` (the accounts gh is logged in to).

- **None**: run \`./md-setup.sh gh-login\`. MasterDeck shows gh's browser login above this chat;
  tell the user to follow it, and wait for them to say they are done, then run \`accounts\` again.
- **One**: tell the user which account MasterDeck will use, and go on.
- **Several**: ask which to use (one or more), and which is the primary (master-agent, plain
  shells and sessions outside every account's repositories run as it).

An account with \`"ok": false\` must log in again (\`gh-login\`). One without \`projectScope\` cannot
read project boards: tell the user to run \`gh auth refresh -h github.com -s project -u <login>\`
in their own terminal (you don't), or go on without boards.
Never run \`gh auth login\`, \`gh auth switch\` or \`gh auth logout\` yourself.

## 3. Repositories and boards

For each chosen account run \`./md-setup.sh discover <login>\`: its organizations, the repositories
it can reach (with open issue counts) and its project boards (with their columns, in order).
Tell the user what you found in short, and ask:

- which repositories to follow: **specific ones, or all** (suggest the ones with open issues);
- which is the main repository (with one account: where a plain \`#12\` points);
- which project board(s) to use, naming each board's columns so the user recognises it, or all,
  or none (issues and pull requests still work without a board).

A repository or board belongs to one account only.

## 4. Preferences and mods

Propose defaults and ask only where a choice matters:

- \`workspace\`: the folder where the user's repositories are checked out (master-agent and new
  shells start there). Suggest \`~/code\` or a folder the user names; look at where their
  repositories already are if that helps (\`ls\` is fine; don't change anything).
- With two or more accounts, each other account may have its own workspace (empty: the same).
- \`masterEnabled\`: a master-agent session that hands out work and collects what sessions report
  (default on).
- \`notifications\`: system notifications when something needs the user (default on).
- \`mods\`: install MasterDeck's Claude Code mods (a ticket line and alerts inside sessions;
  default on).

## 5. Summary and confirm

Write \`review.json\` in this folder and run \`./md-setup.sh review review.json\`:

\`\`\`json
{
  "accounts": [
    { "login": "alice", "primary": true, "repos": ["acme/api", "acme/web"], "primaryRepo": "acme/api",
      "boards": [{ "owner": "acme", "number": 3 }] },
    { "login": "alice-work", "repos": "all", "boards": "all", "workspace": "~/work" }
  ],
  "workspace": "~/code",
  "masterEnabled": true,
  "notifications": true,
  "mods": true
}
\`\`\`

\`repos\` and \`boards\` are \`"all"\` or lists from \`discover\`; \`"boards": []\` is no board.
If the answer has \`errors\`, fix the draft (ask the user where it is their choice) and run
\`review\` again. When it is accepted, MasterDeck fills its setup wizard with it and shows the
summary above this chat with a **Save** button. Show the user the same summary in a few lines,
and tell them to press **Save** in MasterDeck when it looks right, or to tell you what to change
(then write a new \`review.json\` and run \`review\` again).

**Only the user's Save writes the setup.** Never say it is saved before they press it. When they
do, MasterDeck saves it, closes this session by itself and shows what was set up.

## Rules

- Only write files in this folder. Never edit \`~/.claude/master/config.json\`, \`~/.claude\`,
  MasterDeck's files or the user's shell profile; MasterDeck writes the setup itself.
- Don't run \`master\`, \`gh auth\` commands that change anything, or anything that changes GitHub.
- Reading is fine: \`gh auth status\`, \`gh api\` GET requests, \`ls\`, \`<tool> --version\`.
- If something fails twice, tell the user they can close this chat (**Back to the wizard**) and
  continue in the wizard; what you filled in is kept there.
`;
}

/** The helper the session runs; same transport as the ticket builder's create-ticket.sh. */
export function setupScript(dir: string, platform: string): string {
  // Git Bash (Claude Code's Bash on Windows) takes C:/… paths.
  const d = (platform === "win32" ? dir.replace(/\\/g, "/") : dir).replace(/'/g, `'\\''`);
  return `#!/usr/bin/env bash
# Written by MasterDeck: ask MasterDeck's Setup something and print its JSON answer.
d='${d}'
case "$1" in
  tools|accounts|gh-login) ;;
  discover) [ -n "$2" ] || { echo '{"ok":false,"error":"usage: ./md-setup.sh discover <login>"}'; exit 1; } ;;
  review) [ -n "$2" ] || { echo '{"ok":false,"error":"usage: ./md-setup.sh review review.json"}'; exit 1; } ;;
  *) echo '{"ok":false,"error":"usage: ./md-setup.sh tools | accounts | discover <login> | gh-login | review review.json"}'; exit 1 ;;
esac
fail() { echo '{"ok":false,"error":"could not hand the request to MasterDeck"}'; exit 1; }
mkdir -p "$d/requests" "$d/answers" || fail
id="$(date +%s)-$$-$RANDOM"
# One NUL-terminated argument each: any text survives, no jq needed.
{ printf '%s\\0' "$@" > "$d/requests/$id.tmp" && mv "$d/requests/$id.tmp" "$d/requests/$id.req"; } || fail
# discover reads GitHub (up to two minutes); the rest answer at once.
max=240
[ "$1" = discover ] && max=1120
i=0
while [ $i -lt $max ]; do
  if [ -f "$d/answers/$id.json" ]; then
    out="$(cat "$d/answers/$id.json")"; echo "$out"; rm -f "$d/answers/$id.json" "$d/requests/$id.taken"
    case "$out" in *'"ok":false'*) exit 1 ;; esac
    exit 0
  fi
  sleep 0.25
  i=$((i + 1))
done
rm -f "$d/requests/$id.req" "$d/requests/$id.taken"
echo '{"ok":false,"error":"MasterDeck did not answer. Is its Setup screen still open?"}'
exit 1
`;
}

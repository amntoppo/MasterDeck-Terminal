# Claude Code mods and MasterDeck (issue #86)

Research for #86, 2026-10-10, against Claude Code 2.1.296. The mods API is marked early access and
changes between releases: the declaration file Claude Code writes for each build is the authority.
The prototype that came out of it is `mods/`: a core `masterdeck` and one mod per feature (ARCHITECTURE, "MasterDeck's mods").

Docs: [overview](https://code.claude.com/docs/en/plugins/mods/overview),
[reference](https://code.claude.com/docs/en/plugins/mods/reference),
[API](https://code.claude.com/docs/en/plugins/mods/api),
[interface](https://code.claude.com/docs/en/plugins/mods/interface),
[events](https://code.claude.com/docs/en/plugins/mods/events),
[test](https://code.claude.com/docs/en/plugins/mods/test),
[admin](https://code.claude.com/docs/en/plugins/mods/admin),
[samples](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods),
[built-in mods' source](https://github.com/anthropics/claude-code/tree/main/mods).

## How mods work

- **What one is.** A plugin whose `hooks/hooks.json` names one JS/TS module (`{"modules":
  ["./register.tsx"]}`) exporting `register(on, options)`. Every hook is `($, e, next)`: watch the
  event and `return next(e)`, change it with `next({...e})`, or answer without `next`. The module
  runs inside Claude Code with no Node and no DOM; everything outside goes through `$`
  (`$.fs`, `$.process`, `$.http`, `$.clock`, `$.store`, `$.state`, `$.model`, `$.session`,
  `$.prompt`, `$.tool`, `$.command`, `$.agent`, `$.ui`, `$.env`, `$.settings`).
- **What it can draw** (terminal and the Desktop app's Code tab; not the VS Code panel, `-p`, SDK):
  a pane (`$.ui.open` + `ui.render` on `Pane`), the band above the prompt (`AbovePrompt`), a status
  line (`$.ui.status`, always shown as `⚠ <mod>: …`), toasts, a dim transcript line (`$.ui.log`),
  native notifications, and Claude Code's own rows redrawn (tool rows, messages, the spinner, the
  AskUserQuestion dialog; never the permission prompt).
- **What it can hook.** Tool calls (`tool.call`: deny, rewrite, answer), the prompt (`prompt.submit`),
  the system prompt and per-request context (`prompt.compose`, `prompt.context`), turns
  (`turn.start`, `turn.step`, `turn.complete`), the session (`session.start`, `session.end`,
  `session.receive` / `session.send` for messages between sessions, `session.append` for every
  stored row), its own `/commands` and tools for the model, and the settings hooks' events
  (`classic.Stop`, …).
- **Lifecycle.** Installed as a plugin from a marketplace (`claude plugin install x@mkt`, user
  scope by default). A marketplace added from a local folder is read in place, so updating the
  folder and `/reload-plugins` updates it. `--plugin-dir` loads one for a session (and hot-reloads
  it). A reload runs `register` again and `session.start` again; `$.state` and `$.store` survive it,
  module variables do not.
- **Limits.** 10 s of a hook's own time per event, `$.process.run` 30 s by default, `$.store` 4 MiB,
  `$.fs` 4 MiB a file, redraws at most 10 a second (30 for a shown pane), a pane opened unasked only
  from 144 columns (110 after the person opened one), names up to 64 characters.
- **Off switches.** `disableAllHooks`, `--safe-mode`, `--bare`; an organization's
  `allowManagedModsOnly` / `allowManagedHooksOnly`. Mods are not sandboxed: they run as the user.

## What the probe showed (MasterDeck's sessions run as `claude --bg`)

| Question | Answer |
|---|---|
| Does a mod run in a background session with nothing attached? | Yes: `session.start`, `turn.complete`; it is even drawn, on a headless 195-column terminal |
| Does `claude attach` (MasterDeck's pane) show what it draws? | Yes: band, toast, status line, transcript line, at 80, 90, 110, 130 columns |
| Two clients attached at once? | Each draws the band at its own width |
| A resume with no flags (how MasterDeck resumes)? | The mod comes back: the session wakes with its saved options, `--plugin-dir` included |
| `session.attach` when someone attaches? | Not raised for `claude attach`: the mod cannot tell; nothing here needs it |
| The launching shell's environment? | **Not passed**: a background session runs with the daemon's environment, so `MASTERDECK_HOME` set for `claude --bg` does not reach the mod (it uses `~/.claude/masterdeck`) |

Not checked yet: a mod installed at user scope (the probe used `--plugin-dir`), instant typing
(`predictiveEcho`) with a band above the prompt, Windows, the Desktop app.

## MasterDeck today against mods

| MasterDeck today | With a mod |
|---|---|
| `Sender` types into the session's PTY | `$.prompt.submit` / `$.prompt.fill` (queued until idle, no typing) |
| `/queue` caught at UserPromptSubmit, handed over at Stop through files and rename claims | a real `/queue` command answered at once; `turn.complete` → `$.prompt.submit` |
| AskUserQuestion menus read off the screen (`claude logs` + headless xterm) | `tool.call` on AskUserQuestion: the question as data, and an answer from MasterDeck or a phone |
| The master reports guard: a jq regex in bash | `session.send` in TypeScript |
| Tokens and cost from transcripts | `$.session.usage()` / `session.measure` |
| Ticket context printed once at SessionStart | `prompt.context` / `prompt.compose`, every request, survives compaction and `/clear` |
| The deck hook is bash + jq, macOS only | a mod is JS inside Claude Code: Windows too |

What stays in MasterDeck: everything across sessions (the board, sessions, Needs you, GitHub polling
and accounts, PR watch, notes, starting and resuming, master-agent, the web app). A mod in every
session polling GitHub would burn the rate limit; the mod is a thin reader of what the app writes.

## Integration ideas, by priority

| # | Idea | Value | Effort |
|---|---|---|---|
| 1 | Bridge: the app writes per-session files, the mod reads them and writes a heartbeat (**built**) | foundation | M |
| 2 | Ticket band above the prompt (**built**) | high | S |
| 3 | `/md-note`, `/md-ticket`, `/md-board` (**built**) | medium-high | S |
| 3b | Every mod switched per session from Session details → Mods (**built**: the mod refuses others at `plugin.register`) | medium | M |
| 4 | Ticket context through `prompt.context` | medium-high | S |
| 5 | Agent-loop driver and progress band (#82): `turn.complete` runs the check, then submits the next round (**built**: `masterdeck-loop`) | high for #82 | M-L |
| 6 | Typing, `/queue` and AskUserQuestion through the mod | high (reliability) | L, in steps |
| 7 | The deck hook's guards and peer deltas in the mod (Windows) | high on Windows | M |
| 8 | Toasts for MasterDeck events (**built** for the band's own changes) | medium | S |
| 9 | Exact usage from `$.session.usage()` | medium | S |

## How MasterDeck should ship it

- **Built (#93):** the app bundles `mods/` and copies it to `MASTERDECK_HOME/mods/` (a
  local-folder marketplace read in place); Setup's Mods step and Settings install it with
  `claude plugin marketplace add <folder>` and `claude plugin install <name>@masterdeck --scope
  user` for each mod, plus `prependPlugins` (backups, as for hooks), and remove it again. An app
  update rewrites the folder; Needs you offers `/reload-plugins` for idle sessions on older mods
  (ARCHITECTURE, "Installing the mods").
- Trust the mod only per session, by its heartbeat: anywhere without one (older Claude Code,
  `disableAllHooks`, a policy, a failed load) the deck hook keeps working as today.
- Coexist with the user's mods: pass every event on with `next(e)` (no denies but the guards
  MasterDeck already enforces), draw the band above whatever other mods draw there, and keep
  state, store keys and commands under `masterdeck` / `md-`.
- Accounts need nothing in the mod: it never calls GitHub; the app writes the right account's data.
- Check `claude plugin validate --json` in CI so a new call (`http.fetch`, say) is a deliberate change.

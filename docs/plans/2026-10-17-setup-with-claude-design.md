# Let Claude do it: setup in a Claude terminal (#156): design

## Problem

First-run Setup is a six-step wizard (Account, Tools, GitHub accounts, Repos & boards, Mods,
Preferences). It asks a new user many choices at once. The Tools step already opens a Claude
session that installs missing tools (`INSTALLER_PANE`); the whole setup should be possible the
same way, in conversation.

## What changes

A **Let Claude do it** button (with Claude's mark) under Setup's title, on every step of the
first-run wizard and on the Settings page (Set up MasterDeck). It is shown in the Mac's window only
(the web app never opens it: Setup there cannot reach gh or the Mac's tools) and is off while
Claude Code itself is missing (Claude Code runs the session; the Tools step says how to install it).

Pressing it replaces the step's content with a panel: a header (Claude's mark, "Setting up with
Claude", **Back to the wizard**) and a Claude terminal. The session is briefed by a `CLAUDE.md` in
its own folder and talks to MasterDeck through a helper script, as the Board's ticket builder does.

### The session's folder: `<home>/setup-claude/`

Written by `setupClaudePrepare` (main) before the pane opens, fresh each time:

- `CLAUDE.md`: the briefing (`setupBriefing(platform)`, `shared/setupClaude.ts`): the five steps of
  the ticket, how to install tools on this platform (from `INSTALLABLE`, the installer flow's own
  list), the draft's format, and the rules: write only in this folder, never edit
  `~/.claude/master/config.json` or anything under `~/.claude`, never log in or switch gh accounts
  for the user, and never claim the setup is saved (only the user's click saves it).
- `md-setup.sh`: the helper (`setupScript(dir)`). Same transport as `create-ticket.sh`: it writes
  its NUL-separated arguments to `requests/<id>.req` and waits for `answers/<id>.json`.
- `.claude/settings.json`: the helper and the read-only tool checks (`gh auth status`,
  `<tool> --version`) may run without asking. Package installs still ask the user.
- Old `requests/`, `answers/` and `review.json` are removed. A `requests/` or `answers/` the session
  replaced with a link is removed, never followed (the sweep deletes old files there).
- A browser can neither open the pane (`ptyOpen` refuses `setup-claude` from a remote caller, and
  `WEB_PANES` leaves it out) nor call the three `setupClaude*` channels.

The pane (`PaneSpec` `{ kind: "setup-claude" }`, pane id `setup:claude`) runs
`claude -n md-setup --setting-sources project,local --permission-mode acceptEdits "<first message>"`
in that folder, like the builders: only project settings, so the user's hooks don't reach it. Its
session is MasterDeck's own and hidden from the session list (by name and folder, as the builders).

### The helper's commands

| Command | Answered by | Answer |
|---|---|---|
| `tools` | main (`setupTool` for each of claude, gh, python, git, jq) | `{ok, tools: {id: {ok, detail}}}` |
| `accounts` | main (`ghAccounts`) | `{ok, accounts: [{login, active, ok, projectScope}], error?}` |
| `discover <login>` | main (`detectEnv` + `cli.configDetectAll`, as that login's token, read-only) | owners, their repositories (open issue counts) and boards (number, title, columns, sprint field) |
| `gh-login` | the Setup window | shows gh's browser login (the wizard's own `gh-login` pane) above the chat |
| `review review.json` | the Setup window | checks the draft, fills the wizard with it, shows the summary card |

`discover` is what the wizard's Repos & boards step reads; main keeps each answer and hands it to
the window with the next poll, so the wizard does not read GitHub a second time.

The window polls `setupClaudePoll(known)` every 700 ms while the panel is open: main claims new
requests, answers the main-side ones itself and returns the others (`review`, `gh-login`) plus
the `discover` data not yet delivered. The window answers with `setupClaudeAnswer(id, answer)`.
No waiting on a click inside a request: Claude Code's Bash tool times out after two minutes.

### The draft (`review.json`)

```json
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
```

`readSetupDraft(raw, ctx)` (pure, `shared/setupClaude.ts`) checks it against what MasterDeck
knows: each login is one gh is logged in to (case-insensitive, written as gh spells it), and was
discovered; exactly one primary (one account: it is the primary); `repos` and `boards` are
`"all"` or ones `discover` found for that account; a repository or board belongs to one account;
the primary account has a repository; `primaryRepo` is one of its repositories (default: the
first); workspaces are short single-line strings. Errors name what to fix, so Claude can correct
the draft and run `review` again.

### Same save path as the wizard

The wizard's `save()` is split: `setupPatch(...)` (pure, `setupAccounts.ts`) builds the config
patch from Setup's values (or says what is missing), used by both the wizard's Finish/Save and
Claude's Save, then `deck().configSave(patch)` (`master config save`, validated by the CLI) as
today. A draft becomes Setup's values through `selFromDraft` (an account's repos and boards from
its `discover` data, `allRepos` / `allBoards` for `"all"`), and the commit name and email of each
account come from `ghUser` as when the wizard connects one.

`review` fills the wizard's state (connected accounts, primary, each account's repositories and
boards, workspaces, master-agent, notifications) before it answers, so the steps show what
Claude filled in at any later point.

### Confirming

The summary card above the terminal lists what will be saved (`draftSummary`): accounts and the
primary, each account's repositories (or all) and main repository, boards with their columns,
workspaces, master-agent, notifications, mods. Its buttons: **Save** and **Change in the wizard**.
Nothing is written before **Save**: the config is written only by the user's click in
MasterDeck's own window, never by Claude (the answer to `review` tells Claude so). The briefing
also has Claude show the same summary in the chat and ask for agreement first.

### After Save

Save runs, in order: notifications setting (if changed), mods (`modsInstall`, when the draft asks
and they are not installed; a failure is shown in the success view, not fatal), Remote (first run,
signed in, its switch on: as leaving the Account step does), `configSave`. Then the pane is closed,
and Setup shows a success view: "MasterDeck is set up" with the summary, and goes on by itself
after four seconds (or **Continue**) through `onClose()`, the same exit as Finish, so a first run
gets the Skills popup next. A failed `configSave` keeps the card with the error, and Claude keeps
running.

### Leaving early

**Back to the wizard**, **Change in the wizard**, or the session ending by itself (the user quit
Claude, it crashed) close the panel and return to the wizard on its Tools step with what Claude
had filled in (nothing is saved). A note says so. Pressing **Let Claude do it** again starts a new
conversation.

## Platforms

The helper is a bash script. On Windows, Claude Code runs its Bash tool in Git Bash, which runs it
(the folder path is written with forward slashes). `ponytail:` a PowerShell twin of the helper if
Claude Code on Windows without Git Bash becomes common.

## Not in scope

- The Account step (sign-in) stays the wizard's; Claude's flow does not touch it.
- "Issues whose code is in another repository" and the status mapping stay as detected; the user
  changes them in the wizard.
- The web app: no button.

## Tests

- `shared/setupClaude.test.ts`: `readSetupDraft` (one account primary by default, several need a
  primary, unknown or undiscovered login, unknown repo/board, a repo in two accounts, `"all"`,
  bad workspace), `draftSummary`, `setupBriefing` names every tool and the platform's installer,
  `setupScript` quoting.
- `setupAccounts.test.ts`: `setupPatch` (as the wizard: no account, no repo, bad email, code repos)
  and `selFromDraft`.
- `main/setupClaude.test.ts`: the pump (claim, main-side answers with fake handlers, window-side
  requests returned, answers written atomically, bad ids refused, file outside the folder refused).
- `paneCommand.test.ts`: the `setup-claude` command. `remoteDeck.test.ts`: the new methods blocked.

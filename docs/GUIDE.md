# MasterDeck

One window for all your Claude Code sessions. The sidebar on the left lists what needs you
and every session (tickets live in Board View and the ⌘K palette). Worker sessions open as tabs in the middle as real `claude`
terminals. master-agent is pinned on the right, and you can drag the divider to resize it.

It is a front end for the `master` CLI (`skills/master`). Every write goes through that CLI, so
the ledger's rules still apply: nothing is sent or spawned without an approved proposal.

Installing, setup and development are in the [README](../README.md). This guide covers what each
part of the app does.

## How it works

| What you see | Where it comes from |
|---|---|
| Sessions and their state | `claude agents --json`, polled every 3 s |
| Issues, PRs, session↔issue links | `master snapshot` at startup, then **every hour**, and on Refresh. The last result is cached in `~/.claude/masterdeck/cache.json` and shown at once on the next start |
| Needs you, proposals | `~/.claude/master/ledger.json` (watched) |
| Cost, context, model, mode | the status line hook's files in `~/.claude/masterdeck/stats/`; if a session has none, estimated from its transcript |
| Last tool, activity | the last 64 KB of the session transcript |
| Branch, ahead/behind, diff | `git` in the session's current directory |
| PR, CI, review state | `gh pr view` for the focused tab, every 60 s |

- **Tabs** run `claude attach <id>` in a PTY. Closing a tab only detaches; the background session
  keeps running. Tabs are keyed by the background id, which survives a resume (the sessionId
  does not).
- **Issues:** ● has a session (click to open it), ◐ is approved and waiting for master to spawn it,
  and ○ has no session. Clicking ○ opens the Assign dialog: it shows master's ASSIGN proposal if
  there is one, otherwise a fresh draft from `master draft-assign <n>`. Assign approves it, and
  master-agent spawns the session. The tab opens by itself when the session appears.
- **Master pane:** if master-agent is a background session, it is attached here. If it runs
  interactively in another terminal, the pane says so (it can't be attached). If there is none,
  **Start master** runs `claude --bg -n master-agent "/master"` in the configured workspace.
- **Status line hook:** on first launch the app copies `resources/statusline_tee.py` to
  `~/.claude/masterdeck/` and points `statusLine` in `~/.claude/settings.json` at it. The old
  status line is saved and still runs (its output is shown as before). A settings backup goes to
  `~/.claude/masterdeck/settings.backup.<ts>.json`. Remove it from the master pane's ⋯ menu.
  Set `MASTERDECK_NO_HOOK=1` to skip the automatic install.

## Starting and linking sessions

Clicking a ticket with no session (a card on the board, an issue in the ⌘K palette, or **Start…** on
an ASSIGN card in Needs you) opens the **Start** dialog:

- **System prompt:** master's ASSIGN text (babysit-ticket, worktree, reply protocol), editable.
- **Your first instructions:** optional. They are sent after the system prompt, and the session
  follows them instead of stopping to ask.
- **Start:** switches to Terminals at once with a "Starting…" tab. The app records and approves the
  proposal and runs `master spawn`. The tab attaches as soon as `claude agents` lists the session.
  The ledger lock means master can't spawn it a second time. If the spawn fails, the tab shows the
  error with **Retry**, which spawns the same (now held) proposal again.
- **Link session…:** links a session that already exists instead. Type its name, background id or
  session id (suggestions appear as you type). It runs babysit-ticket's `tt.sh link <issue>` for that
  session, so like any babysit-ticket link it moves the ticket to your in-progress status if it's earlier on the board.
  On Windows this needs Git Bash and `jq` on PATH.

## Keeping many sessions moving

- **Closing a Needs-you card (×):** hides it until the situation changes. A session card comes back
  after new activity in that session, a proposal when its status changes, a context warning at the
  next 10%, a budget card at the next multiple of the budget. Closing a proposal does not reject
  it; use Reject for that.
- **Command palette (⌘K / Ctrl+K):** type to jump to any session, issue (it opens the session, or
  Start) or PR (it opens the PR popup), or run an action: Refresh, a view, Broadcast, Standup, Sprint
  summary, Settings, New shell, Start master. The sidebar footer has the same tools as buttons.
- **Typing into sessions:** broadcast, quick reply, Continue and Compact now type into a session as if
  you wrote it. A session with an open tab gets the text there. A background session gets it through a
  hidden `claude attach` that closes after about 3 s (the session keeps running). A session in another
  terminal gets it relayed by master-agent. Never into a session waiting on a permission prompt: its
  text would answer the prompt, so those show **Open** instead.
- **★ Master (top right, every view):** shows or hides the master pane. Shown, it sits beside the
  board, PRs and the other views too; hidden, they use the full width. Hiding it doesn't stop or
  detach master.
- **After a restart:** background sessions run under Claude Code's daemon, so closing a terminal or
  MasterDeck doesn't stop them, but a restart or crash of the Mac does. MasterDeck keeps a list of the
  ones running (`~/.claude/masterdeck/running-sessions.json`); on the next boot a banner offers
  **Resume all**, which runs `claude --bg --resume` for each: same conversation, same id, same folder,
  still linked to its issue. Settings → *After the Mac restarts* can resume them without asking, or
  turn this off. master-agent is left out (it has its own Start). A session already running again is
  never resumed twice.
- **Queue (Queue Prompts in a session's header):** shows or hides the Queue panel under master, next
  to it rather than instead of it. It holds the focused session's `/queue`, the prompts it runs one by
  one as each response ends. Add prompts, reorder (↑ ↓), remove or clear them; the list updates as the
  session works through it. Pick another session from the menu at the top. An idle session only
  moves on after its next response, so the panel offers **Send next now**. In a session, `/queue
  <prompt>`, `/queue list` and `/queue clear` do the same. Needs the queue hooks (Setup → Hooks).
- **Broadcast (📣):** one message to the sessions you tick; each shows how it's sent, or why it can't be.
- **Quick reply:** a Needs-you card with a session's question has a reply box.
- **Idle nudges:** a session working a ticket but quiet for over N minutes (Settings) shows in Needs
  you with **Continue**. One stuck on a prompt that long shows "Waiting".
- **Auto-open:** when a background session blocks on a prompt, its tab opens (attached, not focused)
  and the dock bounces. The dock badge is the Needs-you count.

## Cost and context

- **Tokens:** each session's header shows **Tokens used** (input, output and prompt-cache, with the
  split on hover), and the Costs view shows tokens next to spend: per day, per ticket and per
  session. They are summed from the session's transcript and its subagents', counting each message
  once, by the day it was sent. The first Costs view reads your history once (a few seconds, in the
  background); after that only new lines are read (`~/.claude/masterdeck/tokens.json`). Cache reads
  are usually most of the total.
- **Costs view ($):** spend today, 7 and 30 days, a 14-day bar chart, and tables per ticket and per
  session. The data is the status line's cumulative cost, recorded per session per day in
  `~/.claude/masterdeck/costs.json`. Spend a session had before MasterDeck first saw it counts as a
  baseline: it's in All time and ticket totals, but not in any day.
- **Context warnings:** at the warning level (85% by default), a notification (once), a Needs-you card
  and a **Compact now** chip in the tab header, which types `/compact`.
- **Budget per ticket:** past $X (Settings), a notification (once) and a Needs-you card. Board cards show
  each ticket's spend.

## PRs and reviews

- **PRs view:** every PR in the org, mine and the team's: all open PRs plus the latest 300 closed or
  merged in the last 30 days. It is fetched when the view opens (if older than 10 minutes), on
  Refresh, and with the hourly GitHub refresh, through the shared cache. The last list is kept on
  disk for the next launch.
  - Presets: Everyone, Mine, Needs my review, Failing CI, Recently merged.
  - Filters: state (open, merged, closed not merged, closed or merged, any), created by (me first,
    then each author with a count), repository (with counts), review (needs my review, waiting,
    approved, changes requested, reviewed by me), CI, drafts, last updated (including stale 3+ or
    7+ days), unresolved threads, label, and a search over title, number, branch, author and ticket.
    Sort by recently updated, newest, oldest or largest diff. Filters are remembered.
  - Clicking an author or a repository in a row filters by it. **Review** opens the PR popup (it is
    highlighted when my review is requested); ↗ opens GitHub.
  - Closed PRs come without CI and threads: the full query times out on 100 closed PRs.
- **Fix CI / Address comments:** sent to the owning session in master's wording. With no session, the
  Start dialog opens with that instruction filled in.
- **Auto-babysit:** failing CI or unresolved threads on my PRs appear as offers, in Needs you and at
  the top of the PRs view. **Approve & send** uses master's own REVIEW/CI proposal when there is one;
  otherwise the offer goes straight to the session. Dismiss hides it until the situation changes.

## Board extras

- **Drag cards** between columns. The status moves through babysit-ticket (`tt.sh set --force`,
  against a temporary state folder, so no real session is touched). Moving backwards asks first; a
  failure puts the card back.
- **Summary:** done / in progress / blocked / to do, per person, and a burndown (one point per day, from
  each board refresh). Copy as Markdown.
- **Standup (🗒):** talking points per ticket, to read out on the call: **Done** / **Blocked** /
  **Waiting on my input** (from session reports), **PR up**, and up to three short **Worked on** lines from
  your commits (merge commits and conventional-commit prefixes dropped; "+N more commits" for the rest).
  Pick the range: Since last standup (Friday on a Monday), Yesterday, Last 3 days, This week, or Custom
  From–To dates; changing it re-reads git. **Copy points** gives plain bullets.

## Session hygiene

- **Janitor (🧹):** every worktree under `<repo>/.claude/worktrees`, classed like the worktree-janitor
  skill: SAFE, PUSHED, DIRTY, UNPUSHED, or IN USE (a live session works there). Remove works for SAFE
  and PUSHED; DIRTY and UNPUSHED need the name typed; IN USE can't be removed. Branches are never
  deleted. Parked sessions can be removed too (their transcripts stay).
- **Templates:** the Start dialog's Template… menu inserts a saved snippet ("TDD, small PR",
  "Investigate only", "Fix and open PR", "Pair with me", plus yours). **Save as template** stores the
  current text in `~/.claude/masterdeck/templates.json`.
- **History (🔎):** a full-text, any-case search over every session transcript (about 8 s over 1.3 GB).
  Results show the files touched and snippets, with Open for live sessions and **Resume here** for
  ended ones.

## Settings (⚙)

Nudge after N minutes, budget per ticket, context warning %, auto-open on prompts, dock badge.
Stored in `~/.claude/masterdeck/settings.json`.

- **GitHub & board:** reopens Setup (owner, issue repo, project board, status mapping, workspace,
  hooks). Saved to `~/.claude/master/config.json`.
- **Skills:** each bundled skill's state in `~/.claude/skills`. MasterDeck installs missing skills
  at launch and updates its own unchanged copies. A skill you edited, your own copy, or a symlink
  is left alone; **Replace with bundled** swaps it (the old folder goes to
  `~/.claude/skills/.masterdeck-backup/`).

## Links survive a resume

babysit-ticket links tickets to sessions **by session id**, and resuming a parked background session
gives it a new session id. MasterDeck remembers every session id each background session has had,
in `~/.claude/masterdeck/session-history.json`. It also recognises the original one, because a
background id is the first 8 characters of the original session id. When a resumed session has no
link, or only babysit-ticket's automatic branch link made in the first 2 minutes after the resume,
MasterDeck re-links it to its earlier ticket with `tt.sh link`. A link made on purpose later is left
alone. Each re-link is tried at most once every 10 minutes; a failure shows in the sidebar footer.

## One GitHub cache for everything

Every GitHub read on this machine that matters goes through `ghc`, a drop-in for `gh` that ships
with the master skill (`~/.claude/skills/master/ghc`, linked as `~/.local/bin/ghc`). Callers:
master's sweep and snapshot, MasterDeck (PR status per tab, PR popups, assignees),
babysit-ticket's `tt.sh`, and babysit-pr's poll loop.

- **Short-lived cache.** Reads are kept in `~/.claude/gh-cache` for a few seconds to minutes, so
  the same read from several sessions makes one call. TTLs: PR status 45 s, PR summaries 2 min,
  the board 5 min, assignees 10 min, your login 1 h.
- **One call at a time per read.** Identical reads made at the same moment wait for the first one
  and share its answer.
- **Writes go straight through.** Assign, comment, status change and the like reach GitHub at once.
  They also drop the cached reads they could have changed (an issue write drops board reads too).
- **One shared pause.** After a rate-limit error, every caller stops calling GitHub for 10
  minutes. Cached reads are served from the last answer, however old. The sidebar footer shows the
  pause, and otherwise today's hit rate ("GitHub cache today: 80% of reads served").
- `ghc --status` prints the pause and today's counters. `ghc --no-cache …` bypasses the cache.
  Escape hatches: `MASTER_NO_GH_CACHE=1` for master and `TT_NO_GH_CACHE=1` for `tt.sh`.
- On Windows, MasterDeck calls `gh` directly, because the cache's file locks are POSIX-only.

babysit-pr's poll also got cheaper: one GraphQL and one REST call per poll, down from three
GraphQL and two REST calls.

## Board View

The **Terminals | Board View** switch at the top of the sidebar replaces the tabs and master pane
with a Kanban board of your issues in the current sprint, in the project's column order. The
columns from your "ready" status to "dev done" always show; other columns appear when one of your
cards is in them.

- **Badge:** the Claude task state for the issue, first match wins: ❓ Question, ⛔ Blocked, ✋ Needs
  input, ⏳ Onboarding (approved or still setting up), ⚙️ Working, ✅ Done, 💤 Idle, ○ No session.
- **PR chips:** coloured by state (open green, draft grey, merged purple, closed red). Open PRs also
  show CI ✓ ✗ ● and 💬 unresolved threads. Clicking a chip opens the PR.
- **Clicking a card:** opens that issue's session in Terminals, or the Assign dialog if it has none.
- **Data:** `master board` (2 GitHub calls), refreshed together with the issues: at startup, every
  hour, and on **Refresh**. "refreshed 15 minutes ago" beside the button shows the last refresh. The
  board is cached with the issues, so it shows immediately on the next start.

## Environment

| Variable | Default | Use |
|---|---|---|
| `MASTER_CONFIG` | `~/.claude/master/config.json` | the shared GitHub/board config (Setup writes it) |
| `MASTER_WORKSPACE` | the config's `workspace` | where master and new sessions start |
| `MASTER_HOME` | `~/.claude/master` | ledger location |
| `MASTERDECK_HOME` | `~/.claude/masterdeck` | stats, hook, backups |
| `MASTERDECK_NO_HOOK` | unset | `1` skips the status line hook install |
| `MASTERDECK_NO_SKILLS` | unset | `1` skips installing the bundled skills at launch |
| `MASTERDECK_SKILLS_DIR` | `~/.claude/skills` | where bundled skills are installed |
| `MASTERDECK_SMOKE` | unset | `1` prints `SMOKE OK …` after the first healthy state and exits |
| `MASTERDECK_CAPTURE` | unset | path: save a screenshot after 8 s and exit (dev aid) |
| `MASTERDECK_USER_DATA` | unset | separate profile folder for a test run |
| `MASTERDECK_TEST_NO_ATTACH` | unset | `1` refuses `claude attach` (test runs) |
| `MASTERDECK_BOARD_FIXTURE` | unset | path to a `master board` JSON used instead of GitHub (test runs) |

## Keyboard

`⌘1`–`⌘9` (Ctrl on Windows) switch tabs, `⌘⇧W` closes a tab, and `⌘C` copies the terminal
selection.

## Windows notes

- Terminals use ConPTY (Windows 10 1809+). Shell tabs open PowerShell.
- `claude` is found with `where claude` (either `claude.exe` or npm's `claude.cmd`).
- The CLI runs as `python -m master.cli`; no bash needed.
- `claude attach` and `claude --bg` have not been tried on Windows yet. If attach fails, the pane
  shows claude's own error.
- Not yet verified on a Windows machine:
  - The status line hook runs your previous status line command with Python's `shell=True`, which
    means `cmd.exe`. A bash-only status line command (e.g. `bash "…sh"`) needs Git Bash on PATH.
  - The CLI uses `python`. If that is the Microsoft Store stub, install Python from python.org or
    turn off the app execution alias.
- Editor arguments go through `cmd.exe` when the editor is a `.cmd` shim. Paths containing `"`, `%`
  or `!` are refused and opened with the OS default handler instead.

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
| Needs you, proposals | `~/.claude/master/ledger.json` (watched); questions from the session's transcript and, for a menu, its screen (`claude logs`, every 4 s while it waits) |
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

- **Ticket description:** the issue's body from GitHub, editable. With **Include as instructions**
  ticked (the default), your edited copy is sent after the system prompt, and the session works from
  it instead of stopping to ask. Untick it to leave the description out; your edits don't change the
  issue on GitHub.
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

## Shells and manual sessions

**+ Shell** (Sessions header) opens a terminal in the workspace from Setup. If that workspace is a
git checkout on some other branch, it is first put on its default branch (origin's HEAD, else
main, master or dev): changes on the old branch are stashed, untracked files included, under a
message naming that branch (`git stash list`; `git stash pop` on that branch brings them back),
then it fast-forwards from origin. A toast says what happened. Only the workspace itself is
switched, and sessions running in that checkout see the new branch too.

A session you start yourself (`claude` in a shell) is not linked to any ticket unless you ask:
`/babysit-ticket` or `tt link <N>` in it, or **Link session…** in a ticket's Start dialog. Being in a
checkout whose branch was once linked to a ticket does not link it.

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
- **Workflow (🔀 in the sidebar):** the path from an issue to a merged PR, stage by stage (issue, Claude
  session, babysit-ticket, your instructions, work, before the PR, PR hooks, merged), with what MasterDeck
  and its skills do at each and every hook Claude Code runs there, read live from `~/.claude/settings.json`,
  your workspace repos' `.claude/settings*.json` and your enabled plugins. **+ Add a skill** attaches any
  skill in `~/.claude/skills` to a stage (session starts, linked to its issue, after a push, before the
  PR, PR created, PR merged): a hook in `~/.claude/settings.json` tells the session to run it at that
  point, in a background subagent or in the session, with your extra instructions. **+ Add an
  instruction** attaches plain text instead: at that point the session gets it as it is, no skill
  involved (e.g. after a push: "post the preview URL in the PR description"). Both are saved as soon as
  they are added, in `~/.claude/masterdeck/workflow.json`; **Edit** opens the step in place (Save, Cancel); a saved edit reaches sessions again, even ones that had the old text. Remove takes the hook out again.
- **Stopped sessions on an issue:** a card whose issue had a session that is no longer running shows
  **Stopped** (or Done) with that session and **Resume**; opening the issue lists every earlier
  session on it, newest first, each with Resume. The links come from babysit-ticket
  (`~/.claude/babysit-ticket/state.json`); resumes of one background session count as one; sessions
  whose conversation is gone (deleted, or only a title stub) are left out. Resume runs
  `claude --bg --resume` in the session's own folder.
- **After a restart:** background sessions run under Claude Code's daemon, so closing a terminal or
  MasterDeck doesn't stop them, but a restart or crash of the Mac does. MasterDeck keeps a list of the
  ones running (`~/.claude/masterdeck/running-sessions.json`); on the next boot a banner offers
  **Resume all**, which runs `claude --bg --resume` for each: same conversation, same id, same folder,
  still linked to its issue. Settings → *After the Mac restarts* can resume them without asking, or
  turn this off. master-agent is left out (it has its own Start). A session already running again is
  never resumed twice.
- **Worktrees (in a session's header):** one 📁 chip per git worktree the session created or
  worked in, in any repo (`repo / worktree`; hover for the path and branch), read from its
  transcript (EnterWorktree, `git worktree add`, where it ran). A session without one shows its
  folder. Click a chip to open it in your IDE: on macOS the app code files open with (for example
  Cursor, VS Code or Antigravity), else the first editor found, else `cursor` / `code`. ⌥-click
  copies the path.
- **Summary (in a session's header):** shows or hides the Summary panel under master: what the focused
  session did, in five parts (Goal, Done, Decisions, Open, State). **Summarize** / **Update** reads its
  transcript (your messages, its replies, files it edited, commands that change things), its PRs and the
  branch's changes, and asks a small model (`claude -p --model haiku`, about 20 s) for the summary; it
  runs only when you press it, and it is kept per session in `~/.claude/masterdeck/summaries/`. The panel
  says when the session has moved on since. **Post to issue** comments it on the session's issue.
- **Queue (Queue Prompts in a session's header):** shows or hides the Queue panel under master, next
  to it rather than instead of it. It holds the focused session's `/queue`, the prompts it runs one by
  one as each response ends. Add prompts, reorder (↑ ↓), remove or clear them; the list updates as the
  session works through it. Pick another session from the menu at the top. An idle session only
  moves on after its next response, so the panel offers **Send next now**. In a session, `/queue
  <prompt>`, `/queue list` and `/queue clear` do the same. Needs the queue hooks (Setup → Hooks).
- **Broadcast (📣):** one message to the sessions you tick; each shows how it's sent, or why it can't be.
- **Set a status by hand:** click the status chip in a session's header (or right-click it in the
  sidebar → Set status…). Pick a status (it stays, in the sidebar, header and board card, until you
  choose **Automatic**; Needs Input still shows while it waits on a prompt), or **Stop session…**:
  it ends (the conversation is kept and can be resumed) and leaves the sessions list at once. A
  session in another terminal is stopped there.
- **Session order:** the sidebar keeps your order; activity never reorders it. A new session goes on
  top once. Drag a session to move it; right-click → Move to top.
- **Right-click a session** for: Open, Set status…, Summary, Open ticket, Open PR (its newest),
  Open folder in editor, Move to top, and Stop session…. The copy commands are in the header's ⋯ menu.
- **Session status:** the sidebar and each session's header show one status, first match wins:
  **Needs Input** (a prompt or permission), **Working**, **Question** or **Blocked** (what it told
  master, or a question its last message asks you), then where its PR stands: **Merged** (all merged), **Rework** (you gave it more
  instructions after its last PR merged; a new PR then shows its own status, and once that is merged
  too the session is Merged again, however many PRs it takes), **Approved**, **Changes Requested**,
  **CI Failing** (a build or test check; not the review check), **Ready for Review**, **In Review**;
  then **Waiting** (its turn is over but a Monitor, background command or agent, or scheduled
  wakeup it started is still running; hover for which); otherwise **Idle**: nothing running, no
  question, waiting for your next instruction. Ready for Review: the automated review check (e.g. `claude-review`) passed or
  failed, or nothing new was said on the PR for 20 minutes (Settings), and the session is not
  working. In Review: the review check runs, or comments are recent. Draft PRs count. Hover a
  status for why. Notifications when a session becomes Ready for Review or its PR is merged. The PRs
  of every session are checked every two minutes while open.
- **Notifications:** every new Needs-you item (except held ones) shows a macOS / Windows
  notification; Settings → "Notify me when something new needs me" turns them off. Clicking one
  opens the item. On macOS a notification can also act: a button for the item's main action
  (Approve, Continue, Compact now, Send) and a reply field for a question; both go through the inbox
  like the cards. The first notification asks macOS for permission (System Settings → Notifications
  → MasterDeck).
- **Needs you is one inbox** (`shared/inbox.ts`, `main/inbox.ts`): the main process builds every item
  (questions and menus, sessions waiting on input, blocked, proposals, failing CI and review threads
  on my PRs, budgets, context, idle and waiting nudges), each with a stable id, a priority, the full
  text and its actions. Items are ordered by priority. Every action (reply, pick an option, answer a
  menu, continue, compact, approve, reject, send) goes through one path that first checks the item
  is still open and the session still in a state for it. **⏾** snoozes (an hour, 4 hours, until
  tomorrow); **×** dismisses until the situation changes. Items close by themselves when resolved
  (answered, CI green, threads resolved, active again…) and **Done today** lists what closed and
  how. It is saved in `~/.claude/masterdeck/inbox.json`; every addition, action and resolution is
  appended to `inbox-events.jsonl`, and notifications come from those events. The PRs view's
  "Needs its session" list is the same inbox.
- **Questions:** a session asking you something shows as a **QUESTION** card with the whole
  question, its options and a reply box.
  - An AskUserQuestion menu is read from the session's screen (`claude logs`; Claude Code writes it
    to the transcript only once it is answered). Click an option to answer the question showing; a
    multi-select takes ticks and **Next**; "write your own answer" is the menu's "Type something".
    After the last question, **Submit answers**. The keys go to the session's tab, or a short hidden
    `claude attach`, and only if the same question is still on its screen.
  - A question in words (`#N: question — …` to master-agent) shows what the session asked you,
    with any numbered or lettered choices in it as buttons (they reply "B: …").
  - Answered in the session itself (from here or in its tab), the card goes by itself, and the
    ledger is marked `sent` with "answered in the session", as master-agent would.
- **Needs-you popup:** click any Needs-you card for a popup with all of it: the full question,
  option descriptions, the message master sent, and the same buttons.
- **Idle nudges:** a session working a ticket but quiet for over N minutes (Settings) shows in Needs
  you with **Continue**. One stuck on a prompt that long shows "Waiting".
- **Auto-open:** when a background session blocks on a prompt, its tab opens (attached, not focused)
  and the dock bounces. The dock badge is the Needs-you count.

## Tasks

The **Tasks** tab (beside Terminals, Board View and PRs) shows every session as a task, so you can
see at a glance where the work stands:

- **Flow strip** at the top: one column per step (Started, Coding, PR open, Review, Merged), with
  the number of tasks on it and a pill for each. Click a pill to jump to its task.
- **Lanes:** tasks grouped by what they need: Needs you (a question, a prompt, a blocker, failing
  CI, changes requested), Working, In review, Idle, Merged and Parked (folded by default). Click a
  lane's title to fold or unfold it.
- **Each task** shows its ticket and title, session and branch, a five-step progress bar coloured
  by how the current step is going, its status, what it is doing right now (the question it asks,
  the tool it runs, or why it waits), when it was last active, its PRs with CI state (click one for
  the PR card), lines changed, cost and context used. Next to the status, a second chip says what
  the session itself is doing when that differs: Working, Waiting, Asked you, or **Idle** (waiting
  for your next instruction); the header counts the idle ones.
- **Permissions from Needs you:** when a session stops for a tool permission (run a Bash command,
  edit or create a file, fetch a URL…), its Needs-you card (PERMISSION) and its Tasks row show what
  it wants to do (the command or file, and its description), why it asks, the question, and each
  option as a button: **Yes**, the **don't ask again / allow all** option, and **No**. A click
  presses that option's number in the session, only if the same prompt is still on its screen.
- **Answer from Tasks:** when a session waits on you (a prompt or permission, a menu on its screen,
  a question in its last message, or a question or blocker it reported to master), its row opens an
  answer panel: the full question, its options (click one), and a reply box (⌘↵ sends). Answers go
  through the matching Needs-you item, so that item clears too. **Open** (or a double-click) opens it in
  Terminals.

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

- **PR tabs:** like the Board, the PRs view has tabs, starting with **Mine** (my open PRs, selected) and **Everyone**: **+** adds one, double-click renames, × closes.
  Each tab keeps its own filters and preset (for example one tab "Needs my review", another "Mine"),
  over the same list fetched from GitHub. Tabs are remembered.
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

- **Set up MasterDeck:** opens Setup as one page (tools, GitHub account, repos and boards, status mapping, workspace,
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

- **Several repos and boards:** the board shows the tickets of every repository and board chosen in
  Setup (Repos & boards; or Settings → Set up MasterDeck), fetched in one GraphQL query for all boards
  (plus one for their PRs). A ticket is a repo and a number: `#12` in the primary repository, `api#12`
  in another; two repos' `#12` never mix (sessions, costs, statuses, links, babysit-ticket and master
  all keep the repo). A card moves only within its own board's columns.
- **Tabs:** it starts with **Mine** (your issues, selected) and **Everyone**. **+** adds a tab; each tab has its own name (double-click to rename) and filters, over the
  same fetched board. **Repos** and **Boards** filters (with **Select all**) pick what a tab shows; with
  some boards picked, only their columns show. Tabs and their filters are remembered.

- **Badge:** the Claude task state for the issue, first match wins: ❓ Question, ⛔ Blocked, ✋ Needs
  input, ⏳ Onboarding (approved or still setting up), ⚙️ Working, then where its session's PR
  stands (🟣 Merged, 🔁 Rework, 👍 Approved, ✏️ Changes Requested, ❌ CI Failing, 👀 Ready for Review,
  🔍 In Review; see Session status), ✅ Done (the session told master it is done), 💤 Idle,
  ⏸ Stopped (can be resumed), ○ No session. Hover a badge for why.
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

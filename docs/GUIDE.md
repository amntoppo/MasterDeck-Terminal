# MasterDeck

One window for all your Claude Code sessions, laid out as a command center:

- **The rail** (far left): the views (Terminals, Board, PRs, Tasks), then Costs, Janitor,
  Notes and Workflow, and at the bottom Broadcast, Standup, Skills, Commands (⌘K) and Settings. A badge
  on Terminals counts what needs you; one on PRs counts PRs waiting on you. A blinking amber dot
  above the bottom buttons means a browser, phone or API client is connected right now (see
  *Remote connections* below).
  - **Your order:** drag any icon up or down the rail to move it, also between the top and the
    bottom; a line shows where it lands, and Esc cancels. With an icon focused, ⌥↑ / ⌥↓ (Alt+↑ / ↓
    on Windows) moves it one place. The line and the gap above the bottom group stay where they are.
    The order is kept in Settings (also for the web app's desktop layout); right-click the rail →
    **Reset icon order**, or Settings → General → **Rail icons**, puts it back. An icon added in a
    later version shows at its usual place. The phone's tab bar keeps its own order.
- **Terminals:**
  - **Sessions column:** what needs you, then the **tabs** (All and your own), then your **Starred** sessions, then every other session grouped by what it needs (Needs you,
    Working, In review, Idle, Merged; your drag order within each group), then open shells and
    sessions starting, and Parked; a **Filters** line above the groups narrows the list. Click one to open its terminal. **Split** shows two terminals
    side by side; **+** opens the new-terminal / new-session menu. A row always shows the session's
    name first; its ticket and account badge sit beside it, or on the line below when the column is narrow.
  - **Terminal:** the session's own `claude` terminal, in the middle, with no bar above it.
    **⌘-click** (Ctrl-click on Windows and in a browser off a Mac) an `http://` or `https://` link in
    it to open it in your browser: a dev server's `http://127.0.0.1:20060`, a link that wraps onto
    the next line, or a link with its own text (OSC 8). Hold the key over a link to see it underlined.
    A plain click still selects text. In the web app the browser opens it, so a `localhost` link
    is that computer's, not the Mac's.
  - **Right panel:** tabs **Details** (everything about the session: what it waits on, status,
    ticket and progress, PRs, worktrees, tokens, context, model, diff, and its actions; beside it the session's **Notes**), **Tools**
    (**Queue**, **BTW** and **Mods**) and **Summary**. Drag its edge to resize it; › hides it, **‹ Panel** brings it back.
- **Master:** master-agent's terminal in its own column at the far right, on every screen. The
  **★ Master** button (top right, always there; ⌘⇧M) shows or hides it; hidden, it stays attached.
- **The other views** use the full width (next to Master when it shows).

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
  **Start master** runs `claude --bg -n master-agent "/master"` in the configured workspace (the primary account's).
- **Status line hook:** on first launch the app copies `resources/statusline_tee.py` to
  `~/.claude/masterdeck/` and points `statusLine` in `~/.claude/settings.json` at it. The old
  status line is saved and still runs (its output is shown as before). A settings backup goes to
  `~/.claude/masterdeck/settings.backup.<ts>.json`. Remove it from the master pane's ⋯ menu.
  Set `MASTERDECK_NO_HOOK=1` to skip the automatic install.

## Starting and linking sessions

Clicking a ticket with no session (a card on the board, an issue in the ⌘K palette, or **Start…** on
an ASSIGN card in Needs you) opens the **Start** dialog. Its fields are in four groups: **Ticket**,
**Where it runs**, **Options** and **Instructions**. Enter in any one-line field starts, ⌘↵ (Ctrl+↵)
starts from anywhere, Esc cancels. With nothing changed, Start does what it always did.

- **Ticket description:** the issue's body from GitHub, editable. With **Include as instructions**
  ticked (the default), your edited copy is sent after the system prompt, and the session works from
  it instead of stopping to ask. Untick it to leave the description out; your edits don't change the
  issue on GitHub. **Text / Preview** switches between the Markdown text and the description as
  GitHub shows it (headings, lists, task lists, code, quotes, tables, links, images); the text is
  never changed by looking at it. A link opens in the browser (https only). An image that cannot be
  loaded (an upload in a private repository needs a login the app does not have) is shown as a link.
- **Create worktree** (the Mac's window only; off by default): MasterDeck makes a git worktree for
  the ticket before the session starts, `<checkout>/.claude/worktrees/<branch>`, on a new branch,
  and starts the session in it. **Branch name** is `<number>-<title>` unless you type another;
  **Base branch** is the repository's default branch as it is on this machine (nothing is fetched),
  or any branch you name. A branch or folder of that name already there, a base that does not
  exist, or anything else git refuses is said in the dialog and nothing starts. Unticked, the
  session starts in the folder shown and sets up its own worktree, as before. The box is greyed
  out when the folder is not a git checkout, or is a workspace where no checkout of the ticket's
  repository was found (choose its folder first); it is not shown for a refused start that is
  tried again. While Start is assigning or making the worktree the dialog cannot be closed.
- **Model** and **Permission mode:** `claude --model` and `claude --permission-mode` for the new
  session (Default, Plan mode, Accept edits, Auto). Default sends neither flag.
- **Assign to me:** shown for a board card nobody is assigned to. Ticked, the ticket is assigned to
  you (with two or more accounts: the account the session runs as) on GitHub before the session starts; if GitHub refuses, the dialog says so and nothing starts.
- **Remember these choices for `<repository>`:** ticked at Start, the worktree box, base branch,
  model, permission mode, workflow and assign-to-me become the defaults for that repository's next
  ticket (kept in this window's storage). Unticked at Start, they are forgotten. They are not
  applied to a dialog opened from master's proposal or from a refused start: unchanged, that
  proposal is approved or tried again as it is.
- The card moves to In Dev by itself once the session is linked, as before: there is no box for it.
- **System prompt** (closed until you open it): master's ASSIGN text (worktree, reply protocol; MasterDeck links the ticket itself), editable.
- **Your first instructions:** optional. They are sent after the system prompt, and the session
  follows them instead of stopping to ask.
- **Start:** switches to Terminals at once with a "Starting…" tab. The app records and approves the
  proposal and runs `master spawn`. The tab attaches as soon as `claude agents` lists the session.
  The ledger lock means master can't spawn it a second time. If the spawn fails, the tab shows the
  error with **Retry**, which spawns the same (now held) proposal again, as it is (never a second
  proposal, whatever model or account you picked).
- **A folder Claude Code has not been allowed to work in.** Claude Code starts a session only in a
  folder where its own trust prompt was accepted once. Claude Code looks at the folder and its parents: inside a git repository up to the repository's root, outside one all the way up. So a sub-folder of a trusted repository is fine, a plain folder under a trusted folder is fine, and a repository under a trusted plain folder (a checkout in a trusted workspace) is not.
  The dialog knows before you start (it reads Claude Code's `~/.claude.json`, and never writes it).
  For such a folder it says "Claude Code has not been allowed to work in `<folder>` yet." under
  the folder line, with **Open Claude there…**, and **Start** waits. The button opens a tab running
  `claude` in that folder; the dialog steps aside (what you typed is kept) while you answer Claude
  Code's prompt there, and comes back by itself as soon as the folder is trusted (it looks every two
  seconds, for ten minutes at most; **Back to the dialog** returns earlier): "Claude Code can work
  in `<folder>` now. You can close that tab." MasterDeck never answers the prompt for you and never
  closes that tab. **Start anyway** starts without waiting, for when MasterDeck read it wrong. A
  trusted folder, or one nothing is known about (no file, a linked worktree that is not listed, a
  folder that is not there), shows none of this and Start is never held back. In the web app and on a phone
  the line says to do it on your Mac, and Start stays available.
- **A start Claude Code refused** ("Workspace not trusted…") never ends there. The "did not start"
  tab says the same line, with **Open Claude there…** and **Try again** (**Start now** once the
  folder is trusted). If you closed that tab, or master started the proposal, the start is in Needs
  you as a HELD card with the same two buttons; **Try again** starts that same proposal, not a new
  one. Only a start MasterDeck's own spawn held for this reason can be tried again this way (not
  one held for anything else, such as a start that timed out and may be running). If the ticket
  has a session by then (you started it again another way), Try again starts nothing and closes
  the held start; the tab then says "#12 already has a session: `<name>`" with **Open it**. Opening the Start dialog for the ticket again starts from the held
  start ("the start Claude Code refused (proposal N); it is tried again"): unchanged, Start tries
  that proposal again; changed, a new one replaces it. Pressing **Open Claude there…** again for a
  tab whose Claude has exited starts Claude in it again. From a phone or the API the answer says to open Claude there on your Mac, and the held
  start's **Try again** works from the phone too. Any other failure reads as before.
- **Account** (two or more GitHub accounts): who the session works as; see Several GitHub accounts.
- **Where it starts:** the line under the Account field (near the top, so it is seen on a short window). MasterDeck looks for a checkout of the
  ticket's repository in the workspace of the ticket's account (Setup → Preferences): the workspace
  itself, its sub-folders, and one level below the sub-folders that are plain folders (an `acme/`
  folder of clones). A checkout is a folder with a `.git` folder whose `origin` is that repository
  (https or SSH, an SSH host alias, any case); linked worktrees are neither picked nor looked into,
  hidden folders are skipped, and links leading out of the workspace are not followed. With several
  checkouts of one repository, the folder named after it wins, then the nearest, then the shortest
  path. Found: "Starts in `<folder>`, your checkout of acme/api." The system prompt then says the
  folder is a checkout of the repository the issue is filed in, to work in a git worktree there,
  and, if the work belongs in another repository (a tracker repository that only holds issues), to
  use that repository under the workspace instead; it asks nothing. Not found: "No checkout of
  acme/api found in `<workspace>`." The session then starts in the workspace with the prompt it
  always had, and has to find the repository itself; you can still press Start. A very large
  workspace is not searched to the end (2000 folders): the line then says "No checkout of acme/api
  found — only the first 2000 folders of `<workspace>` were searched." **Choose folder…** picks
  another folder for this session; if it is a checkout of the repository the prompt says so. On
  the Mac it opens the folder picker and any folder will do. In the web app it lists the workspace
  and the repositories MasterDeck found in it, with a filter, and only those: a session started
  from a browser never runs in a folder you type. The prompt changes with the folder only while it is MasterDeck's
  own text: one you edited, or one master wrote for its proposal, is left alone. With two or more
  accounts the line also says who the session runs as, and the folder is looked for in that
  account's workspace: picking another **Account** looks again in the picked account's workspace
  (not after **Choose folder…**, and not for a refused start being tried again). A ticket with no
  repository of its own is looked up as the primary repository.
  **Issues built in another repository** (an issue tracker whose code lives elsewhere): add the pair
  in Setup → Repos & boards, under **Issues whose code is in another repository** (issues filed in
  `acme/tracker`, code in `acme/api`). A ticket of the tracker then starts in the checkout of
  `acme/api`, as the account that has `acme/api` (else the tracker's), and the line says "your
  checkout of acme/api (where acme/tracker's code lives)". The system prompt names the code
  repository instead of asking the session to find it. The session runs as the code repository's
  account, so that account must be able to read the tracker: a private tracker under another
  account cannot be read from the session (pick the tracker's account in the Start dialog then).
  For master's proposal the dialog looks the ticket up again: a checkout that exists now replaces
  the proposal's folder only when that folder is the plain workspace (a folder master chose on
  purpose stays), and the new proposal keeps the proposal's model; when nothing differs, master's
  own proposal is approved as it is. master's ASSIGN proposals and a PR's **Start review** (for the
  PR's repository, as the PR's repository's account: it reads and pushes there; the card's issue
  repository's account only when no account has the PR's) pick the folder the same way, and so does `master add` without `--cwd` for an
  ASSIGN or a PR review of a real issue; a meeting's session and any other kind start in the
  workspace, as before.
- **The PR of the folder's branch:** a session working by hand in a repository's main checkout on a
  feature branch is shown that branch's PR, and linking it records the branch, as always. A ticket
  or PR review session that MasterDeck itself started in a checkout is different: the branch it
  found there (whatever was left checked out, with its open PR) is not its own. MasterDeck
  remembers that branch ("parked on") and does not give the session its PR, or record it in the
  ticket link, while the session still sits in a main checkout on that same branch. As soon as it
  works in a git worktree, or that same checkout is on another branch (the session switched or
  made its own), the usual rules apply. In any other repository's main checkout (the prompt may
  send it on to one), or while the branch cannot be read, it is given nothing. A PR review session never takes the folder's branch PR. PRs a
  session opens itself count wherever it works. No session takes the branch PR of a workspace
  folder (the primary's or another account's).
- **Link session…:** links a session that already exists instead. Type its name, background id or
  session id (suggestions appear as you type). MasterDeck records the link itself (no
  skill needed) and, as the `ticket` step of the session's workflow (the Default workflow has it),
  moves the ticket to your in-progress status if it's earlier on the board.

### Asking master to start sessions

In master-agent's terminal or the MasterBar app's chat, ask in your own words:

- "start a session in MasterDeck-Terminal to fix the flaky tests" (from scratch: a task, optionally
  a repository or folder, a name, a new worktree, a model, a permission mode, an account);
- "start sessions for #42 and api#12", or "pick up everything in Ready For Dev assigned to me"
  (tickets by number, or by column, assignee, label or sprint on your boards).

master answers with a plan: one line per session (its name, folder, ticket, model, mode, account),
warnings (no checkout found, a folder Claude Code was never allowed to work in) and what it will
not start (a ticket not found, closed, or that already has a running session, with that session's
name). Nothing starts until you say yes: approve all, or keep only some ("start 14 and 16"). Say
"start it now" in the request to skip the question. Each session is a normal background session:
it shows in the session list at once, master replies with its `claude attach` id, and it keeps
running when master stops. A ticket's session starts in the ticket's repository checkout with the
ticket's title, description and sub-issues as its first prompt (as background: it sets up and asks
you for instructions first, unless your request gave some), and MasterDeck links it to the
ticket, moves the card to In Dev and assigns the ticket to you (say "don't assign me" to leave
that out). A start that fails stays in Needs you; nothing is tried again until you say so.

## Linked sessions

Link sessions that should know about each other: a backend session and the client one, two repositories
changed for the same ticket, a reviewer and the author. Any running sessions can be linked, in any
repository or GitHub account, up to 8 links per session. A link works both ways.

- **At start:** the Start dialogs (**Where it runs** in Assign, and **New Claude session…**) have a
  **Link to sessions** field. Pick running sessions; the new session knows them in its first message.
- **Later:** in a session's details, **Linked sessions** lists its links. **Add…** links another
  session, **×** removes one. With no links, **Link sessions…** is in the actions row.

What a linked session sees:
- A **Linked sessions** block: each peer's name, folder, branch, ticket, state and its summary. It is
  given when the session starts or resumes, and again after a compaction or `/clear`.
- When a peer's summary changes (it is made again after the peer stops, at most every 2 minutes, only
  when its transcript grew), a note about it comes with the session's **next prompt**, once. A session
  that was idle for hours gets one current note, not a backlog.
- Nothing is shared with a session that has no links. `peerSync.auto: false` in the app config turns
  off the automatic part; the block at start and **Sync now** still work.

**Sync now** (in the section) makes a fresh summary of the session and delivers what its peers have not
received yet, without waiting for their next prompt or Stop.

**Unlink or end:** removing a link stops further sharing at once; it does not take back what is already in a
session's transcript. A session that ends or is removed loses its links at the next poll.

On Windows (and where MasterDeck's hook is not installed) there is no per-prompt note: **Sync now** types
the update into peers that are idle, and skips busy ones.

A `/queue ...` prompt is handled as usual and does not use up a pending note: the note waits for your next
real prompt.

## Shells and manual sessions

**+** (Sessions header) opens a menu:
- **New terminal** (⌘T): a shell in the workspace from Setup (see below).
- **New Claude session…**: a background Claude session without a ticket. Pick its **workspace**
  (the workspace, one of its repos, or any other folder), its **name** (filled in as
  `<folder>-<n>`), an optional **first message** (without one it starts idle, waiting in its
  terminal), the **model**, the **workflow** template it starts with, and its **permissions**
  (as in your settings, plan first, accept edits, auto, or ask for everything). It opens in a tab.
  With two or more GitHub accounts the **account** comes first. The dialog remembers, per account,
  the workspace, model, workflow and permissions you last started with, and opens on the account
  you last used with its choices filled in; picking another account fills in that account's
  choices, except for fields you already changed. If you then pick another workspace, the account
  follows that folder again (its repository's account), unless you picked the account yourself in
  this dialog. Name and first message are never remembered. A
  remembered folder that is gone, or a model or workflow no longer offered, falls back to the
  default with a short note. The memory is kept per browser (the Mac's window and each browser
  have their own) and survives restarts.
- **Terminal in a repo ›**: a shell in any repo of the workspace.
- **Start from an issue…** (⌘K) and **Resume a past session…** (⌘⇧F).

**New terminal** opens a terminal in the workspace from Setup. If that workspace is a
git checkout on some other branch, it is first put on its default branch (origin's HEAD, else
main, master or dev): changes on the old branch are stashed, untracked files included, under a
message naming that branch (`git stash list`; `git stash pop` on that branch brings them back),
then it fast-forwards from origin. A toast says what happened. Only the workspace itself is
switched, and sessions running in that checkout see the new branch too.

A session you start yourself (`claude` in a shell) is not linked to any ticket unless you ask:
**Link session…** in a ticket's Start dialog. (`/babysit-ticket` or `tt link <N>` by hand only
updates the skill's own file, which MasterDeck no longer reads.) Being in a
checkout whose branch was once linked to a ticket does not link it.

## Schedules

Some work should run without you starting it: triage new issues every morning, update
dependencies every night, a security audit every Monday. **Schedules** (the clock in the rail,
under **More** on a phone, or **Go to Schedules** in ⌘K) starts a background Claude session for it
on a timer.

**New schedule** asks for:
- **Name**, and the **Prompt** each run gets as its first message. With a **Workflow** picked the
  prompt may stay empty: the run is then told to follow that workflow. The workflow is attached as
  in **New Claude session**, so its steps run in the session.
- **Model**, **Folder** (the workspace, one of its repos, or any other folder), **Account** (two or
  more GitHub accounts; by default the folder's) and **Permissions**.
- **When**: every day at a time, weekdays, on chosen days, every 1, 2, 3, 4, 6, 8 or 12 hours (at a
  minute), or a cron expression (minute hour day month weekday), in a **Time zone** (yours by
  default). The next three runs are shown in your own time; a cron that never matches is refused.
- **Skip a run while the previous one is still going** (on by default), **Notify when a run
  finishes**, **Notify when a run fails or is stopped**, a **Cost limit per run** (a run that spends
  more is stopped; its conversation is kept), and **Missed runs**: **Run once when back** or **Skip
  them**.

Each run is a real `claude --bg` session named after the schedule and its time
(`morning-triage-1017-0900`), started in the schedule's folder as its account. It shows in the
session list with a **⏱ schedule** chip, like any session you started yourself.

Claude Code starts a background session only in a folder you have allowed it to work in (its own
trust prompt). When a schedule's folder was never allowed, the editor says so before you save, and a
run it refused says so in the history, with **Open Claude there…**: answer Claude Code's prompt there
once and the next runs start.

Times are wall-clock times in the schedule's zone. When the clock goes back an hour, a time in the
repeated hour runs once; when it jumps forward, a time in the skipped hour runs at the first minute
after it (a daily 02:30 runs at 03:00 that day).

The list shows each schedule with an on/off switch, when it runs, its next run and its last run's
status and cost, and **Run now**, **Edit** and **Delete**. Click a schedule for its last runs:
when each started (on time, catch-up or Run now), its status (Running, Finished, Failed, Skipped,
Stopped, with the reason), how long it took, its cost, and its session (click to open it). A run is
finished when its session goes idle after working; one that waits on you (a permission prompt, a
question) is still running, for up to 12 hours: after that it no longer counts as running, so it
cannot hold the schedule back for ever. When a run is skipped because the previous one is still
going, you are told once (with **Notify when a run fails**).

Runs start while MasterDeck is open. When the Mac slept or MasterDeck was closed through one or more
runs, the schedule runs **once** when MasterDeck is back (or records them as skipped, if you chose
that), never one run per missed slot; and after a wake at most one such catch-up run starts every
30 seconds across all schedules. Pausing a schedule and turning it on again starts counting from
then: what it would have run while paused is not caught up. Deleting a schedule removes it and its
history; sessions it started keep running.

Schedules and their history are kept on this Mac (`schedules.json` in MasterDeck's folder). The web
app shows and edits them too. A run's notification goes out when the schedule's own switch says so
and **Settings → Notifications → Scheduled run** sends it somewhere (by default a system
notification; a click opens the run's session).

## A session's tabs: files and diffs

Each session's terminal has its own row of tabs above it. **Terminal** is always first; it cannot
be closed or moved. Other tabs show files and changes from the session's folder:

- **A file tab** shows the file: Markdown (`.md`) rendered (**Preview** / **Source**), anything
  else with syntax colours for its language and line numbers. A binary file, one over 1 MB or
  20,000 lines, or one that is gone says so instead. **Reload** reads it again (it also reloads
  when the session's turn ends); **Open in editor** opens it in your editor (desktop only).
- **A diff tab** shows what changed in one file: removed lines in red, added in green, with old
  and new line numbers. **Split** shows old and new side by side when the pane is wide enough
  (remembered). **Open file** opens the whole file next to it. It stays live while it shows.

Close a file or diff tab with **×** or a middle-click; closing the tab you are on moves to the one
on its right (else its left). Each session keeps its tabs when you switch sessions, after a
resume and after a restart.

Open files from:
- **Details → Diff**: the files changed in the session's folder, each with **A** (added),
  **M** (modified), **D** (deleted) or **R** (renamed) and its `+`/`−` line counts.
  **Uncommitted** compares with the last commit (new, untracked files count as added); **Branch**
  shows everything since the branch left the default branch, commits included: what a PR would
  hold. The list updates by itself every few seconds while it shows. Click a file to open its diff
  (or go to it when it is open already).
- **Details → Files**: the session's folder as a tree (git's files, ignored ones left out), with a
  filter box. Click a file to open it.
- **⌘P**: type part of a file's name in the open session's folder, ↵ opens it.
- **⌘-click a path in the terminal** (Ctrl-click on Windows) that Claude printed, relative or
  absolute, inside the session's folder (underlined while you hold the key).

MasterDeck only reads here: nothing in these tabs changes a file. The web app shows the same tabs,
reading the files on your Mac over the encrypted line, only inside the session's folder; a file or
diff too big to send says so.

## Keeping many sessions moving

- **Closing a Needs-you card (×):** hides it until the situation changes. A session card comes back
  after new activity in that session, a proposal when its status changes, a context warning at the
  next 10%, a budget card at the next multiple of the budget. Closing a proposal does not reject
  it; use Reject for that.
- **Command palette (⌘K / Ctrl+K):** type to jump to any session, issue (it opens the session, or
  Start) or PR (it opens the PR popup), or run an action: Refresh, a view, Broadcast, Standup, Sprint
  summary, Settings, New shell, Start master. The rail has the same tools as buttons.
- **Typing into sessions:** broadcast, quick reply, Continue and Compact now type into a session as if
  you wrote it. A session with an open tab gets the text there. A background session gets it through a
  hidden `claude attach` that closes after about 3 s (the session keeps running). A session in another
  terminal gets it relayed by master-agent. Never into a session waiting on a permission prompt: its
  text would answer the prompt, so those show **Open** instead.
- **Your half-typed prompt is safe:** a message from MasterDeck (a PR review, a monitor, a workflow
  step, a broadcast) never goes out mixed with what you were typing. With MasterDeck's mods
  installed, Claude gets it as a prompt of its own (shown as "Prompt from the masterdeck plugin")
  and your text stays in the prompt, cursor and all. Without them, MasterDeck waits while your
  prompt has text or you are typing: the session gets a **✉ 1** badge and a bar above its terminal
  with the message, who sent it, **Send now** (sends it now if your prompt is empty) and **Discard**.
  It goes by itself once your prompt is empty, or when Claude finishes the turn it is working on.
- **★ Master (top right, every screen, ⌘⇧M):** shows or hides master-agent's column. Drag its edge
  to resize it. Hiding it doesn't stop or detach master.
- **Workflow (on the rail):** a canvas where you build what sessions do, from an issue to a merged
  PR. Drag blocks from the palette on the left (or click one: it lands after the selected block,
  joined to it) and join them by dragging from a block's right dot to another block:
  - **Triggers:** session starts, linked to its issue, after a git push, before the PR, PR created,
    PR merged, **before / after a command** matching a pattern you type (a regular expression, e.g.
    `npm (run )?test`), **turn finished** (the session does these before it stops, once per turn),
    **needs you** and **idle for N minutes** (MasterDeck acts on these itself).
  - **Skills:** every skill `/skills` lists, grouped and expandable: yours (`~/.claude/skills`),
    synced, each enabled plugin's (named `plugin:skill`), and each workspace repo's `.claude/skills`
    (those work only in sessions in that repo). Searching opens the groups with a match.
  - **Actions:** a skill (in a background subagent or in the session, with extra instructions), an
    instruction (text the session is told as it is), or **Notify me** (a desktop notification, after
    Needs you or Idle; after Idle, instructions are sent to the session as a message).
  - **Built-ins:** board moves, the self-review before the PR, and the PR watch, all done by
    MasterDeck. Remove one to turn it off for sessions using that workflow.
  - **Arrows:** *then* (do the next block after this one; several arrows out of a block run side by
    side), *if it worked* and *if it failed* (dashed green and red: the session follows the one that
    matches how the step went). Pick the kind for new arrows in the toolbar, or select an arrow to
    change it. Select a block or an arrow and its settings open in a card over the canvas (click
    the canvas or × to close it); Delete removes the selection. **Tidy up** lines the blocks up.
  - **Loop:** a frame (under Actions) whose blocks the session repeats until the loop is done.
    Drag skills, instructions, monitors or notifications into it (a trigger, a built-in or another
    loop stays outside); drag one out to take it out. Move the frame by its header (its blocks
    move with it) and resize it from its bottom-right corner. Its card sets what ends it: a
    **check command** (passes when it exits with 0, or when its output matches or no longer
    matches a pattern, within a time limit of 1 to 9 minutes), **the agent says it's done** (with
    the goal it works toward; it ends its turn with a line starting `LOOP DONE:`), or both; and
    its limits: **max iterations** (1 to 100), **max minutes**, and **rounds with no progress**
    (3 on a new loop; 0 turns it off).
    Arrows into a block in the frame go to the frame (a loop starts at its top); blocks in it lead
    only to each other. Leave it with the toolbar's arrow kinds while the frame is selected: **when
    met** (green) and **at the limit** (amber); *then* goes on either way. One loop runs at a time,
    on the main path: put loops one after another, not side by side or inside an "if it
    worked/failed" branch. While a loop runs, the session can't end its turn until the loop is
    over (MasterDeck checks at each turn end and tells it to go on); **Stop loop** in the
    session's Details ends it. Your *When the session finishes a turn* steps wait while a loop runs and come
    with the message that ends the last loop. On a session's own workflow the frame's header shows where it is
    (`3/10 · last check failed`).
  - Drag the palette's right edge to make it wider or narrower (remembered; double-click resets).
  - Problems (a block no trigger reaches, a missing pattern) show as a red **!** on the block and a
    count in the toolbar; click the count to step through them.
  Changes save by themselves. **All hooks** lists every hook Claude Code runs (your settings, your
  workspace repos, enabled plugins).
- **Build with Claude:** the button in the Workflow window's header opens a Claude session on the
  right that builds workflows from what you ask ("after a push run the tests; if they fail fix
  them, if they pass post the preview URL"). It knows the format, every trigger and built-in, your
  skills and the workflow open on the canvas (MasterDeck writes them into its folder,
  `~/.claude/masterdeck/workflow-builder/`, as `CLAUDE.md` and `current.json`). It writes its
  workflow to `draft.json`; MasterDeck checks it (`check.json`, which the session reads back to fix
  problems) and shows it on the canvas with **Apply to <workflow>**, **Save as template**,
  **Discard** and a switch back to the current one. Drag the line between the canvas and the
  builder to resize it (double-click resets it). The session runs with your project settings
  only (your hooks and workflow steps don't reach it), edits its own folder without asking, and
  doesn't show among your sessions. **New chat** starts over; reopening continues the last chat.
  The first time, Claude may ask you to trust its folder. It can draft loops too ("after a push:
  until `npm test` passes, fix the failing tests; at most 8 rounds"), and the check reports a block
  it put in a loop that can't repeat there instead of leaving it out quietly.
- **Custom triggers:** besides the built-in triggers, a workflow can use triggers of your own: a
  Claude Code hook event (before a tool, after it, or when you send a prompt), the tool it applies
  to (e.g. `Bash`, `Edit|Write`), a regular expression on the command, the file path or the prompt,
  optionally one on the tool's output (e.g. `FAIL`), and how often it may fire. They live in
  `~/.claude/masterdeck/workflows/triggers/` and show under **Custom triggers** in the palette.
  MasterDeck adds one hook per event they use to `~/.claude/settings.json`.
- **The builder creates triggers and skills:** when a workflow needs a trigger or a skill that
  doesn't exist ("whenever a SQL migration is edited, review it for locks and missing rollbacks"),
  the builder defines the trigger in its draft and writes the skill (`skills/<name>/SKILL.md` in its
  folder). The draft's banner shows **+ N new triggers** and **+ N new skills** (hover for what
  they are). They are installed only when you **Apply** or **Save as template** (the skill into
  `~/.claude/skills`, the trigger into the library); **Discard** asks first and lists everything it
  throws away. A skill named like an existing one is refused.
- **Monitors:** a monitor is a watch script whose every output line is an event that wakes the
  session (Claude Code's Monitor tool): CI results on a PR, errors in a log, new review comments.
  A **Monitor** block (palette → Monitors) arms one at its trigger: the session is told the exact
  command, its timeout (at most 30 minutes), whether to re-arm it when it expires and until when,
  and what to do on each event. A block can pass arguments to the script (e.g. `<PR number>`,
  filled in by the session) and override what to do per event. The library lives in
  `~/.claude/masterdeck/workflows/monitors/` (a definition and an executable `<id>.sh` each).
  The builder creates them too: it defines the monitor in its draft and writes the script to
  `monitors/<id>.sh`; MasterDeck checks it (`bash -n`, unbuffered pipes, a description) and
  installs it on Apply / Save as template; Discard lists it with the rest.
- **Workflow templates:** the Template bar edits the **Default** (what every new session copies) or
  a template: **+ New template** starts one as a copy of the one shown; Rename and Delete work on
  templates. Templates live in `~/.claude/masterdeck/workflows/templates/`.
- **Built-in workflows:** MasterDeck ships five templates, marked **Built-in** on their tab; the line
  under the bar says what each does and when to use it. Each keeps board moves, the self-review
  before the PR and the PR watch, and loops until it can show its checks pass.
  - **Superpowers**: a feature big enough to design first; you answer questions at the start and
    approve the plan (it names the Superpowers skills, used if you have them installed).
  - **Ticket to PR**: a well-described ticket of ordinary size that needs no design session.
  - **Bug fix**: a bug report; it reproduces the bug and pins it with a failing test first.
  - **TDD (locked tests)**: behaviour you can state as inputs and outputs; the tests are committed
    first (a commit whose message starts with `tests:`), and MasterDeck checks that every test of
    every `tests:` commit on the branch stays unchanged while the code is written. Inside the loop,
    a reviewer looks for code that only fits the tests; a gap it finds gets a new `tests:` commit.
  - **CI doctor**: a branch whose CI should be green before review; after each push the session
    waits for every CI run of the commit, reads a failure and fixes it, until all of them pass. A
    commit no CI runs for passes too, and the session says so.

  Pick one in the Start dialog or apply it from a session's Details like any template. A built-in
  can be edited and renamed. Once its blocks change, the chip reads **Built-in · edited**. Once its
  blocks or its name differ from what MasterDeck ships, **Restore original** shows: it puts back the
  flow and name MasterDeck ships (your edits are lost; it asks first). **Duplicate** (in place of
  + New template) makes a copy of your own. Delete asks first and removes it for good until you
  press **Restore built-ins (n)**, which brings back every deleted one. A new MasterDeck version
  updates the built-ins whose blocks you have not changed (a renamed one keeps your name); an
  edited one is left as it is, and its line says when a newer version ships.
- **A session's own workflow:** each session gets its own copy the first time MasterDeck sees it: the
  Default, or the template picked under **Workflow** in the Start dialog. Its **Details** tab shows a
  **Workflow** line: the workflow point the session reached last (linked to its issue, pushed, PR
  created, merged…), read from its transcript (the commands it ran), its PRs on GitHub and the
  hooks' log, with what the workflow does there (built-ins and the plan's first lines; click for
  all of it). It pulses as **running** while the session works on that step (since its last turn
  end) or waits on the watch a built-in started there, else it shows how long ago; *Next* lists
  the points still ahead. Above it, each of the session's workflow loops has a line: while one
  runs, `↻ Fix the tests · iteration 3/10 · 12 min · last check failed` (pulsing); once it is over,
  how it ended (`done: …`, the limit it hit, or `stopped by you`). **Stop loop** (while it runs, after
  a confirm: a stopped loop can't be given more) lets the session end its turn at the next turn end.
  **History** lists every round, newest first (at most 50): its time, how long the check took,
  passed / failed / no check, *said done* when the session claimed it, and the check's output
  (click a round to unfold it), and under it what the session said it tried that round; then the
  loop's progress, every round's line, drawn as Markdown with every tag shown as text. A session in
  a loop ends each round with a line starting `PROGRESS:` that says what it tried; MasterDeck keeps
  those lines and shows the last three to the session at each round (the session writes no file for
  them). The session row in the list shows `↻ 3/10` while a loop runs, and `↻ ✓` (met) or
  `↻ !` (at a limit) for an hour after; hover it for the same line. On a phone the badge and the
  Details line are the same. A session keeps the hooks it started with (Claude Code reads them once),
  so this works for sessions older than a workflow change too. **Edit** opens the same editor
  as the Workflow window, full size, for that session only, with **Use a template… → Apply** and
  **Save as template**. Changing the Default or a template doesn't change sessions that already have
  their copy. Copies are in `~/.claude/masterdeck/workflows/sessions/<session id>.json`, and each run
  is logged in `workflows/runs.jsonl`. One MasterDeck hook per trigger in `~/.claude/settings.json`
  reads the session's copy (or the Default before it has one); workflows from older versions (a
  list of steps) are turned into flows at launch.
- **Stopped sessions on an issue:** a card whose issue had a session that is no longer running shows
  **Stopped** (or Done) with that session and **Resume**; opening the issue lists every earlier
  session on it, newest first, each with Resume. The links are MasterDeck's own
  (`~/.claude/masterdeck/ticket-links.json`; babysit-ticket's links were copied in once); resumes of one background session count as one; sessions
  whose conversation is gone (deleted, or only a title stub) are left out. Resume runs
  `claude --bg --resume <id>` in the session's own folder, with no other option: the same session
  wakes with its name, model and account as they were. (Any option there makes Claude Code start a
  copy and keep the old session in the list, which is how duplicate sessions with old messages
  appeared before.) A copy is made only when you pick another account for it; the old session must
  be stopped first. MasterDeck never removes a session: the old one stays in Claude Code, stopped,
  and MasterDeck leaves it out of its lists while it does not run (`~/.claude/masterdeck/superseded-sessions.json`);
  the copy keeps its ticket link and PRs, and master never proposes to resume the old one.
  Duplicates made before this fix are not cleaned up: remove the ones you don't need yourself
  (Session hygiene, or `claude rm <id>`; that also deletes the session's worktree).
- **A resume opens the session.** After **Resume** on a card, in the Start dialog or in History
  (**Resume a past session…**), MasterDeck closes the dialog, switches to Terminals and opens the
  session's tab on its Terminal with the keyboard in it, so you can type at once. A tab it already
  had is reused (a terminal that showed "Session ended" attaches again); until Claude Code lists the
  session the tab says "Resuming …". A resume that fails leaves you where you were with the error.
  **Resume all** after a restart opens nothing: it resumes many sessions and stays where you are.
- **After a restart:** background sessions run under Claude Code's daemon, so closing a terminal or
  MasterDeck doesn't stop them, but a restart or crash of the Mac does. MasterDeck keeps a list of the
  ones running (`~/.claude/masterdeck/running-sessions.json`); on the next boot a banner offers
  **Resume all**, which runs `claude --bg --resume` for each: same conversation, same id, same folder,
  still linked to its issue. Settings → *After the Mac restarts* can resume them without asking, or
  turn this off. master-agent is left out (it has its own Start). A session already running again is
  never resumed twice, also when MasterDeck is started a second time.
- **Session details (right panel → Details)** has two tabs, and the one you pick stays picked
  (per window; the web app keeps its own):
  - **Session:** what waits on you, the status, the workflow, schedules, linked sessions, the
    session's **Processes**, the worktrees or folder and branch, context, tokens, model, diff, and
    the session's actions.
  - **Processes** lists what the session started that is still running: its background commands
    (a dev server, `npm run dev`, `uv run …`), the tool call running now, and what a command left
    running when it ended (`cmd &`), with everything they started below them. Each row shows the
    command, how long it has been up, its pid, CPU and memory, its folder, and the **ports** it
    listens on: click `localhost:8000 ↗` to open it in your browser (on the web app the port is
    shown, not opened: it is on the Mac). Click the command to see the processes below it and its
    last output, which follows along. The list refreshes every few seconds while it is on screen;
    a background command that ends shows **exited** with its exit code for a minute, then drops
    off. macOS and Linux only for now.
  - **GitHub:** a row each for the **Ticket**, the **Pull requests** and the **Monitors**, with
    counts and status badges while closed and **↗** to open the item on GitHub. Click a row to open
    it, and open what is inside it in turn: the ticket's steps, its note and its **Sub-issues**
    (done of total; click one, or press Enter or Space on it, to read its description, status,
    assignees and labels in place); each PR's **Checks** (failing first), **Reviews** (the latest per reviewer),
    **Open threads** (file and the last comment), **Comments** (newest first) and, when MasterDeck
    watches it, **PR watch** with what it found and **Stop**; each monitor with the lines it printed,
    newest first, and **Stop**. Open rows refresh by themselves when the session's state changes (a
    PR also each minute) and stay open when you switch tabs or sessions. The last 50 events of a
    monitor are kept while MasterDeck runs; after a restart its list starts again. The tab's label
    counts the PRs and monitors, in red when a PR's CI fails or changes were asked for. The account
    the session works as is at the top.
- **Worktrees (Details tab, or ⌘E for a popup):** list every git worktree the session created
  or worked in, in any repo (repo / worktree, branch, path; click a path to copy it), read from its
  transcript (EnterWorktree, `git worktree add`, where it ran). Each has **Open in editor**: on macOS
  the app code files open with (for example Cursor, VS Code or Antigravity), else the first editor
  found, else `cursor` / `code`. A session without a worktree shows its folder.
- **Summary (right panel → Summary):** what the focused
  session did, in five parts (Goal, Done, Decisions, Open, State). **Summarize** / **Update** reads its
  transcript (your messages, its replies, files it edited, commands that change things), its PRs and the
  branch's changes, and asks a small model (`claude -p --model haiku`, about 20 s) for the summary; it
  runs only when you press it, and it is kept per session in `~/.claude/masterdeck/summaries/`. The panel
  says when the session has moved on since. **Post to issue** comments it on the session's issue.
- **Mods (right panel → Tools → Mods):** this session's Claude Code mods, each with a switch for
  this session; the label says how many are off (see MasterDeck's mods below).
- **Queue (right panel → Tools → Queue):** holds the focused session's `/queue`, the prompts it runs one by
  one as each response ends. Add prompts, reorder (↑ ↓), remove or clear them; the list updates as the
  session works through it. Pick another session from the menu at the top. An idle session only
  moves on after its next response, so the panel offers **Send next now**. In a session, `/queue
  <prompt>`, `/queue list` and `/queue clear` do the same. `/queue` is handled by MasterDeck's own
  hook, so it works in any Claude session on macOS and Linux, MasterDeck open or not; if you
  installed the queue skill's hooks by hand, MasterDeck leaves `/queue` to them. Sessions already
  running when MasterDeck took the queue skill's hooks out keep using those (Claude Code reads hooks
  when a session starts), and MasterDeck's hook stays out of `/queue` for them until they end.
  While a workflow loop runs, queued prompts wait until it ends (`/queue` still adds to the list);
  then the next one goes in, also when the loop ended and left the session idle (MasterDeck types it
  in, as **Send next** does, once).
- **Broadcast (📣):** one message to the sessions you tick; each shows how it's sent, or why it can't be.
- **Set a status by hand:** click the status chip in the Details tab (or right-click the session in
  the column → Set status…). Pick a status (it stays, in the column, Details and board card, until you
  choose **Automatic**; Needs Input still shows while it waits on a prompt), or **Stop session…**:
  it ends (the conversation is kept and can be resumed) and leaves the sessions list at once. A
  session in another terminal is stopped there.
- **Session order:** within each group the column keeps your order. A session moves to another
  group only when what it needs changes. Drag a session to move it; right-click → Move to top.
- **Tabs in the session list:** a line of tabs under Needs you groups your sessions by project or
  topic. **All** is first and always there: every session, whatever tab it is in. **+** adds a tab
  (type its name, Enter; Esc cancels). Drag a session from the list onto a tab to put it there (the
  tab lights up under the pointer); drop it on another tab to move it, or on **All** to take it out
  of its tab. Without dragging: right-click the session → **Move to tab ▸** (**No tab** takes it
  out). A session started from **+** → **New Claude session…**, or from the **Start** dialog (the
  Board, ⌘K), goes into a tab by itself: once you have a tab of your own, both dialogs have a
  **Session list tab** field, set to the tab on screen; pick another or **All (no tab)**. On Start
  the list shows that tab and the new session appears there as soon as Claude Code lists it (if the
  tab is deleted first, it stays in All). A session is in one tab at most and always also in All. Each tab shows how many sessions it
  holds and a red badge for those that need you. Inside a tab the column works as in All, on that
  tab's sessions only: Starred, the groups, Parked, Filters and Cleanup (Needs you and the shells
  stay the same in every tab). Double-click a tab to rename it, drag it to reorder it, right-click it
  for **Rename**, **Move left / right** and **Delete tab** (its sessions stay, in All). Tabs scroll
  sideways when they do not fit. The tabs and who is in which are kept on the Mac (the web app shows
  the same ones) and follow a session when it is resumed, also as a copy; the tab on screen is
  remembered per window or browser. A session that is gone from the list for ten minutes leaves its
  tab.
- **Starred sessions:** click the ☆ on a session's row (it shows on hover), right-click → Star, or
  **☆ Star** in the Details tab. A starred session sits in **Starred** at the top of the column and
  stays there whatever its status; its row still shows the status. Unstar it to send it back to its
  group. Stopping it, or it ending, takes the star off. Stars are kept across restarts (per
  window: the web app keeps its own). With nothing starred the section is hidden.
- **Filter the sessions:** the **Filters** line above the session groups is closed by default;
  click it to open the search (on the session name, its ticket and its repository's folder, every
  word must match) and the
  choices: **Status** (the column's groups, and Parked), **Account** (only with two or more
  accounts; "gh's active account" for a session started without one), **Repo** (the folder each
  session runs in; a session in a worktree counts under its repository) and **★ Starred only**.
  Within one kind any picked value matches; different kinds must all match. Closed, the line shows
  how many filters are on and a chip for each (× removes it; more than fit scroll sideways), and
  **Clear all**; closed, the line stays at the top while the list scrolls. When nothing matches,
  the column says so with **Clear filters**. Picking Parked opens the Parked fold (it stays open
  while that filter is on). Shells and starting sessions show only when no status, account, repo
  or star filter is on, and the search looks at their names. A folder chip shows as many parts of
  the path as it takes to tell two folders of one name apart. Cleanup offers only the sessions the
  filters show. The filters and
  whether the line is open are kept across restarts (per window: the web app keeps its own).
- **Right-click a session** for: Open, Set status…, Summary, Open ticket, Open PR (its newest),
  Open folder in editor, Star / Unstar, Move to top, Clone…, and Stop session…. The copy commands, Close terminal and Stop are in the Details tab.
- **Clone a session** (right-click → **Clone…**) to try another approach from the same point, or
  to run a side task with the same context. The dialog asks for a **Name** (`<name> (clone)` by
  default; `(clone 2)`, … when taken), an optional **First message** (what the clone should do
  next) and, when the session has a ticket, **Keep ticket link** (off by default: the board and the
  PR watch stay with the original). **Clone** starts a new background session with a copy of the
  whole conversation, in the same folder, as the same GitHub account, with the same model and
  permission mode when MasterDeck can read them from the conversation (plan, accept edits and auto
  carry over; bypass permissions never does; otherwise Claude Code's defaults). The clone's
  terminal opens as soon as it is listed (a "Starting…" tab until then, with Try again if it did
  not start); Details says "Cloned from <name>". The original keeps running, with its name,
  ticket and PRs: the clone does not take over the PRs the original made or its branch's PR (only
  ones it makes itself, or its own branch's once it switches). Clone is greyed out, with the
  reason, for a session with no conversation yet and for one waiting on your answer.
- **Session status:** the column and the Details tab show one status, first match wins:
  **Needs Input** (a prompt or permission), **Working**, **Question** or **Blocked** (what it told
  master, or a question its last message asks you), then where its PR stands: **Merged** (all merged), **Rework** (you gave it more
  instructions after its last PR merged; MasterDeck's own PR watch and monitor messages do not count; a new PR then shows its own status, and once that is merged
  too the session is Merged again, however many PRs it takes), **Approved**, **Changes Requested**,
  **CI Failing** (a build or test check; not the review check), **Ready for Review**, **In Review**;
  **Working** also while background agents or background commands it started still run (its turn
  is over, but the work isn't; hover for which), then **Waiting** (a Monitor or a scheduled wakeup
  it set up is still pending; hover for which); otherwise **Idle**: nothing running, no
  question, waiting for your next instruction. Ready for Review: the automated review check (e.g. `claude-review`) passed or
  failed, or nothing new was said on the PR for 20 minutes (Settings), and the session is not
  working. In Review: the review check runs, or comments are recent. Draft PRs don't count: a session whose open PRs are all drafts keeps its usual status (Working, Idle…) until one is marked ready for review. Hover a
  status for why. Notifications when a session becomes Ready for Review or its PR is merged. The PRs
  of every session are checked every two minutes while open.
- **Notifications:** every new Needs-you item (except held ones) shows a macOS / Windows
  notification; Settings → **Notifications** chooses which kinds notify you and where. Clicking one
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
- **A workflow loop at its limit:** when a loop ends at a limit (iterations, time, or no progress)
  without its criterion met, a **LOOP AT ITS LIMIT** card names the session, the loop and why it
  stopped. **Run 5 more** opens the loop again with five more iterations and, if the session is
  idle, types MasterDeck's own `Continue the loop "<name>".` into it (also from the notification and
  the web app). **Leave it** dismisses the card; **Open** opens the session. The card closes by
  itself once the loop runs again, and a loop that reaches its limit again is a new card. The card
  has no **Stop loop**: the loop is already over.
- **A workflow loop that paused:** a loop still running on a session that has been idle for 5
  minutes (Claude Code ends a turn after eight blocked stops in a row, or the session simply
  stopped) shows a **LOOP PAUSED** card with the loop and its round. **Continue** types
  MasterDeck's own `Continue the loop "<name>".` into the session (also from the notification and
  the web app); **Stop loop** ends the loop (after a confirm); **Open** opens the session. The card
  closes by itself once the session works again or the loop ends.
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
- **Permissions from Needs you:** MasterDeck registers its own Claude Code hook (see *MasterDeck's
  hook* below). When a session asks for a tool permission, its Needs-you card (PERMISSION) and its
  Tasks row show exactly what it wants to run (command, file or URL and its description) with
  **Yes**, **Yes, and don't ask again: <rule>** and **No**, plus an optional note that Claude reads
  when you choose No. The answer goes through the hook, so it works for any session, including one
  in another terminal. The terminal shows the prompt too; answering there clears the card. Sessions
  started before the hook was installed fall back to reading the prompt off the screen.
- **Cleanup:** the **Cleanup** button at the bottom of the Sessions column (next to Refresh) makes
  every session selectable, with the ones whose PRs are merged already picked. Click sessions to
  pick or unpick them (**None** / **All** clears or picks every one). **Stop sessions** stops the
  picked ones after one confirmation and closes their tabs; **Cancel** leaves Cleanup. Their
  conversations are kept, so you can resume one later from its ticket on the Board. Parked
  sessions show greyed out, since they're already stopped.
- **Questions from Needs you:** when Claude asks you questions (its AskUserQuestion tool), the
  hook holds them too. The card (QUESTION) and the Tasks row show each question with its header and
  its options with their descriptions: pick one, or several where it says *pick any*, or type your
  own answer under it. **Submit** sends every answer at once, and Claude reads them as yours.
- **The task's terminal:** click a task (not its buttons) to show its session's terminal under it,
  shorter than in Terminals; click again to hide it. It is the same terminal as the Terminals tab
  (same session, same output; typing goes to the session), not a new one. Claude's input box stays
  on its bottom line and the output above scrolls. Drag its bottom edge to change the height
  (remembered). One task at a time. While it shows, it sets the terminal's size; the Terminals tab
  takes its size back when you return there. A parked session shows **Attach** (attaching resumes
  it); one running in another terminal can't be shown. Double-click a task to open it in Terminals.
- **Answer from Tasks:** when a session waits on you (a prompt or permission, a menu on its screen,
  a question in its last message, or a question or blocker it reported to master), its row opens an
  answer panel: the full question, its options (click one), and a reply box (⌘↵ sends). Answers go
  through the matching Needs-you item, so that item clears too. **Open** (or a double-click) opens it in
  Terminals.

## MasterDeck's hook

At launch MasterDeck writes `~/.claude/masterdeck/deck/hook.sh` and registers it in
`~/.claude/settings.json` (a backup is kept) for PermissionRequest, Notification, StopFailure,
PreCompact, PostCompact, CwdChanged, SessionStart, UserPromptSubmit and Stop, and before the
Monitor and SendMessage tools. New sessions pick it up; running ones
after a restart.

- **Permissions:** answered from Needs you or Tasks (above). While MasterDeck is closed the hook
  returns at once and the terminal prompt works as always.
- **Exact status:** a session waiting on a permission shows Needs Input at once; one Claude Code
  reports idle shows Idle.
- **API errors:** a turn that ends on an API error (rate limit, overload…) becomes a Needs-you
  item, **API ERROR**, with **Continue**; Tasks shows it on the row.
- **Compactions:** Tasks shows *Compacting* while it runs and *compacted N ago* after.
- **Worktrees:** a session that moves into a worktree adds it to its Worktree list.
- **The ticket after a compaction:** a session on a ticket is told, after a compaction, resume or
  `/clear`, which ticket it works on and what earlier sessions on it did (their saved summaries).
  New sessions get the same from the Start dialog: **Include what earlier sessions did**.
- **Reports go only to master:** a session MasterDeck starts reports to master with SendMessage,
  first line `#12: done`, `#12: blocked — <reason>`, `#12: question — <question>` or
  `#12: answered — <answer>` (`repo#12` for a ticket in another repo). The hook checks every
  SendMessage: a message that starts like that (also `owner/repo#12`, and after `>`, `**`, a
  backtick, `## ` or `1. `) goes through only to the master session (the
  `masterName` in `~/.claude/master/config.json`, default `master-agent`). Sent to any other
  session, it is stopped and the session is told to send it to master by name and, if master is
  not reachable, to ask you there, so no other session ever receives a report or answers as if it
  were master. Everything else is untouched: other messages between sessions, messages to and
  from subagents (a subagent's `#12: done` to its parent passes), and whatever the master session
  itself sends. With master turned off (Setup → Preferences) a report
  goes to no session; sessions report in their own terminal. A changed master name applies at once.
  Needs `jq`; without it the hook lets every message through.

Not used: WorktreeCreate/WorktreeRemove, since a hook there would replace Claude Code's own worktree
creation.

## MasterDeck's mods

Claude Code mods (Claude Code 2.1.287 or later) that show inside a session what MasterDeck knows
about it, one mod per feature, each switched on or off per session.

**Installing them.** Setup's **Mods** step (and Settings → **Hooks, mods & skills** → **Mods**)
has **Install mods**: one press adds MasterDeck's folder of mods (`~/.claude/masterdeck/mods`) to
Claude Code as a marketplace, installs every mod for your user, and puts the core first in
`prependPlugins` in `~/.claude/settings.json`. It checks Claude Code's version first (2.1.287 or
later) and backs up `settings.json` before every change (`~/.claude/masterdeck/settings.backup.*.json`).
**Remove** takes the mods, the marketplace and the `prependPlugins` entry out again (the rest of
your settings stays). **Repair** shows when only part of it is there (a mod switched off by hand,
`prependPlugins` missing). New sessions load the mods; running ones at a reload.

**Updates.** Each MasterDeck update copies its mods into `~/.claude/masterdeck/mods`, which Claude
Code reads in place, so there is nothing to install again. Running sessions keep the older mods
until they reload their plugins: Needs you then shows a **MODS** item with how many sessions run
older mods (or none, after an install) and **Reload idle sessions**, which types `/reload-plugins`
into each one that waits at an empty prompt (never into one asking a question or a permission).
Settings → Mods has the same button. The others take the new mods when you reload them from
Tools → Mods, or at their next start.

**Where the order is not yours to set.** With your organization's managed settings in place, or
signed in to Claude Code with a Team or Enterprise plan, Claude Code ignores `prependPlugins` in
your own settings: the mods still load, but the core may load after the others and cannot switch
them per session. Setup and Settings say so; an admin can list `masterdeck@masterdeck` in
`prependPlugins` in the managed settings.

Then start or resume a session (or run `/reload-plugins` in one). In a session on a ticket, with
a PR or with linked sessions:

- **Ticket line** (`masterdeck-ticket`): a line above the prompt with the ticket, its board column,
  the PR with its CI and open review threads, and how many sessions are linked; short in a narrow
  terminal, with the title when there is room. **Details** (or `/md-ticket`) opens a pane with links
  to the ticket and the PR; **Hide** hides the line. With MasterDeck closed, the line says so and how
  old its data is.
- **Alerts** (`masterdeck-alerts`): toasts when the card moves, a review thread opens, CI fails or
  passes, or the PR merges.
- **Note command** (`masterdeck-note`): `/md-note <text>` adds the text to the ticket's note in
  Notes at once, without a turn of Claude (macOS and Linux).
- **Agent loop** (`masterdeck-loop`): `/md-loop [--max N] <check> -- <goal>`, for example
  `/md-loop npm test -- fix the failing tests`. Claude works on the goal; when its turn ends the check
  runs in the session's folder; while it fails, Claude gets its last lines and another round, up to N
  (5 unless you say). A line above the prompt shows the round and what runs, with **Stop**; it ends
  when the check passes, after N rounds, when you interrupt a round (Esc), press Stop, type
  `/md-loop stop`, or switch the mod off. `/md-loop` alone says where it stands.
- **Board** (`masterdeck-board`): `/md-board` opens a pane with the board of the session's account
  (its sprint, each column with its cards and how many there are), this session's ticket marked.
  Read only.
- **MasterDeck core** (`masterdeck`): nothing on screen; it does the switching below and tells
  MasterDeck which mods run in each session.

**Tools → Mods** has a switch per mod, for that session only:

- **MasterDeck** lists the core (always on: it does the switching) and the five feature mods. One
  switched off stops at once (nothing drawn or toasted, its command does nothing), and comes back at
  once when switched on.
- **Other mods** lists every other mod MasterDeck has seen in your sessions (yours, marketplace ones,
  ones loaded with `--plugin-dir`, the ones built into Claude Code). One switched off does not load
  in that session; one that is running keeps running until the session starts again ("Off from the
  session's next start"). Switched back on, it loads within seconds (Claude Code reloads its plugins
  in that session, one line in the transcript). Mods your organization manages and mods built into
  Claude Code cannot be switched here.
- The choices last across a resume. Mods load in every other session as usual.
- A running session takes new or updated mods only when it reloads its plugins. When a session runs
  older ones the tab says so, with **Reload plugins** (it types `/reload-plugins` into the session
  when it waits for you). MasterDeck's switches work before that too: the choice applies once the
  mod runs there.

The mods only read what MasterDeck writes and never talk to GitHub. In a session MasterDeck has
nothing for, they show nothing. To remove them all: **Remove** in Settings → Mods.

## Side questions (BTW)

**Tools → BTW** (the right panel) asks a quick side question about the session, the way Claude Code's
`/btw` does, without typing in the terminal:

- Type the question and press **Enter** (**Shift+Enter** for a new line), or **Ask**. The answer
  streams in under it ("Answering…" until the first words); **Stop** ends it.
- The answer comes from the session's conversation so far, with no tools (it cannot read files or
  run anything). It works while Claude is busy, does not interrupt it and is never added to the
  conversation. Each question also sees your last 20 side questions and their answers, as `/btw` does.
- Each answer shows Markdown and code, what it cost, **Copy** and **Remove**. One that failed says
  why, in red, with **Try again**.
- **History** lists every side question of the session, newest first, with its time (the exact time
  on hover), and is kept across restarts (`~/.claude/masterdeck/btw/`).
- A `/btw` you type in the session's terminal shows here too, marked **terminal**. Claude Code keeps
  those answers nowhere, so MasterDeck reads the answer off a background session's screen while the
  `/btw` box is open: only what fits in the box (the entry says so when the answer was longer). For
  an interactive session, or one asked before MasterDeck was running, only the question is there;
  **Ask here** puts it in the box to ask again from the tab.
- Each question from the tab reads the session's whole conversation once (a separate run of
  `claude`, with its own prompt cache), so it costs more than `/btw` in a long session; the cost is
  shown on the answer.

## Cost and context

- **Tokens:** the Details tab shows **Tokens** (input, output and prompt-cache, with the
  split on hover), and the Costs view shows tokens next to spend: per day, per ticket and per
  session. They are summed from the session's transcript and its subagents', counting each message
  once, by the hour it was sent. The first Costs view reads your history once (a few seconds, in the
  background); after that only new lines are read (`~/.claude/masterdeck/tokens.json`). Cache reads
  are usually most of the total.
- **Costs view ($):** the total for the chosen period, the sessions and tickets that spent in it, a
  bar chart and tables per ticket and per session. **The time filter** (top right) picks the period:
  Last 1 hour, Last 5 hours, Last 12 hours, Today, Yesterday, Last 7 days (the default), Last 30
  days, All time, or **Custom…**, a From and To date and time (the To minute counts; an end before
  the start is refused). Today and Yesterday follow your Mac's time zone. The list shows the period
  ("Last 7 days", or a custom "3 Oct – 9 Oct", with times when it has any; ✎ changes it), and the
  choice is remembered across restarts. Everything but the **All time** column follows it; the
  chart has a bar per hour (up to two days), per day (up to two months), per week, then per month.
  A period with nothing in it says **No costs in this period**. The data is the status line's
  cumulative cost, recorded per session per hour in `~/.claude/masterdeck/costs.json` (kept per day
  once a month old, and from before this version). A period that starts or ends inside a clock hour
  gets that hour's share by time (so Last 1 hour is an estimate within the hour); spend a session
  had when MasterDeck first saw it today counts in that hour. Spend a session had before MasterDeck
  first saw it on an earlier day counts as a baseline: it's in All time and ticket totals, but not
  in any period. **USD / Tokens** (top right)
  switches the whole view to tokens: the figures, the chart and both tables (sorted by tokens), with
  dollars as the second figure. The choice is remembered.
- **Hours (Costs view, desktop only):** the third choice beside USD / Tokens: an *estimate* of how
  long you worked per GitHub account, per day and per ticket, from when your sessions on this Mac
  were active (every line of their transcripts and their subagents'). It is not a time tracker. The
  rule is written next to the numbers: a gap of up to 1 hour between a session's activity counts as
  working, a longer one does not (pick 15 min, 30 min, 1 h or 2 h; remembered), whether you were there
  or the session worked on its own. An account counts each minute once, however many of its sessions
  were active then; a ticket gets its full time, so two tickets worked from 10:00 to 11:00 show 1 h
  each and 1 h for the account. A session with no ticket counts for its account only. A session's
  account is the one it was started as, else the account of its folder's repository, else of its
  ticket's repository (a removed worktree), else (with one account) that account; anything else is
  listed as **unknown account**. A resumed session is one session: the gap across the resume is
  filled like any other. All of a session's time goes to the ticket it is linked to now. The numbers
  refresh every minute while the tab is open; the time filter cuts them to its period. Click a day to see its tickets. **Export CSV…** saves `date,account,ticket,minutes` for the range (an `(account total)` row
  per account and day, then its tickets) where you choose. Only this Mac's sessions are counted, and
  only sessions the Costs view knows (those with a status line record). Nothing of it goes to the
  web app, a phone or the API.
- **Context warnings:** at the warning level (85% by default), a notification (once), a Needs-you card
  and **Compact now** in the Details tab, which types `/compact`.
- **Budget per ticket:** past $X (Settings), a notification (once) and a Needs-you card. Board cards show
  each ticket's spend.

## PRs and reviews

- **PR tabs:** like the Board, the PRs view has tabs, starting with **Mine** (my open PRs, selected) and **Everyone**: **+** adds one, double-click renames, × closes.
  Each tab keeps its own filters and preset (for example one tab "Needs my review", another "Mine"),
  over the same list fetched from GitHub. Tabs are remembered.
  With two or more GitHub accounts each tab shows one account's PRs (its owner's), with a badge; **Mine**,
  **Needs my review** and **Reviewed by me** use that account's login, and the presets work inside the tab's
  account. The first select in the filter row changes the tab's account (and clears its repo, author and label
  picks); connecting another account adds a **Mine** tab for it once. With one account nothing changes.
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
- **Review with Claude:** a Claude session on the right of the PRs view, one per PR tab (as the
  tab's account with two or more accounts). Click a row to pick a PR (it is highlighted, and the
  pick is remembered per tab); the panel's head says **Reviewing owner/repo#123**. Ask "review this
  PR", "summarise what changed", "is it safe to merge?", "what does the CI failure mean?": it reads
  the PR's diff, checks and comments with `gh`. Open it with **Review with Claude** in the header,
  the Claude mark on a row (picks the PR and asks for a review), or **Review with Claude** in the
  PR popup. Drag its edge to resize (double-click resets), **›** hides it (the session goes on),
  **×** ends it, **New chat** starts over; opening it again later continues the last conversation.
  - **Posting:** it writes nothing to GitHub until you agree. It shows the exact review (comment,
    approve or request changes, with any inline comments), and posts it only after your yes, with
    MasterDeck's `post-review-<tab>.sh` (kept in `~/.claude/masterdeck/pr-review-guard/`, out of the
    session's reach), which Claude Code asks you to allow each time. The script posts only to the
    PR picked in the list, and only as the tab's account; `gh pr review`, `gh pr comment`, `gh pr
    merge` and the like are blocked in that session.
  - Its folder is `~/.claude/masterdeck/pr-review/tab-<tab id>/` (`CLAUDE.md`, `context.json` with
    the tab's filters and the picked PR, kept current by MasterDeck). The session is not listed with
    your sessions. On a phone the panel covers the list; **›** goes back to it.
  - **Automate Review and Merge automatically (#157):** **◂ Auto** at the panel's bottom left shows
    or hides a small card beside the chat's input box (remembered); on a phone it sits above the
    tip line. Its two switches are per PR tab and kept across restarts.
    - **Automate Review** adds a MasterDeck monitor (**Automate Review · <tab>**, by MasterDeck; ▴
      on the card shows its events and **Stop**) that checks GitHub every 2 minutes, as the tab's
      account, for open PRs whose review is asked of you or one of your teams (the tab's repository
      when its Repo filter is set, else the account's owner). Each new request is typed into the
      tab's review session once Claude's turn is over and you have not typed there for 30 seconds
      (no session running: one is started, and the panel shows it). Claude reviews it and posts a
      **comment** review at once with the post script's `--auto` form; it never approves or requests
      changes. A PR is reviewed once, and again only after new commits. The card's status line
      says "Watching · 2 reviews in progress · last check 1 min ago"; ▴ lists each PR and where it
      is (waiting, reviewing, comments sent, approved, ready to merge, merged, could not merge).
    - **Needs you** (Settings → Notifications → **Automated review**, on by default): "Review
      comments sent on owner/repo#123" (with the number of comments), "owner/repo#123 is ready to
      merge" (approved, every check green, no conflicts), "Merged owner/repo#123", "Could not merge
      owner/repo#123", each with **View on GitHub**.
    - **Merge automatically** is off by default and needs Automate Review. Turning it on shows a
      warning first. Then a PR the tab reviewed is merged with `gh pr merge` as the tab's account,
      with the repository's default method, once it is ready: open, not a draft, approved, every
      check green, no conflicts, GitHub's merge state clean (branch protection satisfied) and no
      commits since the review. Nothing failing, pending or blocked is merged, branch protection is
      never bypassed, and a failed merge is not tried again for the same commit. A browser can turn
      it off, not on.
    - Closing the tab or changing its account switches both off.
  - **Watched PRs (#182):** ▴ on the card also lists the PRs MasterDeck watches for the tab: the
    ones you watch from it, and your sessions' own PRs (of the tab's account). Each row shows the
    PR, its title, where its events go, what it last saw and when, and **×** to stop watching it.
    **Add** takes a PR link (`https://github.com/owner/repo/pull/123`), `owner/repo#123`, or `#123`
    / `123` in the tab's repository (its Repo filter, else the account's issue repository). It reads
    the PR as the tab's account first and says what is wrong in the card: not a PR, not found or no
    access, no such PR, merged or closed, already watched.
- **The eye (#182):** each open PR (row and PR popup) has an eye: filled when MasterDeck watches it,
  dimmed when not. Its tooltip says where the events go ("Watched: events go to session
  login-redirect", "… to this tab's Review with Claude session", "Not watched: click to watch").
  Click it to watch the PR or stop watching it, as the PR tab's account. One watch per PR: a PR
  already watched keeps its watch. A session's own PR (watched automatically) shows the eye filled;
  turning it off asks first, and that PR is not watched again by itself. A watch you start:
  - starts quiet: what is on the PR already is not news;
  - goes to the session that owns the PR (made it, or works on the issue it closes), as a session's
    own watch does, with the same delivery rules; the owner can come later, and when it ends the
    watch falls back to the tab's review session;
  - with no such session, goes to the tab's **Review with Claude** session (started if none runs):
    new comments, reviews, review threads and a merge conflict are typed there as one line asking
    Claude to summarise them (it never replies, pushes or merges for them); new commits are
    reviewed as Automate Review does, also while Automate Review is off (Merge automatically still
    merges only what the tab reviewed, with the switch on); "ready to merge", "merged", "closed"
    and "can't read it any more" go to Needs you (**Automated review** in Settings → Notifications);
  - ends by itself when the PR is merged or closed (the eye turns off), is kept across restarts
    (`pr-watch.json`), shows in the session's Details → GitHub → Monitors when a session owns it,
    and works the same in the web app. Closing the PR tab ends the watches it sent to its review
    session.
- **Fix CI / Address comments:** sent to the owning session in master's wording. With no session, the
  Start dialog opens with that instruction filled in.
- **Auto-babysit:** failing CI or review feedback on my PRs appear as offers, in Needs you and at
  the top of the PRs view. **Approve & send** uses master's own REVIEW/CI proposal when there is one;
  otherwise the offer goes straight to the session. Dismiss hides it until the situation changes.
  Review feedback is unresolved comments on the code, plus ordinary PR comments and review
  summaries (a note left with a review, or any Changes requested) from others since your last
  comment or review on the PR. Bots count only when they are the Claude reviewer; deploy-preview
  and other bot comments do not.

## Board extras

- **Reorder columns:** press and hold a column's heading until it lifts, then drag it left or
  right; the other columns make room. Near the board's edge it scrolls, so a column can go past
  what's on screen. Release to drop, Esc to put it back. The order is saved and applies to every
  tab; columns you hide keep their place.
- **Dragging a card** to another column scrolls the board the same way near its left or right
  edge, and scrolls a long column near its top or bottom.
- **New ticket (+ on a column):** each column's header has a **+**. It opens a dialog for an issue
  that lands in that column: title, description (Markdown), repository, account (two or more GitHub accounts), status, board (with
  several), sprint, milestone, assignees and labels. Defaults come from where you clicked: the
  column, the board, the tab's filters (people, labels, milestone, the first picked repo) and the sprint
  the Board shows. **Create ticket** does it in MasterDeck (no skill needed): the issue, added to the
  board with its status and sprint. Changing a card's status from the Board is also done by
  MasterDeck. In a tab with no GitHub board the + is on Todo only and the ticket is created without
  a board step (no status, board or sprint); Create with Claude there is told the same, is given only
  that account's repositories, and never puts the ticket on another account's board (naming one is
  refused). In a repository view the + is on Todo only too: the dialog opens with the first picked
  repository (the + names it), and the ticket goes on the tab's board in its "ready" column, with no
  sprint (change the repository or column in the dialog).
- **Create with Claude:** from that dialog, a Claude session opens on the right of the Board (only
  there; it keeps running while you look at another view, and its edge drags to resize). It knows
  the boards, columns, sprints, repos and people, and where the + was clicked (its folder,
  `~/.claude/masterdeck/ticket-builder/`, has `CLAUDE.md` and `context.json`). Ask for a ticket, or
  several ("split this into tickets"); it writes them and creates them on the board with
  `./create-ticket.sh` (the one command it may run without asking), and the Board refreshes with a
  note of what it created. What you typed in the dialog is handed over as a draft it shows you
  before creating. The first time, Claude asks you to trust its folder (it pre-approves the create
  command). **New chat** starts over (the settings bar keeps its values).
  - **The settings bar**, below the chat, says what every ticket it creates gets: repository,
    people, column (and board, with several), sprint, labels and milestone, on one line. Click it to
    change them (label and milestone choices follow the repository; column and sprint follow the
    board); a change applies to the next ticket, without a new chat. It starts from where you
    clicked: the column, the tab's filters and sprint, or what you picked in the New ticket dialog.
    The bar always wins: MasterDeck creates the ticket with its values whatever Claude passes. Ask
    for something else in the chat ("assign it to Ravi") and Claude says the bar's value applies, so
    change it in the bar; if Claude passed another value anyway, it tells you which one was used.
  With two or more GitHub accounts each Board tab has its own Create with Claude session, working
  as the tab's account (its header says `as @login`; its folder is
  `~/.claude/masterdeck/ticket-builder/tab-<tab id>/`). Tickets it creates go in as that account.
  Switching tabs shows that tab's session (the others keep running); closing a tab, or changing its
  account, ends its session (reopening the tab can continue the chat). An account that needs to log
  in again shows the error in the panel instead of starting as another account.

- **Drag cards** between columns. MasterDeck moves the status itself (the board write
  babysit-ticket used to make, forced for a drag). Moving backwards asks first; a
  failure puts the card back.
- **Summary:** done / in progress / blocked / to do, per person, and a burndown (one point per day, from
  each board refresh). Copy as Markdown.
- **Standup (🗒):** talking points per ticket, to read out on the call: **Done** / **Blocked** /
  **Waiting on my input** (from session reports), **PR up**, and up to three short **Worked on** lines from
  your commits (merge commits and conventional-commit prefixes dropped; "+N more commits" for the rest).
  Pick the range: Since last standup (Friday on a Monday), Yesterday, Last 3 days, This week, or Custom
  From–To dates; changing it re-reads git. **Copy points** gives plain bullets.

## Session hygiene

- **Janitor (🧹):** every worktree under `<repo>/.claude/worktrees` (the repos of every account's workspace, also one level down in a folder of clones), classed like the worktree-janitor
  skill: SAFE, PUSHED, DIRTY, UNPUSHED, or IN USE (a live session works there). Remove works for SAFE
  and PUSHED; DIRTY and UNPUSHED need the name typed; IN USE can't be removed. Branches are never
  deleted. Parked sessions can be removed too (their transcripts stay).
- **Janitor → Meetings** (macOS, in MasterDeck's window only): every recorded meeting with its date,
  title, audio size and transcript size, and the totals. **Older than 7 / 30 / 90 days** picks those
  meetings (or tick them by hand); **Delete audio** removes their recordings and keeps the
  transcripts, **Delete meetings** removes transcripts and audio. The notes a meeting added always
  stay: they are your notes. MasterDeck asks on the Mac first; more than 10 at once need the number
  typed. The meeting being recorded can't be picked. Works after **Turn off meetings** too.
- **Templates:** the Start dialog's Template… menu inserts a saved snippet ("TDD, small PR",
  "Investigate only", "Fix and open PR", "Pair with me", plus yours). **Save as template** stores the
  current text in `~/.claude/masterdeck/templates.json`.
- **Find (⌘F):** on Terminals it searches the open terminal's text (its scrollback included); on
  Board and PRs, the text on the screen. A bar opens at the top right: every match is highlighted,
  the current one brighter; **Enter** / **↓** go to the next, **⇧Enter** / **↑** to the previous, and
  the terminal or screen scrolls to it. **Esc** closes it. Terminals highlight up to 1,000 matches
  (all are still counted and reachable); screens update as they change.
- **History (⌘⇧F, or History in ⌘K):** a popup over any screen. Type to search every session
  transcript (exact text, any case). Results list the sessions, newest first, with snippets. Click a
  snippet to open that conversation on the right, scrolled to the message it came from and outlined,
  with the text highlighted. **↑ ↓** step through every match in the conversation. Long
  conversations load a window around the match, with **show more** at either end. **Open session**
  (live) or **Resume** (ended), and **Copy id**.

## Notes

A place for what you would otherwise keep in another app: your own notes, and one note per ticket.

- **Open it:** the **Notes** button on the rail, above Workflow (on a phone: **More → Notes**), or **Notes** in ⌘K. It
  opens a panel over the current view, next to the rail; the app behind it stays usable. Close it
  with the button again, the ✕, or **Esc** while you are in the panel. On a phone it is a full-screen sheet: the list first, a
  note replaces it, **‹ Notes** goes back, and choosing another tab, the command palette or a More
  screen closes the sheet (what you typed is saved first).
- **Your notes:** **New note** opens a title and a text. There is no Save button: the note is saved
  half a second after you stop typing (every two seconds while you keep typing), and when you leave
  it or close the panel. Every note stays
  in the list under **Notes**, the one edited last first, with the start of its text. The search
  box above the list finds notes by their titles and texts (every word you type must be in the
  note), and a ticket's note by its ticket too, written `owner/name#12`. **Delete** (under the text) asks first and cannot be undone.
- **Markdown:** write a note in Markdown (`# headings`, `- lists`, `- [ ] tasks`, `[links](https://…)`,
  `` `code` ``, `**bold**`, `_italic_`, tables, quotes) and see it rendered. Under the text, **Write**
  shows the text you edit, **Preview** the note rendered, and **Side by side** (in a window at least
  1000 px wide) both, with the panel twice as wide. Each window and browser remembers its choice (a
  new, empty note always opens in **Write**). In the
  preview a link opens in your browser, never in MasterDeck, and only `https://` links are links. An
  image (`![name](https://…)`) shows as a link to it: opening a note never loads anything. HTML
  in a note is never run or drawn: `<b>`, `<img>`, `<script>` and the like show as the text you typed.
  The list, a ticket's **Details** and the hover text of a card's note mark show the start of a note
  as plain words (the marks left out). Nothing about the stored note changed: a note written before
  reads the same (or better: a `- ` line is a list now), and nothing on disk was rewritten.
- **Notes from a session:** ask any Claude session to "write this to a note" (or "add it to the
  ticket's note"). MasterDeck installs the `masterdeck-notes` skill: with it a session can make a new
  note (as many as you ask for, each with its own title), add text at the end of a note it made, or
  add text at the end of a ticket's note (made when there is none). A session only adds; it never
  reads your notes, changes what you wrote or deletes anything. The note shows up in the panel at
  once; if you are typing in that same note, the editor says **Changed elsewhere** as usual. MasterDeck
  must be running (the session is told when it is not). macOS only for now.
- **A ticket's note:** one per ticket. In a session's **Details → GitHub**, the **Ticket** row
  (a **Note** badge on it says the ticket has one) shows the note rendered, with when it was last
  changed; a long one is cut to a few lines with **Show more**. Click the text (or **Edit**) to
  change it in place: **Save** or ⌘/Ctrl+Enter saves, **Cancel** or Esc drops the change, and
  **Delete** (or saving it empty) asks first and deletes only the version you started from. With no note yet, a **Write a note…** box is ready: type and Save. If the
  note was changed elsewhere since you started (the Notes panel, the Board, a browser), Save says
  **Changed elsewhere.** with **Reload** (take that text and go on) or **Keep mine**; nothing is
  overwritten or deleted without asking. A change made elsewhere shows up here by itself. **Open in Notes**
  opens it in the Notes panel, as does the small mark on a ticket's card on the Board (always
  visible, dimmed, on a phone). Such a note has no title: the panel shows the ticket and its
  title. It is listed under **Tickets**. Emptying it removes it.
- **A session's notes (Session details → Notes):** the Details tab has the tabs **Session**, **GitHub**,
  **Notes**, **Diff** and **Files**. **Notes** reads **Notes 3** when the session has notes: its ticket's
  note (listed first, as **Ticket note**), the notes about the session, and the notes about its
  ticket, newest first. A note that came from a meeting carries a **Meeting · 9 Oct** chip, and a
  dot on the tab says one came since you last opened that session's Notes tab (each window and
  browser keeps its own). Pick a note to read it, rendered, below the list. **Edit** opens it in the
  Notes panel; **New note** opens the panel on a new note about this session (and its ticket),
  which the editor shows as **About login-redirect · #112**. Editing is in the panel (only the
  ticket's own note can also be written in place, under **GitHub → Ticket**). The web app's Details has the same tab.
- **Filters:** under the search box, **All · Mine · Tickets · Sessions · Meetings**. **Mine** is your
  own notes, about nothing in particular; **Tickets** a ticket's note or a note about a ticket;
  **Sessions** the notes about a session; **Meetings** the notes that came from a meeting. A note can
  be in several (a meeting note about a session and its ticket is in all three). Each window and
  browser remembers its choice. A row shows the session a note is about, and the meeting it came
  from, as chips. The search also finds a note by the session's name and the meeting's title.
- **In the web app:** the same panel and the same notes. When a note is changed in two places at
  once (the Mac and a browser), the editor says **Changed elsewhere** and asks: **Reload** takes
  the other version, **Keep mine** saves yours over it. A note deleted elsewhere says so, and you
  can **Keep** it (save it again) or **Discard** it.
- **When a note cannot be saved** (1000 notes already, or a character a note cannot hold) the
  editor says so with **Discard**, and keeps your text on screen until you choose. When the Mac
  does not answer (the web app, a lost connection), or could not write the file just then, it says
  **Not saved** and tries again every few seconds.
- **Every note:** the text as you typed it (Markdown, shown rendered). It is kept on this Mac, in
  `~/.claude/masterdeck/notes/` (one small file each), never sent to a session (sessions can add to
  notes, not read them) or to GitHub, and
  not part of what the phone and API line carries. A browser gets notes only over the end-to-end
  encrypted connection: the list carries the first 120 characters of each; a whole note is sent
  when you open it, and when your save meets a newer version of that note (so the editor can offer
  **Reload**). A file in that folder that MasterDeck cannot read as a note is left alone.
- **Limits:** 200 characters in a title, 50,000 in a note, 1000 notes.

## Setting up with Claude

Setup (the first-run wizard, and Settings → **Set up MasterDeck**) has a **Let Claude do it**
button under its title. It opens a Claude terminal inside Setup that walks you through the same
steps in conversation:

1. **Tools**: checks `claude`, `gh`, Python, `git` and `jq`, and offers to install what is missing
   (Homebrew on macOS, winget on Windows; you approve each install).
2. **GitHub accounts**: with one `gh` login it says which it will use; with several it asks which
   to use and which is the primary; with none it opens gh's browser login above the chat.
3. **Repositories and boards**: for each account, what it can reach; you pick specific
   repositories or all, the main one, and the boards (named with their columns), or none.
4. **Preferences**: proposes the workspace folder, master-agent, notifications and MasterDeck's
   mods, and asks only where it matters.
5. **Summary**: Claude hands its choices to MasterDeck, which checks them, fills the wizard's steps
   with them and shows a summary card above the chat. **Save** writes the setup the same way the
   wizard's Finish does; **Change in the wizard** closes the chat and shows the steps to edit by hand.

Nothing is saved before you press **Save**: Claude cannot write the setup itself. After Save the
chat closes, Setup shows what was set up, and the main screen opens after a few seconds (with the
Skills popup on a first run). **Back to the wizard**, or quitting Claude, returns to the wizard with
whatever Claude had filled in. Pressing **Let Claude do it** again starts a new chat. The button is
off while Claude Code is not installed (the Tools step says how), and is not in the web app.

## Settings (⚙)

Nudge after N minutes, budget per ticket, context warning %, auto-open on prompts, dock badge.
Stored in `~/.claude/masterdeck/settings.json`.

- **Appearance** (General): **Light**, **Dark** or **System**. System follows macOS (or Windows)
  light or dark mode and switches with it. The change shows at once, terminals included, and is
  kept. The default is Dark. In the web app, the choice applies to that browser only, so a phone
  can be light while the Mac stays dark. In the light theme, terminal text is darkened
  automatically where a program picked colours for a dark background. If Claude Code's own colours
  still look wrong, run `/theme` in the session and pick a light theme there.

- **Notifications:** a table of what MasterDeck tells you about (rows) and where (columns), with a
  checkbox per cell. The kinds: Session finished, Session needs input (a permission prompt, a
  question, a menu), New item in Needs you (everything else there), PR ready for review, PR merged,
  CI failed, Monitor event (monitors MasterDeck runs, at most one a minute each), Update available,
  Workflow notify step, Meetings and Scheduled run. The places: **System notification** (macOS / Windows),
  **Needs you** (the list in MasterDeck) and **Mobile push** (shown greyed out: it comes with the
  mobile app). A change applies at once.
  - Needs you off for Session needs input or CI failed leaves those items out of the list (and the
    dock badge, and the web app) without closing them: switched on again, they are back as they
    were. New item in Needs you is always listed. Needs you on for an event (Session finished, PR
    merged, Update available…) adds it to the list as a **NOTICE** with **Open** (when it has a
    session) and **Done**; notices go after three days.
  - **Pause all notifications** stops every system notification and keeps your choices; Needs you
    still lists everything.
  - **Send test** sends one test notification through every place that works now (System
    notification and Needs you), whatever is ticked or paused, and says where it went.
  - The defaults are what MasterDeck did before: system notifications for everything it notified
    about, nothing new. An older "Notify me when something new needs me" switched off carries over
    (the three Needs-you kinds start with System notification off). Setup's Notifications box sets
    those three too.

- **Set up MasterDeck:** opens Setup as one page (tools, GitHub accounts, repos and boards, status mapping, workspace,
  hooks). Saved to `~/.claude/master/config.json`. **Let Claude do it** works here too (see Setting up with Claude).
- **Hooks, mods & skills:** status lines, not switches (but **Mods**, see MasterDeck's mods). **Queue** says who runs `/queue`: MasterDeck's
  hook, queue hooks you installed by hand (MasterDeck then leaves `/queue` to them), or nothing
  (Windows). **Self-review gate** says whether the gate before `gh pr create` is installed; it stops the
  first `gh pr create` of each branch with an instruction to review the diff, then lets the retry (same branch) go through. It is a
  step of the Default workflow, so a workflow without the self-review step skips it.
  **Master reports guard** says whether the check on SendMessage is installed (macOS and Linux): a
  session's report (`#12: done`, blocked, question, answered) goes only to the master session, never
  to another session (see MasterDeck's hook). Older versions
  installed hooks for babysit-ticket, babysit-pr and queue; MasterDeck removes exactly those once,
  at launch (a backup of `~/.claude/settings.json` is kept), and does that work itself.
- **Skills:** each bundled skill's state in `~/.claude/skills`, for use by hand: MasterDeck needs
  none of them, and the Skills popup has no automatic switches (just Add, Remove, Replace with
  bundled, and Close). MasterDeck installs missing skills at launch and updates its own unchanged
  copies. A skill you edited, your own copy, or a symlink
  is left alone; **Replace with bundled** swaps it (the old folder goes to
  `~/.claude/skills/.masterdeck-backup/`).
- **Watch new PRs** (Sessions, on by default): MasterDeck follows each open PR a session makes (only
  for sessions whose workflow keeps the PR watch step). Once a minute it checks GitHub; new review
  threads, comments, changes requested, a merge conflict, a stalled automated Claude review and the
  merge reach the session as one message starting `[MasterDeck PR watch] repo#12:` once its turn is
  over. A PR that was older when the watch started gets one line counting what is already on it
  (its threads and comments are not listed); after that only new ones are sent, never twice, also
  across restarts. The very first time (no watch file yet, e.g. right after upgrading from the
  babysit-pr skill), PRs picked up in the first 10 minutes say nothing about what they already
  have: only what comes after. Reviews and comments posted from your own GitHub account count
  too (you reviewing your own PR, or a review session posting as you); only the replies the
  session posted itself are left out. A session busy for a long time gets one short message per PR, not a backlog. The session is told reviewer text is for it to judge, never to
  force-push or merge. The watch ends when the PR is merged or closed (the session is told), and
  has no time limit. A PR MasterDeck can no longer read (deleted repo, lost access) ends after three
  tries, with one line to the session. Review-thread offers for a watched PR are not added to Needs you while its
  session can take messages (it gets them already); a parked session, one on a prompt, or an
  interactive one with master offline still gets the offer. CI offers always are. A session with a watched PR shows **Waiting** when idle.
- **Monitors run by** (Sessions): who runs the monitors sessions arm (PR review comments, merge
  readiness, deploys, a workflow's monitor blocks).
  - **Claude Code** (default): each monitor stops after 30 minutes, Claude Code's limit, and the
    session re-arms it; each re-arm is a short turn.
  - **MasterDeck:** MasterDeck's hook catches the session's Monitor call and MasterDeck runs the same
    script with no time limit. Claude is told so and does not re-arm it. What the script prints
    waits until the session's turn is over, then reaches it as one message starting
    `[MasterDeck monitor: <description>]`. It ends when the script exits (the session gets a last
    message) or when you press **Stop** in Details. The monitors are kept in
    `~/.claude/masterdeck/watches.json` and start again when MasterDeck does. Only while MasterDeck
    is open: when it is closed, a new Monitor call goes to Claude Code as usual.
  - Sessions read their hooks when they start, so one started before MasterDeck 0.6.1 keeps
    Claude Code's monitors until it is restarted.
  - **Details → Monitor:** a blinking line for each monitor MasterDeck runs for the session, with
    its events and a Stop button. With several, they open as a list. A PR watch shows as
    "PR watch · repo#12"; its Stop ends the watch and tells the session. A PR stopped this way is
    not watched again. The PR watch says when it last read the PR from GitHub; when reads fail it
    shows **read failing** and the error (it tries again every minute and clears itself), and if
    it could not read the session's transcript it says how many comments by the session's account
    it held back.
- **Details → Scheduled:** jobs a session scheduled with Claude Code's CronCreate (e.g. "check App
  Store Connect every 10 minutes"), read from its transcript: a name from the prompt, how often, when
  it runs next and when it ends (recurring jobs expire after 7 days; session-only ones end with the
  session). Click one for its whole prompt. A job the session cancelled (CronDelete) disappears, and
  an idle session with jobs shows as Waiting ("scheduled: …"), not Idle. Cancelling is done in the
  session itself.

### Settings → Updates

MasterDeck updates itself (issue #122). Only in the Mac's (or Windows PC's) own window: the web app
never sees or starts an update, and a development build (`npm run dev`) or an app run straight from
the DMG has updates off (Settings → Updates says why).

- **Finding an update.** MasterDeck checks 30 seconds after it starts and then every six hours.
  **Check for updates** in Settings → Updates (or **Check for Updates…** in the MasterDeck menu on a
  Mac) checks now. The section shows your version, when it last checked, and one status line: Up to
  date, Update available, Downloading 42%, Ready to install. A newer version shows its release notes
  below. Every change merged into MasterDeck comes out as a new version within the hour (a patch
  release whose notes list the changes), so small updates can come often.
- **The dot on Settings.** While an update is available or ready, the rail's Settings icon has a
  dot (blue: available, green: ready, red: required). Hover it for which.
- **Downloading.** With **Automatically download updates** on (the default), a new version downloads
  as soon as it is found. Off: press **Download**. Every download is checked against MasterDeck's
  signature before it is installed; one that does not match is thrown away.
- **Restarting.** When the update is ready, a card in the corner says "MasterDeck 0.10.0 is ready.
  Restart now to update." **Restart now** closes MasterDeck, installs the new version and opens it
  again. Your Claude sessions keep running (they run under Claude Code's daemon), and the session
  list and tabs come back with the window. **Remind me later** hides the card for four hours; the
  next start asks again. On a Mac, quitting MasterDeck normally also installs a ready update (not
  MasterDeck's own **Restart**, and not while MasterDeck is opened again at once: then the next quit
  installs it). After such a quit nothing checks that the new version starts: the previous copy
  stays hidden beside it (`.MasterDeck.app.previous`) until the new version has started once.
- **Required update.** When your version is no longer supported, a **Required update** banner shows
  over the terminals until you update; **Open Updates** leads to Settings → Updates.
- **Beta channel.** On: MasterDeck also offers beta versions, before they are released. They may
  have more bugs. Off again: a beta update that was downloaded but not installed is dropped; a beta
  already installed stays until the next stable release is newer.
- **Your password (Mac).** When MasterDeck sits in a folder your user cannot write to, macOS asks for
  an administrator's password to replace it. Cancelling leaves the old version in place and opens it
  again; Settings → Updates then shows the error with **Try again**, which checks and downloads the
  update again before macOS asks for the password once more. If you open MasterDeck yourself while
  macOS is still asking, nothing is replaced: the update waits for the next quit.
- **When an update does not start (Mac).** MasterDeck opens the new version and waits up to two
  minutes for it to start, then tries once more (about four minutes in all). If it still has not
  started, the previous one is put back and opened. Settings → Updates says "Rolled back from vX: it did not
  start", and MasterDeck skips that version until a newer one comes out. After a good update the
  section says "Updated from vY".
- **Errors** show as one line with **Try again** (it checks, downloads or installs again, whichever
  failed; after a failed install that MasterDeck reports when it opens again, it checks again);
  never a popup.
- **Windows.** The update runs MasterDeck's installer in the background on restart. There is no
  automatic roll back on Windows yet. If Windows SmartScreen stops the installer ("Windows protected
  your PC"), choose **More info → Run anyway**, or download the installer from the releases page.

### Settings → Meetings (macOS)

Where meetings are set up (issue #102). Only on a Mac,
only in MasterDeck's own window: the web app and Windows do not show it. It is not part of the
first-run Setup, so nobody who never wants meetings is asked anything.

- **The consent card comes first.** It says what is recorded (your microphone and the sound the
  Mac plays, from Record until Stop), where it stays (this Mac only), what leaves the Mac (once per
  meeting the transcript's text and the list of your sessions, tickets and PRs go to Anthropic, to
  find what relates to which session), and that **no one in the meeting is told**: recording people
  without telling them is illegal in many places, and telling them is your job. **I agree** stores
  the time and the card's version in `settings.json`; a new version of the card asks again.
- **Microphone:** its status (Not asked yet, Allowed, Refused). **Allow microphone** brings up
  macOS's own prompt; once refused, **Open System Settings** opens Privacy & Security → Microphone.
- **Sound from the Mac** (the other people in the call): on macOS 14.2 and later this is the
  **System Audio Recording Only** permission, which no app can read, so the status is the last
  check MasterDeck made ("Not checked yet" until then). **Allow** listens to the Mac's sound for one
  second (play something while it does); the first time, that brings up macOS's prompt. "No sound
  came through" means it heard nothing: allow MasterDeck in System Settings, restart it and try
  again. On macOS 13 to 14.1 it is the Screen & System Audio Recording permission. macOS 12 and
  older cannot record the Mac's sound. macOS may want MasterDeck restarted after you allow it:
  when the check heard nothing or the permission was refused, **Restart MasterDeck** does it (after
  asking; terminals in MasterDeck close, Claude sessions keep running).
- **Your microphone:** **Follow the meeting app's mute** (the default) keeps your mic out of the
  recording while the meeting app has you muted, and puts it back when you unmute. **Always
  record** records it the whole time. When MasterDeck can't see the mute (Accessibility not
  allowed, no meeting app found, a control it can't read), your mic is recorded, as with Always
  record, and the Record popout says why.
- **Accessibility** (shown with Follow): how MasterDeck reads the mute. It reads only the meeting
  app's mute button, nothing else on screen, and only while a meeting is being recorded. **Allow**
  brings up macOS's prompt the first time; after that it opens System Settings → Privacy & Security
  → Accessibility, where you switch MasterDeck on. Like the other permissions, macOS may want it
  allowed again after an update.
- **Check mute reading** (shown with Follow): shows what MasterDeck can see of each meeting app's
  mute, without recording. Join a call, then press **Check** while muted and again while unmuted.
  It looks for about 3 seconds and lists Zoom, Teams, Webex and Google Meet with what it reads and
  why: "Muted (button says 'Turn on microphone')", "Not running", "No mute button found — is the
  call in the front tab, or Meet is full screen / on another desktop — press Check from the same
  desktop as the call", "Search cut short", "The app did not answer", or "Accessibility not given
  to MasterDeck's helper". If macOS allowed MasterDeck but not the part of it that reads the mute,
  it says so above the table, with what to do: remove MasterDeck from Accessibility in System
  Settings and allow it again (each new build needs this). For Google Meet, keep the call in the
  browser window's front tab, not full screen, and press Check from the same desktop as the call:
  other tabs can't be seen, and only pages on meet.google.com are looked at. Like a recording,
  Check turns on Chrome's accessibility tree (and other Chrome-family browsers') until Chrome
  quits.
- **Speech model:** what turns the audio into text, on this Mac. Pick **Best** (574 MB, the most
  accurate; chosen first on Apple Silicon) or **Fast** (148 MB, quicker and less accurate; chosen
  first on Intel), then **Download**. It comes once from whisper.cpp's model page on Hugging Face
  (nothing of yours is sent there), shows its progress and can be cancelled; a file that is not
  exactly the expected one is thrown away. **Ready** means it is on disk; **Remove** deletes it.
  "Speech engine missing" means this copy of MasterDeck has no speech engine: reinstall it.
- **Language:** what your meetings are spoken in. **Detect automatically** (the default) works for
  most; pick one when every meeting is in the same language.
- **Offer to record** (on by default): offer to record when a meeting app is in a call (see
  **The offer** under Record a meeting).
- **Delete audio after** (30 days by default; 7, 90, a year or never): the recording goes, the
  transcript and notes stay. MasterDeck checks a few minutes after it starts and then once a day,
  and removes only audio (a transcript is never removed by a timer; Janitor → Meetings does that
  when you ask). The meeting being recorded is left alone.
- **Turn off meetings** takes your agreement back (the card shows again next time) and stops the
  offers; a recording running then is stopped first (what was recorded is kept); recorded meetings stay.
  Transcribing and matching stop at once: nothing more is transcribed or sent to Claude until you
  agree again, and then they go on where they stopped. A speech model downloading then is cancelled,
  and the model picked before it stays picked. macOS keeps the permissions it gave until you remove them in
  System Settings.

macOS remembers permissions per build of an ad-hoc signed app, so after an update it may ask again.

### Record a meeting (macOS)

- **Record** is the round button in the rail, under the tools (also ⌘K **Record meeting**). It is
  there only in MasterDeck's window on a Mac. Before you agreed on Settings → Meetings it opens that
  screen; the microphone must be allowed there too.
- Its popout takes an optional title, then **Record**. Under it, every time: **Tell the others you
  are recording.** No one in the meeting is told by MasterDeck.
- It records your microphone (**You**) and the sound the Mac plays (**Others**: the people in the
  call) apart, on this Mac. Without a speech model it still records, and says the transcript waits
  until one is downloaded.
- While recording, the button is red with the time recorded. Its popout has **Pause** / **Resume**
  and **Stop**; paused time is not recorded. macOS shows its own recording indicators too.
- **Your mic while recording:** the popout has one line about it. "Mic: muted in Zoom — not
  recorded" and "Mic: on in Zoom" while it follows your mute; "Mic: always recorded." with Always
  record. When the mute can't be followed the line says your mic is recorded and why: Accessibility
  not allowed (with **Open Settings**, to Settings → Meetings), no meeting app found, the mute not
  visible in the app, the mute reader missing (reinstall MasterDeck), or the mute reader stopped
  (MasterDeck tries again; if you were muted, your mic stays out for about 3 s first). While
  paused the line says "Mic: paused."

- **Mic off in the recording** (a switch in the popout) keeps your mic out until you switch it back
  or the recording ends, whatever the meeting app says; each new recording starts with the switch off.
  While your mic is out of a running recording, the red time in the rail shows a struck mic.
- One recording at a time. After 4 hours it stops by itself and says so. If the microphone goes
  away (unplugged, taken by another app), the recording stops and a notification says why.
- Quitting MasterDeck or closing its window while recording asks first: **Keep recording**, or
  **Stop recording and quit** (what was recorded is kept). **Restart** on Settings → Meetings asks
  the same, with **Stop recording and restart**. A crash keeps everything recorded up to
  the last 30 seconds.
- **The offer:** once you agreed on Settings → Meetings and with **Offer to record** on, MasterDeck
  looks every 10 seconds at which programs run (their names only) while nothing is being recorded.
  When Zoom or Webex joins a call, a notification says "Zoom call: record it?" (a click brings
  MasterDeck up with the Record popout open) and a chip by the Record button asks the same, with
  **Record** and **Not now**. It is asked once per call: after Not now, or after a recording, the
  same call is not offered again (a call app gone for 20 seconds or less, such as a move to a
  breakout room, is still the same call). With two calls at once, the second is offered after the
  first chip goes. It never starts recording by itself. The web app is never told which call app is
  in use. Microsoft Teams, Slack
  huddles and calls in a browser (Google Meet) are not noticed: use Record. **Turn off meetings**
  stops the looking.
- The recording is kept in MasterDeck's folder (`~/.claude/masterdeck/meetings`): a playback copy
  (`audio.webm`) and 30-second pieces that are turned into the transcript.

### After Stop: the transcript

- Each 30-second piece is turned into text on this Mac as soon as it is recorded, one at a time and
  at low priority, so the transcript is ready about a minute after **Stop**. Nothing is sent
  anywhere for this. A piece that is text is removed; the playback copy stays.
- Lines say who spoke: **You** (your microphone) or **Others** (the sound the Mac played), in order
  of time. When both talk at once, both lines stay.
- Without a speech model the meeting waits ("Waiting for the speech model") and goes on by itself
  once you download one on Settings → Meetings.
- If turning a piece into text fails, the meeting says why and keeps the pieces; **Try again**
  starts again where it stopped.
- If MasterDeck quits or crashes during a recording or a transcript, the pieces on disk are turned
  into text the next time MasterDeck starts (once you agreed on Settings → Meetings), without
  opening Meetings. Starting asks macOS nothing and records nothing.

### After the transcript: notes in your sessions

- Once the transcript is ready, MasterDeck asks Claude once (`claude -p` with Sonnet, from an
  empty folder, nothing saved) what in it was about which of your sessions, PRs and current-sprint
  tickets. Claude gets the transcript and the list (names, folder names, branches, ticket and PR
  numbers and titles), and is told the transcript is only data: anything said in the meeting that
  sounds like an instruction to it is ignored. A long meeting is read in parts.
- Its answer is checked before anything is written: a match on something not in the list, lines
  that are not in the transcript, or text past its limits is dropped, never guessed or fixed.
- Each match becomes a note about that session (and its ticket), or about the ticket (a PR without
  a session: the ticket it closes, else the PR itself). It shows in the session's Details → Notes,
  on the Board card, and under **Meetings** in the Notes panel. A note has:
  - **From:** the meeting's title and when it was, then what was said about it in a few sentences,
  - **Action items**, when there were any,
  - the lines themselves, quoted with who spoke and when (`> **Others** 12:04 — …`),
  - **Open in Meetings**, to open the meeting at the first quoted line on the Meetings page.
  What Claude or the meeting said shows as plain text: it cannot make a hidden link, an image or a
  heading in your note. A web address someone said stays a visible address.
- The meeting also gets a title from Claude (unless you named it) and a summary.
- **Match again** asks Claude again. Notes from this meeting that you have not changed are replaced;
  notes you edited stay as they are, and get no second copy.
- If the matching fails (Claude could not be reached, took longer than 5 minutes, or did not answer
  in the asked form), nothing is written and the meeting says why.

### The Meetings page (macOS)

The waveform in the rail, between Notes and Workflow (also ⌘K **Go to Meetings**). Only in
MasterDeck's window on a Mac: the web app has no Meetings page, and a meeting's transcript and
audio never reach a browser or a phone.

- **Left:** a month calendar (‹ ›), days with meetings marked with a dot, and the range: **Today**,
  **This week**, **Last 30 days** (the default) or **Custom**, with its **From** and **To**. A click
  on a day shows that day. Under it the meetings of the range, newest first: title, date, length,
  how many notes it added, and its state (**Recording**, **Transcribing 3/12**, **Waiting for the
  speech model**, **Matching**, **Done**, **Failed** with **Try again** or **Match again**).
- **Right, the meeting:** its title (click it to rename; Enter keeps it, Escape goes back), date,
  length and the apps seen, its state, the summary, and **Notes added:** a chip per note it wrote
  (each opens the note).
- **Mic log** (closed until you open it; only meetings recorded since it was added): each change
  of your mic during the recording, with its time: what MasterDeck read in the meeting app (Muted,
  Unmuted, Unknown), the app, why (button found, no mute button found, search cut short, no
  Accessibility, …), and whether your mic was out of the recording or recorded from then on. A
  meeting where your mic was never out shows why here. Times are wall clock since you pressed
  Record (a pause counts, unlike the transcript's). A change of why alone is not listed. The first
  and the last 250 changes are kept; in between it says how many were not kept. **Export
  transcript** includes it.
- **The player** over the whole transcript: **Play** / **Pause**, **−15s** / **+15s**, the position
  bar, and **1x / 1.5x / 2x**. The line being played is highlighted and kept in view until you
  scroll; a click on a line (or Enter on it, with Tab to get there) plays from there, and Space plays
  or pauses when you are not typing in a field. Lines Claude matched to a session or ticket carry its chip (click it for
  the note).
- **Search the transcript:** the words are marked in every line, **↑ / ↓** (or Enter, Shift+Enter)
  go from one to the next, the count shows where you are.
- **Match again** (asks Claude again; needs Settings → Meetings turned on), **Export transcript**
  (a Markdown file), **Export audio** (the `.webm`), **Delete audio** (the transcript and notes
  stay) and **Delete meeting** (the transcript and audio go; the notes it added stay, they are your
  notes now). Both deletes ask first; neither works while that meeting is being recorded.
- **Open in Meetings** in a meeting's note opens this page at that line's time (in the window; the
  web shows the words only). **Open** on a meeting's Needs-you item opens it here too.
- Before you set meetings up, the page says what it is for and has **Set up meetings**. After
  **Turn off meetings** the meetings you kept are still listed, played, exported and deleted here;
  nothing is recorded or transcribed.

### Meetings in Needs you

- **Meeting '<title>': notes added to 3 sessions** (and tickets): **Open** opens it on the
  Meetings page, **Dismiss** leaves it. It goes once opened.
- **Could not be matched: <why>**: **Match again**.
- **Transcription failed: <why>**: **Try again** (also from the notification's button).
- These are on the Mac only: they are not sent to a phone, and a browser shows them with Dismiss
  only.

## Account

Settings → Account is where this Mac signs in to your MasterDeck account (needed for Remote).

- **Methods:** Continue with Google, GitHub or Apple, or an email and password (Create account
  takes an optional name; a new email account must be verified from the message sent to your inbox
  before you can sign in).
- **Browser sign-in:** MasterDeck opens a browser page; sign in there and approve this Mac. The
  page hands the sign-in back to MasterDeck by itself (a one-time local address on this Mac), so
  there is nothing to type. "Open the page again" reopens it, "Cancel" stops, and a countdown shows
  when it expires (5 minutes).
- **Use a code instead:** if the page can't reach MasterDeck (or you choose **Use a code instead**),
  MasterDeck shows a **code**: type it in the page and approve. Only approve if you started this
  sign-in; the page never needs the code pre-filled.
- **Signed in:** shows your email and how you signed in. **Manage account** opens
  `dev.masterdeck.dev/account` (devices, password, delete). **Sign out** (after a confirm) removes
  this Mac's session and stops Remote.
- **Limit:** up to 5 Macs can be signed in to one account.

## Remote

MasterDeck can connect out to the MasterDeck service (dev.masterdeck.dev) so a
phone, curl or CI can see your sessions and act on them while you're away from the Mac.

- **What it sends:** Tasks, Needs you and the board, as one snapshot (at most once a second, and
  only when something changed; changes to cost, context, monitor counters or next-run times alone
  go at most every 15 s). After the first full snapshot only the differences are sent. Never
  terminals, their output, the cost book or files. (The web app is different: see below.)
- **What can be done remotely:** answer, snooze or dismiss a Needs-you item (`inbox.act`,
  `inbox.snooze`, `inbox.dismiss`); start a session from a board issue (`session.start`); stop or
  resume a background session (`session.stop`, `session.resume`); message a session
  (`session.send`); edit its queue (`queue.edit`); set its status (`session.setStatus`). Anything
  else is refused as unsupported.
  - `session.send` with `via: "queue"` (the default) waits until the session's turn is over (it goes
    straight in if the turn is already over; needs the queue hook); `via: "now"` types it at once.
  - **master-agent** can't be controlled remotely.
  - Text isn't sent to a session that waits on a prompt (answer it from Needs you instead), and a
    suspended session must be resumed first. Only background sessions can be stopped remotely, with
    no confirmation on the Mac (the phone already asked).
  - Text with control characters, or starting with `/` or `!`, is refused (by the backend, and
    again by MasterDeck).
- **While the Mac sleeps or MasterDeck is closed,** commands wait on the backend and run in order
  when MasterDeck reconnects, each exactly once (MasterDeck remembers the last 500 in
  `~/.claude/masterdeck/remote-done.json`). Until then you can cancel one from the API
  (`DELETE /v1/commands/<id>`).
- **Stale answers:** an answer or dismiss for an item that is no longer waiting (answered here
  already, or its question changed) is dropped and the command shows as `stale`.
- **Questions from the API:** items created with `POST /v1/items` show in Needs you as **ASKED**,
  with their options and, if allowed, a reply box. Your answer goes back to the backend; when the
  item names a session, the session also gets `[<title>] <answer>`. Such a card stays while it's
  open, even if its session has ended.
- **Setting it up:** sign in under Settings → Account, then switch on **Connect to the backend** in
  Settings → Remote. It's off by default; signed out, Remote shows "Sign in first" with a
  button to the Account page. There is no address or token to paste.
- **One Mac at a time:** only one Mac per account can be connected. A second one shows "Another Mac
  is connected to this account" and keeps retrying slowly.
- **Status dot:** green Connected (with the last sync time), amber connecting or reconnecting (with
  the reason, e.g. it can't reach the backend, or at launch "waiting for sessions to load":
  MasterDeck connects once its session list is in, so waiting commands find their sessions; if
  `claude agents` fails the status says why, and after a minute it connects anyway: phone and API
  commands then fail with that reason, and the phone keeps its last session list, until the list is in), red an error that needs you (another Mac is
  connected, or MasterDeck is too old for the backend), grey off. If the server signs this Mac out
  (or the account was deleted) the line stops and says so.
- **Security:** anyone signed in to your account can drive your Claude sessions. Keep your password
  secret and sign out of devices you don't use (Manage account).

## Web app (app.masterdeck.dev)

The whole MasterDeck window in a browser, on any computer, talking to your Mac end-to-end
encrypted (the MasterDeck service only relays sealed messages it can't read). Needs Remote on (above).

- **First time in a browser:** sign in with your MasterDeck account, then approve the browser on
  the Mac. The Mac shows "Allow <browser> to control this Mac?" with **three words**; allow only if
  the browser shows the same three words. **Deny** is the default; Esc does nothing. A request
  expires after 5 minutes. A private window can't be approved (it can't keep its key).
- **What works:** every view (Terminals with live terminals you can type in, Board, PRs, Tasks,
  Costs, Janitor, Notes, Workflow, Settings, Skills, Standup, Broadcast, History). Confirmations show in the
  page instead of on the Mac. Not on the web: signing in or out of the Mac's account, approving
  browsers, connecting GitHub accounts, the folder picker (a repo picker instead), opening editors,
  and turning Remote off.
- **Terminal sizes:** while the Mac shows a terminal, its size wins; the browser's size applies
  only to terminals the Mac isn't showing.
- **While it loads:** the page says what it is doing (Connecting…, Waiting for your Mac…, Loading
  sessions…). If the wait passes 15 seconds (reconnects don't restart it), or the Mac says it
  can't send, it says why (the server can't be reached, your Mac doesn't answer, no sessions
  arrived, too much to send) with **Retry**. A Mac whose MasterDeck speaks another version gets "Update MasterDeck on your Mac"
  (or "Reload this page" when the Mac is newer), with the versions.
- **Very long lists:** when the Mac's lists are too large to send whole, the web gets a shorter
  copy (finished master proposals without their prompts first; then, only if needed, closed PRs,
  old Needs-you items and past sessions). The PRs view says "Open PRs only on the web" then.
- **Mac offline:** the page shows "Your Mac is offline" with when it was last seen, and **Retry**,
  until the Mac is back. If the Mac's latest changes ever get too large to send while the page is
  open, a line at the top says what you see may be out of date.
  One tab per browser: opening another shows "MasterDeck is open in another tab · Use here".
- **Settings → Remote → Browsers** lists approved browsers (and which are connected); **Revoke**
  cuts one off at once (it has to be approved again). Signing the Mac out, or into another account,
  forgets every approved browser. Three failed connections from one browser within an hour show
  "Possible tampering on the connection to …".

### On a phone

Open app.masterdeck.dev in the phone's browser (iPhone Safari, Android Chrome); a window up to
760 px wide gets the phone layout, wider ones the normal one.

- **Tab bar** at the bottom: **Sessions** (Needs you and the session list; badge = what needs
  you), **Tasks**, **Board**, **PRs** (badge = PRs waiting on you), **Master** (when master-agent is
  on) and **More** (Costs, Janitor, Notes, Workflow, Settings, Broadcast, Standup, Skills, Commands).
- **A session:** tap it in Sessions. The terminal fills the screen: **‹ Sessions** goes back,
  **Panel** opens Details / Tools / Summary as a sheet (› closes it). One terminal at a time (no
  split).
- **Quick keys** under the terminal (and under master): Esc, Tab, ⇧Tab, ^C, ↑ ↓ ← →, Enter, y, n
  and /. A tap types the key into the terminal without closing the keyboard;
  a swipe along the bar scrolls it without typing anything. The page shrinks above the
  keyboard while it is open.
- **Board and PRs filters:** the filter row is one **Filters (n)** button (n = filters changed from
  the tab's defaults) next to the search box. Tap it for every filter (and, on PRs, the sort) in a
  sheet; **Reset** puts the filters back (search is kept), **Done**, Esc or a tap outside closes it.
  Picking a repository there turns the tab into a repository view (see Board View); **Reset** or
  **Back to board** returns to the board.
- **Sign out** is on the Settings screen (bottom right).
- Terminal size: as on any browser, the Mac's size wins while the Mac shows that terminal; a
  terminal the Mac isn't showing takes the phone's width (about 45 columns).

### Instant typing (web)

The web terminal shows what you type at once, dim, and corrects it when the Mac's real output
arrives, so typing feels local even with a slow connection. It never changes what the terminal
ends up showing: anything it isn't sure about (password prompts, full-screen apps it hasn't learned,
hidden cursor, special character sets) it simply doesn't predict. In Claude Code (a full-screen
app) it starts after three typed characters have come back exactly as predicted. Switch it off in
Settings → General → **Instant typing (web)** (on by default; the setting is the Mac's, so it applies
to every browser).

### Remote connections

While any browser or phone/API client is connected, a blinking amber dot shows on the rail (on the
Mac only; solid if your system reduces motion). Hover or focus it for the list: who (the account
email or browser name), the device ("Chrome on macOS", or "Unknown device" for older browser tabs)
and how long ago it connected. Click it to open Settings → Remote.

## Links survive a resume

MasterDeck links tickets to sessions **by session id**, and resuming a parked background session
gives it a new session id. MasterDeck remembers every session id each background session has had,
in `~/.claude/masterdeck/session-history.json`. It also recognises the original one, because a
background id is the first 8 characters of the original session id. When a resumed session has no
link, or only an automatic link made in the first 2 minutes after the resume,
MasterDeck re-links it to its earlier ticket. A link made on purpose later is left
alone. Each re-link is tried at most once every 10 minutes; a failure shows in the sessions column footer.

## One GitHub cache for everything

Every GitHub read on this machine that matters goes through `ghc`, a drop-in for `gh` that ships
with the master skill (`~/.claude/skills/master/ghc`, linked as `~/.local/bin/ghc`). Callers:
master's sweep and snapshot, MasterDeck (PR status per tab, PR popups, assignees, PR watch, board
moves), and babysit-ticket's `tt.sh` and babysit-pr's poll loop when you run them by hand.

- **Short-lived cache.** Reads are kept in `~/.claude/gh-cache` for a few seconds to minutes, so
  the same read from several sessions makes one call. TTLs: PR status 45 s, PR summaries 2 min,
  the board 5 min, assignees 10 min, your login 1 h.
- **Per account.** With two or more connected accounts, MasterDeck's calls and every session started as an account carry the account (`GHC_ACCOUNT`): each account has its own cached answers and its own pause (`paused-<login>.json`). A `GH_TOKEN` set without `GHC_ACCOUNT` gets its own entries too (keyed on a hash of the token, never the token). Calls with neither (one account, your own terminals) use today's keys and `paused.json` as before.
- **One call at a time per read.** Identical reads made at the same moment wait for the first one
  and share its answer.
- **Writes go straight through.** Assign, comment, status change and the like reach GitHub at once.
  They also drop the cached reads they could have changed (an issue write drops board reads too).
- **One shared pause.** After a rate-limit error, every caller stops calling GitHub for 10
  minutes. Cached reads are served from the last answer, however old. The sessions column footer shows the
  pause, and otherwise today's hit rate ("GitHub cache today: 80% of reads served").
- `ghc --status` prints the pause and today's counters. `ghc --no-cache …` bypasses the cache.
  Escape hatches: `MASTER_NO_GH_CACHE=1` for master and `TT_NO_GH_CACHE=1` for `tt.sh`.
- On Windows, MasterDeck calls `gh` directly, because the cache's file locks are POSIX-only.

babysit-pr's poll also got cheaper: one GraphQL and one REST call per poll, down from three
GraphQL and two REST calls.

## Several GitHub accounts

For people who work for more than one organization with different GitHub accounts. Each account
is a `gh` login (`gh auth status` lists them).

- **Connect them** in Setup → GitHub accounts: tick each account MasterDeck should use, check the
  name and email its commits get, and pick the primary one. **Add an account…** runs
  `gh auth login --web` in the dialog (gh then makes that login its active one; MasterDeck says so
  and never switches it). Under Repos & boards, an **Account** menu shows each account's own
  repositories and boards; a repository belongs to one account.
- **A workspace per account** (Setup → Preferences, two or more accounts): under **Workspace**
  (the primary account's; master and new shells start there) each other account has its own
  **Workspace for <login>** field with the same **Choose…** button: the folder that account's
  repositories are cloned in. A session for one of its tickets starts in the ticket's repository's
  checkout there (see Where it starts, under the Start dialog). Left empty, the account uses the
  workspace above, as before. With one account there is only the one Workspace field. Making
  another account the primary swaps the two folders: each account keeps the one it had. The Janitor,
  the + menu's repos and standup cover every account's workspace.
- **Each session works as one account**: its commits (name and email from Setup), its pushes and
  PRs, and every `gh` call inside it. New session and Start show an **Account** field (two or more
  accounts): it defaults to the account of the repository the issue's code is in (the issue's own
  unless Setup says another), else the issue's repository's (for a repository no account lists, on
  a board: the account with that owner, else the account whose board holds the card), else the
  folder's `origin`, else the primary; accounts needing a new login can't be picked. Details shows the session's account. A
  session keeps its account; to change it, stop it and resume it with another account picked in the
  Start dialog: that starts a copy of the conversation as the new account (a running session is
  refused; the old session stays, stopped and hidden). Leaving the Account field alone never
  copies. A session started without an account (before the second one was connected, or outside
  MasterDeck) keeps working as gh's active account; after its first resume MasterDeck knows and
  shows **gh's active account (started without an account)** instead of a login. Pick an account
  when resuming it to move it to one. master's proposals use the issue's account (shown on the proposal).
- **An account that needs to log in again** (its token expired or was revoked) shows in Needs you: **Log in** opens a terminal tab running `gh auth login` (on the Mac only; from a browser or phone the card says to run it there). Only that account stops: its sessions keep running, it is left out of the Account fields, and the other accounts keep refreshing. Refresh checks the accounts again. If the primary account needs to log in, master uses gh's active account until then.
- **Board and PRs**: each tab belongs to one account (see Board View, PRs).
- **Badges**: with two or more accounts each session row (Sessions, Tasks), proposal and Board/PRs tab shows `@login`, and the top of each session's terminal (and of each Board tab's Create with Claude panel) says `as @login`; shell tabs show nothing (they use your own setup). **New ticket** has an Account menu (the tab's account by default; accounts needing a new login are not offered); its repositories and boards follow, and the ticket is created as that account (**Create with Claude** hands over to the tab's session, so its button says `as @<tab account>` and is off, with a note, while the dialog's Account is another one: switch to that account's tab to use it); changing the account resets assignees, labels and sprint that came from the old one. **Standup** counts commits made with any connected account's email.
- **Where the tokens are.** With two or more accounts, MasterDeck keeps one Claude Code settings
  file per account in `~/.claude/masterdeck/accounts/` (only you can read it: mode 600). A session
  started as an account gets that file (`claude --settings`), so its token never shows in a process
  list. A session can read its own account's token, as it could run `gh auth token` before; it could
  also read the other files there, as it can read gh's own `hosts.yml` today. Tokens never go to
  MasterDeck's backend, the web app or a phone; only logins do. Disconnecting an account deletes
  its file once none of its sessions is running. GitHub Enterprise and hosts other than github.com
  are not supported.
- **One account** (the usual case): nothing changes. Sessions and GitHub calls use `gh`'s active
  account as before; Needs you only says so when gh's active account is not the one in Setup.

With two or more GitHub accounts connected, MasterDeck reads each one's token from `gh` (it never
switches gh's active account) and gives sessions started as that account their own token and git
identity; GitHub remotes are pushed over HTTPS with that token, including `git@github.com:` and ssh
aliases from `~/.ssh/config` (and the files it `Include`s). An account whose token GitHub refuses shows as needing a new login; an
offline check changes nothing. With one account nothing changes.

**How commits, pushes and PRs work in a session.** The commands are the ordinary ones, with no
account flag: `git commit`, `git push`, `gh pr create`. The session's environment carries the account
(from the `--settings` file MasterDeck starts it with):

| Variable | What it does |
|---|---|
| `GH_TOKEN` | That account's token. `gh` uses `GH_TOKEN` before its stored logins, so every `gh` call in the session (PRs, comments, reviews, `gh api`) is made as this account, whichever account is active in `gh`. |
| `GHC_ACCOUNT` | Keeps the shared GitHub cache apart per account. |
| `GIT_AUTHOR_NAME` / `_EMAIL`, `GIT_COMMITTER_NAME` / `_EMAIL` | The name and email from Setup, so commits are authored as this account. |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` | Git settings for this session only: `user.name`, `user.email`; the github.com credential helper cleared (so a password in your Mac's keychain is not used) and set to `gh auth git-credential` (which answers with `GH_TOKEN`); `url.https://github.com/.insteadOf` for `git@github.com:`, `ssh://git@github.com/` and each ssh alias, so SSH remotes push over HTTPS as this account. |

So with `alice` as the primary and active `gh` account, a session started as `bob-work` still
commits, pushes and opens PRs as `bob-work`. To check in any session: `gh api user --jq .login` and
`git config user.email`. The account needs access to the repo: without it the push or PR fails with a
permission error; nothing falls back to the primary. Shell tabs and your own terminal do not get
these variables: they use your global git setup and `gh`'s active account.

**Adding a scope to a second account.** `gh auth refresh` only works on `gh`'s active account (it has
no user flag); signing in as another account in the browser fails with "error refreshing credentials
for <active>, received credentials for <other>". Switch first, then switch back:

```bash
gh auth switch -u <second account>
gh auth refresh -h github.com -s project    # sign in as the second account
gh auth switch -u <primary>
```

One limit: a rule in your global git config that sends GitHub over SSH (for example
`url.git@github.com:.insteadOf https://github.com/`, or a `pushInsteadOf`) wins over the session's
rewrite, so such a session may push as the SSH key's account. Setup shows a warning on the
accounts when it finds one; remove the rule (`git config --global --unset …`) to fix it.

Skills you run by hand inside a session (`tt.sh`, babysit-pr's poll, `/babysit-ticket`) use that
session's `GH_TOKEN` and `GHC_ACCOUNT`, with the primary's config and boards: babysit-ticket in a
second account's session works against the primary's boards. Run outside any session (your own
terminal) they use `gh`'s active account.

**gh's active account.** With one account MasterDeck runs as gh's active account; when that is not
the primary set in Setup, Needs you says so and how to switch (`gh auth switch -u <primary>`). With
several, a master-agent started without the primary's settings (by hand, or before the second
account was connected) shows "restart master-agent so it runs as <primary>".

The workflow builder (the Workflow window's Claude session) runs as the primary account, like
master; while the primary needs to log in again it uses gh's active account.

**Known limits.** These are deliberate; each may be lifted when it gets in the way
([#37](https://github.com/amntoppo/MasterDeck-Terminal/issues/37) tracks them).

- **A rate limit on one account pauses MasterDeck's own polling for every account** (board, PRs,
  the snapshot) until it lifts. Sessions are not paused: the shared
  GitHub cache pauses only the calls of the account that hit the limit.
- **Skills run by hand** (`tt.sh`, babysit-pr, `/babysit-ticket`) use the session's account for
  GitHub but the primary's config and boards; outside a session, gh's active account (see above).
- **SSH host aliases** are read from `~/.ssh/config` and the files it `Include`s, not from a config
  given elsewhere (`ssh -F`, `GIT_SSH_COMMAND`, `core.sshCommand`, `/etc/ssh/ssh_config`). A remote
  that uses such an alias is pushed with the SSH key, so as the key's account.
- **A global git rule sending GitHub over SSH** beats the session's account (see "One limit" above).
- **When the primary needs to log in again, master starts as gh's active account** (without the
  primary's settings). Needs you shows the Log in item; after logging in, it asks to restart
  master-agent so it runs as the primary.
- **A session in a folder whose `origin` is no repository of a connected account** (or has no
  `origin`): the PR of its current branch is read as the primary account.
- **A board belongs to one account.** A card on it whose issue is in another account's repository
  moves between columns as the board's account, while assigning it and linking its PR go as the
  repository's account. Who can be assigned is read per repository, not per board.
- **Select all under one account counts every repository as yours** for the lists that ask "is this
  ticket or PR one of mine" (PRs, sessions' tickets, master's sweep), also for the other accounts.
  The Board's repository view is stricter (one account's Select all never opens another account's
  owner).
- **An account shows healthy for a few seconds after launch or a new login**, until GitHub has
  answered its check. A session started as it in those seconds with a token GitHub refuses fails
  at its first GitHub call; the account then shows as needing a new login.

## Board View

**Board** on the rail shows a Kanban board of your issues in the current sprint, in the project's column order. The
columns from your "ready" status to "dev done" always show; other columns appear when one of your
cards is in them.

- **Several repos and boards:** the board shows the tickets of every repository and board chosen in
  Setup (Repos & boards; or Settings → Set up MasterDeck), fetched in one GraphQL query for all boards
  (plus one for their PRs). A ticket is a repo and a number: `#12` in the primary repository, `api#12`
  in another; two repos' `#12` never mix (sessions, costs, statuses, links, babysit-ticket and master
  all keep the repo). A card moves only within its own board's columns.
- **Several accounts:** with two or more GitHub accounts each tab shows one account (its badge says which): its boards, columns and sprint, and **Mine** means that account's login. The first select in the filter row changes a tab's account; connecting another account adds a Mine tab for it once; + adds a tab on the same account.
- **No GitHub board:** an account with repositories but no project board selected in Setup still has a Board. Its tab shows the open issues of the repositories ticked for it (and the ones closed in the last 14 days), in four columns MasterDeck works out itself; nothing is stored on GitHub: **Todo** (open, no session), **In Dev** (a session is linked to it, running or stopped, or its PR is a draft), **PR Raised** (a linked PR is open and ready), **Done** (closed, or its PR merged). With several PRs, one still open keeps it in PR Raised; a PR closed without merging counts for nothing. A line at the top says so: "This account has no GitHub board. Columns are worked out by MasterDeck." Cards cannot be dragged and columns cannot be reordered there, and there is no sprint picker or Summary; everything else works (open the session, Start, the PR, Assign, Resume, the filters, also on a phone). Link a session to such an issue from MasterDeck (Start, or **Link session…**): `/babysit-ticket`'s `tt.sh link` run by hand does not work for an account with no board (it answers "is not on any selected board"). An issue that is also on another account's board shows there, as that board's card with its status, not in this tab. It reads the first 10 repositories, 300 open issues and 50 closed ones, and says under that line what it left out, one line each: "Showing the first 300 of 412 open issues.", "Not found: acme/old-site" (a repository GitHub no longer knows: renamed, deleted or no access; the others still show), "acme/api not read: RATE_LIMITED" (not read this time; asked again on the next refresh), "Pull request details not read: …" (the cards show, without CI and review threads; with no card the tab still says "No open issues"). **Refresh** asks again for every repository, also one that was not found a minute ago. master only proposes issues assigned to that account.
- **Create a GitHub board** (on the Mac; the link in that line): makes a GitHub project under the account's owner with the columns Todo, In Dev, PR Raised, Done, links the ticked repositories, adds their open issues (each in the column the Board showed) and selects the board for the account, so the tab switches to it. You name it (default `<repository> board`); a confirmation lists what will be created before anything is written. The account's token needs the `project` scope; without it the dialog shows the commands (see "Adding a scope to a second account"). An issue GitHub refuses, or a rate limit, is reported with **Try again** (with one account, Try again is refused if gh's active login was switched since: switch back first). A board made this way has no sprints: its tab shows all its issues and has no sprint picker (add a sprint field to it on GitHub and save Setup again, and it is treated like any other board). MasterDeck never deletes a project: if a run stops half-way, the dialog names the project and what to do with it. From the web app or a phone the line says "Create one from MasterDeck on your Mac."
- **Empty tabs** say why: "No issues match" (the filters hide them all), "No open issues" (an account with no board whose repositories were read and have none; with **Open Setup** and, on the Mac, **Create a GitHub board**), "Could not read <repositories>" (an account with no board whose repositories GitHub did not answer for: renamed, deleted, rate limited; the lines above say why; **Retry** refreshes, **Open Setup** lets you fix the list; while the account is read for the first time the tab says "Loading board…" instead), or "Nothing selected" (no repositories or boards picked for the account; **Open Setup**; MasterDeck then asks GitHub for no board at all, and a board read earlier is no longer shown).
- **Repository view:** pick one or more repositories in a tab's **Repos** filter and the tab shows every issue of those repositories instead of the board: the open ones and the ones closed in the last 14 days, whether or not they are on a project board. A line under the tabs says so, "Issues of api, web — not the board.", with **Back to board** (it clears the Repos pick). The columns are MasterDeck's own, worked out as in a tab with no board (Todo, In Dev, PR Raised, Done), so cards cannot be dragged and there is no sprint picker, Summary or Boards filter; the other filters apply as usual (on **Mine** you see your issues of that repository; **Show everyone's issues** keeps the repositories). An issue that is also on one of your boards shows that board's column as a small chip (▦ In QA; hover for the board's name): the column says where MasterDeck sees the work, the chip what the board says. The chip shows only for boards selected in Setup under the account that read the repository: with two accounts, an issue of alice's repository that sits on a board selected only under bob-work has no chip. Clicking a card works as on the board. The Repos filter lists the repositories ticked in Setup for the tab's account (one is enough); its first entry, **The board (no repository)**, goes back. In a tab with no GitHub board picking a repository simply filters the issues it already shows (picking all of them reads **All repos** again, and with a single repository there is no Repos filter, as before). A repository that is not ticked in Setup is read only when its owner is the owner of an account that has **Select all** itself: one account's Select all does not open another account's organisation, and a repository named after a login is not read. It reads up to 300 open and 50 closed issues per repository, ten repositories of an account per GitHub call (more are read in turn, none is left out), at most 30 repositories per tab, and says under the line what it left out or could not read ("api: showing the first 300 of 412 open issues.", "Not found: acme/old", "acme/api not read: RATE_LIMITED"). A picked repository that MasterDeck never reads shows as not read with the reason, and **Retry** and **Back to board** if nothing else is on screen: "acme/gone is not selected in Setup."; "globex/app is a repository of bob-work, an account with no board: its issues are on that account's tab."; "… not read: more than 30 repositories picked."; "… not read: MasterDeck already shows 30 repositories in open tabs. It makes room about 25 minutes after a tab stops showing one." (MasterDeck keeps 30 repositories across all tabs and browsers and never drops one a tab still shows; a tab asks for its repositories every 20 minutes, so about 25 minutes after a tab went back to the board, or was closed, its repositories make room for another tab's); "… not read: 30 repositories are already waiting for their first read. It is asked again in a few minutes." The issues are read when you open such a tab (one GitHub call per account, one more when a linked PR is open), kept with the board's cache, and refreshed with the board every hour and on **Refresh** while the tab is on screen (only the Board's own Refresh skips GitHub's shared cache; the refresh after creating a ticket or assigning does not); a repository that could not be read the first time (or found no room) is asked for again by the tab every 5 minutes and read again once the failure is 5 minutes old, so 5 to 10 minutes later, or at once with **Retry** (Retry and the Board's **Refresh** always read GitHub afresh, also when a read of that repository was already under way); a tab with no repository picked reads nothing extra. At most 1200 cards, and 500 KB of data, across the repositories on screen are kept: a repository that is cut says "api: showing the first N of the M issues read, to keep the view small." (cards with many labels and PRs are cut sooner). While some repositories are still being read the cards already read show, with a "Loading api…" line. master does not propose these issues. A tab saved before this version with repositories picked now opens as a repository view (before, it showed the board's cards of those repositories).
- **Tabs:** it starts with **Mine** (your issues, selected) and **Everyone**. **+** adds a tab; each tab has its own name (double-click to rename) and filters, over the
  same fetched board. The **Boards** filter (with **Select all**) picks which boards a tab shows; with
  some boards picked, only their columns show. The **Repos** filter turns the tab into a repository
  view (above). Tabs and their filters are remembered.

- **Badge:** the Claude task state for the issue, first match wins: ❓ Question, ⛔ Blocked, ✋ Needs
  input, ⏳ Onboarding (approved or still setting up), ⚙️ Working, then where its session's PR
  stands (🟣 Merged, 🔁 Rework, 👍 Approved, ✏️ Changes Requested, ❌ CI Failing, 👀 Ready for Review,
  🔍 In Review; see Session status), ✅ Done (the session told master it is done), 💤 Idle,
  ⏸ Stopped (can be resumed), ○ No session. Hover a badge for why.
- **PR chips:** coloured by state (open green, draft grey, merged purple, closed red). Open PRs also
  show CI ✓ ✗ ● and 💬 unresolved threads. Clicking a chip opens the PR.
- **Clicking a card:** opens that issue's session in Terminals. With no session: your own card opens
  the Start dialog; someone else's (or nobody's) opens the PR popup when it has a PR, else the Assign
  popup. Both popups also have **Start a session**: it opens the Start dialog for the issue as it is,
  without assigning it and without writing anything to GitHub (its tooltip says who stays assigned).
  The Assign popup lists **Me** first (with two or more accounts: the tab's account), then the
  people who can be assigned in the card's own repository, read from GitHub as the account that
  repository belongs to, on any tab and for any card (a board card, a card of an account with no
  board, a repository-view card). So bob-work's tab offers the people of bob-work's repository,
  never the primary account's. A card of the primary issue repo shows the list at once; for any
  other repository **Me** shows at once and "Loading who else can be assigned in app…" until the
  rest arrives (kept for an hour, so the next popup for that repository is instant). If the read
  fails the popup says so and offers **Me** alone: assigning to yourself still works. A card on one of your boards whose repository is not ticked in Setup gets its repository's people too, read (and assigned) as the account whose organisation owns the repository, or else the account whose board holds the card, so a private repository on bob-work's board is not asked for as the primary account. The Board's
  Assignee filter lists the people seen on the tab's cards and the tab's account; the primary issue
  repo's people are added only on the primary account's tab (or with one account).
- **Description and sub-issues in the popups:** the Assign popup shows the ticket's description as
  GitHub renders it, so you can tell what the work is before you pick it up. The Assign popup and
  the Start dialog (under Ticket) list the ticket's **Sub-issues**: each one's number, title and
  status (its column when it is on the board, else Open or Closed), with "2 / 5 done" above the
  list (done means closed, as on GitHub). Click a sub-issue (or press Enter or Space on it) to open
  it in place: its status, who is assigned, its labels and its description as GitHub renders it,
  with **Open on GitHub ↗**; click it again to close it. Several can be open at once (a very long
  description, or a list of many long ones, is cut short with a note). A ticket with no
  sub-issues shows no section. The ticket's description and the sub-issue list each scroll in
  their own box, so the popup's buttons stay in view; in Details a long sub-issue description
  scrolls in its own box.
- **A linked session's PR closes the issue when it is merged.** When the session linked to an issue
  opens a PR, MasterDeck adds that PR to the issue as a closing reference (it shows under the
  issue's Development box on GitHub), exactly as writing "Closes #12" in the PR would. This holds for
  every linked issue, also one that is on no board (a session started from a repository view). It is
  part of the Board moves step of the Default workflow: a custom workflow without that step does
  not add it.
- **Board moves:** MasterDeck moves the card to In Dev when a session is linked, PR Raised once its
  PR is open and not a draft, Dev Done when all its PRs are merged — the Board moves step of the
  Default workflow; a custom workflow can leave it out. Cards only move forward, and each move is
  made once: a card you move back stays there. Only PRs the session opened, or ones on its linked
  branch, count for its ticket (the PR of whatever branch its folder is on is shown, not linked).
  Links copied in from babysit-ticket are left alone until a session links that ticket again. A session master
  spawned for an issue is linked by MasterDeck, and a link made from MasterDeck still runs the
  workflow's "When a session is linked" steps (sent to the session once its turn is over).
- **Data:** `master board` (2 GitHub calls; for an account with no board one call for its repositories' issues, and one more only when a linked PR is open), refreshed together with the issues: at startup, every
  hour, and on **Refresh**. "refreshed 15 minutes ago" beside the button shows the last refresh. The
  board is cached with the issues, so it shows immediately on the next start.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Workspace not trusted. Run `claude` in `<folder>` once and accept the trust prompt, then retry." / "Claude Code has not been allowed to work in `<folder>` yet." | Claude Code has never been allowed to work in that folder. A session now starts in the ticket's repository's checkout, and for a git repository trusting the workspace folder above it does not count (trusting the repository covers its sub-folders). Press **Open Claude there…** (the Start dialog, the "did not start" tab, or the HELD card in Needs you), accept Claude Code's prompt in the tab that opens, then **Start** / **Try again**; you can close that tab afterwards. By hand: run `claude` in that folder once. Do it once per checkout. |
| The line stays after you accepted the prompt | MasterDeck reads Claude Code's `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) and found no accepted entry for that folder or a parent that counts. **Start anyway** / **Try again** asks Claude Code itself, which decides. |

## Environment

| Variable | Default | Use |
|---|---|---|
| `MASTER_CONFIG` | `~/.claude/master/config.json` | the shared GitHub/board config (Setup writes it) |
| `MASTER_WORKSPACE` | the config's `workspace` | where master and new sessions start (it also replaces every account's own workspace) |
| `MASTER_HOME` | `~/.claude/master` | ledger location |
| `MASTERDECK_HOME` | `~/.claude/masterdeck` | stats, hook, backups |
| `MASTERDECK_ISOLATED` | unset | `1` with `MASTERDECK_HOME`: Claude settings and skills default under that folder instead of `~/.claude` |
| `MASTERDECK_REMOTE_URL` | `https://dev.masterdeck.dev` | sign-in/remote backend (https, or http on localhost) |
| `MASTERDECK_CLAUDE_SETTINGS` | `~/.claude/settings.json` | Claude settings file to edit |
| `MASTERDECK_NO_HOOK` | unset | `1` skips the status line hook install |
| `MASTERDECK_NO_SKILLS` | unset | `1` skips installing the bundled skills at launch |
| `MASTERDECK_SKILLS_DIR` | `~/.claude/skills` | where bundled skills are installed |
| `MASTERDECK_SMOKE` | unset | `1` prints `SMOKE OK …` after the first healthy state and exits |
| `MASTERDECK_CAPTURE` | unset | path: save a screenshot after 8 s and exit (dev aid) |
| `MASTERDECK_USER_DATA` | unset | separate profile folder for a test run |
| `MASTERDECK_TEST_NO_ATTACH` | unset | `1` refuses `claude attach` (test runs) |
| `MASTERDECK_BOARD_FIXTURE` | unset | path to a `master board` JSON used instead of GitHub (test runs) |

## Keyboard

⌘ is Ctrl on Windows. The full list is in Settings (`⌘/` opens it there).

| Keys | What |
|---|---|
| `⇧↑` / `⇧↓` | Previous / next terminal tab (switches to Terminals) |
| `⌘1`–`⌘9` | Terminal tab 1–9 |
| `⌘T` | New terminal in the workspace (+ menu) |
| `⌘⇧W` | Close the tab (the session keeps running) |
| `⌘\` | Split two tabs side by side, or close the split |
| `⌘K` | Command palette |
| `⌘P` | Open a file of the open session in a tab |
| `⌘`-click | A file path in a session's terminal opens it in a tab |
| `⌘F` | Find in the open terminal, or on the Board or PRs screen |
| `⌘⇧F` | History: search every session, jump to the match |
| `⌘J` | Open the first Needs-you item |
| `⌘E` | The open session's worktrees (Open in editor) |
| `⌘⇧M` | Show or hide master |
| `⌘⇧G` | Refresh from GitHub |
| `⌘,` | Settings (a page: Account, General, Needs you & alerts, Sessions, Hooks, mods & skills, Remote, Keyboard shortcuts, About) |
| `⌘/` | The shortcut list |

Shift+Up/Down work from a terminal too (they don't reach the shell), but not in a text box, where
they select text, or while a dialog is open. `⌘C` copies a terminal selection.

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

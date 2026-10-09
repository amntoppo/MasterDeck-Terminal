# MasterDeck

One window for all your Claude Code sessions, laid out as a command center:

- **The rail** (far left): the views (Terminals, Board, PRs, Tasks), then Costs, Janitor,
  Notes and Workflow, and at the bottom Broadcast, Standup, Skills, Commands (⌘K) and Settings. A badge
  on Terminals counts what needs you; one on PRs counts PRs waiting on you. A blinking amber dot
  above the bottom buttons means a browser, phone or API client is connected right now (see
  *Remote connections* below).
- **Terminals:**
  - **Sessions column:** what needs you, then your **Starred** sessions, then every other session grouped by what it needs (Needs you,
    Working, In review, Idle, Merged; your drag order within each group), then open shells and
    sessions starting, and Parked; a **Filters** line above the groups narrows the list. Click one to open its terminal. **Split** shows two terminals
    side by side; **+** opens the new-terminal / new-session menu.
  - **Terminal:** the session's own `claude` terminal, in the middle, with no bar above it.
  - **Right panel:** tabs **Details** (everything about the session: what it waits on, status,
    ticket and progress, PRs, worktrees, tokens, context, model, diff, and its actions), **Queue**
    and **Summary**. Drag its edge to resize it; › hides it, **‹ Panel** brings it back.
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
- **After a restart:** background sessions run under Claude Code's daemon, so closing a terminal or
  MasterDeck doesn't stop them, but a restart or crash of the Mac does. MasterDeck keeps a list of the
  ones running (`~/.claude/masterdeck/running-sessions.json`); on the next boot a banner offers
  **Resume all**, which runs `claude --bg --resume` for each: same conversation, same id, same folder,
  still linked to its issue. Settings → *After the Mac restarts* can resume them without asking, or
  turn this off. master-agent is left out (it has its own Start). A session already running again is
  never resumed twice, also when MasterDeck is started a second time.
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
- **Queue (right panel → Queue):** holds the focused session's `/queue`, the prompts it runs one by
  one as each response ends. Add prompts, reorder (↑ ↓), remove or clear them; the list updates as the
  session works through it. Pick another session from the menu at the top. An idle session only
  moves on after its next response, so the panel offers **Send next now**. In a session, `/queue
  <prompt>`, `/queue list` and `/queue clear` do the same. `/queue` is handled by MasterDeck's own
  hook, so it works in any Claude session on macOS and Linux, MasterDeck open or not; if you
  installed the queue skill's hooks by hand, MasterDeck leaves `/queue` to them. Sessions already
  running when MasterDeck took the queue skill's hooks out keep using those (Claude Code reads hooks
  when a session starts), and MasterDeck's hook stays out of `/queue` for them until they end.
  While a workflow loop runs, queued prompts wait until it ends (`/queue` still adds to the list).
- **Broadcast (📣):** one message to the sessions you tick; each shows how it's sent, or why it can't be.
- **Set a status by hand:** click the status chip in the Details tab (or right-click the session in
  the column → Set status…). Pick a status (it stays, in the column, Details and board card, until you
  choose **Automatic**; Needs Input still shows while it waits on a prompt), or **Stop session…**:
  it ends (the conversation is kept and can be resumed) and leaves the sessions list at once. A
  session in another terminal is stopped there.
- **Session order:** within each group the column keeps your order. A session moves to another
  group only when what it needs changes. Drag a session to move it; right-click → Move to top.
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
  Open folder in editor, Star / Unstar, Move to top, and Stop session…. The copy commands, Close terminal and Stop are in the Details tab.
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

## Cost and context

- **Tokens:** the Details tab shows **Tokens** (input, output and prompt-cache, with the
  split on hover), and the Costs view shows tokens next to spend: per day, per ticket and per
  session. They are summed from the session's transcript and its subagents', counting each message
  once, by the day it was sent. The first Costs view reads your history once (a few seconds, in the
  background); after that only new lines are read (`~/.claude/masterdeck/tokens.json`). Cache reads
  are usually most of the total.
- **Costs view ($):** spend today, 7 and 30 days, a 14-day bar chart, and tables per ticket and per
  session. The data is the status line's cumulative cost, recorded per session per day in
  `~/.claude/masterdeck/costs.json`. Spend a session had before MasterDeck first saw it counts as a
  baseline: it's in All time and ticket totals, but not in any day. **USD / Tokens** (top right)
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
  refresh every minute while the tab is open. Click a day to see its tickets. **Export CSV…** saves `date,account,ticket,minutes` for the range (an `(account total)` row
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
- **A ticket's note:** one per ticket. In a session's **Details** tab, **Add note** (or **Edit
  note**, with the start of the note above it) opens it; so does the small mark on a ticket's card
  on the Board (always visible, dimmed, on a phone). Such a note has no title: the panel shows
  the ticket and its title. It is listed under **Tickets**. Emptying it removes it.
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

## Settings (⚙)

Nudge after N minutes, budget per ticket, context warning %, auto-open on prompts, dock badge.
Stored in `~/.claude/masterdeck/settings.json`.

- **Set up MasterDeck:** opens Setup as one page (tools, GitHub accounts, repos and boards, status mapping, workspace,
  hooks). Saved to `~/.claude/master/config.json`.
- **Hooks & skills:** status lines, not switches. **Queue** says who runs `/queue`: MasterDeck's
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
  have: only what comes after. A session busy for a long time gets one short message per PR, not a backlog. The session is told reviewer text is for it to judge, never to
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
    not watched again.
- **Details → Scheduled:** jobs a session scheduled with Claude Code's CronCreate (e.g. "check App
  Store Connect every 10 minutes"), read from its transcript: a name from the prompt, how often, when
  it runs next and when it ends (recurring jobs expire after 7 days; session-only ones end with the
  session). Click one for its whole prompt. A job the session cancelled (CronDelete) disappears, and
  an idle session with jobs shows as Waiting ("scheduled: …"), not Idle. Cancelling is done in the
  session itself.

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
- **Mac offline:** the page says "Your Mac is offline — last seen …" and pauses until it is back.
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
  **Panel** opens Details / Queue / Summary as a sheet (› closes it). One terminal at a time (no
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
  unless Setup says another), else the issue's repository's, else the folder's `origin`, else the
  primary; accounts needing a new login can't be picked. Details shows the session's account. A
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
aliases from `~/.ssh/config`. An account whose token GitHub refuses shows as needing a new login; an
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

Also still single-account: the workflow-builder sessions use `gh`'s active account; SSH host aliases are only found in
`~/.ssh/config`; and a rate limit on one account pauses MasterDeck's own polling for all accounts
until it lifts.

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
  list (done means closed, as on GitHub). Clicking a sub-issue opens it on GitHub. A ticket with no
  sub-issues shows no section. A long description and a long list each scroll in their own box,
  so the popup's buttons stay in view.
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
| `⇧←` / `⇧→` | Previous / next view: Terminals, Board View, PRs, Tasks |
| `⇧↑` / `⇧↓` | Previous / next terminal tab (switches to Terminals) |
| `⌘1`–`⌘9` | Terminal tab 1–9 |
| `⌘T` | New terminal in the workspace (+ menu) |
| `⌘⇧W` | Close the tab (the session keeps running) |
| `⌘\` | Split two tabs side by side, or close the split |
| `⌘K` | Command palette |
| `⌘F` | Find in the open terminal, or on the Board or PRs screen |
| `⌘⇧F` | History: search every session, jump to the match |
| `⌘J` | Open the first Needs-you item |
| `⌘E` | The open session's worktrees (Open in editor) |
| `⌘⇧M` | Show or hide master |
| `⌘⇧G` | Refresh from GitHub |
| `⌘,` | Settings (a page: Account, General, Needs you & alerts, Sessions, Hooks & skills, Remote, Keyboard shortcuts, About) |
| `⌘/` | The shortcut list |

Shift+arrows work from a terminal too (they don't reach the shell), but not in a text box, where
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

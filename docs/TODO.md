# TODO (as of 2026-10-06)

Open work, grouped and roughly prioritized (P1 first). Each item: context, where in the code, and
a suggested approach. Nothing here is started. The older design note for Codex/Copilot support is
the repo-root [TODO.md](../TODO.md).

Each open item below is also a GitHub issue with code pointers, approach and acceptance criteria:
[issues #4–#64](https://github.com/amntoppo/MasterDeck-Terminal/issues). Close the issue in the PR that
fixes it, and move the item here to "Recently done".

## Shipping / ops

- **masterdeck.dev in Google (2026-10-10).** The site is live but not indexed yet, and "masterdeck"
  also names a card trick and a decking brand. Done: structured data, the brand in the home page's
  h1, sitemap dates, IndexNow on deploy, one address (no workers.dev), links from this repository
  (website field, description, topics, README, release notes). Left, by hand: add the domain to
  Google Search Console (Domain property, verified through Cloudflare), submit
  `https://masterdeck.dev/sitemap-index.xml`, request indexing of the home page, and import it into
  Bing Webmaster Tools. Then links from elsewhere (a launch post, Claude Code lists) do the most.

- **P2 · First launch after a local reinstall hangs — cause found (2026-10-03).** A stack sample of the
  hung main process shows it inside a JS timer → `SecItemCopyMatching` → `SecKeychainItemCopyContent` →
  `SecurityServer::ClientSession::decrypt` (blocked in `mach_msg`): a synchronous Keychain read
  (`safeStorage` / "MasterDeck Safe Storage") waiting on macOS's "allow access" prompt, which appears
  because every local build has a new ad-hoc signature. It runs before `createWindow()`, so there is no
  window, and the blocked main thread ignores quit and SIGTERM. Fix options: (a) sign local builds with one
  stable self-signed identity (`CSC_NAME` / `codesign -s`) so "Always Allow" sticks; (b) create the window
  first and do every `safeStorage` read after it, off the startup path, with a visible "waiting for
  Keychain" state; (c) both. Until then: click Always Allow on the prompt (it can sit behind other
  windows). GitHub issue #6.
- **P1 · Backend CI deploy broken.** The CI Cloudflare token gets error 7403. Where:
  `masterdeck-backend/.github/workflows`. Approach: give the token Workers Scripts:Edit + the
  account/zone permissions the custom domains need, or drop the deploy job and keep local
  `npx wrangler deploy`.
- **P2 · Measure web-bridge upload with a web tab open** after the state-patch rollout (before:
  134 MB / 3 min). Approach: [OPERATIONS § Measuring upload](OPERATIONS.md#measuring-upload) with
  busy sessions and one tab on Terminals and one on Tasks.
- **P3 · User to confirm Cloudflare billing**: Free plan, payment method, and whether
  `masterdeck.dev` auto-renews (Registrar). Not code.
- **P2 · Global git rules sending GitHub over SSH beat a session's account.** A
  `url.<ssh>.insteadOf`/`pushInsteadOf` for `https://github.com/` in the user's global git config
  wins over the per-session rewrite (`accountEnvBlock`), so a session may push as the SSH key's
  account. Today it is only detected (`githubSshRewrite` in `main/accountEnv.ts`, a `warning` on
  `ghAccounts`). Approach: give sessions `GIT_CONFIG_GLOBAL` pointing at a copy of the global config
  without those rules, or a per-account `core.sshCommand` with the right key.

- **P3 · Multi-account polling gaps.** `master board`'s `errors` don't name the account (the app
  shows them as is); a rate limit on one account pauses the app's polling for every account
  until it lifts (accepted simplification, as in PR watch); untagged team PR pages cached
  before a second account was connected are dropped (not kept as the primary's) if the primary's
  first search fails; `me`/assignable users are the primary's only.
- **P3 · A "duplicates" hint.** Resumes no longer make copies (see Recently done), but copies made
  before the fix, or by hand (`claude --bg --resume <id> -n …`), still show as two sessions of one
  name. They are not cleaned up automatically (MasterDeck never removes a session): the user
  removes them. Show a hint on sessions that share a name (Sources/Sidebar).
- **P3 · A copy made by `master spawn` does not inherit the ticket link in the app.** `resumeAs`
  calls `Sources.noteCopy`; `master spawn` only writes the copy's account and the superseded ids,
  so the app does not know which session the copy came from. Write the pair (old → copy) to a
  file the app reads, or parse it from the proposal's note.
- **P3 · A copy does not carry the old session's model and permission mode.** A resume as another
  account passes `--settings` and `-n` only; the status line's model is a display name, not
  always a valid `--model` value. Read the saved options from the bare-resume note or the
  transcript if this matters.
- **P3 · Master reports guard, hook input.** `tool_input.to/message/summary` and
  `agent_id`/`agent_type` follow Claude Code's documented PreToolUse input; not yet checked
  against a live session's payload. If a field differs the guard fails open.
- **P2 · Board tab builder folders and Claude Code's trust dialog.** Every new Board tab's
  builder folder (`ticket-builder/tab-<id>/`) shows Claude Code's trust dialog until it is
  accepted, and its pre-approved permissions are ignored until then. Check after a reinstall
  whether trusting `<home>/ticket-builder` covers its `tab-*` subfolders; if not, pre-trust each
  new folder or start them in the shared folder.
- **P3 · Parked: gh-active notice with `GH_TOKEN` in the app's env.** When the app's environment
  carries `GH_TOKEN` (or `GITHUB_TOKEN`) for another user, the notice that gh's active account is
  not the primary gives wrong advice (gh uses the token, not the active account). Approach:
  suppress the notice when `GH_TOKEN`/`GITHUB_TOKEN` is set.
- **P3 · Accepted simplifications of several accounts.** (a) A rate limit on one account pauses
  MasterDeck's own polling for all accounts (`Sources.githubPaused` is global; ghcache's pause is per
  account): per-account pause if it bites. (b) Skills run by hand inside a session use its token and
  `GHC_ACCOUNT` but the primary's config and boards; outside a session, gh's active account. (c) SSH aliases are only read from `~/.ssh/config`. (d) A global
  `url.<ssh>.insteadOf` rewrite beats the session's (see the P2 item above). (e) The workflow
  builder sessions use gh's active account. (f) master starts without `--settings` when the primary
  needs to log in again (Needs you says so). (g) The current branch's PR for a session in a folder
  without an `origin` of any connected account is read as the primary. (h) Boards and their repos
  belong to one account: a board holding issues from another account's repos moves cards as the
  repo's account. (i) Select all in one account's Repos & boards may widen what another account
  lists. (j) An account can show healthy for a few seconds before its background check fails.
- **P3 · Phone/API clients and `session.start.account`.** The protocol field is merged and deployed
  in the backend (PR #10); no web or phone UI sends it yet.
- **P3 · Several-accounts review leftovers (small).**
  - Config parsing: `parseAccounts` warns on every parse, top-level `repos` are ignored once an account lists repos, a duplicate board under two accounts is dropped silently, `repoFromRemote` accepts any host for scp/ssh forms, `ssh://git@github.com:443/` and aliases without `user@` are not rewritten, `#` anywhere strips the rest of an ssh config line, login and board keys compared case-sensitively in `accountForProject`/`sessionAccount`.
  - Accounts: a removed account's file lingers up to an hour after its last session ends; a failing `configSave` writes a `config.backup.<ts>.json` each launch; a transient `gh auth token` failure deletes an unused file until the next refresh; `accountClients` never evicts removed logins; an invalid `GHC_ACCOUNT` fails open to the default cache key; `ghc --status` reads only `paused.json`; gh's active account is read each minute (a switch shows up to a minute late); the master-agent notice also shows for a master started by hand while gh's active account is the primary; Setup's scopes with several accounts are the intersection (`project` vs `read:project` not merged).
  - Sessions: `accountOfSession` matches spawn proposals by name only (a reused name picks an old account); `proposalAccount` reads the latest snapshot; AssignDialog's default ignores a proposal's `spawn.account`; a removed or unhealthy recorded login is still shown and sent on resume (fails visibly); unhealthy and unknown accounts get the same remote refusal text; PR watch: an entry whose account was removed falls back to the primary, and a PR shared by two sessions keeps the first one's account.
  - Setup/UI: `closeLogin` may run twice, repeated Log in clicks open duplicate gh-login tabs, the gh-login pane inherits the app's env (a `GH_TOKEN` set at launch makes `gh auth login` refuse), a board held by another account stays in raw `boards` state.
  - Board/PRs: untagged cards on unconfigured boards show only on the primary tab, the global `selectedSprint` may name a sprint the tab's account lacks, after multi to single stale tagged team PR copies show twice until the next refresh.
  - Ticket builder: `md-ticket-builder-*` sessions are hidden by name, a corrupt `context.json` skips the remote account check, and a ticket session's account is sticky.
  - Tests missing: multi-mode gating, remote refusal, dismiss-heal, the `context.json` read, `Sources` glue; the `.pane-head` layout and a prettier warning on `main/index.ts` were not checked.
- **P3 · Old per-tab ticket-builder folders are never removed.** With two or more accounts each
  Board tab gets `ticket-builder/tab-<id>/`; closing the tab leaves it (so reopening continues).
  Main doesn't know which tabs exist (they live in the renderer's storage), so nothing sweeps them.
  Approach: the renderer reports its tab ids, and `tab-*` folders of no tab untouched for 7 days go.
- **P2 · First real run of "Create a GitHub board".** Everything is tested against a fake gh; the
  mutations were checked by schema introspection only. Run it once on a throwaway repository and
  confirm: the default Status field is there and its options keep their ids, 20 aliased
  `addProjectV2ItemById` per request pass GitHub's secondary limits, a repository of another owner
  links, adding an issue twice is harmless, and whether `projectsV2(query: "is:open")` lists a board
  created seconds earlier (the duplicate-name check after a timed-out create relies on it: if the
  search lags, a second Create of the same name is not refused). Where: `main/boardCreate.ts`; the spec's §9
  (backend repo, `docs/superpowers/specs/2026-10-05-board-without-a-github-project-design.md`).
- **P3 · Existing boards without a sprint field show nothing under "Current sprint".** Only boards
  MasterDeck creates are marked `sprintless`. Approach: let Setup write the marker when the detected
  board has no iteration field (`setup._board_of` knows), after the user agrees: it changes what such
  a board shows (everything, on every sprint choice).
- **P3 · What a board-creation run could not add is kept in memory only** (`BoardCreator.pending`):
  after a restart, Try again is gone and the issues must be added on GitHub. Approach: a small file
  under `MASTERDECK_HOME`, or an "Add missing issues" action that lists a board's repositories' open
  issues that are not on it.
- **P3 · Accounts with more than 10 repositories or 300 open issues and no board** see a cut-off
  Board (it says so). Approach: page further on demand, or filter by assignee in the query for the
  Mine tab.
- **P3 · Create a GitHub board from the web app / phone** is blocked by design; revisit if asked
  (needs a confirmation flow that does not rely on the Mac's dialog, and a way to fix a missing scope
  remotely).
- **P3 · The first sweep after the upgrade can raise many ASSIGN proposals** for a user with no
  board and many old open issues assigned to them: every one in Todo with no session is proposed, and
  there is no cap (spec A4 leaves it so). Approach: cap the ASSIGN proposals per sweep for derived
  issues (newest first), or propose only issues updated in the last N days. Where: `rules.propose`,
  `normalize.repo_issues`.
- **P3 · A repository that answers null with anything but NOT_FOUND is asked again on every sweep.**
  A partial answer makes gh exit 1, the shared cache stores only exit 0, and only `NOT_FOUND` is
  remembered (`missing-repos.json`), so a repository that keeps answering e.g. `FORBIDDEN` (SAML,
  access removed without a rename) means the whole repository query is sent again each time, for
  every repository of the account. Approach: remember such a repository for a few minutes (a short
  TTL beside the hour for NOT_FOUND), still naming it in `unread`. Where: `collect.Live.repo_issues`.
- **P3 · Board without a GitHub project: review leftovers (small).**
  - Board creation (`main/boardCreate.ts`): an account error from `makeGhRunner` on the create call
    ("not ready yet", "needs to log in again": never sent, empty stdout, `ghc.ts`) still gets the
    "may have been created" suffix (only `accountGh`'s refusal is marked `NOT_SENT`); `columnsOf`
    refuses a Board that is not loaded but cannot tell a stale one (an old cache), so issues may get
    the column they had at the last read; a repository link that keeps failing does not by itself
    keep the job pending (it is retried only when Try again runs for another reason), and no test
    covers a run whose only leftover is an unlinked repository; Try again after the account was
    disconnected answers "nothing left to add"; with one account Try again is refused while gh's
    active login is not the one that confirmed (it must be switched back by hand; a job made while
    gh named no active login can only be retried in that same state); a status request that failed after GitHub applied it
    is sent again on Try again and overwrites a move made on GitHub in between (one batch); the
    duplicate-name check reads the owner's first 100 open boards (the confirmation says so).
  - Board tab (`BoardView.tsx`, `shared/derivedBoard.ts`): "Could not read <repositories>"
    (`'not-read'`) shows only when the tab has no card at all; with cards from other repositories
    only the note line says it. An account whose whole read failed (no part at all) shows "Loading
    board…" again during each later refresh, then "Could not read" (`awaitingRead` cannot tell a
    first read from a read after a failure). `boardDeriver` keeps the board's identity stable but still builds
    the derived objects on every state build. `columnsWithDerived` (remote snapshot): a board with
    both kinds of cards whose own columns share a name with MasterDeck's, and a board with no cards,
    are untested edges. A "Nothing selected" tab still shows the sprint picker and Summary (it is
    not in fallback mode: no repositories). An unconfigured app reads as "Nothing selected" in
    `boardEmpty` (the Board shows Setup's welcome instead; check the web app and phone). No test
    renders `BoardView` or covers `Sources.refreshBoard`'s gate (helpers only). The spec says
    "N open issues; the filters hide all of them"; the tab says "N issues" (the count includes
    recently closed ones).
  - Create with Claude in a tab without a board: the CLAUDE.md lists only the tab account's
    repositories, but the "People on the board" list and the open sprints still come from every
    account, and a `--repo` of another account is not refused (the issue is created there, on no
    board). A tab whose account has a board still falls back to the config's first board (the
    primary's) when `--project` is left out, as before.
  - The account a ticket is created as is matched by exact case in `BoardOps.create`
    (`CreateOpts.account`) and `ticketContext`: a login spelled in another case is treated as not
    connected, so the no-board rules do not apply to it (the repository's account still decides).
    An account with no repositories and no board is not "boardless" (`boardless` needs repositories),
    so a ticket created as it without `--project` still falls back to `cfg.projects[0]`.
  - Version skew: a `master` CLI from before this change prints no `derived` parts (the tab then
    reads "Could not read" until both are updated), and one that prints only the top-level `notes`
    cannot attribute them with two accounts without a board. Say so in the release notes.
  - `master board` / `master snapshot` (`collect.py`, `board.py`, `normalize.py`): `missing` is
    recorded from the first page round only (a null on a later page is not marked);
    `missing-repos.json` is read and written without a lock; closed issues are the 50 most recently
    updated since the 14-day cut (not strictly the 50 most recently closed); only the first 5 linked
    PRs of an issue are read, so an open sixth is not seen; `derived.total` counts every open issue
    also under `--mine`; an issue that is on another account's board is taken off this
    account's `total` / `shown` only when it was among the issues read (past the 300 it still
    counts); the 300-issue cap applies before the assigned-to-me filter; the snapshot's
    repository read runs even when the login is unknown, and the snapshot drops `missing` / `unread`.
  - Linking and tickets (`boardOps.ts`, `boardFlow.ts`): `setStatus` refuses by the repository's
    account even when the issue sits on another account's board; tests missing for "linkPr still
    runs for a ticket without a board", a ticket with no card, and New ticket with a picked account
    that is not the repository's.

- **P2 · BoardFlow autoLink marks `linkTried` before the attempt.** A transient `issueInfo` failure means the session is never linked (no retry); more visible now that off-board issues link (`offBoard`). Where: `main/boardFlow.ts` autoLink. Approach: set `linkTried` only after a definitive answer (linked, or refused as not selected), keep it unset on a read failure.
- **P2 · First real use of the Board's repository view: its GraphQL cost is unproven.** `master
  repo-issues` was tested with fake runners only. On a real repository confirm: GitHub accepts the
  combined query (`projectItems` inside the repository-issues query) and what it costs (the shared
  cache's log shows the points left; the spec's 6 to 7 points per repository is an estimate, and a
  tab with more than ten repositories of one account now makes one call per ten, one after the
  other, inside one CLI run that has two minutes per ten), the chip matches the card's column on the
  board, and, if a token without the `project` scope is at hand, the view still shows its issues
  with the note "Board columns not read: …" (the refusal is recognised by an error on a
  `projectItems` path, by type `INSUFFICIENT_SCOPES`, by a message naming `projectItems` or
  `read:project`, and when gh fails with no data over one of those: none of the four shapes was seen
  live). Where: `collect.Live.repo_issues`, `collect._boards_refusal`, `board._boards_part`, spec §12.
- **P2 · Deploy the web app only after the desktop release that has the repository view.** A desktop
  from before has no `board:repos` handler: a web tab with repositories picked (a saved one counts)
  sits on "Loading issues…" for ever. Approach: in `BoardView`, when an asked repository has no part
  after some seconds, say "Update MasterDeck on your Mac to see a repository's issues".
- **P3 · The refresh after a ticket or an assign does not re-read the repository it touched.** Only
  the Board's own Refresh / Retry forces the repository read; a ticket created from a repository view
  shows up when the gh cache lets the next read through (an assign shows at once: `noteAssigned`).
  Approach: after a write, force a read of that one repository (`RepoIssues.refresh` with a list).
- **P3 · A big repository view is cut, and slow before the cut.** The state carries at most 1200
  cards and 500 KB of JSON across the repositories on screen ("api: showing the first N of the M
  issues read, to keep the view small.") and 30 repositories.
  Approach: render a column's cards on scroll, or page the read, then raise the limits.
- **P3 · Only the repository view's share of the state is size-budgeted.** The web bridge drops a
  state whose JSON passes about 1.05 MB (`browserBridge.ts` `tooBig`); `viewOf` keeps the view under
  500 KB, but the board, sessions and PR lists have no budget, so a very large board beside a full
  view can still lose the web its state (the desktop is not affected). Approach: measure the whole
  state in `Sources.build` and shrink the view's budget by what the rest takes, or say so in the web app.
- **P3 · A refusal can fall out of what MasterDeck remembers.** It keeps the 30 latest refusals
  (a repository it had no room for). A tab whose refusal was pushed out by 30 newer ones shows
  "Loading api…" for that repository until its next ask (at most 20 minutes) instead of the reason.
  Needs more than 60 distinct repositories asked for within the hour. Approach: answer `boardRepos`
  with the plan instead of fire-and-forget.
- **P3 · The repository view does not say when MasterDeck on the Mac is older than the web page**
  (see "Deploy the web app only after…" above): the same "Loading issues…" for ever.
- **P3 · A no-board account's repositories past the first ten cannot be seen by picking one.** Picking
  filters what `master board` read (the first ten). Approach: let `cleanRepos` accept a repository of
  a no-board account that its `derived` part lists as `skipped`.
- **P3 · `/babysit-ticket`'s `tt.sh link` refuses an issue no board holds**; MasterDeck links it
  (Start, Link session…). Approach: the same rule in `tt.sh` (the repository is selected in Setup).
- **P3 · The repository view is not in the phone API's snapshot** (`toRemoteSnapshot`): a protocol
  change. The web app has it.
- **P3 · An archived project item still shows as a chip** in the repository view (`projectItems`
  returns archived items). Approach: read `isArchived` and leave those out.
- **P3 · A whole-run CLI timeout discards chunks that already succeeded.** `master repo-issues`
  reads ten repositories of an account per GitHub call inside one process (30 repositories: three
  calls, up to six minutes); when the app's timeout ends the run, the repositories already read are
  lost with it, and other repository reads and Refresh wait behind it (one read at a time).
  Approach: print each chunk as a line when it is done and let `RepoIssues` apply them as they come,
  or have the app send one CLI call per ten.
- **P3 · Three gaps in which account a card's calls go out as** (`accountForCard`, `forCard`).
  (1) A status move is routed by the card's account, not by the project's owner: a repository
  listed by account A whose card sits only on B's board is moved with A's token, which fails when A
  cannot write B's project. (2) `Sources.boardOf` without a number (the assignable-users read, a
  PR's summary) guesses by repository: the first loaded card of that repository decides the board.
  (3) `BoardFlow` drops the project it already knows: a my-issues card outside the loaded sprint, in
  a repository no account lists or owns, is not found by `boardOf` and routes to the primary.
  Approach: carry the card's `project` in the ticket through `move`/`linkPr`/`setStatus` and route
  project writes by `accountForProject`.
- **P3 · A session for a card of a repository no account lists starts as the primary account.**
  MasterDeck's own calls for such a card go out as the account whose board holds it (`forCard`);
  a session started from it (Start, a PR review) still takes its account from the repository alone
  (`defaultAccount`: `matchRepo`, else the primary), so it may not be able to read a private
  repository on another account's board. Approach: pass the card's board into `defaultAccount`.
- **P3 · The per-repository Assign list was not seen in the app or against GitHub** (suites only):
  the loading line, the error line, and `gh api repos/<o>/<r>/assignees` as a second account.
- **P3 · The PR popup was not checked at phone width.** The phone preview has no card that opens
  the PR popup, so its fit at 390 px (with the new **Start a session** button) was not seen. Approach:
  add such a card to `web/preview/fixture.ts` and look at `/?preview` at 390x844.
- **P3 · Small things seen in the isolated app (plan K, Task 8).** A card in Done whose PR is merged
  still shows the **Review PR** badge; two test files use real-looking first names as logins in
  lines from before this plan (`newTicket.test.ts`, `boardFilter.test.ts`): rename to `alice` /
  `bob-work`.
- **P3 · The final fixes of plan K were checked by the two test suites only**, not in the isolated
  app: reads of more than ten repositories, the stricter Select all rule, the reasons a picked
  repository is not read, the 5-minute ask, the size budget, the Assign popup's tooltip. Approach:
  one isolated run with `MASTERDECK_REPO_FIXTURE` and a tab that picks an unticked repository.

## Create a GitHub board: first real run (2026-10-06)

- **P2 · The first batch of issues reported "Added 0 of 26".** The first real run (one account's
  board, one repository, 26 open issues) created the project, its four columns, the repository link
  and the config entry correctly, then answered `ok` with "Added 0 of 26 issues" and 26 left. The
  same `addProjectV2ItemById` batch of 20 sent by hand a minute later was accepted whole, and the
  board's item count lagged for about half a minute (7, then 20, then 26; every item came up as
  Todo). So right after `createProjectV2` GitHub answers the first add batch with errors, or in
  part, and item counts are eventually consistent. To do: log what GitHub answered for a batch that
  is not `answered`; count the aliases that did succeed in a partial answer; retry a failed batch
  once after a pause before giving up; do not report `ok` with the board selected while nothing was
  added (the tab then shows an empty board until Try again). Not reproduced in a test yet.

## Untrusted start folder: review leftovers (2026-10-06, no issue yet)

- **P3 · Small leftovers of the trust fix.** (a) `ptyWrite` / `ptyClose` have no caller or kind
  check, so a paired browser can blind-write to or close the `claude:<folder>` helper tab by its id
  (it cannot open or read it; same as the `gh-login` tab). (b) The retry branch of `startAssign`
  rejects a proposal whose ticket has a live session without checking it is held for trust. (c) The
  "already running" closing sentence is three separate literals (CLI, `assign.ts`, `trust.ts`): share
  one. (d) A proposal started elsewhere in the meantime answers the retry with an error, not
  "started". (e) A held card can stay behind when master has a newer proposal for the same ticket.
  (f) `trust.py`: a folder spelled in another letter case than Claude Code's key reads as not
  trusted (Start waits for **Start anyway**); a `.git` that cannot be read is walked past. (g) The
  Python trust tests have no file-level guard against a real `claude` call if `spawn()` stopped
  honouring its runner. (h) The parent-folder rule mirrors a reading of Claude Code's code; confirm
  it against the real prompt once.

## Where a session starts (2026-10-05)

- **P3 · Trust on Windows** (2026-10-06; the Mac's first real run is done, #59, 2026-10-09: the
  dialog's line for a temp checkout, **Open Claude there…** showing Claude Code 2.1.295's real
  prompt in the tab, the line turning into "can work in … now" once it was accepted, and a real
  `claude --bg` starting there). Never done: Windows (how Claude Code spells a folder's key there is
  assumed: forward slashes, compared without case). If Claude Code moves or renames
  `hasTrustDialogAccepted`, the dialog says nothing (not known) and the refused start still offers
  the fix; check `trust.py` then.
- **P3 · Open Claude there… leaves an interactive Claude running in its tab** after the prompt is
  accepted (a full session in that folder, on the default model and mode, until the user exits it);
  the dialog only says "You can close that tab". Decide whether the tab should end on its own once
  the folder is trusted, or whether the tab should run `claude` with a flag that exits after the
  prompt if Claude Code ever has one.
- **P3 · A held start does not count in the Needs you badge and sends no notification** (held
  items never do). A start master spawned and Claude Code refused is only seen in the list.
  Decide whether a refused start should be its own kind.
- **P3 · Claude Code's parent walk is mirrored from a reading of its code**, not from a documented
  rule (inside a repository up to its root, outside one all the way up). If a release changes it,
  `trust.py` is the one place; a wrong False only shows the line and holds Start until Start
  anyway.
- **P3 · The web app cannot re-check trust** (`deck.trust` is the window's): its Start dialog
  shows the line from the draft and leaves Start available.

- **P3 · Choose folder… into a folder that is not the checkout, once** (#59, 2026-10-09). Done for
  real in the isolated app with the real `claude` ([OPERATIONS](OPERATIONS.md#isolated-e2e-test-recipe),
  "A real start from the Start dialog"): Start from the dialog put the session in the resolved temp
  checkout (`claude agents` agrees), `parked-sessions.json` got its record keyed by the background
  id (`claude --bg` 2.1.295 prints `backgrounded · <id> · <name>` and four hint lines; the real
  output is in `test_spawn.py`), and a link of the parked session recorded no branch while the
  same link without the record took the folder's. From a master proposal: the native picker
  (the user chose in the sheet), the line turning into "the folder you chose (a checkout of
  acme/tracker)", and Start replacing master's proposal with one that keeps its prompt and model
  (`--model haiku`), the session running in the chosen folder with its own parked record. The
  folder chosen was the checkout the sheet opened on, so a start in a folder that is no checkout
  (the "the folder you chose" line without the repository, no parked record for a workspace) is
  still only unit-tested.
- **P3 · A proposal's model is not shown by the Start dialog.** Opened from a proposal that names
  `--model haiku`, the Model select reads "Default" (the start keeps master's model through
  `startChoice`; only the picker is silent). Preselect it, or say "master picked Haiku" under it.
- **P3 · Re-linking a session that no longer owns its branch leaves the old `branches` entry**
  (`ticket-links.json`): seen when the same session was linked with and without its parked record
  (branch `""` on the second link, `acme/tracker@feat/someone-elses → #59` still mapped). A
  session's link that records `""` should drop the branch key its earlier link wrote.
- **P3 · The app tries to link a session it started to its ticket at once** ("link …: could not
  read #940" in the log for a fixture ticket), so with `MASTERDECK_BOARD_FIXTURE` a started
  session is never linked and its card never moves; fine for tests, but worth a word in the
  recipe. Decide whether a failed first link should be retried on the next poll.
- **P3 · A workspace that is itself a repository with its clones next to it.** Setup's label says
  repos live "in or next to" the workspace, and `ops.repos()` lists the siblings in that case, but
  `checkout.scan` only looks inside the workspace (it never leaves it). Such a setup gets "No
  checkout found" and starts in the workspace as before. Approach: when the workspace has a `.git`
  folder, also look at its parent's direct sub-folders.
- **P3 · "Code lives in" is set by hand.** Setup's pairs (#61) cover a tracker whose code is in one
  repository. A tracker whose issues go to several repositories still starts in the tracker's
  checkout (no pair) or always in the one paired repository. Possible next step: the issue's linked
  PRs or branches, when it has any, before the pair.
- **P3 · Nothing checks that the code repository's account can read the tracker** (#61 review).
  With a private `bob/tracker` paired to `acme/api` (alice), the session runs as alice and
  `gh issue view bob/tracker#7` fails, with any comment or board step it does itself. Documented
  in Setup and the guide; a fix would fall back to the tracker's account when the code account
  cannot read it (one read, remembered), or warn in the Start dialog.
- **P3 · A proposal made before a `codeRepos` pair existed** carries the issue's account and folder.
  The Start dialog's default is now the code account, so the start becomes a new proposal
  (`reuse` is false) while `adoptFresh` keeps the proposal's folder when it was a checkout (the
  tracker's), and the session runs as the code account in the tracker's checkout. Rare (only
  across adding a pair); a fix would let `adoptFresh` also move from the issue repository's own
  checkout when a pair now points elsewhere.
- **P3 · "The PR's repository wins" is the app's only** (#61 review). A `PRREVIEW` added through
  the CLI without `--cwd` / `--account` (`checkout.default_cwd`) looks up the issue's code
  repository and account, not the PR's: the proposal carries no PR repository. The app's PR
  popup passes both. A fix would add the PR's repository to the proposal (`--cwd-repo`).
- **P3 · The Start dialog opened from master's proposal starts with the ticket's default account**,
  not the account the proposal names (`sp.account`). Both come from the same rule now
  (`start_account` / `startAccount`), so they differ only for a proposal written by hand.
- **P3 · The scan is remembered per CLI process only** (60 s): each Start dialog and each sweep
  scans once (a stat per folder, a small file read per checkout; the folder named after the
  repository is found without a scan). If a large workspace makes that slow, keep the map in a file under `master_home()`
  and re-scan on a miss (`ponytail:` note in `checkout.py`).
- **P3 · A fork's checkout never matches.** `origin` pointing at `alice/api` (a fork) with
  `upstream` at `acme/api` is not a checkout of `acme/api` for the resolver. Approach: also read the
  `upstream` remote, or ask GitHub for the fork's parent once and remember it.
- **P3 · An SSH alias without a user** (`github-acme:acme/api.git`) is not parsed by the shared
  origin parser (`config._REMOTE_RE`, the app's `repoFromRemote`), so such a checkout is not found
  and its sessions get no account from the folder either. Fix both parsers together.
- **P3 · `collect.Live.branch_head` still looks for local branches beside the top-level workspace
  only** (`config.workspace().parent`); another account's workspace falls back to the GitHub API.
- **P3 · A browser's `assign` request still carries any `cwd`.** #62 checks the folder a browser
  chooses in the Start dialog (`chosenFolder` on `draftAssign`), but `assign` passes its own `cwd`
  on from a browser as from the window (as it always did, and the + menu's New session takes a
  typed path). Decide whether a browser's starts should all be held to `workspaceFolders()` (a
  proposal's folder, a worktree and the workspace would have to pass too).

## Start dialog (#66): leftovers (2026-10-06)

- **P3 · The app has one theme.** #66 asks for light and dark; the dialog uses the palette's
  variables only, so a light theme would carry over, but there is none to check against.
- **P3 · Create worktree is the Mac window's only.** The web app does not show the box
  (`worktreeCreate` is `blocked`). To offer it there the folder must be the one the CLI resolves
  for the ticket, never one the browser names.
- **P3 · A worktree whose start then fails stays.** The worktree is made before `master spawn`; if
  the spawn fails, **Retry** starts the held proposal in it, but closing the tab leaves the
  worktree and its branch (Janitor lists it). Starting the ticket again with the box ticked says
  the branch exists.
- **P3 · The small `Markdown` in `SummaryPanel.tsx` could move to `MarkdownView`** (`shared/markdown.ts`), as Notes (#65) did.
- **P3 · Remembered choices are per window profile** (localStorage): the web app keeps its own.
- **P3 · `skills/master/tests/test_ghcache.py`: three tests fail when run from inside a MasterDeck-started session** (seen 2026-10-06, on `main` too; cause not looked into, the session's own `GHC_*` environment is the suspect).

## Remote / web

- **P1 · Drift test doesn't run in CI.** `app/src/shared/remote.drift.test.ts` skips without the
  backend checkout, and MasterDeck CI doesn't check it out (the backend repo is private). Approach:
  a CI step that checks out `amntoppo/masterdeck-backend` with a read-only deploy key / fine-grained
  token into `../masterdeck-backend` (or set `MASTERDECK_BACKEND`), or commit a hash of
  `protocol.ts` on both sides and compare that.
- **P2 · Control-character rule gaps** in `masterdeck-backend/src/protocol.ts` (then
  `sync-protocol.sh`): `inbox.act` `question` (`z.string().max(2000)`), `MenuAnswer.answers`
  record keys (`z.string().max(500)`), `itemAnswered.by` (`z.string().max(40)`), `ItemInput.body`
  and `ItemInput.ticket`. Approach: use `clean(n)` for each; additive (stricter) — check the web/app
  never sends control chars there.
- **P2 · External items: dismiss sends no callback; callbacks have no timestamp.** Where:
  backend `hub.ts` (`dismissItem`, the callback signer `sign()` / `x-masterdeck-signature`). The
  desktop already sends `itemDismissed`. Approach: deliver a `dismissed` callback; sign
  `timestamp.body` and add `x-masterdeck-timestamp` so receivers can reject replays (document a
  5-minute window).
- **P3 · Invalid backend address silently ignored.** There is no address field anymore (Settings
  → Remote has none since accounts); `remoteUrl()` in `app/src/shared/account.ts` silently falls
  back to `https://dev.masterdeck.dev` when `MASTERDECK_REMOTE_URL` is malformed. Approach: log a
  warning at startup (and show it in Settings → Remote) when the env var is set but rejected.
- **P3 · Typing latency options (undecided).** (a) cut the bridge's PTY batch `batchMs` 50 ms → ~10
  ms (`app/src/main/browserBridge.ts`, more frames); (b) Durable Object `locationHint` near Asia
  (backend `idFromName` in `worker.ts`; an existing hub would start fresh, losing stored
  snapshot/commands); (c) Cloudflare Argo routing (paid). User in India is routed to Marseille
  (~195 ms ping).
- **Instant typing follow-ups** (`app/src/renderer/src/predictiveEcho.ts`):
  - P2 · Verify in a real browser by an agent (only the user's "That works" so far).
  - P3 · The first 3 chars after observe mode starts are never predicted (by design of
    `RECOVER_AFTER`); could carry a learned "echoes" flag per pane across buffer switches.
  - P3 · Backspace/arrows never predicted on the alternate screen (`allowed()`); could learn them
    like chars.
  - P3 · zsh right prompts (text right of the cursor) block Backspace/Right predictions.
  - P3 · Test parity: tests use `@xterm/headless` 5.5, the browser runs `@xterm/xterm` 6. Bump
    headless when a 6.x exists, or run the fuzz against xterm 6 in jsdom.
  - P3 · Optional hardening in `write()`: hold output when `overlayInflight > 0 || held.length`
    (today only `overlayInflight > 0`).
- **Remote indicator follow-ups**: P3 · no React/jsdom render tests for `RemoteIndicator`
  (`Rail.tsx`; only the pure helpers are tested); P3 · browsers from old web builds show "Unknown
  device" and no connected-since (they never send `device`, `connectedAt` unknown) — goes away as
  tabs reload the new web app.

- **P3 · Phone layout follow-ups** (web, ≤760 px). Where: `src/web/web.css` (`.app.phone`),
  `BoardView`. (a) The Board is one wide row of columns that scrolls
  sideways; a one-column-at-a-time picker would read better. (b) Checked only in emulation (the dev
  preview, Chrome); try a real iPhone/Android for the soft keyboard (`visualViewport`) and safe
  areas. (c) Dialogs that are fixed-layout grids (Setup, Workflow canvas) were only made to fit, not
  redesigned.

## Older (pre-remote)

- **P3 · Board "Everyone" tab**: own issues not shown when selecting yourself as the person
  filter. Needs repro steps from the user. Where: `app/src/shared/boardFilter.ts`, `BoardView.tsx`.
- **gamerun-app PR #140 (feat/org-join-code)**: closed unmerged on purpose; the merge-conflict
  question was never answered; 4 local commits unpushed there. Other repo; ask the user.
- **Offers never answered** (ask before doing): show Claude Code's own monitors in Details.
- **Native PR watch / board / queue follow-ups** (plan H, all P3, deferred from review):
  `LinkStore` read-modify-write has no lock across instances (`main/ticketLinks.ts`); auto-link
  marks a ticket tried before linking, so a transient failure is never retried, and
  `board-link-tried.json` is never pruned (`main/boardFlow.ts`); PR watch polls inaccessible PRs
  forever and runs the heavy query every minute for CONFLICTING/UNKNOWN PRs (`main/prWatch.ts`);
  a hook killed between the alive check and reading its answer loses one `/queue` item
  (`main/deckHooks.ts`); review-gate markers in `$TMPDIR` are never cleaned; a ticket request has a
  ms race between `.taken` and `rm -f .req` on timeout (`mv .req .gone` would close it).
- **Queue item waits a turn (M2)**: when the app claims a Stop request but answers after the hook's
  7 s wait, the hook exits without a prompt; the item stays queued (not lost) and goes at the next
  turn's Stop (`main/deckHooks.ts` `pumpQueue`).
- **legacy-sids `*` expansion**: `deck/legacy-sids` starts as `*` and becomes the sessions alive at the first
  healthy session list, not those alive at the migration. If the app quits before that, sessions started in
  between lose `/queue` until they end; if `claude agents` never succeeds, `*` blocks `/queue` everywhere.
  Fix: store the migration time and keep only sessions that started before it.
- **Board link branch is often empty**: the auto-link takes the branch from the session's cwd at spawn (often
  `dev`), so `prOnBranch` rarely helps; a PR the transcript scan cannot see (opened in the browser) is not
  linked. Fix: refresh an empty link `branch` when the checkout moves to a feature branch.
- **Settings backups never pruned (M4)**: `settings.backup.*.json` in `<home>` pile up (up to 4 on
  the first launch: migration, review gate, deck hook, workflow hooks) (`main/hooks.ts` `write`).
- **Orphaned babysit-proof hook**: older machines may still have a babysit-proof `PROOF_PRE`
  PreToolUse hook in `~/.claude/settings.json` (the skill is gone; `migrateLegacyHooks` does not
  remove it). Remove by hand, or add it to `LEGACY`.
- **Cleanup** (list exact paths, delete only those): remote-probe transcript folders under
  `~/.claude/projects`; scratch dirs in `~/.claude/jobs/*/tmp`; the leftover untracked
  `skills/babysit-proof/` (only `__pycache__`, skill removed in 9329db4).

## Notes: open points (2026-10-06, issue #63; Markdown is #65)

- **P3 · No history and no export.** No earlier versions of a note, and no export (the files in
  `~/.claude/masterdeck/notes/` are plain JSON).
- **P3 · Markdown in notes (#65): open points.** (a) A task list's boxes in the preview cannot be
  ticked: change `[ ]` in the text. (b) An image in a note is a link, never drawn (nothing is fetched
  on opening a note): a picture pasted into a note is not shown. (c)
  Details and the card's hover show the plain one-line preview, not rendered Markdown (the full text
  is never in the list). (d) The preview parses the whole text on every key; fine at 50,000
  characters, not measured on a slow phone.
- **P3 · Sessions writing notes (#65): open points.** (a) Any process of the user's can write a
  request (as it can write the notes folder itself); there is no switch to turn it off. (b) A
  session cannot read a note, also not one it made, and cannot replace or delete text. Not a wall: a
  session runs as the user and can read the notes folder's files, and the 50,000-character refusal
  tells it something about a note's length. (c) Not on
  Windows (bash and the deck folder are macOS-only today). (d) A note does not say which session
  wrote it; the session can say so in its text. (e) The skill names its script by
  `~/.claude/skills/...`: with `MASTERDECK_SKILLS_DIR` elsewhere the path in SKILL.md is wrong.
- **P3 · Editor edges.** (a) If the answer to a first save is lost (the line drops after the store
  wrote it), the editor retries as a new note and makes a duplicate. (b) A note marked "Deleted
  elsewhere" with nothing unsaved is dropped when the user switches to another note. (c) The notes
  list is not retried when its first read fails (`useNotes`: the panel stays on "Loading notes…" until
  the window reloads). (d) **Delete** on a brand-new draft that was never typed in asks nothing.
  (e) "Could not open the note" is set on the status line, which is drawn only inside an open editor:
  with the list alone nothing shows it. (f) **Discard** does not look again after its read: text typed
  in that moment goes with the rest. (g) Refused text is tried once more when the user leaves; when
  that try gets no answer (the line dropped just then) it is not retried on the timer (the text stays
  in the editor). (h) ⌘K on a phone-width window can leave the sheet over a pick that stays in the
  same view. (i) **Keep mine** that gets no answer is not tried again by the timer: the conflict line
  stays and the user presses it again. (j) A disk failure that does not clear (no space, no
  permission) is retried every 5 s with only "Not saved": no reason shown, no **Discard**, and
  switching notes is held back. (k) A drag that starts on a Board card's note mark may still drag
  the card (the mark's own `dragstart` handler was only checked with a made-up event).
- **P3 · Store edges.** (a) The store reads any file in the notes folder whatever its size and follows
  symlinks (only a file that is not a note is left alone). (b) A preview is cut at 120 UTF-16 units and
  can cut an emoji in half. (c) No fsync before the rename: a power cut can leave an empty note file
  (it then loads as "not a note" and is left alone). (d) An empty or broken file with a ticket note's
  name (`t-<owner>~<name>~<number>.json`) blocks that ticket's note until the user moves it away: the
  save says so and names the file. (e) At 1000 notes with long non-Latin titles and previews (3 bytes
  a character) the answer of `notes:list` can pass the web bridge's frame (about 1.05 MB of JSON); the
  web panel then stays on "Loading notes…". (f) Search lowercases every note's text in main on each
  call (up to 50 MB of string work at 1000 full notes), and the panel searches again on every list
  change while a query is typed.
- **P3 · The Board card's note mark** keeps 20 px in every card's top row, also while it is
  invisible, so the badge beside it sits further left than before. The user's eye decides.
- **P2 · Not checked.** The native **Delete** confirmation (a native dialog blocks CDP: only the
  user can press it); the real web app over the real bridge (needs a web deploy after the desktop
  release that has Notes); a real phone (iOS zoom on focusing the editor: the CSS sets 16 px); the
  Master tab closing the phone sheet; the session Details entry (**Add note** / **Edit note**) on
  screen (no listed session had a ticket in the isolated run); Windows.

## Linked sessions: open points (2026-10-07, issue #67)

- **Sync now typed delivery covers idle peers only.** Without live hooks (Windows) a busy peer is
  skipped and gets nothing until the next Sync now.
- **The first poll after launch may replay old Stops.** Bounded by the 2-minute debounce and the stale
  check, but a summary can be made for a session that did nothing new.
- **A `StopFailure` counts as a Stop** for the summary on Stop.
- **`PeerPicker` swallows ⌘/Ctrl+Enter and has no IME guard**, so a dialog's Enter-to-start does not
  work with the picker focused and a composing Enter can pick a row.
- **The phone API `session.start` has no `peers`.** A session started from a phone cannot be linked at
  start; it can be linked after, from its details.

## Create with Claude settings bar: open points (2026-10-09, issue #68)

- **Not run against GitHub.** A ticket created through the bar (assignees, labels, milestone,
  sprint) was checked with fake creates only; the first real one is the user's.
- **The bar is per session in memory.** Closing the app (or the tab) loses its edits; it starts again
  from where the + was clicked. Persist it per tab if that is missed.
- **One bar for every ticket.** "Split this into tickets" in different repositories means changing the
  bar between them; per-ticket values would need the bar to hold a list.
- **Labels or a milestone the repository lacks** (from the tab's filters) are only caught by
  `gh issue create` failing; the bar does not drop them once the repository's labels load.

## Working hours: open points (2026-10-09, issue #64)

- **Several machines.** The estimate covers this Mac only. The user wants an account's time from
  every machine where the same MasterDeck account is connected: each Mac would send its activity
  spans (account, ticket, start, end) to the backend, a protocol and storage change.
- **Only sessions in the cost book** (a status line record) are counted: a session that ran without
  MasterDeck's status line is not seen.
- **No Hours on the web app or a phone** (`DECK_ACCESS` blocks both channels); open them over the
  encrypted bridge if the user wants it there.
- **Commit times are not used**; add them only if turns prove too coarse.
- **`hoursOrigins` (main/index.ts) has no test**: the pool of four, the skipped missing folder and its
  own cache were checked by reading only; move it to a module with a fake runner if it grows.
- **The ticket is the cost book's** (the session's last linked ticket): time before a session was
  linked counts for that ticket too, and a session relinked to another ticket moves all its time.

## MasterDeck mod: open points (2026-10-10, issue #86)

See [MODS.md](MODS.md) for the research and the ideas list; ARCHITECTURE, "The MasterDeck mod".

- **Not installed by MasterDeck.** Setup step / Settings switch that copies `mods/` under
  `MASTERDECK_HOME/mods/` and runs `claude plugin marketplace add` + `claude plugin install
  masterdeck@masterdeck --scope user` (and uninstall), with a version check (2.1.287+). Package
  `mods/` in the app (electron-builder `extraResources`).
- **Installed by hand on the user's machine (2026-10-10)**: `mods/` copied (`git archive`) to
  `~/.claude/masterdeck/mods`, `claude plugin marketplace add` it, `claude plugin install
  masterdeck@masterdeck --scope user` (settings.json backed up first as
  `settings.backup.<ts>.before-mod.json`). A new `claude --bg` with no flags loads it (heartbeat,
  nothing drawn without a band). Running sessions take it at `/reload-plugins` or their next start.
  Updating the copy is by hand until the app installs it.
- **A background session runs with the daemon's environment**, not the shell that ran `claude --bg`:
  `MASTERDECK_HOME` does not reach the mod there, so an isolated test app's sessions use the real
  `~/.claude/masterdeck/deck`. Give the mod the deck folder another way (a `userConfig` option the
  install sets, or a pointer file under `~/.claude`) before isolated E2E tests use it.
- **The real app writes the band files** (checked on the installed build: one per live session
  with a ticket, PR or link). The mod's band was seen only against a stand-in deck folder; seeing it
  in a real ticket session after `/reload-plugins` is the user's check.
- **Instant typing with a band above the prompt** (`predictiveEcho`) not checked in MasterDeck's pane.
- **`/md-note` needs `mv` and `rm`** (`$.process.run`): macOS and Linux only; Windows needs
  `cmd /c move` or a rename in `$.fs`.
- **A mod switched off while it runs stays until the session starts again**: Claude Code's
  `/reload-plugins` does not judge a running, unchanged module again. A "Restart to apply" in the Mods
  tab (stop and resume with no flags, when idle) would close the gap.
- **Order matters**: the mod judges only what loads after it. `prependPlugins` in user settings is
  honoured only without managed settings and outside Team/Enterprise sign-in; elsewhere an admin
  must list it (or the mods load before it and show "Not loaded in this session"). Set by hand on
  the user's machine (2026-10-10, settings backed up as `settings.backup.<ts>.before-prepend.json`):
  checked in a throwaway session, the installed mod loaded before a `--plugin-dir` mod and refused
  it. Setup should add `prependPlugins` with the install (backup, atomic).
- **The agent loop lives in the session** (`masterdeck-loop`): MasterDeck's window does not show it
  yet, and #82's workflow canvas cannot start one. Next: the loop writes `deck/loops/<sid>.json`
  (round, max, status), Session details shows it, and a workflow step starts `/md-loop` with its
  check and goal.
- **`/md-board` is read only** and lists 30 cards a column; moving a card from it is a later step
  (through BoardFlow, never from the mod).
- **`/md-board` shows the app's one selected sprint** (`state.board` is read for it): another
  account's board with no cards in that sprint shows empty columns (seen 2026-10-10 on a second
  account). A board file per account and its own current sprint needs a read per account.
- **Updating the mods needs a reload in every running session** (the copy under
  `~/.claude/masterdeck/mods` changes at once, sessions take it at `/reload-plugins`). The Mods tab
  offers **Reload plugins** per session; an app-run install could offer it for every idle session.
- **Switching a refused mod back on adds a `/reload-plugins` row** to the transcript (the engine's).
- **Two copies of the band's shape** (`shared/modBand.ts`, `mods/shared/deck.ts`);
  a change bumps `v` in both.
- **Next ideas** (MODS.md): ticket context through `prompt.context`; the agent-loop driver for #82;
  `/queue`, typing and AskUserQuestion through the mod; the deck hook's guards in the mod (Windows).

## Product ideas (from the user, 2026-10-03)

## Recently done

| What | MasterDeck | Backend |
|---|---|---|
| MasterDeck's own icon: the masterdeck.dev mark on a dark tile as the app icon (macOS `.icns` on Apple's icon grid, Windows `.ico`, the Dock in dev) and on app.masterdeck.dev (favicon, apple-touch and Android icons, `manifest.webmanifest`), all from `app/scripts/icons.mjs` | branch `feat/app-icon` | — |
| The session name always shows in the Sessions column: the ticket (`repo#n`) and account badge wrap below the name in a narrow column instead of squeezing it to nothing (`.srow-name` in `Sidebar.tsx` / `styles.css`) | branch `worktree-session-name-wrap` | — |
| Claude Code mods researched and a prototype built (issue #86, `docs/MODS.md`): a probe showed a mod runs in a `claude --bg` session and draws in `claude attach` (band, toast, status line, at any width, two clients at once, kept on resume). `mods/masterdeck`: the ticket, its column, the PR (CI, threads) and linked sessions above the prompt, toasts on changes, `/md-ticket` (a pane), `/md-note` (adds to the ticket's note), a heartbeat; the app writes `deck/band/<sid>.json` (`shared/modBand.ts`, `DeckHooks.setBand`) and shows **Mod live** in Session details (`state.modLive`); split into a core `masterdeck` and one mod per feature (`masterdeck-ticket`, `masterdeck-alerts`, `masterdeck-note`; shared `mods/shared/deck.ts`); Session details → **Mods** switches each mod per session (MasterDeck's own go quiet at once; another is refused by the mod's `plugin.register` hook when it loads, and switched on again it joins at a reload the mod asks for; `mod-off.json`, `mod-catalog.json`, `offMods` in the band; then `masterdeck-loop` (`/md-loop`, rounds until a check passes, #82) and `masterdeck-board` (`/md-board`, `deck/boards/<key>.json`); mods 0.5.0) | PR #91, branch `worktree-MasterDeck-Terminal-86-mods` | — |
| Where a session starts, checked for real (issue #59): a ticket session started from the Start dialog in the resolved temp checkout, `parked-sessions.json` keyed by the background id, the parked session's link recording no branch (and the folder's branch without the record), `claude --bg` 2.1.295's real output in `test_spawn.py` (the parser needed no change), the real trust prompt through **Open Claude there…**, the native picker and a start from the chosen folder keeping master's prompt and model, the recipe in OPERATIONS | branch `worktree-MasterDeck-Terminal-59-start-for-real` (not merged) | — |
| A session moves to Merged when its PR merges: the PR watch's own "merged" message (typed in after the merge) counted as the user writing, so every watched session showed Rework instead (`isUserWords` now skips `[MasterDeck …]` messages); and the PR watch's merge reaches the session's lane at once (`Sources.prEnded`, read past the gh cache) instead of on the next review poll | branch `fix/session-merged-state` | — |
| Create with Claude's settings bar (issue #68): repo, board, status, sprint, assignees, labels and milestone below the chat, collapsed to one line; prefilled from the + column, the tab's filters and sprint, or the dialog's draft; options follow the repository (labels, milestones) and the board (columns, sprints); MasterDeck's create pump enforces the bar on every ticket, so a change applies to the next one, and its answer lists any value it replaced; Claude is told to say the bar's value applies when the chat asks for another | branch `worktree-MasterDeck-Terminal-68-ticket-settings` (not merged) | — |
| Board popups show the description and sub-issues (issue #81): the Assign popup shows the ticket's description (rendered Markdown, as the Start dialog does), and both the Assign popup and the Start dialog list its sub-issues with number, title, status (board column, else Open / Closed), "n / m done", each opening on GitHub; hidden when there are none; the description and the list scroll in their own boxes (`shared/subIssues.ts`, `SubIssues.tsx`, `GitHub.subIssues`, `issue:subIssues`) | branch `worktree-MasterDeck-Terminal-81-board-popup-subissues` (not merged) | — |
| The web app's Start dialog has **Choose folder…** (issue #62): a pick of the workspace and the repositories MasterDeck found (`RepoPicker` `listOnly`, no typed path; fits the phone at 390 px), and main takes a browser's folder for the draft only when it is one of them, as real paths (`chosenFolder(remote, cwd, known)`, `workspaceFolders()` in `main/index.ts`); anything else is refused with a message and the dialog keeps its folder (it was dropped silently) | branch `worktree-MasterDeck-Terminal-62-web-folder-choice` | — |
| Notes in Markdown (issue #65): a note's text is drawn as Markdown (`MarkdownView` with `html={false}`: every tag is text, https links only, opened in the browser), **Write / Preview / Side by side** in the editor, previews in the list, Details and on the card read the Markdown as one plain line; the window refuses navigation away from the app; sessions can add to notes with the `masterdeck-notes` skill (`note.sh new / ticket / append`, `main/noteRequests.ts`, answers carry an id, never a note's text) | branch `worktree-MasterDeck-Terminal-65-notes-markdown` (not merged) | — |
| Where a session starts, three decisions (issue #61): Setup's **Issues whose code is in another repository** pairs (`codeRepos`: a tracker's tickets start in the code repository's checkout, as its account, and the prompt names it); picking another account in the Start dialog looks for the folder in that account's workspace (`draft-assign --account`, not after Choose folder… or for a held start); a PR review runs as its PR's repository's account and is looked up in that account's workspace (`checkout --account`). One rule on both sides: `config.start_account` / `startAccount` | branch `worktree-MasterDeck-Terminal-61-start-folder` | — |
| Remote no longer waits for ever on "waiting for sessions to load" (issue #8): the status says why when `claude agents` fails, and after 60 s (`REMOTE_WAIT_MS`, `remoteWait` in `shared/remoteSnapshot.ts`) the line connects anyway; until the first session list no snapshot is sent, and commands are answered "still loading" (retried) while it loads or fail at once with the agents error while `claude agents` fails | branch `worktree-MasterDeck-Terminal-8-remote-waiting` | — |
| Session filters (issue #74): a **Filters** line in the Sessions column, closed by default, with the count of filters on, a removable chip for each and Clear all; open, a name/ticket search and Status (lanes and Parked), Account (two or more accounts only), Repo (a worktree counts under its repository) and Starred only, any-of within a kind and all kinds combined (`shared/sessionFilter.ts`, `SessionFilterBar.tsx`); "No sessions match the filters" with Clear filters; Cleanup only offers what is shown; kept in localStorage (`sessionFilter`, `sessionFilterOpen`) | `worktree-MasterDeck-Terminal-74-session-filters`, PR #76 (not merged) | — |
| Working hours (issue #64; spec in the backend repo): Costs → **Hours** estimates time per GitHub account, day and ticket from session activity on this Mac (`shared/hours.ts`, activity spans in `tokens.json` v2), idle gap 1 h by default, an account counts a minute once and each ticket its full time, "unknown account" listed, **Export CSV…**; desktop only | PR #75, branch `worktree-MasterDeck-Terminal-64-hours` (not merged, installed locally) | spec on `docs/working-hours-64` (not pushed) |
| Linked sessions (issue #67; spec and plan in `docs/superpowers/`): link running sessions to each other from the Start dialogs or the details panel (`session-peers.json`, `shared/peers.ts`, `main/peers.ts`, up to 8 links); a linked session gets a block of its peers at start, resume and compaction and a note on its next prompt when a peer's summary changes (`deck/peers/<sid>.delta.json`, `PeerSync`, summaries made on Stop, at most every 2 minutes); **Sync now**, with typed delivery to idle peers where hooks are not live; `peerSync.auto` switches the automatic part off | bed46c0, 6c16bb0, d4bd2dc, 4198668, b7e0d37, ed2983e, 32a18cc, 39e979d, 761c118, a2b727c, 80d88ae, and the spec and plan a2931db (`worktree-MasterDeck-Terminal-67-link-sessions`, not merged) | — |
| Notes (issue #63; the plan is in the backend repo): a panel on the rail (and under More on a phone) for the user's own notes and one note per ticket (**Add note** / **Edit note** in Details, a mark on the Board card); plain text under `<home>/notes/`, one file each, saved 500 ms after typing stops; a save carries its version and a two-place edit asks (Reload / Keep mine); not in `AppState`, the snapshot, a prompt or GitHub; open to the web over the encrypted bridge (list with 120-character previews, a note's text when opened or in a save's conflict answer); a save the store refuses is not retried for ever (Discard), a file that is not a note is left alone; phone sheet that closes when another screen is chosen; from the final review: a save at the latest 2 s after the first unsaved key, a failed disk write is retried and answered without the file's path, a flush when the tab is hidden, the rail's tooltips above the open panel, the phone's More menu above the open sheet | 0e93bb3, 774b374, 30e953e, 50f45b6, 9ff1bbb, db8f97a, 6e3effe, 7b47eac, b886e43, 8c7d56a, b0b7229, 45b81dc (docs), and the final review's fixes (the commit after it): 13 commits (`worktree-MasterDeck-Terminal-63-notes`, not merged) | — |
| The Start dialog in four groups (Ticket, Where it runs, Options, Instructions), Enter starts; **Create worktree** with branch name and base branch (`main/startWorktree.ts`, made before the session, an error stays in the dialog); **Permission mode** (`--permission-mode` through `master add` / `spawn`); **Assign to me**; **Remember these choices** per repository; the description's **Text / Preview** (`shared/markdown.ts`, `MarkdownView.tsx`). "Move to In Dev" was left out: the board flow does it already (#66) | branch `worktree-MasterDeck-Terminal-66-start-session` | — |
| A start Claude Code refuses ("Workspace not trusted") no longer dead-ends: one reader of Claude Code's `.claude.json` in the CLI (`trust.py`, `master trust`, `trusted` in `draft-assign` / `checkout`), the Start dialog says so before starting and opens `claude` in the folder (**Open Claude there…**, a `claude-here` tab; MasterDeck never answers the prompt or writes the file) and comes back once it is trusted, the refused start's tab and the HELD card offer the same with **Try again**, which starts the same held proposal through `master spawn --held-for-trust` (only a start the CLI marked `held_for: "trust"`, never beside a live session; `AssignRequest.retry`, `retryHeld`; a retry used to add a second proposal when a model or account was named), the Start dialog reuses a held refused start, the trust read follows Claude Code's parent walk, a browser can neither open Claude on the Mac nor take its pane, `master spawn` records the folder it was refused in | fix/workspace-trust | — |
| A workspace per GitHub account, and a ticket's session starts in its repository's checkout: `accounts[].workspace` (Setup → Preferences, one field per other account; the top-level `workspace` stays the primary's), one resolver `skills/master/lib/master/checkout.py` (origin match over the workspace, depth 2, 2000 folders, no links out) behind `rules._assign`, `master draft-assign` (`--cwd`, `found`), `master add` / `spawn` without a folder and `master checkout` (PR review, `cwdRepo`); the Start dialog shows the folder, "No checkout of owner/name found in <workspace>", **Choose folder…** and the account. Review round: the origin is read from `.git/config` (2000 folders, 20 git calls, "only the first N folders were searched"), duplicates ranked, only ASSIGN / PR review of a real issue is looked up, a session MasterDeck parks in a main checkout does not take the branch it found there (`parked-sessions.json`, `ownsFolderBranch`; hand-started sessions as before), `Ops.repos()` covers every account's workspace (`main/checkouts.ts`), master's chosen folder, prompt and model survive the Start dialog, Setup swaps workspaces when the primary changes | merge 660c726 (released in v0.8.0) | — |
| Board repository view (plan K; spec and plan in the backend repo, 2026-10-05): a Board tab with repositories picked in its Repos filter, on an account with a board, shows every issue of them, on a board or not, in Todo / In Dev / PR Raised / Done (`shared/repoView.ts`, `main/repoIssues.ts`, `master repo-issues`), read only while such a tab is on screen, ten repositories of an account per GitHub call and as many calls as needed (at most 1200 cards, 500 KB and 30 repositories in the state, none on screen ever dropped for another; only the Board's Refresh / Retry skips the gh cache; a never-read repository is asked for again every 5 minutes); a picked repository that is never read says why (not selected in Setup, another account's with no board, more than 30 picked, no room) instead of loading; with Select all an unlisted repository is read only under the owner of the account that has it (`repoPickable`, `config.repo_readable`); a chip shows the column of an issue that is also on a board; a session can be started from any card (**Start a session** on the Assign and PR popups) and linked to an issue no board holds (`offBoardOk`); a new ticket from the view goes to the first picked repository with no sprint; the Repos filter shows with one repository in a tab with a board; a tab with no board still only filters and keeps its older defaults; a linked session's PR is a closing reference on the issue, also for an issue no board holds; master is unchanged | merge e75ec9c (released in v0.8.0) | — |
| Board without a GitHub project (plan J; spec and plan in the backend repo, 2026-10-05): a tab whose account has no board shows its repositories' issues in Todo / In Dev / PR Raised / Done, worked out by MasterDeck on every state (`shared/derivedBoard.ts`, `master board` repository read, read-only columns, hint and notes); **Create a GitHub board** makes a real one as that account, on the Mac only (`main/boardCreate.ts`: plan, native confirmation, re-check, columns, links, issues 20 a request, Try again, config last, `sprintless`); empty states say what is empty ("No open issues", "Could not read …", "Nothing selected"); linking a session and New ticket / Create with Claude work without a board; master proposes only that account's own Todo issues | merge 7714ec8 (released in v0.8.0) | — (no protocol change) |
| Several GitHub accounts (plan I; spec and plan in the backend repo, 2026-10-03): `config.accounts` + migration, `AccountEnv` token and settings file per account, sessions start/resume as an account (`session-accounts.json`), master spawns as the issue's account, per-account ghcache and calls (`accountClients`), per-account polling, account badges, Board/PRs tab per account, New ticket per account, `session.start.account` | merge 6a83862 (released in v0.8.0) | feat/session-start-account (not pushed) |
| Several GitHub accounts, final review fixes: `GHC_ACCOUNT` in each account's settings env (ghcache keys a bare `GH_TOKEN` on its hash); Needs-you notices when gh's active account is not the primary and when master-agent was not started as the primary; `master spawn` holds an account that is not connected; ticket builder refuses while accounts load; ORPHAN default as the app's; ghc pause per mode; Setup scopes of every account | feat/multi-gh-accounts | — |
| Several GitHub accounts: a Create with Claude session per Board tab as the tab's account (`main/ticketDirs.ts`), and `as @login` at the top of every session (`accountLabel`, `SessionAccount`) | feat/multi-gh-accounts (Task 16b) | — |
| Duplicate sessions: every resume cloned the session (`claude --bg --resume <id>` with any flag starts a copy; MasterDeck always passed `-n`, and `--settings` with two accounts, so each app start after a reboot cloned every running session). Resume is bare now (`resumeAs`, `spawn.command`), recorded or not; a copy only for an account the user picked or a rename, refused while the old one runs (fresh `claude agents` read); never `claude rm`: the old side goes to `superseded-sessions.json` and is hidden while stopped; a session woken without `--settings` is marked and shown as gh's active account; the restorer and `master spawn` skip what runs again (by session id or bg id; unknown holds). Closes "Session accounts across resume and attach" | fix/master-reports-only | — |
| Master reports guard: a PreToolUse hook on `SendMessage` (`hook.sh MasterReport`, installed with the deck hook) denies a report (`#12: done`/blocked/question/answered; `name#12`, `owner/name#12`, after markdown/quote characters) sent to any session but the master; `masterName`/`masterEnabled` read from config.json at run time; the master session (`deck/master-sids`, written at once on start/resume) and subagents are exempt; Settings → Hooks & skills shows it (`HookStatus.masterGuard`) | fix/master-reports-only | — |
| Sessions never hand a report to another session when master-agent is not running: the reply instruction (assign/CI/review/stale prompts, master SKILL) now says to ask the user instead. Seen when a #440 session messaged two sessions named `masterdeck` | fix/master-reply-only | — |
| Phone: Board and PRs filter rows fold into a "Filters (n)" button beside the search box; the controls open in a sheet (Reset, Done, Esc/backdrop). `PhoneFilters.tsx`, `activeBoardFilterCount` (boardFilter.ts); desktop DOM unchanged | feat/phone-filters | — |
| Native PR watch, board moves, /queue hook; skill hooks migrated away (PrWatch: light query per 50 PRs, heavy only when changed; BoardFlow + BoardOps + MasterDeck's own `ticket-links.json`, imported once; Create with Claude hands tickets to MasterDeck; `/queue` through hook.sh with a Stop handshake, `MASTERDECK_QUEUE_DIR`; one-time `migrateLegacyHooks` → `native-hooks.json`; MasterDeck's own self-review gate). Deploy watch and CI-failure messages are deliberate non-goals (Needs you covers failing CI). Final-review fixes: board moves made once (`board-moved.json`), imported links left alone, only own/linked-branch PRs linked; `deck/legacy-sids` for sessions alive at the migration; silent first PR-watch run | 2342f28 … 071b47b, merge f433be5 | plan H |
| Phone layout for the web app (`isWeb() && max-width 760px`: tab bar, one screen at a time, terminal with quick keys, master screen, panel sheet, visual-viewport height) + dev-only preview (`/?preview`, stub deck and fixture state) | 643352a … 68bf172, merge b3c4d4b; deployed | — |
| Remote backend v1 + MasterDeck remote client (snapshot relay, commands run-once, API items, Settings → Remote) | 50d39d7 … 2f694a7, merge 8042d6d (PR #1) | plan A |
| Accounts / OAuth sign-in, device token in Keychain, Settings → Account | 955712d … 27dd416, merge 99d2d68 (PR #3) | plans C/D |
| Desktop loopback sign-in (no code; code flow as fallback) | 66ed2c8 … 83de748, merge ab6df30 | plan E |
| Web app stage 1 + 2 (approved browsers, commit-reveal words, E2E bridge, protocol 3, all views) | 4cb35cf … 4360ece, merge 9c29222 | plans F/G, 5638a44 |
| Snapshot volume: volatile key + 15 s hold, `snapshotPatch` with ack | 9da2877, 83da773, 2c38ce7, abdba04, 0b6d8ed | PR #4 ea53f9e |
| Web bridge state patches (`evp`, resync) | 11f1e4a, 365621c, 75aafa1 | — |
| Remote-connection indicator on the rail | 988116e, def5c23, 0d7e495, 9e9a12e, ce27e5d | PR #5 fccbfee |
| Instant typing for the web terminal | 190a65f … b298895, merge bacb8d6 | — |

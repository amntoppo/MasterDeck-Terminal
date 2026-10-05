# TODO (as of 2026-10-05)

Open work, grouped and roughly prioritized (P1 first). Each item: context, where in the code, and
a suggested approach. Nothing here is started. The older design note for Codex/Copilot support is
the repo-root [TODO.md](../TODO.md).

Each open item below is also a GitHub issue with code pointers, approach and acceptance criteria:
[issues #4–#29](https://github.com/amntoppo/MasterDeck-Terminal/issues). Close the issue in the PR that
fixes it, and move the item here to "Recently done".

## Shipping / ops

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
- **P3 · Phone/API clients and `session.start.account`.** The protocol field is in the backend
  branch `feat/session-start-account` (worktree `~/Documents/masterdeck-backend-proto`), not pushed
  or deployed; no web or phone UI sends it yet. The drift test needs that checkout (set
  `MASTERDECK_BACKEND`) while the MasterDeck branch is unmerged.
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

## Remote / web

- **P1 · Drift test doesn't run in CI.** `app/src/shared/remote.drift.test.ts` skips without the
  backend checkout, and MasterDeck CI doesn't check it out (the backend repo is private). Approach:
  a CI step that checks out `amntoppo/masterdeck-backend` with a read-only deploy key / fine-grained
  token into `../masterdeck-backend` (or set `MASTERDECK_BACKEND`), or commit a hash of
  `protocol.ts` on both sides and compare that.
- **P2 · Remote stuck on "waiting for sessions to load"** when `claude agents` never succeeds.
  Where: `syncRemote()` / `remoteReady` in `app/src/main/index.ts` (only set once
  `sources.isHealthy("agents")`). Approach: show the agents error (`state.sources.agents`,
  `errors`) in the status message, and after a timeout (e.g. 60 s) connect anyway, letting
  `RemoteCommands`' transient retry cover early commands.
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

## Product ideas (from the user, 2026-10-03)

- **P2 · Notes section.** A place in MasterDeck to write notes (free text, kept between launches;
  could live in the left rail as its own view, saved under `~/.claude/masterdeck/`). Open questions:
  per ticket / per session or global, Markdown, sync to the web app.
- **P2 · Working hours per GitHub account, from tickets worked on.** Estimate time worked per
  account from what MasterDeck already knows: each session's account (`session-accounts.json`, plan I),
  its linked ticket (`ticket-links.json`), session activity/turn times and commit times. Show per
  account per day and per ticket (e.g. in Costs or a new view), exportable. Open questions: how idle
  time counts, sessions without a ticket, accounts on several machines.

## Recently done

| What | MasterDeck | Backend |
|---|---|---|
| Board repository view (plan K; spec and plan in the backend repo, 2026-10-05): a Board tab with repositories picked in its Repos filter, on an account with a board, shows every issue of them, on a board or not, in Todo / In Dev / PR Raised / Done (`shared/repoView.ts`, `main/repoIssues.ts`, `master repo-issues`), read only while such a tab is on screen, ten repositories of an account per GitHub call and as many calls as needed (at most 1200 cards, 500 KB and 30 repositories in the state, none on screen ever dropped for another; only the Board's Refresh / Retry skips the gh cache; a never-read repository is asked for again every 5 minutes); a picked repository that is never read says why (not selected in Setup, another account's with no board, more than 30 picked, no room) instead of loading; with Select all an unlisted repository is read only under the owner of the account that has it (`repoPickable`, `config.repo_readable`); a chip shows the column of an issue that is also on a board; a session can be started from any card (**Start a session** on the Assign and PR popups) and linked to an issue no board holds (`offBoardOk`); a new ticket from the view goes to the first picked repository with no sprint; the Repos filter shows with one repository in a tab with a board; a tab with no board still only filters and keeps its older defaults; a linked session's PR is a closing reference on the issue, also for an issue no board holds; master is unchanged | the commits of `feat/board-repository-view` (fill in the range once it is merged) | — |
| Board without a GitHub project (plan J; spec and plan in the backend repo, 2026-10-05): a tab whose account has no board shows its repositories' issues in Todo / In Dev / PR Raised / Done, worked out by MasterDeck on every state (`shared/derivedBoard.ts`, `master board` repository read, read-only columns, hint and notes); **Create a GitHub board** makes a real one as that account, on the Mac only (`main/boardCreate.ts`: plan, native confirmation, re-check, columns, links, issues 20 a request, Try again, config last, `sprintless`); empty states say what is empty ("No open issues", "Could not read …", "Nothing selected"); linking a session and New ticket / Create with Claude work without a board; master proposes only that account's own Todo issues | feat/board-without-project (547d483 … 6537700, and the follow-up commit right after it; not merged, not pushed) | — (no protocol change) |
| Several GitHub accounts (plan I; spec and plan in the backend repo, 2026-10-03): `config.accounts` + migration, `AccountEnv` token and settings file per account, sessions start/resume as an account (`session-accounts.json`), master spawns as the issue's account, per-account ghcache and calls (`accountClients`), per-account polling, account badges, Board/PRs tab per account, New ticket per account, `session.start.account` | feat/multi-gh-accounts, 6ba4cc0 … 394203a (not merged, not pushed) | feat/session-start-account (not pushed) |
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

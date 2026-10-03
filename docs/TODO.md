# TODO (as of 2026-10-03)

Open work, grouped and roughly prioritized (P1 first). Each item: context, where in the code, and
a suggested approach. Nothing here is started. The older design note for Codex/Copilot support is
the repo-root [TODO.md](../TODO.md).

Each open item below is also a GitHub issue with code pointers, approach and acceptance criteria:
[issues #4–#29](https://github.com/amntoppo/MasterDeck-Terminal/issues). Close the issue in the PR that
fixes it, and move the item here to "Recently done".

## Shipping / ops

- **P2 · First launch after a local reinstall hangs.** Seen twice on 2026-10-03: after
  `install-mac.sh`, the first `open` leaves the main process idle (0% CPU), writing nothing, ignoring
  quit and SIGTERM; `kill -9` and a second launch work. Suspect a synchronous `safeStorage` Keychain
  prompt (a new ad-hoc signature each build) with no visible window, or the old instance not fully
  gone. Approach: `sample <pid>` while hung, log a line before each startup await in `main/index.ts`,
  and check Console for a Keychain prompt. Workaround in the reinstall recipe: if no file in
  `~/.claude/masterdeck` changes within 30 s, `pkill -9 -f MacOS/MasterDeck$` and open again.
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
- **P2 · Unverified: does a session keep its `--settings`?** Whether `claude --resume` keeps a
  session's original `--settings` (MasterDeck always passes it again) and whether `claude attach`
  of a parked session keeps it. Approach: resume and attach a session started as a second account
  and run `gh api user` in it.
- **P3 · Accepted simplifications of several accounts.** (a) A rate limit on one account pauses
  MasterDeck's own polling for all accounts (`Sources.githubPaused` is global; ghcache's pause is per
  account): per-account pause if it bites. (b) Skills run by hand (`tt.sh`, babysit-pr) stay
  single-account. (c) SSH aliases are only read from `~/.ssh/config`. (d) A global
  `url.<ssh>.insteadOf` rewrite beats the session's (see the P2 item above). (e) The workflow
  builder sessions use gh's active account. (f) master starts without `--settings` when the primary
  needs to log in again (Needs you says so). (g) The current branch's PR for a session in a folder
  without an `origin` of any connected account is read as the primary.
- **P3 · Phone/API clients and `session.start.account`.** The protocol field is in the backend
  branch `feat/session-start-account` (worktree `~/Documents/masterdeck-backend-proto`), not pushed
  or deployed; no web or phone UI sends it yet. The drift test needs that checkout (set
  `MASTERDECK_BACKEND`) while the MasterDeck branch is unmerged.
- **P3 · Several-accounts review leftovers (small).** Config parsing: `parseAccounts` warns on
  every parse, top-level `repos` are ignored once an account lists repos, a duplicate board under two
  accounts is dropped silently, `repoFromRemote` accepts any host for scp/ssh forms, `ssh://git@github.com:443/`
  and aliases without `user@` are not rewritten, `#` anywhere strips the rest of an ssh config line,
  login and board keys compared case-sensitively in `accountForProject`/`sessionAccount`.
  Accounts: a removed account's file lingers up to an hour after its last session ends; a failing
  `configSave` writes a `config.backup.<ts>.json` each launch; a transient `gh auth token` failure
  deletes an unused file until the next refresh; `accountClients` never evicts removed logins;
  an invalid `GHC_ACCOUNT` fails open to the default cache key; `ghc --status` reads only `paused.json`.
  Sessions: `accountOfSession` matches spawn proposals by name only (a reused name picks an old
  account); `proposalAccount` reads the latest snapshot; AssignDialog's default ignores a proposal's
  `spawn.account`; a removed or unhealthy recorded login is still shown and sent on resume (fails
  visibly); unhealthy and unknown accounts get the same remote refusal text; PR watch: an entry
  whose account was removed falls back to the primary, and a PR shared by two sessions keeps the
  first one's account. Setup/UI: `closeLogin` may run twice, repeated Log in clicks open duplicate
  gh-login tabs, the gh-login pane inherits the app's env (a `GH_TOKEN` set at launch makes `gh auth
  login` refuse), a board held by another account stays in raw `boards` state. Board/PRs: untagged cards
  on unconfigured boards show only on the primary tab, the global `selectedSprint` may name a
  sprint the tab's account lacks, after multi to single stale tagged team PR copies show twice until
  the next refresh. Ticket builder: `md-ticket-builder-*` sessions are hidden by name, a corrupt
  `context.json` skips the remote account check, and a ticket session's account is sticky.
  Tests missing: multi-mode gating, remote refusal, dismiss-heal, the `context.json` read,
  `Sources` glue; the `.pane-head` layout and a prettier warning on `main/index.ts` were not checked.
- **P3 · Old per-tab ticket-builder folders are never removed.** With two or more accounts each
  Board tab gets `ticket-builder/tab-<id>/`; closing the tab leaves it (so reopening continues).
  Main doesn't know which tabs exist (they live in the renderer's storage), so nothing sweeps them.
  Approach: the renderer reports its tab ids, and `tab-*` folders of no tab untouched for 7 days go.

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

## Recently done

| What | MasterDeck | Backend |
|---|---|---|
| Several GitHub accounts (plan I; spec and plan in the backend repo, 2026-10-03): `config.accounts` + migration, `AccountEnv` token and settings file per account, sessions start/resume as an account (`session-accounts.json`), master spawns as the issue's account, per-account ghcache and calls (`accountClients`), per-account polling, account badges, Board/PRs tab per account, New ticket per account, `session.start.account` | feat/multi-gh-accounts, 6ba4cc0 … 394203a (not merged, not pushed) | feat/session-start-account (not pushed) |
| Several GitHub accounts: a Create with Claude session per Board tab as the tab's account (`main/ticketDirs.ts`), and `as @login` at the top of every session (`accountLabel`, `SessionAccount`) | feat/multi-gh-accounts (Task 16b) | — |
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

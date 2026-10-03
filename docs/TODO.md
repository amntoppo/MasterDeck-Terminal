# TODO (as of 2026-10-03)

Open work, grouped and roughly prioritized (P1 first). Each item: context, where in the code, and
a suggested approach. Nothing here is started. The older design note for Codex/Copilot support is
the repo-root [TODO.md](../TODO.md).

## Shipping / ops

- **P1 · Push and release decision.** `main` is 21 commits ahead of `origin/main` (9da2877 …
  bacb8d6); no release since v0.6.2. Approach: the user decides; then
  [OPERATIONS § Release](OPERATIONS.md#release). Don't push before that.
- **P1 · Backend CI deploy broken.** The CI Cloudflare token gets error 7403. Where:
  `masterdeck-backend/.github/workflows`. Approach: give the token Workers Scripts:Edit + the
  account/zone permissions the custom domains need, or drop the deploy job and keep local
  `npx wrangler deploy`.
- **P2 · Measure web-bridge upload with a web tab open** after the state-patch rollout (before:
  134 MB / 3 min). Approach: [OPERATIONS § Measuring upload](OPERATIONS.md#measuring-upload) with
  busy sessions and one tab on Terminals and one on Tasks.
- **P3 · User to confirm Cloudflare billing**: Free plan, payment method, and whether
  `masterdeck.dev` auto-renews (Registrar). Not code.

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

## Older (pre-remote)

- **P3 · Board "Everyone" tab**: own issues not shown when selecting yourself as the person
  filter. Needs repro steps from the user. Where: `app/src/shared/boardFilter.ts`, `BoardView.tsx`.
- **gamerun-app PR #140 (feat/org-join-code)**: closed unmerged on purpose; the merge-conflict
  question was never answered; 4 local commits unpushed there. Other repo; ask the user.
- **Offers never answered** (ask before doing): show Claude Code's own monitors in Details.
- **Orphaned babysit-proof hook**: older machines may still have a babysit-proof `PROOF_PRE`
  PreToolUse hook in `~/.claude/settings.json` (the skill is gone; `migrateLegacyHooks` does not
  remove it). Remove by hand, or add it to `LEGACY`.
- **Cleanup** (list exact paths, delete only those): remote-probe transcript folders under
  `~/.claude/projects`; scratch dirs in `~/.claude/jobs/*/tmp`; the leftover untracked
  `skills/babysit-proof/` (only `__pycache__`, skill removed in 9329db4).

## Recently done

| What | MasterDeck | Backend |
|---|---|---|
| Self-review gate of MasterDeck's own (`reviewGateCommand`/`installReviewGate`, always installed, `pr-review` decides per session; first `gh pr create` of a session denied with a review instruction; passes on a babysit-pr marker); built-ins say MasterDeck does them | feat/native-babysit | plan H |
| Skill hooks out, once (`migrateLegacyHooks`: exact MasterDeck commands and `masterdeck-builtin` wrappers only, `native-hooks.json`); Settings → Hooks shows Queue and Self-review gate as status; Skills popup without switches; `/queue` gates on MasterDeck's queue | feat/native-babysit | plan H |
| `/queue` through MasterDeck's own hook (UserPromptSubmit stores; Stop handshake: app claims by rename and answers, else the hook drains; queue-off when the skill's hooks are installed; `MASTERDECK_QUEUE_DIR`) | feat/native-babysit | plan H |
| PR watch by MasterDeck (PrWatch: light query per 50 PRs, heavy only when changed, viewer-gated seen set, Details rows, review offers de-duplicated; Settings → Watch new PRs) | feat/native-babysit | plan H |
| Board moves by MasterDeck (BoardFlow: link spawned sessions, PR links, PR Raised only once the PR is ready, Dev Done when all merged; linked steps for native links) | feat/native-babysit | plan H |
| Create with Claude hands tickets to MasterDeck (requests/answers folders; 90 s wait, stale-request sweep, body-file realpath containment) | feat/native-babysit | plan H |
| Remote backend v1 + MasterDeck remote client (snapshot relay, commands run-once, API items, Settings → Remote) | 50d39d7 … 2f694a7, merge 8042d6d (PR #1) | plan A |
| Accounts / OAuth sign-in, device token in Keychain, Settings → Account | 955712d … 27dd416, merge 99d2d68 (PR #3) | plans C/D |
| Desktop loopback sign-in (no code; code flow as fallback) | 66ed2c8 … 83de748, merge ab6df30 | plan E |
| Web app stage 1 + 2 (approved browsers, commit-reveal words, E2E bridge, protocol 3, all views) | 4cb35cf … 4360ece, merge 9c29222 | plans F/G, 5638a44 |
| Snapshot volume: volatile key + 15 s hold, `snapshotPatch` with ack | 9da2877, 83da773, 2c38ce7, abdba04, 0b6d8ed | PR #4 ea53f9e |
| Web bridge state patches (`evp`, resync) | 11f1e4a, 365621c, 75aafa1 | — |
| Remote-connection indicator on the rail | 988116e, def5c23, 0d7e495, 9e9a12e, ce27e5d | PR #5 fccbfee |
| Instant typing for the web terminal | 190a65f … b298895, merge bacb8d6 | — |

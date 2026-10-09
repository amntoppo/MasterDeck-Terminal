# Remote: account, backend line, web app, instant typing

Everything that leaves the Mac. Desktop side in detail; the backend side is in
`masterdeck-backend` (Worker `src/worker.ts`, per-user Durable Object `src/hub.ts` "UserHub" with
SQLite, contract `src/protocol.ts`). Design history: `masterdeck-backend/docs/superpowers/specs/`
(remote backend, accounts/OAuth, desktop loopback sign-in, web app, web app stage 2) and
`reports/2026-10-02-web-app-e2e.md`.

```
 phone / curl / CI ──REST + /v1/live──┐
                                      ▼
 browser (app.masterdeck.dev) ──/v1/browser──▶ UserHub DO (dev.masterdeck.dev) ◀──/v1/desktop── MasterDeck (CloudSync)
        │                                       stores snapshot, commands, items                  │
        └──────── E2E frames (opaque to the server) ─────────── relayed ─────────────────────────▶ BrowserBridge
```

| Host | What | Deploy |
|---|---|---|
| `https://dev.masterdeck.dev` | backend API, sign-in pages (`/login`, `/desktop-login`, `/account`) | backend repo, `npx wrangler deploy` (local; CI deploy is broken, token error 7403). `workers_dev` is off, so the old `*.workers.dev` URL no longer serves |
| `https://app.masterdeck.dev` | the web app (static) | this repo, `cd app && npm run deploy:web` |

The desktop backend address is `remoteUrl(process.env)` (`shared/account.ts`): `DEFAULT_REMOTE_URL`
(`https://dev.masterdeck.dev`) unless `MASTERDECK_REMOTE_URL` is `https://host` or
`http://localhost|127.0.0.1[:port]`. An invalid value silently falls back to the default.

## 1. Account sign-in (desktop side)

Code: `main/account.ts` (`Account`), `main/loopback.ts` (`startLoopback`), `shared/account.ts`
(`AccountState`, `Identity`, `parseIdentity`), UI `renderer/.../AccountPanel.tsx` (Settings →
Account). IPC: `account:signIn|cancel|reopen|useCode|providers|email|signOut|manage`
(all `blocked` on the web).

- **Browser sign-in (Google/GitHub/Apple), default = loopback + PKCE** (`signInWith`): starts a
  one-shot `127.0.0.1` listener (`/callback?code&state`, 5 min), opens
  `${base}/desktop-login?port&state&challenge&provider`, waits, checks `state` (timing-safe), then
  `POST /desktop/redeem {code, verifier, name}` → `201 {id, token, email}`; `409` = 5-Mac cap.
  If the listener can't start it falls back to the code flow. A redeem that lands after a cancel
  drops its device again (`DELETE /v1/devices/self`).
- **Code flow** (`useCode` / `signInWithCode`, "Use a code instead"): OAuth device code
  (`/auth/device/code`, poll `/auth/device/token` with `client_id=masterdeck-desktop`), show
  `userCode`, then `/auth/get-session` and `finish()`.
- **Email** (`signInEmail`): `/auth/sign-up/email` or `/auth/sign-in/email` (Better Auth; `/auth/*`
  requests carry an `origin` header for its CSRF check), then `finish()`.
- `finish()` exchanges the short session for this Mac's own device: `POST /v1/devices {name}` →
  device token, then signs the session out. `saveDevice` writes the token
  (`remoteToken.ts writeToken`, Keychain-encrypted `remote-token`) and `account.json`
  (`{email, provider, deviceId}`); a failed identity write undoes the token and the device.
- **Sign out**: `DELETE /v1/devices/self` with the device token, then clear both files.
  `signedOutRemotely(msg)` is called by CloudSync on close 4003 / HTTP 401 / 410.
- `onChange` in `index.ts`: `accountChange()` (browserBridge.ts) wipes approved browsers on sign-out
  or when a different email signs in; `syncRemote()` restarts the line.
- `accountManage` opens `${REMOTE}/account` (devices, password, delete).

## 2. CloudSync: the line to the backend

Code: `main/cloudSync.ts` (`CloudSync`), wired in `syncRemote()` in `main/index.ts`. One outbound
WebSocket `wss://…/v1/desktop` with `Authorization: Bearer <device token>`.

### Lifecycle

- `syncRemote()` runs at startup, on account changes, on a `remoteEnabled` flip, on every state
  while it waits for sessions (below) and from the wait's timer. Key = `url + token` when `settings.remoteEnabled` and a token exist.
- **Waits for sessions**: until `remoteReady` it shows `connecting · "waiting for sessions to load"`
  and does not dial, so pending commands find their sessions. When `claude agents` fails the text
  adds the reason (`…: claude agents: <first line of the error>`, ≤ 120 chars, `agentsFailure`),
  set again only when it changes (`setRemote` emits a state, whose callback calls `syncRemote`). `remoteReady` is set by `remoteWait` (`shared/remoteSnapshot.ts`): as
  soon as agents is healthy, or after `REMOTE_WAIT_MS` (60 s, a timer started with the wait) without
  it, when it connects anyway and logs one line. Until the first healthy session list
  (`sessionsLoaded`) no snapshot is pushed (an empty session list would wipe what the phone and web
  still show) and `RemoteCommands` gets no state: while agents is only loading a command is answered
  transiently ("still loading", re-run for a minute by `CloudSync`, not written to
  `remote-done.json`); while it is in `error` it fails at once and finally (`notLoaded`: "MasterDeck
  has no session list: claude agents: …"), so a queue of commands does not hold the line a minute each.
- Each (re)start clears external items (`sources.setExternalItems([])`).
- On `open`: `hello {deviceId, appVersion, protocol: 3, macPublicKey?}`. No `welcome` within 15 s
  → terminate and redial. Ping every 30 s; nothing received for 2 × ping → terminate.
- Close codes: **4003** signed out (reason `account deleted` → "This account was deleted"),
  **4005** another Mac is connected (error, retry at the backoff cap), **4001** protocol mismatch
  (error, at cap), others → reconnect with backoff 1 s → 60 s (jittered). HTTP 401 → signed out,
  410 → deleted, other HTTP errors → error + retry. Any close/stop calls `onDisconnect`
  (bridge drops channels) and `onClients([])`.
- Status (`RemoteStatus {conn: off|connecting|connected|error, message, lastSyncAt}`) →
  `sources.setRemote({...st, hasToken: true})` → `AppState.remote`. Off states come from
  `remoteStatusWhenOff` ("Sign in first (Settings → Account)").

### Snapshots → patches with ack

- `toRemoteSnapshot(state, version)` (`shared/remoteSnapshot.ts`) builds `RemoteSnapshot`: live
  sessions (cost rounded to cents, context to %), PR URLs, schedules, monitors; inbox
  open/snoozed/last 20 history; menus only for open `menu` items; the board (columns, sprint,
  cards); proposed/approved proposals; `prLive` for linked PRs. Never terminals, output, the cost
  book or files.
- `push()` debounces 1 s (`debounceMs`). `flush()`:
  1. `fitSnapshot(snap, SNAPSHOT_LIMIT = 900_000)` trims in order: `history`, `cards` (not linked
     to a live session), `board`, `bodies` (inbox bodies cut to 2000 chars). Still too big →
     not sent, status message "snapshot too large to send" (logged once).
  2. Nothing changed (`lastKey` = JSON with `takenAt: 0`) → nothing.
  3. **Volatile hold**: if only volatile fields moved (`volatileKey` zeroes `takenAt`, `costUsd`,
     `contextPct`, schedule `nextAt`, monitor `events`/`lastEventAt`), wait until 15 s
     (`minVolatileMs`) after the last send (deferred, never dropped).
  4. Once the server has acked (`ackedV`), only one send is in flight at a time.
  5. With an ack: `compare(ackedDoc, doc)` (fast-json-patch). Empty → mark sent. Send
     `snapshotPatch {base: ackedV, ops}` when ops ≤ 2000 and the patch JSON ≤ 60 % of the full
     JSON; else a full `snapshot`.
- Acks: `snapshotAck {v}` → `ackedV = v`, `ackedDoc` = that send's doc, flush again. Stale acks
  (`v <= ackedV`) are ignored. No ack within 10 s (`ackTimeoutMs`) → reset, next send is full.
  `snapshotNeeded {reason}` or `error` `bad_message`/`too_large` → reset (+ resend full).
  `welcome` resets too. An old server that never acks gets full snapshots forever: the in-flight
  list keeps 16 fulls and ignores the acks of dropped ones (`dropped`).
- Server side (`hub.ts onSnapshotPatch`): base must equal the stored version, paths may not
  contain `__proto__` or `constructor/prototype`, the result must be an object ≤ `MAX_SNAPSHOT`
  (1 MB); otherwise `snapshotNeeded`. Fulls over 1 MB → `error too_large`.
- Measured (2026-10-02): ~145 MB / 55 min upload before; with the web tab closed after the change,
  715 bytes / 2 min (pings only).

### Commands (phone/API → Mac)

- Arrive in `welcome.pending` and as `command {cmd}`. `enqueue` runs them **one at a time, in
  order** (`chain`), via `runSettled`: an outcome marked `transient` (MasterDeck still loading) is
  re-run every 1 s for up to 60 s. The result goes back as `result {cmdId, ok, status?, message
  (≤2000), data?}`; a result for a dropped socket is lost and the server re-sends the command.
- `RemoteCommands.run(cmd)` (`main/remoteCommands.ts`): **run-once per id** — outcomes are kept
  (last 500, `remote-done.json`, temp + rename) and returned again on redelivery; another app
  instance's file is re-read before running; in-flight duplicates share one promise. Recorded
  after the handler finishes, so a crash mid-run means at-least-once.
- It re-validates every command with the wire contract (`CommandInput.safeParse`) and runs the
  parsed form. Commands have no expiry; they queue on the backend while the Mac is offline and can
  be cancelled with `DELETE /v1/commands/:id`.

| Command | Desktop behaviour |
|---|---|
| `inbox.act {itemId, args:{action, text?, key?, question?, answer?}}` | item must be open or snoozed, else `stale`; `inboxAct(..., remote=true)` with `by: remote:<by>` |
| `inbox.snooze {minutes 1..10080}` / `inbox.dismiss` | same staleness check |
| `session.start {issue, repo?, model?, prompt?, account?}` | `cli.draftAssign` → `startAssign` (prompt replaces the draft text; `account?` a GitHub login connected on the Mac, refused when it is not or needs to log in again (only with two or more accounts; with one it is ignored), omitted: the issue's account; send it only when the user picked one, desktops before it reject a command that sets it) |
| `session.stop {key}` | background sessions only, no confirm dialog (`stopBg`) |
| `session.resume {key}` | only `done`/`suspended` sessions |
| `session.send {key, text, via: queue\|now}` | refused when `needs-input` ("answer it from Needs you") or `suspended`; `now` or idle → `sender.send` straight (never via master); `queue` → `editQueue add` (needs the queue hook) |
| `queue.edit {key, edit}` | `editQueue` |
| `session.setStatus {key, status}` | `sources.setManualStatus` |

Safety rules (both ends): text that reaches a session must pass `noEscape` (no leading `/` or `!`
after whitespace, no C0/C1 control chars except `\n`/`\t`); option keys `/^[A-Za-z0-9]{1,3}$/`
(`optionMessage`); **master-agent cannot be controlled remotely**; no typing into a session
waiting on a prompt; suspended sessions must be resumed first; remote sends never go through
master-agent (`sendMasterUp(true, …)`); `runInboxAction` re-checks `remoteTextAllowed` for
replies.

### External Needs-you items (API-created)

- `POST /v1/items` (`ItemInput`: title, body, options?, allowText, sessionKey?, ticket?, priority
  default 85, https `callbackUrl?`) → the backend sends the open list as `items {items}` →
  `sources.setExternalItems` → inbox kind `external`, id `ext-…`, shown as **ASKED**.
- Answer: `runInboxAction` checks `externalAnswerAllowed` (free text only if `allowText`, else one
  of the options), then `cloud.answerItem` → `itemAnswered {itemId, answer, by}`. If the item names
  a session, the backend (`hub.ts`) also queues a `session.send` (`via: queue`) with
  `[<title>] <answer>`, which comes back as a normal command. Dismiss → `itemDismissed {itemId}`
  (the backend sends no callback for a dismiss).
- Callbacks (backend): signed `x-masterdeck-signature: sha256=<hmac>`, 5 attempts
  (`CALLBACK_DELAYS` 0 s, 30 s, 2 min, 10 min, 30 min), `redirect: manual`, private hosts refused.

### Remote clients presence

- Protocol-3 desktops get `clients {clients: LiveClient[]}` after `welcome` and on every client
  connect/disconnect (server coalesces to ≤ 1 per 250 ms, also on server-initiated closes:
  sign-out 4003, expiry 4006, account delete). `LiveClient = {id, kind: live|api, name (email,
  ≤120), device (≤80, from `X-MasterDeck-Device` or the parsed User-Agent, backend
  `src/device.ts`), since}`; `kind: api` = the static dev token only.
- Desktop: `cleanClients` drops malformed entries, strips control/format chars (`cleanLabel`),
  caps at 50 → `sources.setRemoteClients` → `AppState.remoteClients`.

### Desktop ↔ backend messages (`/v1/desktop`)

| Direction | `t` | Fields | Notes |
|---|---|---|---|
| D→S | `hello` | `deviceId, appVersion, protocol, macPublicKey?` | first frame |
| D→S | `snapshot` | `data` | full; > 1 MB → `error too_large` |
| D→S | `snapshotPatch` | `base, ops[]` (add/remove/replace, ≤ 2000, ≤ 1 MB) | → `snapshotAck` / `snapshotNeeded` |
| D→S | `result` | `cmdId, ok, status?: 'stale', message, data?` | one per command |
| D→S | `itemAnswered` / `itemDismissed` | `itemId, answer, by` / `itemId` | external items |
| D→S | `ping` | | every 30 s |
| D→S | `frame` / `browserClose` | `b, d` / `b` | browser bridge |
| D→S | `browserDecision` / `browserNonce` | `id, allow` / `id, macPublicKey, nonce` | approval |
| S→D | `welcome` | `pending: Command[], user?: {id, email}` | ready; flush + run pending |
| S→D | `command` | `cmd` | |
| S→D | `items` | `items: ExternalItem[]` | the open list |
| S→D | `snapshotAck` / `snapshotNeeded` | `v` / `reason` | |
| S→D | `clients` | `clients: LiveClient[]` | protocol 3 |
| S→D | `open` / `close` / `frame` | `b, name, publicKey` / `b` / `b, d` | browser channel |
| S→D | `browserRequest` / `browserReveal` / `browserRevoked` | `id, name, email, commit, expiresAt` / `id, publicKey, nonce` / `id` | approval |
| S→D | `pong`, `error` | `code, message` | `protocol` code → error status |

Clients on `/v1/live` get `snapshot {v, data, desktop}`, `patch {from, to, ops}`, `desktop`,
`command {record}`, `item`, `error`, and may send `resync`. REST for clients: `/v1/snapshot`,
`/v1/commands` (POST/GET/GET :id/DELETE :id), `/v1/items` (POST, GET :id, POST :id/answer,
DELETE :id), `/v1/devices`, `/v1/callback-secret`.

## 3. The browser bridge (Mac side of the web app)

Code: `main/browserBridge.ts` (`BrowserBridge`), `main/browserStore.ts` (`browsers.json`),
`main/macKey.ts` (`browser-key`), `shared/e2e.ts`, `shared/bridgeWire.ts`, `shared/remoteDeck.ts`.
The backend only relays opaque frames; the Mac's store is authoritative.

### Approval (commit-reveal, three words)

1. Web: new P-256 key + nonce nB, `POST /v1/browsers {name, commit = SHA-256("masterdeck-commit-v1"‖pubB‖nB)}`.
2. Mac gets `browserRequest {id, name, email, commit, expiresAt}`. Denied unless the account
   matches (`account()` = signed in **and** CloudSync's `welcome.user` email agrees), the Mac key
   exists, ≤ 3 unrevealed requests and ≤ 10 nonces per hour. Expiry capped at 5 min. Sends
   `browserNonce {id, macPublicKey, nonce nM}` (the same nonce again if re-sent after a reconnect).
3. Web polls `GET /v1/browsers/:id`, sees `macNonce`, posts `/reveal {publicKey, nonce}`.
4. Mac gets `browserReveal`, checks the commitment, computes `words()` = 3 BIP-39 words from
   SHA-256("masterdeck-sas-v2"‖pubM‖pubB‖nM‖nB); `AppState.browserRequests` → `BrowserApproval`
   modal ("Allow <name> to control this Mac?", Deny focused, Esc/backdrop do nothing).
5. `browserDecide(id, allow)` → `browserDecision`; allow stores `{id, name, publicKey,
   approvedAt}` under the account id. If the line is down the prompt stays.
6. Revoke from the Mac (`browserRevoke`): `DELETE /v1/browsers/:id` first (hub closes the browser
   with 4003 "revoked"), then locally. A browser the Mac doesn't know under this account (e.g.
   after an account switch) is revoked on the backend too, so it re-approves instead of looping.

### E2E channel

- On `open {b, name, publicKey}` for a known browser with a matching key: handshake. Web sends
  `hs1 {e, n}`, Mac `hs2 {e, n, tag}`, web `hs3 {tag}`. Keys: HKDF-SHA256 over
  ECDH(eB,eM)‖ECDH(sB,eM)‖ECDH(eB,sM), salt over both static/ephemeral keys and nonces; two
  AES-GCM keys (one per direction) + an HMAC confirm key. Frames: AES-GCM, 96-bit nonce = direction
  constant ("B2M1"/"M2B1") + 64-bit counter, AAD `masterdeck-e2e-v1`; seal/open are serialized so
  counters stay in step; any failed open kills the channel (fail closed).
- Then the Mac sends `hello {protocol, appVersion, platform, home}`; the web refuses a different
  `PROTOCOL_VERSION` ("Update MasterDeck" screen). `connectedAt` is recorded at open.
- Failures (bad frame, handshake) close the channel; 3 in an hour for one browser →
  `warning()` "Possible tampering on the connection to <name>" (shown in Settings → Remote).
- Limits: 200 calls/s per browser; frames ≤ `MAX_FRAME` (1.4 MB) after sealing — too-big
  messages are never sealed (`ret` becomes "result too large for the web").

### Calls, subscriptions, state patches, PTY streaming

| Web → Mac (`WebToMac`) | Mac behaviour |
|---|---|
| `call {id, m, a}` | only `DECK_ACCESS[m].kind === 'remote'`; `ptyOpen` only for `attach, shell, ticket-builder, builder, installer` (a `ticket-builder` with a bad `tab` id, an `account` that is not a connected login, or one other than the tab folder's `context.json` account is refused; logins case-insensitive); `ARG_FIX`; runs `reg.call(ch, args)` with `{remote:true}`; `invoke` → `ret` |
| `sub {ev, arg?, patches?: 1}` / `unsub` | only `event` channels; per-id events need `arg` (≤200). `sub state` sends the state at once (full) |
| `visible {on}` | hidden tabs get no `pty:data` (buffer cleared) |
| `device {device}` | once per connection; sanitized (≤80) → `browsers[].device` |
| `resync {ev: state}` | a full state, at most one per connection per `resyncMs` (1 s) |

| Mac → Web (`MacToWeb`) | |
|---|---|
| `hello {protocol, appVersion, platform, home}` | first sealed message |
| `ret {id, ok, v \| e}` | call result |
| `ev {ev, arg?, v, n?}` | event; for a `patches: 1` state subscriber `n` numbers each state |
| `evp {ev: state, n, ops}` | state patch: ops turn state n-1 into n |

- State: queued per connection at most every `stateMs` (1500 ms default), deduped by JSON.
  Old web (no `patches`) → full state each time. Patch subscriber → numbered full first, then
  `evp` when ops JSON ≤ 60 % of the full; a full too big for the relay doesn't advance the base or
  `n`, so the next goes full again.
- Web (`src/web/remoteDeck.ts`): applies `evp` only when `n === base.n + 1`, ops are an array with
  no `__proto__`/`constructor/prototype` path, and `applyPatch` succeeds on a private
  `structuredClone`; otherwise drops the base and sends `resync` (asks again if no full within
  3 s). Listeners always get their own copy.
- PTY data: batched per connection for `batchMs` (50 ms), flushed early at 128 KiB, split into
  ≤ 128 KiB pieces (surrogate pairs kept whole) with `seq` adjusted per piece; `pty:exit` flushes
  first. Measured before patches: the bridge sent the full AppState to each tab up to every
  500 ms, 134 MB / 3 min.
- Notes travel here and nowhere else remote (never in the snapshot of §2): `notesList` answers
  titles and 120-character previews, `notes:changed` carries the same for one note to tabs that
  subscribed, and a note's whole text goes only as the answer of `notesGet` or in the conflict
  answer of `notesSave`. `notesDelete` from a tab skips the Mac's native confirmation (the web app
  asked with `webConfirm`). Details: [ARCHITECTURE § Notes](ARCHITECTURE.md).
- `dropChannels()` on any CloudSync disconnect (approval requests survive and finish after the
  reconnect); `closeAll()` on sign-out/account change.

### Mac ↔ web hub close codes (browser socket `/v1/browser?id=`)

| Code | Meaning | Web (`afterClose`, `Gate.tsx`) |
|---|---|---|
| 4003 | revoked or signed out | delete keys, "Request access again" (or sign-in) |
| 4006 | session re-check | reconnect at once (once), then backoff |
| 4008 | closed by the Mac | check `GET /v1/browsers/:id`, then backoff or re-approve |
| 4009 | open in another tab | "MasterDeck is open in another tab · Use here" |

## 4. The web app (app.masterdeck.dev)

- Source: `app/src/web/` (`index.html` with a strict CSP; `main.tsx` mounts `Gate`; `web.css`)
  plus the whole renderer (`@renderer/App`). `public/_headers`: `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `no-referrer`, `nosniff`.
- `Gate.tsx` flow: `/auth/get-session` (cookie) → sign-in screen (`${API}/login?next=…`) →
  keys in IndexedDB per user (`keys.ts`; other accounts' keys deleted; private windows →
  "can't be approved") → `approve()` (`approval.ts`) → socket + handshake (`connect()`): backoff
  1 s → 30 s, ping 30 s, handshake timeout 15 s, "Mac offline" banner from `desktop` messages
  (or after 10 s of silence) → `window.deck = createRemoteDeck(...)` → `<App key={gen}/>`
  (remounted per channel). Sends `visible` on tab visibility and `device` (`deviceFrom(UA,
  userAgentData.platform)`) once. Sign out deletes the browser row and keys.
- `renderer/src/web.ts`: `isWeb()`, `can()`, `WEB_VIEWS` (all views since stage 2),
  `screenOk/shortcutOk/actionOk`. Desktop-only things are hidden: the `remoteEnabled` toggle,
  Account actions, browser approval/revoke, editor buttons, folder picker (replaced by
  `RepoPicker`), native dialogs (replaced by `webConfirm`). `openExternal` on the web opens only
  `https://` URLs.
- Build/serve/deploy: `npm run build:web` (→ `app/out/web`, `MD_API` default
  `https://dev.masterdeck.dev`, must be https for production), `npm run dev:web` (Vite;
  `MD_API=http://localhost:8787` adds the local backend to the CSP; `/?preview` shows the app on fixture data
  with no Mac, dev server only, see ARCHITECTURE), `npm run deploy:web`
  (wrangler 4, `app/web/wrangler.jsonc`: Worker `masterdeck-web`, static assets SPA, custom domain
  `app.masterdeck.dev`). Deploy only when the user asks.

## 5. Instant typing (predictive local echo, web only)

Code: `renderer/src/predictiveEcho.ts` (`createPredictor(term, {now?, timeoutMs?, enabled?})`),
wired in `TerminalView.tsx` only when `isWeb()`. Setting `instantTyping` (default `true`,
Settings → General "Instant typing (web)"; a Mac without the field counts as on). It is a Mac
setting, so it applies to every browser of that Mac.

Design (after VS Code's TypeAheadAddon and mosh): a predictable key is drawn at once, dim
(`ESC[0;2m`), as an overlay whose covered cells are saved. Before each chunk of real output the
overlay is undone (cells, cursor and pen restored), so program output always lands on the real
screen; after it is parsed the predictions are checked in order against the buffer — confirmed
ones drop, the rest are redrawn, a surprise clears all and pauses.

**Hard invariant**: screen + scrollback + cursor always equal a plain terminal fed only the real
output. When in doubt, predict nothing.

- Predicts: printable single-width chars; on the normal screen also Backspace (only with nothing to
  its right), ←, → (only over existing text). Never: Enter, Tab, Ctrl-C, Esc, pastes, wide chars,
  the last column, pending wrap (`x === cols`).
- **Observe mode** on the alternate screen (Claude Code's TUI, `?1049h`): entering/leaving a
  buffer drops and pauses; while paused, keys are tracked hidden and each exact echo at the cursor
  counts; after 3 in a row (`RECOVER_AFTER`) predictions show. Only chars there. Esc/Ctrl-C on the
  alt screen pause again (vim leaving insert mode). vim normal mode, less, top: never predicted
  (no exact echoes). On the normal screen a pause also lifts after 10 s.
- Guards: parser ground-state tracking across chunks (`scan`, incl. 8-bit C1 from any state, ESC
  ends strings, CAN/SUB); our overlay only enters the stream in ground state. SGR pen tracking
  (unknown SGR → off until reset). Charsets G0-G3 designations + locking shifts (`ESC n/o/~/}/|`)
  + SO/SI in every state except OSC/DCS; RIS resets. Insert mode, origin mode, hidden cursor
  (`?25l`), `pass(word|phrase|code)` on the line, low latency (average of ≥ 3 echoes < 30 ms →
  off), 2 s prediction timeout, a blind period after an unmodelled key (`syncMs` 300 ms - 3 s from
  measured latency). Our own writes carry a private OSC 7731 marker with a random per-instance
  token, so program output can't fake it. Mouse motion and focus reports are neutral.
- The predictor owns `term.resize`: a resize with an overlay on screen first undoes it (as its own
  write); real output is held while overlay writes are in flight so the resize orders exactly as in
  a plain terminal. `TerminalView` calls `pred.clear(refit)` around fits and shows.
- Tests (`predictiveEcho.test.ts`, 72 tests, ~30 s, `@xterm/headless` 5.5 as the reference): unit
  cases per guard, the real Claude Code capture `app/test/fixtures/claude-echo.json` (learn then
  predict, and every-byte split replays with a key typed in between), review rounds 2-4 (C1,
  charsets, resize ordering, pending wrap, SO/SI), and a seeded fuzz of 300 runs against a plain
  xterm (the reviewer ran ~14k with 0 mismatches). Not yet verified by an agent in a real browser;
  the user reported "That works".
- Measured context: user in India routed to Cloudflare Marseille, ~195 ms ping, ~170 ms TTFB;
  web echo was ≈ 0.5 s+ before instant typing.

## 6. The remote indicator

- `Rail.tsx` `RemoteIndicator`: a blinking amber dot (`.ri-dot`, solid under
  `prefers-reduced-motion`) in the bottom group of the rail, above Broadcast/Standup/Skills/Commands
  and Settings, while ≥ 1 remote connection exists. Hidden on the web (`showRemoteDot(n, isWeb())`).
- Data: `mergePresence(state.browsers, state.remoteClients)` (`shared/remotePresence.ts`):
  connected approved browsers (`kind: browser`, `since = connectedAt ?? 0`) + live clients
  (`phone` / `api`), newest first, names cleaned (`cleanLabel`, "Unnamed").
- Hover/focus card "Remote connections (n)": name, device (`describeDevice` → "Unknown device"),
  "connected X ago" (when `since > 0`; refreshed every 15 s). Esc hides it; click → Settings →
  Remote. `aria-label` "<n> remote connection(s) active".
- Browsers from older web builds send no `device` and have no `connectedAt` → "Unknown device",
  no time.

## 7. Settings → Remote (desktop UI)

`SettingsView.tsx` section `remote`: explanation, **Connect to the backend** toggle
(`remoteEnabled`, desktop only; the Mac also ignores `remoteEnabled` in remote `setSettings`
calls), "Sign in first / Go to Account" without a token, a status dot + text (Connected · last
sync, or the status message), the tampering warning, and **Browsers** (name, "connected",
Revoke).

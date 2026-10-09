# Operations

Build, install, release, deploy, test safely, measure, troubleshoot. Rules first: **never push or
deploy unless the user asks**, **rebuild + reinstall + relaunch after every change**, **no real
GitHub writes in tests**, **never type into the user's real sessions**.

## Dev setup

- Node 22 (CI uses 22), Python 3.9+ (`python3`), `git`, `jq`, `gh`, Claude Code. macOS arm64 is
  the daily machine.
- `cd app && npm install` — `postinstall` runs `electron-builder install-app-deps` (node-pty for
  Electron). `npm run dev` for hot reload (bundles `../skills`).
- Checks before a commit: `npm run typecheck`, `npm test` (~1360 tests, ~40 s), and for skill
  changes `PYTHONPATH=skills/master/lib python3 -m pytest skills/master/tests -q` (~416 tests).
- Backend checkout next to this repo (`~/Documents/masterdeck-backend`) so the protocol
  drift test runs.

## Build, package, install (local)

After every change, from `app/`:

```bash
rm -rf dist                                    # frees ~1 GB; disk is often short
npm run build                                  # electron-vite → out/
npx electron-builder --mac dir --arm64         # dist/mac-arm64/MasterDeck.app, no DMG
npx electron-builder install-app-deps          # ALWAYS: put node-pty back to arm64
osascript -e 'quit app "MasterDeck"'
while pgrep -f /Applications/MasterDeck.app >/dev/null; do sleep 1; done
./scripts/install-mac.sh                       # refuses while MasterDeck runs; strips quarantine
open /Applications/MasterDeck.app
```

- `scripts/install-mac.sh` copies `dist/mac-<arch>/MasterDeck.app` (else `dist/mac/`) to
  `/Applications` and prints the installed version. Quitting the app never stops background
  Claude sessions.
- Full installers: `npm run dist:mac -- --publish never` (DMGs arm64 + x64, ~1.5 GB free disk
  needed) / `npm run dist:win -- --publish never`. Then `install-app-deps` again.
- Packaging config: `app/electron-builder.yml` (appId `io.github.amntoppo.masterdeck`, ad-hoc
  signature `identity: "-"`, no hardened runtime, node-pty unpacked from asar, `statusline_tee.py`
  and `../skills` as extra resources without tests/caches).
- Icons: `app/build/icon.icns` (macOS, also the DMG), `icon.ico` (Windows), `icon.png` / `icon.svg`
  (the source tile; `npm run dev` puts it in the Dock), and the web app's `src/web/public/favicon.svg`,
  `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` and `manifest.webmanifest`. All are made by
  `node scripts/icons.mjs` (macOS: it calls `iconutil`) from the mark masterdeck.dev uses, and committed.
  A Mac may keep showing the old icon of a replaced app until the Dock restarts (`killall Dock`).
- Smoke: `MASTERDECK_NO_SKILLS=1 MASTERDECK_SMOKE=1 MASTERDECK_USER_DATA=$(mktemp -d)
  dist/mac-arm64/MasterDeck.app/Contents/MacOS/MasterDeck` → `SMOKE OK sessions=… issues=…`.

## Release

Only when the user asks. Last release: v0.8.2 (2026-10-06; v0.8.0 and v0.8.1 had no Windows build).

```bash
cd app && npm version X.Y.Z --no-git-tag-version   # package.json + lock
cd .. && git commit -am "Version X.Y.Z"
git tag vX.Y.Z
git push origin main && git push origin vX.Y.Z
```

CI (`.github/workflows/ci.yml`, on push to `main`, tags `v*`, PRs) runs Python tests, typecheck,
vitest and builds DMGs (macos-latest) and the NSIS EXE (windows-latest); on a tag it attaches them
to the GitHub release with `.github/release-notes.md` as the body. `install.sh` downloads the
latest release.

## Web app deploy

```bash
cd app && npm run deploy:web     # build:web (MD_API https://dev.masterdeck.dev) + wrangler@4 deploy -c web/wrangler.jsonc
```

Publishes the static Worker `masterdeck-web` on `app.masterdeck.dev` (assets `out/web`, SPA
fallback). Needs a logged-in wrangler on this machine. Only when asked. Local dev against a local
backend: `MD_API=http://localhost:8787 npm run dev:web -- --port 5175 --strictPort` (the backend
then needs `APP_ORIGIN=http://localhost:5175`).

## Backend deploy (other repo, for reference)

`cd ~/Documents/masterdeck-backend && npx wrangler deploy` (local; the CI deploy fails
with Cloudflare error 7403). Changes go branch → PR → squash merge to `master`, when the user
asks. Secrets `DESKTOP_TOKEN` / `CLIENT_TOKEN` / `CALLBACK_SECRET` (static dev/test tokens are
only accepted on dev hosts since accounts/OAuth); local copies in `~/.config/masterdeck-remote/`
(mode 600). The owner's Cloudflare account,
Workers Free plan assumed: 100k Worker requests/day, DO 100k requests/day (incoming WS messages
count 20:1), 13,000 GB-s/day, SQLite 5M rows read / 100k written per day, 5 GB stored; over the
limit = errors until 00:00 UTC, no automatic billing. 2026-10-02 usage: DO 24,952 requests, rows
3,432 read / 1,064 written, Worker 547 requests.

## Isolated E2E test recipe

Use this for anything that clicks or calls `window.deck`. It never touches the real
`~/.claude/settings.json`, skills, config or app profile.

```bash
E2E=$(mktemp -d)
mkdir -p "$E2E/home" "$E2E/master" "$E2E/ud" "$E2E/ws"
cd ~/Documents/MasterDeck-Terminal/app
npm run build
MASTERDECK_HOME="$E2E/home" MASTERDECK_ISOLATED=1 MASTERDECK_USER_DATA="$E2E/ud" \
MASTER_HOME="$E2E/master" MASTER_WORKSPACE="$E2E/ws" \
MASTERDECK_NO_HOOK=1 MASTERDECK_NO_SKILLS=1 \
MASTERDECK_REMOTE_URL=http://localhost:8787 \
npx electron . --remote-debugging-port=9333
```

- Drop `MASTERDECK_REMOTE_URL` to stay off any backend; for remote/web tests run the backend with
  `wrangler dev` on :8787 (its own persist dir under `$E2E`; back up and restore `.dev.vars` if you
  change it) and the web app on 5175 (above).
- Drive over CDP: `curl -s http://127.0.0.1:9333/json` for the page's `webSocketDebuggerUrl`, then
  `Runtime.evaluate` with `awaitPromise: true`, e.g. `window.deck.getState()`,
  `window.deck.setSettings({...s, remoteEnabled: true})`, `window.deck.browserDecide(id, true)`;
  `Page.captureScreenshot` for pictures. The Chrome DevTools MCP works too (new isolated page).
- Native dialogs: with `--inspect=127.0.0.1:9334` you can stub `dialog.*` / `shell.openExternal`
  in main for the run.
- The isolated app still lists the user's real sessions: never Reply, Stop or answer their items.
- **Never give the app itself a temp `HOME` on macOS**: without the login keychain there, startup
  stops on a system keychain dialog (on the user's screen) and the window never opens. To keep it
  off the real `~/.claude.json`, set `CLAUDE_CONFIG_DIR=$E2E/claudecfg` instead: `master trust`,
  `draft-assign` and `checkout` then read `$E2E/claudecfg/.claude.json` (write
  `{"projects": {"<real path of a folder>": {"hasTrustDialogAccepted": true}}}` there to make a
  folder trusted, `{"projects": {}}` for none).
- **Anything that would run `claude`** (Start, Try again, **Open Claude there…**): put a stand-in
  first on the PATH the app uses. The app takes its PATH from `$SHELL -ilc`, so point `SHELL` at a
  small script that sets `PATH="$E2E/bin:/usr/bin:/bin"` and runs `/bin/sh`, and put a `claude`
  script in `$E2E/bin` that prints `[]` for `agents`, prints Claude Code's refusal and exits 1 for
  `--bg` (or `backgrounded · 4f2a9c1e` and 0), and prints a line and sleeps with no arguments.
  Checked this way (2026-10-06): the Start dialog's line and button for an untrusted temp checkout,
  the tab running the stand-in in that folder, the dialog coming back once the temp file says
  trusted, the refused start's tab, the HELD card, **Try again** / **Start now** spawning the one
  proposal (held → sent), and no line for a trusted folder.
- **A real start from the Start dialog** (done once, 2026-10-09, issue #59): the same launch with
  the real `claude` on the PATH (no stand-in) and `MASTERDECK_BOARD_FIXTURE`, a throwaway checkout
  `$E2E/ws/tracker` (`git init`, `origin` = `https://github.com/acme/tracker.git`, one commit, left
  on a branch that is not the ticket's), the config's `workspace` = `$E2E/ws`. Board → **Show
  everyone's issues** → a card with no PR → **Start a session**. The dialog names the checkout and
  says Claude Code has not been allowed there: **Open Claude there…** opens the real prompt in a
  tab (Down, Enter accepts it, which adds the folder to the real `~/.claude.json`: ask the user
  first; `/exit` the interactive Claude it leaves), the dialog comes back, pick Haiku and a one-line
  first instruction, Start. Then: `claude agents --json` shows the session's `cwd` is the checkout,
  `$E2E/home/parked-sessions.json` has one record keyed by the background id (the ledger's note
  holds the `claude --bg` output), and a link records no branch for it: add a real repository to
  `repos` in `$E2E/master/config.json` and `window.deck.linkSession({repo, number}, sessionId,
  cwd)` for a real issue no board of that config holds (a read; no move) → `ticket-links.json`
  has `"branch": ""`; with `parked-sessions.json` moved aside the same link records the folder's
  branch. A master proposal for the dialog: the CLI refuses writes from a Claude session, so write
  the fixture with the ledger library (`with ledger.locked() as led: ledger.add(led, …)`; `locked`
  saves the object it yields) under `$MASTER_HOME`. Afterwards `claude stop <id>` each session,
  delete only the transcript folders those folders made under `~/.claude/projects/` (exact names),
  and leave the trust entry (MasterDeck never writes `~/.claude.json`).
- A unit test that opens a pane through `PtyManager` runs whatever `paneCommand` names, a real
  shell included: replace `node-pty` for the whole file with `vi.mock` before anything loads it
  (`ptys.test.ts`), so it cannot start a process even while it is red. An argument the code under
  test does not take yet protects nothing. The same for the CLI: patch `subprocess.run` around a
  `cli.main(["spawn", …])` in a test.
- The Board without GitHub: `MASTERDECK_BOARD_FIXTURE=<json>` with a `config.json` under
  `$MASTER_HOME`. `app/test/fixtures/board.json` goes with a config that has a board;
  `app/test/fixtures/board-derived.json` with one that has repositories and no board
  (`"repos": ["acme/tracker"], "project": 0, "projects": []`): the hint, the four columns, no drag.
  Never press **Create a GitHub board** in such a run: its read and its native dialog use the
  machine's real gh account, and the dialog is the last stop before a real write.
- The Board's repository view without GitHub: add `MASTERDECK_REPO_FIXTURE=<json>`
  (`app/test/fixtures/repo-issues.json`: issues of `acme/tracker` and `acme/api`) to a run whose
  config has a board and both repositories (`"repos": ["acme/tracker", "acme/api"]`). Pick a
  repository in a tab's Repos filter, or call `window.deck.boardRepos(["acme/api"])` and read
  `repoView` from `window.deck.getState()`.
  Before any tab asks, `repoView` is absent from the state. With both picked the tab shows "Issues of
  tracker, api — not the board.", **Back to board**, the note "api: showing the first 300 of 412 open
  issues.", the columns Todo / In Dev / PR Raised / Done, no drag, no sprint picker, no Summary, and
  the chip "▦ Dev Done" on #967 (it is on the fixture board). The columns are worked out from the
  machine's sessions too: a card sits in Todo unless a real session here happens to be linked to an
  issue of that number, then it is In Dev and carries that session's name (keep no screenshot of
  it). The fixture's closed issue is older than 14 days and does not show.
  For the other states copy the fixture and add parts: `{"repo": "acme/web", "ok": true, "total": 0,
  "shown": 0}` gives "No open issues", `{"repo": "acme/docs", "ok": false, "total": 0, "shown": 0,
  "note": "…"}` gives "Could not read docs" with **Retry**; a tab saved with a repository the config
  does not select says "… is not selected in Setup." The app rewrites `config.json` into the
  accounts form on its first start: for a second run with other repositories edit `accounts[].repos`
  too. With `board-derived.json` and a config with no board, picking a repository only filters (no
  line, `repoView` stays absent, all picked reads "All repos" again).
  Look only: never press **Assign**, **Assign to me**, **Create ticket**, **Create with Claude** or
  **Start a session** in such a run (they act as the machine's real gh account or start a real
  session); close popups with Esc. Add `MASTERDECK_TEST_NO_ATTACH=1` so a click on a session's card
  cannot attach to a real session. A PR popup will say "gh: Not Found": the fictional repository was
  asked for, read-only.
- To compare with `main`: `git worktree add --detach <tmp>/main main` (the branch `main` itself is
  checked out elsewhere), link `app/node_modules` into it, `npm run build` there, and launch it with
  the same variables from a fresh `$E2E/home`, `ud` and `master`. With no repository picked the
  Board's DOM differs only in the "refreshed" time's tooltip.
- The phone layout without a phone: `npm run dev:web` (port 5173 unless `--port` is given), headless
  Chrome with `--remote-debugging-port`, `Emulation.setDeviceMetricsOverride` 390x844 `mobile: true`
  in the same CDP session as the checks, then `/?preview`: the Board, **Filters (n)** → Repos →
  `web`. `document.documentElement.scrollWidth` must stay 390, and a popup's
  `getBoundingClientRect()` inside the viewport. The preview deck sends nothing.
- Before/after: record `shasum -a 256 ~/.claude/settings.json`; it must not change. Afterwards
  kill electron/wrangler/vite, check ports 8787/9333/9334/5175 are free, delete `$E2E` (that path
  only).

### A throwaway Claude session

To test something that needs a live Claude session, start one of your own, never use the user's:

```bash
P=$(mktemp -d) && cd "$P" && git init -q
claude --bg -n probe-$(date +%s) --model haiku "Reply with OK and wait."
```

- A fresh folder hits "Workspace not trusted"; accepting writes the real `~/.claude.json`, so ask
  the user first, or test the PTY path with a shell pane ("Terminal in a repo") instead.
- Stop it with `claude stop <bgId>` when done, remove `$P`, and delete only the transcript folder
  that run created under `~/.claude/projects/` (name it exactly; never a glob).

## Measuring upload

What the Mac sends to the backend (CloudSync + browser bridge share the main process socket):

```bash
PID=$(pgrep -f '/Applications/MasterDeck.app/Contents/MacOS/MasterDeck$' | head -1)
nettop -P -L 1 -J bytes_in,bytes_out -p "$PID"      # sample now
# … wait N minutes with the scenario running (sessions busy, web tab open or closed) …
nettop -P -L 1 -J bytes_in,bytes_out -p "$PID"      # sample again; bytes_out difference = upload
```

Reference numbers: before patches ~145 MB / 55 min (busy sessions); after (web tab closed)
715 bytes / 2 min. The web bridge sent 134 MB / 3 min before state patches; the after-number with
a tab open is still to be measured (TODO).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm test` / `npm run dev` crash in node-pty (wrong architecture, x86_64) | `cd app && npx electron-builder install-app-deps` (needed after every packaging build) |
| `electron-builder` fails or DMG build dies | disk space: `rm -rf app/dist`; a DMG build needs ~1.5 GB free |
| `remote.drift.test.ts` fails | the backend checkout is on a branch whose `src/protocol.ts` differs (or `remote.ts` was hand-edited). Check out backend `master` (or the matching branch) or run `app/scripts/sync-protocol.sh`; set `MASTERDECK_BACKEND` if the backend lives elsewhere. Missing checkout = skipped |
| Remote stuck on "waiting for sessions to load" | `claude agents --json` is failing (the status says why when it errors); run it by hand. After 60 s the line connects anyway; commands then fail at once with "MasterDeck has no session list: …" and no snapshot is sent until the session list is in |
| "Another Mac is connected to this account" | close 4005: only one Mac per account; sign the other out |
| Notifications never show | the bundle needs a whole-bundle (ad-hoc) signature; reinstall from a fresh build |
| `install-mac.sh` says MasterDeck is running | quit it and wait for `pgrep` to be empty |
| A session does not start: "Workspace not trusted. Run `claude` in `<folder>` once…" / "Claude Code has not been allowed to work in `<folder>` yet." | Claude Code's trust prompt was never accepted for that folder (sessions start in the ticket's repository's checkout; for a git repository only the repository itself or a folder inside it up to its root counts, never the workspace above it; a plain folder is covered by any trusted parent). **Open Claude there…** (Start dialog, the "did not start" tab, the HELD card in Needs you), accept the prompt, **Try again**: it spawns the same held proposal (`master spawn <id> --held-for-trust`: only a start the CLI itself held for this, never beside a live session of that name). `master trust <folder>` prints what MasterDeck reads (`true`, `false`, `null` = not known) from `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set, 8 MB at most); it never writes that file |
| Web shows "Update MasterDeck" | Mac and web `PROTOCOL_VERSION` differ; update the Mac or reload |
| Backend CI deploy fails (7403) | deploy locally with `npx wrangler deploy` |

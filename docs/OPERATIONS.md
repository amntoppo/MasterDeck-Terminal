# Operations

Build, install, release, deploy, test safely, measure, troubleshoot. Rules first: **never push or
deploy unless the user asks**, **rebuild + reinstall + relaunch after every change**, **no real
GitHub writes in tests**, **never type into the user's real sessions**.

## Dev setup

- Node 22 (CI uses 22), Python 3.9+ (`python3`), `git`, `jq`, `gh`, Claude Code. macOS arm64 is
  the daily machine.
- `cd app && npm install` — `postinstall` runs `electron-builder install-app-deps` (node-pty for
  Electron). `npm run dev` for hot reload (bundles `../skills`).
- Checks before a commit: `npm run typecheck`, `npm test` (~1180 tests, ~35 s), and for skill
  changes `PYTHONPATH=skills/master/lib python3 -m pytest skills/master/tests -q` (~315 tests).
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
- Smoke: `MASTERDECK_NO_SKILLS=1 MASTERDECK_SMOKE=1 MASTERDECK_USER_DATA=$(mktemp -d)
  dist/mac-arm64/MasterDeck.app/Contents/MacOS/MasterDeck` → `SMOKE OK sessions=… issues=…`.

## Release

Only when the user asks. Last release: v0.7.1 (2026-10-03).

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
- The Board without GitHub: `MASTERDECK_BOARD_FIXTURE=<json>` with a `config.json` under
  `$MASTER_HOME`. `app/test/fixtures/board.json` goes with a config that has a board;
  `app/test/fixtures/board-derived.json` with one that has repositories and no board
  (`"repos": ["acme/tracker"], "project": 0, "projects": []`): the hint, the four columns, no drag.
  Never press **Create a GitHub board** in such a run: its read and its native dialog use the
  machine's real gh account, and the dialog is the last stop before a real write.
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
| Remote stuck on "waiting for sessions to load" | `claude agents --json` is failing (see TODO); run it by hand |
| "Another Mac is connected to this account" | close 4005: only one Mac per account; sign the other out |
| Notifications never show | the bundle needs a whole-bundle (ad-hoc) signature; reinstall from a fresh build |
| `install-mac.sh` says MasterDeck is running | quit it and wait for `pgrep` to be empty |
| Web shows "Update MasterDeck" | Mac and web `PROTOCOL_VERSION` differ; update the Mac or reload |
| Backend CI deploy fails (7403) | deploy locally with `npx wrangler deploy` |

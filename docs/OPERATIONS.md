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
  and `../skills` as extra resources without tests/caches; on macOS also `resources/whisper/<arch>`,
  meetings' speech engine, when `scripts/whisper.sh` built it: see "Meetings: speech engine and models").
- Icons: `app/build/icon.icns` (macOS, also the DMG), `icon.ico` (Windows), `icon.png` / `icon.svg`
  (the source tile; `npm run dev` puts it in the Dock), and the web app's `src/web/public/favicon.svg`,
  `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` and `manifest.webmanifest`. All are made by
  `node scripts/icons.mjs` (macOS: it calls `iconutil`) from the mark masterdeck.dev uses, and committed.
  A Mac may keep showing the old icon of a replaced app until the Dock restarts (`killall Dock`).
- Smoke: `MASTERDECK_NO_SKILLS=1 MASTERDECK_SMOKE=1 MASTERDECK_USER_DATA=$(mktemp -d)
  dist/mac-arm64/MasterDeck.app/Contents/MacOS/MasterDeck` → `SMOKE OK sessions=… issues=…`.
  The smoke test never opens the Keychain (`NO_KEYCHAIN` in `main/macKey.ts`: no browser key, no
  remote token): every build is signed ad hoc, so the Keychain asks again for each new build, and
  its dialog blocks the main thread until answered (the run then hangs with no output, its own 30 s
  timer frozen too). An isolated app that is not a smoke run still asks; that dialog is the user's to answer.

## Release

Only when the user asks. Last release: v0.9.0 (2026-10-10). Before it: v0.8.2 (2026-10-06; v0.8.0
and v0.8.1 had no Windows build).

```bash
cd app && npm version X.Y.Z --no-git-tag-version   # package.json + lock
cd .. && $EDITOR .github/releases/vX.Y.Z.md         # optional: the update's notes (see below)
git add app/package.json app/package-lock.json .github/releases && git commit -m "Version X.Y.Z"
git tag -a vX.Y.Z -m "MasterDeck X.Y.Z"             # an annotated tag's message is the fallback notes
git push origin main && git push origin vX.Y.Z
```

A version with a `-` (`0.10.0-beta.1`) is the **beta** channel and a GitHub prerelease (so
`install.sh`, which takes the latest release, stays on stable); anything else is **stable**.

**CI.** `.github/workflows/ci.yml` (push to `main`, PRs) runs the Python tests, typecheck and
vitest and builds the DMGs and zips (macos-latest) and the NSIS EXE (windows-latest); it no longer
runs on tags. `.github/workflows/release.yml` runs on a tag `v*` (or by hand, **Run workflow** with
an existing tag):

1. **build** (mac and win, the same steps as `ci.yml`, `--publish never`) uploads the DMGs, the mac
   zips, the EXE, the blockmaps and `latest*.yml` as artifacts.
2. **publish** (ubuntu) checks the tag against `app/package.json`'s version, picks the update's
   notes (`.github/releases/v<version>.md`, else the annotated tag's message, else
   `MasterDeck <version>`; see [.github/releases/README.md](../.github/releases/README.md)),
   attaches the DMGs and EXE to the GitHub release with `.github/release-notes.md` as the body (the
   install page, as before), and only then runs `app/scripts/release-publish.mjs`, so a live update
   always has its installers on GitHub.

`release-publish.mjs` first refuses a signing key whose public key is not the app's
(`RELEASE_PUBLIC_KEY` read out of `app/src/shared/releaseKey.ts`; `--expect-key <b64>` names
another, for a test key) and an empty file. It finds the update files (`MasterDeck-<v>-arm64-mac.zip`,
`MasterDeck-<v>-mac.zip` for Intel, and `MasterDeck Setup <v>.exe` with its `.blockmap`, published
as `MasterDeck-Setup-<v>.exe[.blockmap]`), computes each one's base64 SHA-512 and size, signs
`masterdeck-update\nv1\n<version>\n<platform>\n<arch>\n<name>\n<sha512>` with the release key
(Ed25519), uploads every file to R2 through the backend's admin multipart routes (90 MB parts,
each tried four times; a failed upload is aborted; a file `HEAD /v1/updates/files/<key>` already
answers with the same size is skipped) and registers the release with
`POST /v1/admin/releases`, which checks every size and signature. Nothing is offered to users until
that last call. The DMGs stay on GitHub Releases for new installs (`install.sh`, the website).

**Secrets** (repository → Settings → Secrets and variables → Actions; set by the owner):

| Secret | What |
|---|---|
| `RELEASE_ADMIN_TOKEN` | The backend's `RELEASE_ADMIN_TOKEN` (the admin routes' bearer token) |
| `RELEASE_SIGNING_KEY` | The release private key, PKCS8 PEM (the whole file, `-----BEGIN PRIVATE KEY-----` included) |

The private key is also kept on the owner's Mac at
`~/.config/masterdeck-remote/release-signing-key.pem` (mode 600), and nowhere else. Its public key
(raw, base64) is built into the app (`app/src/shared/releaseKey.ts`) and set on the backend as the
var `RELEASE_PUBLIC_KEY`. The API defaults to `https://dev.masterdeck.dev` (`MD_RELEASE_API`
overrides it).

**Publish by hand** (a failed publish job, or a release built locally): put the builds in one
folder (subfolders are searched), then

```bash
cd app
RELEASE_SIGNING_KEY_FILE=~/.config/masterdeck-remote/release-signing-key.pem \
  node scripts/release-publish.mjs --dir ../artifacts --version X.Y.Z --notes ../.github/releases/vX.Y.Z.md --dry-run
# the manifest is printed, with "signed with public key …" on stderr: it must be the app's key
RELEASE_ADMIN_TOKEN=… RELEASE_SIGNING_KEY_FILE=… node scripts/release-publish.mjs --dir ../artifacts --version X.Y.Z [--notes f] [--rollout 10] [--min-supported X.Y.Z]
```

`--channel stable|beta` overrides the channel taken from the version; `--rollout <0-100>` starts a
staged rollout; `--min-supported <v>` makes the update mandatory for anything older. Re-running is
safe: files already uploaded with the same size are skipped, others are uploaded again, and
registering an identical release again is a no-op (a different file for an existing version is
refused with `409`: bump the version instead).

**Rollout, yank, notes after the fact:** `PATCH /v1/admin/releases/<version>` with
`{rolloutPercent, yanked, notes, minSupportedVersion}` (all rows of that version; `yanked: true`
hides it from every check at once). See the backend's `docs/OPERATIONS.md` for the commands.

**Key rotation:** make a new key with `node app/scripts/release-key.mjs <path>` (writes the PEM with
mode 600, refuses to overwrite, prints the public key). Ship an app release that carries the new
public key in `src/shared/releaseKey.ts` first, signed with the **old** key; once users run it,
set the backend's `RELEASE_PUBLIC_KEY` and the `RELEASE_SIGNING_KEY` secret to the new pair. An app
only installs updates signed with the key it has built in, so skipping the first step strands
every installed copy on its version (they would need a manual download).

### Testing in-app updates (end to end, local only)

A release build ignores every update override in the environment (any process of the user can
`launchctl setenv` one). The test overrides work only in an **update-test build**: one built with
`MASTERDECK_UPDATE_TEST_BUILD=1`, which sets electron-vite's define `__MD_UPDATE_TEST__`. Never
publish such a build (release.yml never sets the variable).

```bash
# 0. A test key pair (never the real one); note the printed public key.
mkdir -p /tmp/md-update-test && node app/scripts/release-key.mjs /tmp/md-update-test/key.pem
# 1. The backend locally (its repo): wrangler dev with local D1/R2, RELEASE_PUBLIC_KEY = the test key.
# 2. v N and v N+1 as update-test builds (bump app/package.json between them; do not commit it).
cd app
MASTERDECK_UPDATE_TEST_BUILD=1 npm run build && npx electron-builder --mac dir zip --arm64 --publish never
npx electron-builder install-app-deps
# 3. Publish v N+1 to the local backend with the test key.
MD_RELEASE_API=http://localhost:8787 RELEASE_ADMIN_TOKEN=<local token> RELEASE_SIGNING_KEY_FILE=/tmp/md-update-test/key.pem \
  node scripts/release-publish.mjs --dir <folder with v N+1's zip> --version <N+1> --expect-key <test public key>
# 4. Copy v N's MasterDeck.app to a temp folder and launch it isolated against the local backend.
MASTERDECK_ISOLATED=1 MASTERDECK_HOME=<tmp>/home MASTERDECK_USER_DATA=<tmp>/ud \
  MASTERDECK_UPDATE_URL=http://localhost:8787 MASTERDECK_UPDATE_PUBKEY=<test public key> \
  <tmp>/MasterDeck.app/Contents/MacOS/MasterDeck
```

Settings → Updates → Check for updates finds N+1, downloads and verifies it; Restart now swaps it
in and the helper waits for the health marker (`<tmp>/ud/updates/helper.log`). For the rollback,
publish an N+1 whose window never loads. `release-publish.mjs` wants all three update files (both
mac zips and the EXE with its blockmap): for a mac-only test put small non-empty stand-ins for the
others beside the real zip.

## Web app deploy

```bash
cd app && npm run deploy:web     # build:web (MD_API https://dev.masterdeck.dev) + wrangler@4 deploy -c web/wrangler.jsonc
```

Publishes the static Worker `masterdeck-web` on `app.masterdeck.dev` (assets `out/web`, SPA
fallback). Needs a logged-in wrangler on this machine. Only when asked. Local dev against a local
backend: `MD_API=http://localhost:8787 npm run dev:web -- --port 5175 --strictPort` (the backend
then needs `APP_ORIGIN=http://localhost:5175`).

## Website (masterdeck.dev)

The site is its own repository, [amntoppo/Masterdeck-Website](https://github.com/amntoppo/Masterdeck-Website)
(checkout `~/Documents/personal/Masterdeck-Website`, private). `npm run deploy` there refreshes the
changelog from this repository's releases, builds, deploys the Workers `masterdeck-site`
(masterdeck.dev) and `masterdeck-www` (301 to the bare domain), and pings IndexNow. After a release,
deploy the site again so its Download page shows it. Its README covers search engines: structured
data, the sitemap, and the one-time Google Search Console setup. This repository links to the site
from the README, the release notes (`.github/release-notes.md`) and the repository's website field.

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
- **Mods (Setup / Settings → Mods)**: `claude plugin` writes Claude Code's own settings, so an
  isolated app refuses to install mods unless `CLAUDE_CONFIG_DIR=$E2E/claudecfg` is set (then the
  real `claude` writes `$E2E/claudecfg/settings.json` and `plugins/` only; checked 2026-10-10 with
  Install and Remove). With it set, `claude agents` lists no sessions, so never press **Reload idle
  sessions** in a run that does list real ones: it types `/reload-plugins` into them.
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

## Meetings: capture

How MasterDeck records a meeting on macOS (issue #102; spec §1-§2 in the backend repo). This comes
from Electron 44.4.5's `electron.d.ts` and the Electron docs. **Nothing here has been run on a real
Mac yet**: a real capture needs the user's grants, so it is checked by the user (list below).

**Two streams, both from a hidden capture window**, never at startup:

- **You**: `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })`.
  Permission: Microphone. Ask with `systemPreferences.askForMediaAccess('microphone')` (main,
  after consent); read with `getMediaAccessStatus('microphone')` (never prompts). Needs
  `NSMicrophoneUsageDescription` in `mac.extendInfo`, or macOS kills the app on access.
- **Others** (the sound the Mac plays): `navigator.mediaDevices.getDisplayMedia({ video: true,
  audio: true })`, answered in main by `setDisplayMediaRequestHandler` with `audio: 'loopback'`.

**What `loopback` is on macOS in Electron 44.** The `Streams.audio` comment in `electron.d.ts` still
says "only supported on Windows"; that comment is out of date. The desktopCapturer docs say:

- **macOS 14.2+**: since Electron 39 Chromium captures loopback with Apple's **Core Audio tap**
  (feature `MacCatapLoopbackAudioForScreenShare`, on by default). Permission: **System Audio
  Recording Only** (Privacy & Security → Screen & System Audio Recording, the lower list), for the
  responsible process. It needs `NSAudioCaptureUsageDescription` in Info.plist. Without the key, or
  without the grant, the audio track is silent or `ended`, **with no error**.
  No feature switch is needed. `app.commandLine.appendSwitch('disable-features',
  'MacCatapLoopbackAudioForScreenShare')` falls back to the older ScreenCaptureKit path (full
  Screen Recording permission). That works up to Electron 44 only: Chromium M155 / Electron 45
  removed the feature, and the switch then does nothing. Do not use it.
- **macOS 13 to 14.1**: ScreenCaptureKit carries the system audio. Permission: **Screen & System
  Audio Recording** (the full one).
- **macOS 12 and older**: no system audio. Meetings records only the microphone and says so.

**A video source must be given.** `getDisplayMedia` refuses `video: false`, and the handler must
answer with a video source. Use the capture window's own frame (`video: request.frame`): it is a tab
capture of a blank page and needs no Screen Recording grant on 14.2+. That this pairs with
`loopback` is **not yet checked**. If it does not, use `desktopCapturer.getSources({ types:
['screen'], thumbnailSize: { width: 0, height: 0 } })`, `video: sources[0]`. That one asks for
Screen Recording too. In the window, stop and remove the video track at once and keep the audio.

```ts
// main/meetings/capture.ts — the capture window's own partition, so the main window never gets this.
const ses = session.fromPartition('meetings-capture')
ses.setDisplayMediaRequestHandler(
  (request, callback) => {
    // Only our capture window, only while consent holds; anything else is refused.
    if (!captureWin || request.frame !== captureWin.webContents.mainFrame || !consentOk()) {
      return callback({}) // no streams = denied
    }
    callback({ video: request.frame, audio: 'loopback' })
  },
  { useSystemPicker: false }, // true (macOS 15+) shows Apple's picker and skips this handler
)
ses.setPermissionRequestHandler((wc, permission, cb, details) =>
  cb(wc === captureWin?.webContents && consentOk() && (permission === 'media' || permission === 'display-capture')))
```

```ts
// capture.html's script
const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
for (const t of sys.getVideoTracks()) { t.stop(); sys.removeTrack(t) }
const [others] = sys.getAudioTracks() // missing or readyState 'ended' = no system audio grant
const you = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
```

- `useSystemPicker` stays `false`. It is experimental (macOS 15+), and Apple's picker asks the
  user to pick a screen or window: that is wrong for a meeting.
- `loopbackWithMute` mutes the Mac's speakers while recording. Never use it.
- **No API reads the System Audio Recording grant.** `getMediaAccessStatus('screen')` reports the
  Screen Recording grant only, and `askForMediaAccess` takes `microphone` or `camera` only. So
  setup's **Allow** for "Sound from the Mac" runs a 1-second capture, which brings up the prompt.
  The status is that probe: an audio track that is live and not silent while something plays.
  The spec's `getMediaAccessStatus('screen')` holds only for the 13-14.1 path.
- `npm run dev` / `npx electron .` run under the terminal. macOS asks for, and records the grant
  against, the terminal app (the responsible process), and reads the plist keys from the
  terminal's Info.plist. Test permissions only with the packaged app.

**Ad-hoc signing.** Grants are keyed to the code signature, and an ad-hoc signature changes with
every build. A rebuild or an update may ask again, or show "granted" and capture silence. To start
over (the user does this, never a test or an agent):

```bash
tccutil reset Microphone io.github.amntoppo.masterdeck
tccutil reset AudioCapture io.github.amntoppo.masterdeck    # System Audio Recording Only (14.2+)
tccutil reset ScreenCapture io.github.amntoppo.masterdeck   # Screen & System Audio Recording
```

A Developer ID signature removes this (TODO: signing).

**Fallback, if loopback fails on a real Mac.** A small Swift helper with its own Core Audio
process tap (`CATapDescription` + `AudioHardwareCreateProcessTap`, an aggregate device, macOS
14.2+). It writes 16 kHz mono PCM to a pipe, and the rest of the design stays the same.
Permission: System Audio Recording Only. It needs `NSAudioCaptureUsageDescription` in the app's
Info.plist, and the helper must be signed inside the bundle, so macOS counts MasterDeck as the
responsible process.

**As built** (`main/meetings/recorder.ts`, `renderer/src/capture.ts`): the shape above, with
these choices. The page is started by `executeJavaScript(..., true)` so `getDisplayMedia` has a
user gesture; frames are compared by `processId` / `routingId` (WebFrameMain wrappers may differ
as objects); the window has `autoplayPolicy: 'no-user-gesture-required'`; the AudioContext asks
for 16 kHz (Chromium resamples the streams; `Resampler` covers another rate); the AudioWorklet is
bundled with `?worker&url` (`worker.format: 'es'`, so a module in the build as in dev, where vite
serves it as `?worker_file&type=module` with `import env.mjs`, never `importScripts`) into
`out/renderer/assets/pcmWorklet-*.js` next to `capture-*.js` and loaded from `file://` (not yet run
in a packaged app or in `npm run dev`). `npm run build` builds both renderer pages (`index.html`,
`capture.html`) and both preloads (`index.js`, `capture.js`).

**Checked by the user** (on the packaged app, after Task 5):

- The microphone prompt appears on **Allow microphone**, and the status turns granted.
- On macOS 14.2+, **Allow** for the Mac's sound shows the System Audio Recording prompt (not the
  Screen Recording one), and the next capture has a live, non-silent system track while audio plays.
- `video: request.frame` + `loopback` gives an audio track (else switch to the `getSources` shape).
- After a rebuild and reinstall: whether the grants survive, and what the silent-track message says.
- The speakers keep playing during a recording.
- A real recording: the hidden window opens no window, the worklet loads from `file://`, chunks
  appear in `meetings/<id>/chunks/` every 30 s per track, `audio.webm` grows every 10 s and plays,
  Pause leaves a gap out of both, Stop closes the window within a second or two.

## Meetings: speech engine and models

Meetings are transcribed on the Mac by `whisper-cli` from [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
(issue #102, spec §3). No Python, no network once the model is on disk.

**Building whisper-cli.** `app/scripts/whisper.sh [arm64|x64]` (default: this Mac's) clones the
pinned tag (`WHISPER_TAG`, now `v1.9.4`) into `app/resources/whisper/.src`, stops if the tag is not
the pinned commit (`WHISPER_COMMIT`), builds the `whisper-cli` target with CMake and copies it to
`app/resources/whisper/<arch>/whisper-cli` (about 4 MB arm64, 3 MB x64). The whole folder is
git-ignored. The build is static (`BUILD_SHARED_LIBS=OFF`), portable (`GGML_NATIVE=OFF`), macOS
12+, Accelerate for BLAS, Metal on arm64 with the shaders embedded (`GGML_METAL_EMBED_LIBRARY`),
and CPU only on x64 (cross-built with `CMAKE_OSX_ARCHITECTURES=x86_64`, AVX2/FMA/F16C, so a Mac
from 2013 or later). The script fails if `otool -L` names anything outside `/usr/lib` and
`/System/Library`; it strips the binary and signs it ad hoc again (Apple Silicon runs nothing
unsigned). It needs git, `cmake` (`brew install cmake`) and Xcode's command line tools. To move to
another release, change both pins together.

```bash
cd app && ./scripts/whisper.sh arm64 && ./scripts/whisper.sh x64
otool -L resources/whisper/arm64/whisper-cli   # libSystem, libc++, libobjc, Accelerate, Foundation, Metal, MetalKit, CoreFoundation
```

- CI's macOS job runs it for arm64 and x64 before `dist:mac` (it installs `cmake` with Homebrew
  when the runner has none); the Windows job skips it.
- `electron-builder.yml` `mac.extraResources` ships `resources/whisper/${arch}` as
  `Contents/Resources/whisper/<arch>/whisper-cli`, so each DMG carries only its own. A local
  `--mac dir` build without the script has none: Settings → Meetings says "Speech engine missing".
- Where the app looks (`findWhisper`, `main/meetings/whisper.ts`): `MASTERDECK_WHISPER` (when set
  but not runnable, nothing else is tried), then the app's own (packaged: `Resources/whisper/<arch>/`;
  `npm run dev`: `app/resources/whisper/<arch>/`), then `whisper-cli` on the login shell's PATH
  (Homebrew's `whisper-cpp`).
- It runs as `nice -n 10 whisper-cli -m <model> -f <chunk.wav> -oj -of <tmp>/out -l <lang|auto>
  -t <cores-2> -np` in its own process group (a timeout stops all of it); the JSON's
  `transcription[].offsets` (ms) and `text` are read back, `[BLANK_AUDIO]` dropped.

**Models.** Downloaded on Settings → Meetings from
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>` into
`MASTERDECK_HOME/meetings/models/` (default `~/.claude/masterdeck/meetings/models/`):

| Pick | File | Bytes | Default on |
|---|---|---|---|
| Best | `ggml-large-v3-turbo-q5_0.bin` | 574,041,195 | Apple Silicon |
| Fast | `ggml-base.bin` | 147,951,465 | Intel |

Their sizes and SHA-256 are in `shared/meetingModels.ts`, copied from the repository's LFS listing
(`curl -s https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main`: `lfs.oid`, `lfs.size`;
the same as the `x-linked-etag` / `x-linked-size` headers of a `curl -I` of the file). A download
streams to `<file>.part`, hashed while written, and is renamed only when both match; anything else is
thrown away. It needs the model's size plus 200 MB free. One downloads at a time. To get a model
by hand, put the file there under the same name (it is ready when its size matches). To remove
one: **Remove** on the screen, or delete the file while MasterDeck is closed.

## Meetings: md-mute

`md-mute` reads the meeting app's own Mute / Unmute control through Accessibility, so a recording
can leave the microphone out while you are muted (Plan M; ARCHITECTURE § Meetings: the mute
reader).

**Building it.** `app/scripts/mute.sh [arm64|x64]` (default: this Mac's) compiles
`app/native/mute/main.swift` with `xcrun swiftc -O -swift-version 5 -target <arch>-apple-macos12.0`
into `app/resources/mute/<arch>/md-mute` (about 140 KB arm64, 115 KB x64; git-ignored). It needs
Xcode's command line tools only. Like whisper.sh it fails if `otool -L` names anything outside
`/usr/lib` and `/System/Library` (the Swift runtime is in `/usr/lib/swift` on macOS 12+), strips the
binary and signs it ad hoc (identifier `io.github.amntoppo.masterdeck.md-mute`).

```bash
cd app && ./scripts/mute.sh arm64 && ./scripts/mute.sh x64
otool -L resources/mute/arm64/md-mute   # libSystem, libc++, libobjc, /usr/lib/swift/*, AppKit, ApplicationServices, CoreFoundation, Foundation
```

- CI's macOS job runs it for arm64 and x64 after whisper.sh, before `dist:mac`.
- `electron-builder.yml` `mac.extraResources` ships `resources/mute/${arch}` as
  `Contents/Resources/mute/<arch>/md-mute`. Missing (a local build without the script): the
  recording keeps the microphone.
- Where the app looks (`findMute`, `main/meetings/muteHelper.ts`): `MASTERDECK_MUTE` (set but not
  runnable: nothing else), then the app's own (packaged `Resources/mute/<arch>/`; `npm run dev`
  `app/resources/mute/<arch>/`). There is no PATH lookup.
- An x64 build cannot be run on an Apple Silicon Mac without Rosetta ("Bad CPU type").

**Checking a rule by hand.** Rules are data in `shared/meetingMute.ts`, so a wrong label is a TS
change. To see what the helper reads for a rule, run it from a terminal with one line of rules
(Ctrl-C or closing stdin ends it):

```bash
cd app
{ echo '{"apps":[{"id":"zoom","bundles":["us.zoom.xos"],"menu":{"title":"Meeting","muted":["Unmute audio"],"unmuted":["Mute audio"]}}]}'; sleep 10; } \
  | resources/mute/arm64/md-mute
# {"t":…,"trusted":true,"apps":[{"id":"zoom","state":"muted"}]}   every 400 ms
```

`trusted` is the Accessibility grant of the process that started it (from a terminal: the
terminal's, System Settings → Privacy & Security → Accessibility); `false` means every app reads
`unknown`. The helper never asks for the grant. An app is listed only while it runs; `unknown` while
trusted means no control matched (not in a call, a label the rule does not know, a browser's Meet
in a background tab, or a search past its caps). To find the real label, open the app in a call and
look at the mute button with Accessibility Inspector (Xcode → Open Developer Tool), then put its
title, description or help text (the start of it) in the rule (ASCII only), and anything else
whose label starts the same way but is not your own mute ("Mute all") in its `exclude`. Bad rules
exit 2 with a message.

- A control found is re-read each tick; a full search runs again only when it stops reading, at
  most every 2 s per process, so for up to 2 s after a window is rebuilt the state is `unknown`.
- For Google Meet the helper sets `AXManualAccessibility` on each running Chromium browser (Chrome,
  Arc, Edge, Brave) when the Meet rule is in the rules it was sent (no call app offered: all rules).
  It stays on until that browser quits; the browser may be a little slower while it builds its
  accessibility tree. With Zoom or Webex offered only their rule is sent and no browser is touched.

## Meetings: the fixture

The Meetings page can be checked in the isolated app without recording anything:
`MASTERDECK_MEETINGS_FIXTURE=$PWD/test/fixtures/meetings` (from `app/`, with `MASTERDECK_ISOLATED=1` and `MASTERDECK_HOME` set)
copies `test/fixtures/meetings/meeting.json` (a fictional "Acme web standup", 9 October 2026, six
lines, one match), `audio.webm` (7.5 s of tones, one per line, about 28 KB) and the note it added
(`notes/`) into `MASTERDECK_HOME` at start; a file already there is left as it is (so a renamed or
deleted one stays that way until the next fresh `MASTERDECK_HOME`).

- `audio.webm` is made by `npx electron scripts/meeting-fixture.cjs` (from `app/`): with ffmpeg on
  the PATH by ffmpeg, else by Electron's own MediaRecorder from an oscillator (no microphone), which
  writes WebM as the real recorder does: no duration and no cues at first. Seeking still works.
- `deck.meetingsConsent(true)` in the isolated app stores the consent and asks macOS nothing (the
  isolated settings file). Never press Record or any Allow there.
- Native questions (Delete audio, Delete meeting) and save dialogs (Export): launch with
  `--inspect=127.0.0.1:9334` and replace `require('electron').dialog.showMessageBox` /
  `showSaveDialog` in main for the run.
- The Range answers: CDP `Network.enable` on the page shows the player's `masterdeck-media://`
  requests (`Range: bytes=0-` → 206 with `Content-Range`); another path or an unknown id is 404.
- Checked this way (2026-10-10): the list, the calendar's mark, Today / This week / Last 30 days / a
  day / Custom, play, seek, the playing line, click a line, 1.5x, ±15 s, search with ↑/↓, rename,
  Export transcript and audio, Delete audio, Delete meeting (the note stayed), a note's **Open in
  Meetings** link (Meetings at 0:02, the Notes panel closed), Needs you's Open, ⌘K Go to Meetings,
  the empty page with **Set up meetings** after Turn off.

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

# In-app updates (MasterDeck-Terminal#122): design

Approved by the user on 2026-10-16 ("I approve your spec, plan"). Decision recorded on the issue:
**macOS uses a custom updater (option B, no Apple Developer ID; the app stays ad-hoc signed)**;
Windows uses `electron-updater` (NSIS) against this backend's feed.

## 1. Release identity and signing (shared by all three parts)

- A release file is one `(version, platform, arch)`: `platform` is `darwin` or `win32`, `arch` is
  `arm64` or `x64`. The update file is the mac `.zip` (`MasterDeck-<v>-arm64-mac.zip`,
  `MasterDeck-<v>-mac.zip` for x64) or the Windows NSIS `.exe` (published as
  `MasterDeck-Setup-<v>.exe`, with `MasterDeck-Setup-<v>.exe.blockmap` beside it).
- `sha512` is the **base64** SHA-512 of the file (electron-updater's format).
- The release key is Ed25519. The private key (PKCS8 PEM) lives only in CI secrets
  (`RELEASE_SIGNING_KEY`) and on the owner's Mac (`~/.config/masterdeck-remote/release-signing-key.pem`).
  The public key (raw 32 bytes, base64) is built into the app (`app/src/shared/releaseKey.ts`) and
  set on the backend as the var `RELEASE_PUBLIC_KEY`:
  `Xusi41mvk5IX9UIjHgEIY3VM/J5FPwYzRSn3j6KDkXA=`.
- The signed message is UTF-8, lines joined by `\n`, no trailing newline:

  ```
  masterdeck-update
  v1
  <version>
  <platform>
  <arch>
  <file name>
  <sha512 base64>
  ```

  Binding version, platform, arch and name stops an old or other-platform signed file from being
  replayed as a newer release. `signature` is the base64 Ed25519 signature of that message.
- **Shared test vector** (every implementation tests against it):
  - public key (raw, base64): `AuokUivpXuPlZM7cfzzXh6veO1KFujjDji8HPyCHkUY=`
  - private key (PKCS8 PEM, test only): `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKrF71ca23w7Tr/HDObzqS2xGy5YQeoZ8HxSRt3CpmQT\n-----END PRIVATE KEY-----\n`
  - fields: version `0.10.0`, platform `darwin`, arch `arm64`, name `MasterDeck-0.10.0-arm64-mac.zip`, sha512 `q83vEjRWeJA=`
  - signature: `H+NhmqxgXOseVXHDtkZnlAEIlAlUaWfjxy2J3Bve9zXTqk75fx0ra0h+JaIpjEKLy6LCuH3E5TPiHktYi7lHAQ==`
- Versions compare as semver with prereleases (`0.10.0-beta.1 < 0.10.0`). A tag with a `-` is the
  `beta` channel, else `stable`.

## 2. Backend (masterdeck-backend)

### Storage
- R2 bucket `masterdeck-releases`, binding `RELEASES`. Object key `<version>/<file name>`
  (`^[0-9A-Za-z._-]+/[0-9A-Za-z._-]+$`). Files are served **through the Worker** (no custom
  domain needed yet): `GET|HEAD /v1/updates/files/<version>/<name>`, with single-range `Range`
  support (electron-updater's differential download), `etag`, long immutable cache.
  ponytail: a public R2 custom domain (`releases.masterdeck.dev`) would take the bytes off the
  Worker; only the `url` column changes.
- D1 migration `0006_releases.sql`, table `releases`, primary key `(version, platform, arch)`:
  `version, channel ('stable'|'beta'), platform, arch, name, r2_key, url, sha512, size, signature,
  notes_md, published_at (ms), min_supported_version (nullable), rollout_percent (0-100, default
  100), yanked (0/1, default 0)`; index on `(platform, arch, yanked)`.

### Public routes (no auth; registered before the `/v1/*` auth middleware)
- `GET /v1/updates/check?version=&platform=&arch=&channel=&id=` (rate-limited per
  `cf-connecting-ip`, 120 an hour, via `ratelimit.hit`; `429` over it; `400` on bad params).
  Candidates: same platform and arch, not yanked, channel `stable` (or `stable` + `beta` when
  `channel=beta`), version greater than `version`. **Mandatory**: the current version is below the
  highest `min_supported_version` among non-yanked candidates' rows for that platform/arch and
  channel set. Rollout: `bucket(id) = first 4 bytes of SHA-256(id) as uint32 % 100`; a candidate
  is offered when `bucket < rollout_percent`; with no `id` only 100 % rows; a mandatory answer
  ignores rollout. Answer `204` when nothing is offered, else `200`:
  `{ version, channel, notes, name, url, sha512, size, signature, publishedAt, mandatory }`
  (the highest offered version).
- `GET /v1/updates/feed/:channel/:id/latest.yml` (win32 x64) and `.../latest-mac.yml` (darwin, the
  arm64 and x64 zips): electron-updater's generic-provider file for the release the check would
  offer this id (`version`, `files[{url, sha512, size}]`, `path`, `sha512`, `releaseDate`),
  `404` when none. `GET /v1/updates/:channel/latest.yml` / `latest-mac.yml`: the same for the
  newest non-yanked release, with `stagingPercentage` when its rollout is below 100 (for standard
  clients). `content-type: text/yaml`.

### Admin routes (`authorization: Bearer <RELEASE_ADMIN_TOKEN>`, constant-time compare; `503`
when the secret is unset; also registered before the auth middleware)
- Uploads (R2 multipart; the Worker's request limit is 100 MB and the builds are 120-140 MB):
  `POST /v1/admin/uploads {key}` → `{uploadId}`; `PUT /v1/admin/uploads/:uploadId/parts/:n?key=`
  (body = bytes, ≤ 95 MB) → `{partNumber, etag}`; `POST /v1/admin/uploads/:uploadId/complete
  {key, parts}` → `{key, size}`; `DELETE /v1/admin/uploads/:uploadId?key=` aborts.
- `POST /v1/admin/releases {version, channel, notes, minSupportedVersion?, rolloutPercent?,
  publishedAt?, files: [{platform, arch, name, key, sha512, size, signature}]}`: each object must
  exist in R2 with that size, each signature must verify against `RELEASE_PUBLIC_KEY` (WebCrypto
  Ed25519), `url` = `PUBLIC_URL + /v1/updates/files/ + key`. Re-publishing an identical row is
  idempotent; a different sha512 for an existing row is `409`. Blockmaps are uploaded but not rows.
- `PATCH /v1/admin/releases/:version {rolloutPercent?, yanked?, notes?, minSupportedVersion?}`
  (all rows of that version): staged rollout and the kill switch (`yanked: true` hides it at once).
- `GET /v1/admin/releases` lists rows.
- ponytail: no adoption stats yet (checks per version); a counter table is the upgrade path.

## 3. Release pipeline (MasterDeck-Terminal CI)

- `app/electron-builder.yml`: mac targets `dmg` **and** `zip` (arm64, x64); `publish` set to the
  generic provider (`https://dev.masterdeck.dev/v1/updates/stable`) so `app-update.yml`,
  `latest.yml` and the NSIS `.blockmap` are produced; `--publish never` still stops uploads.
- `.github/workflows/release.yml` on tags `v*`: build mac and win (the same steps as `ci.yml`),
  then a publish job: `node app/scripts/release-publish.mjs` computes sha512 and size, signs with
  `RELEASE_SIGNING_KEY`, uploads to R2 through the admin upload routes (`MD_RELEASE_API`, default
  `https://dev.masterdeck.dev`, `RELEASE_ADMIN_TOKEN`), registers the release, and attaches the
  DMGs and EXE to the GitHub release with `.github/release-notes.md`. Release notes for the update:
  `.github/releases/v<version>.md` when present, else the tag's message, else "MasterDeck <v>".
  `--dry-run` signs and prints the manifest without network calls. `ci.yml` no longer attaches on
  tags.
- `install.sh` and the DMG on GitHub Releases keep working for new installs.

## 4. Desktop client (MasterDeck-Terminal/app)

### Model (`src/shared/updates.ts`)
`UpdateState { current, platform, arch, enabled, disabledReason?, phase: 'idle' | 'checking' |
'up-to-date' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error',
offer?, progress? (0-1), lastChecked?, error?, errorKind? ('offline' | 'check' | 'download' |
'verify' | 'install' | 'permission'), mandatory, remindAt?, rolledBack? {version, reason, at},
updatedFrom? {from, at}, needsAdmin? }`, plus pure helpers: `compareVersions`, `signedMessage`,
`statusLine`, `shouldPrompt(state, now)`, `badge(state)`.

### Main (`src/main/updater.ts` + `updateMac.ts` + `updateWin.ts`)
- Enabled only when packaged (`app.isPackaged`), not with `MASTERDECK_UPDATES=0`, and on mac not
  from a read-only place (`/Volumes/…`, App Translocation): Settings says why.
- Checks: 30 s after launch, every 6 h, and **Check for updates**. Base URL `MASTERDECK_UPDATE_URL`
  else the remote URL rules (`https://dev.masterdeck.dev`). Install id: random UUID in
  `<userData>/updates/install-id`. Test overrides (`MASTERDECK_UPDATE_PUBKEY`) are honoured only
  with `MASTERDECK_ISOLATED=1`.
- With **Automatically download updates** on (default), an offer downloads at once; else
  **Download** in Settings.
- **macOS**: download the zip to `<userData>/updates/<version>/`, streaming the SHA-512; verify
  sha512 **and** the signature (`crypto.verify` with the built-in key); a failure deletes the file
  and reports `verify`. Unpack with `ditto -x -k` into `<userData>/updates/<version>/stage/`, check
  `MasterDeck.app/Contents/Info.plist`'s version equals the offer, clear quarantine → `ready`.
  **Restart now** writes `pending.json` and a helper script (`src/shared/updateHelper.ts`
  generates it: bash 3.2) to `<userData>/updates/`, spawns it detached, and quits normally. The
  helper: waits for the old pid to exit (≤ 120 s), moves the staged app next to the current one,
  swaps by two renames (`MasterDeck.app` → `.MasterDeck.app.previous`, staged → `MasterDeck.app`),
  clears quarantine, opens the app and waits ≤ 60 s for `<userData>/updates/healthy-<version>`;
  a second launch on failure; still nothing → kill it, put the previous app back, write
  `result.json {ok:false, version, reason}` and open the previous app. On success it deletes the
  backup and writes `result.json {ok:true, from, version}`. When the folder is not writable the
  helper runs the moves through `osascript … with administrator privileges` (macOS asks for the
  password); a cancel is `reason: "permission"`. The new app writes `healthy-<version>` 10 s after
  its window loaded. At launch the updater reads `result.json` (rolled back → `rolledBack`, that
  version is skipped until a newer one; ok → `updatedFrom`).
- **The next normal quit installs** a ready update on mac (helper without relaunch) unless the
  folder needs a password. ponytail: no health check on that path (the helper is not there at the
  next launch); upgrade path: the next launch's own health marker.
- **Windows**: `electron-updater`'s `NsisUpdater`, loaded only on win32; `autoDownload` and
  `autoInstallOnAppQuit` off; the feed is `/v1/updates/feed/<channel>/<id>/` so the server's
  rollout decides; the downloaded file's version must equal the offer and its sha512 and signature
  must verify before `ready` (then `autoInstallOnAppQuit` on); **Restart now** is
  `quitAndInstall(true, true)`. ponytail: no automatic rollback on Windows (NSIS replaces the
  install); upgrade path: keep the previous installer and rerun it on a failed health check.
- IPC (`DECK_ACCESS`: blocked on the web: a browser never updates the Mac): `update:state`,
  `update:check`, `update:download`, `update:restart`, `update:later`, event `update:changed`.
  Settings fields: `autoDownloadUpdates` (true), `updateChannel` ('stable').
- The app menu (mac) gets **Check for Updates…** (or **Restart to Update…** when ready), keeping
  the default roles.

### UI
- Settings → **Updates**: version, last checked, **Check for updates**, status (`Up to date`,
  `Update available: v0.10.0`, `Downloading 42%`, `Ready to install`), release notes
  (`MarkdownView html={false}`), **Automatically download updates**, **Beta channel**, errors
  with **Try again** (never a blocking popup), a rolled-back note, "Updated from 0.9.0".
- A dot on the rail's Settings icon while an update is available/ready (and **Required update**
  banner when `mandatory`).
- When ready: a prompt "MasterDeck 0.10.0 is ready. Restart now to update." with **Restart now** /
  **Remind me later** (4 h, kept in memory, so the next launch asks again).
- Restart keeps work: Claude sessions run under Claude Code's daemon; the session list and tabs
  (localStorage per `Session.key`) come back with the window.

## 5. Testing
- Backend: vitest-pool-workers tests for the check (versions, channels, rollout, yank, mandatory,
  rate limit), feeds, files with Range, admin auth, uploads, publish signature checks, patch.
- App: unit tests for `shared/updates.ts` (vector), the helper script against fake `.app` folders
  in a temp dir (swap, health, rollback, permission refused stand-in), the updater with a fake
  server and fake installer, the publish script's manifest and signing (`--dry-run`).
- End to end (local only, nothing deployed): backend `wrangler dev` with local D1/R2, a packaged
  v N in a temp folder, publish v N+1 with the script and the test key, the app updates itself in
  place and comes back healthy; and a broken N+1 rolls back.

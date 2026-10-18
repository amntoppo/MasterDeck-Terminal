# CI/CD for a fast cycle (#178): design

Every merge to `main` already reaches users as an in-app update (#166: `ota-main.yml` →
`release.yml` → `ota-release.yml`). What is slow is the PR side: `ci.yml` builds whisper-cli,
md-mute and the full mac and win installers on every push to every PR, on macOS and Windows
runners, and nothing requires it to pass before a merge. This design makes PR CI checks only,
keeps one required check, tightens the release, and deploys the web app on merge.

## Decisions

| Question | Decision | Why |
|---|---|---|
| What PR CI runs | `ci.yml` on `pull_request` (and `merge_group`, Run workflow): **Python** (pytest), **App** (typecheck + vitest) and **actionlint** (only when `.github/**` changed), all on `ubuntu-latest`, in parallel. No installer, whisper or md-mute build, no artifacts | The builds are the slow, expensive part and run again at release |
| What "docs only" is | `app/scripts/ci-changes.mjs` (tested) decides from the PR's changed files: `code` unless every file is `**/*.md`, `docs/**`, `.claude/**`, `LICENSE`, `.gitignore` or under `.github/` (other than `ci.yml` itself and `.github/actions/**`). Not the `ota-main.yml` list: that one ignores tests, which a PR must run | A docs-only PR runs nothing heavy and still reports the required check |
| The required check | One job named **CI** that `needs` every other job and fails when any failed or was cancelled (skipped is fine). Only it is required | One stable name, whatever runs; a docs PR gets a green CI in seconds |
| Cancelling | `concurrency: ci-<PR number>` with `cancel-in-progress` | A new push cancels the old run |
| Caches | npm (`setup-node`), the Electron download skipped (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`: vitest runs in Node), pip (`setup-python`, `.github/requirements-ci.txt` pins pytest) | Target under 5 minutes |
| Packaging check | A separate, not required workflow `package.yml` on PRs: the mac and win builds (unpublished, artifacts kept 7 days) only when packaging files changed (`app/electron-builder.yml`, `app/build/**`, `app/native/**`, `app/scripts/whisper.sh` / `mute.sh`, the shared build files, or `app/package.json`'s dependencies / `build` / `postinstall`) or the PR has the **build** label. Run workflow builds any branch | The label event cannot be filtered at the trigger; in its own workflow a non-`build` label never touches the required check |
| One build | `.github/workflows/build.yml` (reusable: ref, retention) builds mac and win in parallel; `release.yml` and `package.yml` call it. Two composite actions: `setup-app` (Node, npm cache, `npm ci`) and `native-helpers` (whisper-cli and md-mute, cached) | No third copy of the build steps |
| whisper-cli and md-mute | `actions/cache` keyed by the hash of their sources (`whisper.sh`, which pins whisper.cpp's commit; `mute.sh` + `native/mute/**`) and the runner. Built only on a miss. A cache saved by a release on `main` is restored by later releases and PRs | Built once, not on every release |
| Release tests | `release.yml`'s **test** job (ubuntu: pytest, typecheck, vitest) on the tag's commit, before the builds | The merge commit can differ from the PR head; a failure stops before any mac/win minute |
| After publishing | `ota-release.yml` runs `app/scripts/release-smoke.mjs`: for each platform the check (`/v1/updates/check`) offers the new version to an install inside the rollout, the per-install feed names it, the file downloads with the offered size and sha512, and its signature verifies against the app's key. Rollout 0: nothing is checked (the version is offered to nobody, so nothing is live to check; a notice says so). A newer version offered instead, or the version not offered when no rollout was passed, is a notice, not a failure | Same checks the app makes before installing |
| Release link, tickets | `ota-main.yml`'s **announce** job (after a published release): a comment on every PR the release's notes list (and the merge commit's PR) with the release and channel, then each PR's closing issues moved to **Done** on the board when `BOARD_TOKEN` (a PAT with `project` scope) and the variable `BOARD_PROJECT` (`owner/number`) are set; skipped with a notice otherwise | `GITHUB_TOKEN` cannot write a user's Projects |
| Failure reporting | As before: a commit status on the merge commit and a PR comment. New: a commit status **Web deploy**, and a comment on failure | A MasterDeck Needs you notification from CI needs a backend route that does not exist (TODO) |
| Web app | `web-deploy.yml` on pushes to `main` that change the web build's inputs (`app/src/web/**`, `app/src/renderer/**`, `app/src/shared/**`, `app/web/**`, `app/vite.web.config.ts`, `app/package*.json`, not tests or docs) and Run workflow: `build:web` and `wrangler deploy`, then a check that app.masterdeck.dev serves the built `index.html`. Skipped with a notice until the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist | No manual deploy; nothing red while the token is missing |
| Backend | Not changed here: its deploy on merge waits on #4's token fix (an owner action in Cloudflare). Linked | Another (private) repository; the token is the blocker |
| Protocol drift (#5) | The **App** job checks out `masterdeck-backend` (`master`) when the secret `BACKEND_DEPLOY_KEY` (a read-only deploy key) exists and runs the drift test against it; without it (forks, until it is set) the test skips with a notice. The test now **fails** when `MASTERDECK_BACKEND` is set and the file is missing | A broken checkout can no longer pass silently. The backend side of #5 stays open |
| Protect `main` | Branch protection: PRs required, the **CI** check required, branches up to date, auto-merge allowed. Set by the owner with one `gh api` call (OPERATIONS); `ci.yml` also runs on `merge_group`, so a merge queue can replace "up to date" later | A settings change on the repository, made by its owner after this merges |
| Pause, yank | Unchanged: `OTA_MAIN=off`; `PATCH /v1/admin/releases/<v>` `{"yanked":true}`. Documented as the first lines of OPERATIONS § Release | |

## Flow

```
PR ─► CI: changes → Python ∥ App (+drift) ∥ actionlint → CI (required)
   └► Package (only packaging files or the build label): build.yml mac ∥ win, artifacts
merge ─► push to main
   ├► Auto release: prepare → release.yml (test → build.yml mac ∥ win → attach → ota-release.yml: publish → smoke)
   │                → announce (PR comments, tickets → Done) → report (status; PR comment on failure)
   └► Web deploy (web files changed): build:web → wrangler deploy → smoke → status
```

## Not done

- Branch protection itself (the owner's one command, after the merge).
- The backend's deploy on merge (#4) and its side of the drift check (#5).
- A Needs you item for a failed release (needs a backend route the CI can call).
- A release dispatched by hand for a tag made before this change fails at the setup step (the tag
  has no `.github/actions/`); those tags are released already.

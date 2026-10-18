# Publish an OTA update on every merge to main (#166): design

Today an in-app update ships only when someone pushes a `v*` tag: `release.yml` builds and attaches
the installers and calls `ota-release.yml`, which signs and publishes the update. This design makes
every merge to `main` that changes the app reach users the same way, with no manual step, and keeps
the manual tag as it is.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Trigger | A new workflow `ota-main.yml` on `workflow_run` of **CI** (`completed`, branch `main`, event `push`, conclusion `success`) | "Once ci.yml's tests pass" exactly; a red CI never releases. `workflow_run` has no `paths-ignore`, so the path rule is applied by the workflow itself (below) |
| What is skipped | Releases only when a file changed **since the last release** that is not docs or tooling: `**/*.md`, `docs/**`, `.github/**`, `**/*.test.ts(x)`, `skills/master/tests/**`, `app/web/**` (the web app's Worker), `install.sh`, `LICENSE`, `.gitignore`, images under `docs/` | Measuring against the last release, not the push's own diff, means a docs merge after a failed app merge still ships that app change |
| Ordering | One `concurrency` group `ota-main`, never cancelled in progress. GitHub keeps one pending run and cancels older pending ones: the run that is left releases the newest commit, which holds every merge before it. A run whose commit is already in a release (CI finished out of order) ends with a notice | Merges in a row release in order, never two at once, never a tag clash |
| Version | `app/scripts/auto-release.mjs next`: the highest stable `vX.Y.Z` tag plus one patch; `app/package.json`'s version (without a `-suffix`) when it is higher (a manual minor/major bump). On the beta channel: that version with `-beta.N`, N one above the highest existing `-beta.N` of it | No manual bump for patches; the backend ties a channel to the version (`-` is beta, it refuses anything else), so beta needs a beta version |
| Where the version lives | A **release commit** on top of the merge commit, held only by the tag: `app/package.json` + `package-lock.json` set to the version and the update's notes at `.github/releases/vX.Y.Z.md`. The tag `vX.Y.Z` points at it; `main` never gets it | No bot commit on `main` (no loop, no protected-branch push). The tag stays self-describing: `release.yml`'s and `ota-release.yml`'s version checks and every re-run path (Re-run, Run workflow with the tag) work unchanged, and the notes are the same file whichever path publishes, so a re-publish is identical (the backend refuses a re-publish with other notes) |
| Release notes | One line per merged PR since the last release (first-parent commits; title, `#number` link, the tickets it closes; a direct push lists its subject). In-app: just that list. GitHub release: that list on top of `.github/release-notes.md` (`release.yml` now prepends `.github/releases/vX.Y.Z.md` when the tag has it, for manual releases too). A notes file already on `main` for the computed version is used as written | |
| Build and publish | `release.yml` gets `workflow_call` (`tag`, `rollout`, the two secrets) and `ota-main.yml` calls it; it calls `ota-release.yml` as before, which gets a `rollout` input on `workflow_call` | No second copy of the build steps; a `GITHUB_TOKEN` tag push triggers nothing, so the call is the trigger |
| Channel and rollout | Repository variables: `OTA_MAIN_CHANNEL` (`stable` default, or `beta`), `OTA_MAIN_ROLLOUT` (0-100, default 100), `OTA_MAIN` (`off` pauses automatic releases). **Run workflow** on `ota-main.yml` releases the current `main` with a channel and rollout picked by hand. `min_supported` is never set | |
| Safety | `release.yml` publishes nothing unless both builds (each runs the Python tests, typecheck and vitest) pass (`fail-fast`, `needs`). A failure before the tag leaves nothing behind; a failure after it leaves a tag a re-run reuses: the run looks for a tag on a release commit of the same merge commit and releases that again (idempotent like `ota-release.yml`) | |
| Reporting | A commit status `Auto release` on the merge commit: pending at the start, success with the version, failure with a link to the run. On failure a comment on the merged PR(s) | `workflow_run` runs show on no commit by themselves |
| Yank | `PATCH /v1/admin/releases/<version>` `{"yanked": true}` (backend OPERATIONS), then fix forward with a merge (the next patch). Pause with `OTA_MAIN=off` meanwhile. The GitHub release can be marked prerelease or deleted; the tag stays (a version number is never reused) | |
| Prerequisite | Backend PR #12 (the update service) was merged to `master` on 2026-10-15 and deployed by its CI; `GET /v1/updates/check` answers 204 | Nothing left to do |

## Flow

```
push to main ─► CI (tests + unpublished builds) ─ success ─► ota-main.yml
  plan:    off? / already released? / app files changed since the last tag? → version
  tag:     release commit (package.json, lock, .github/releases/vX.Y.Z.md) → tag vX.Y.Z → push tag
  release: release.yml (workflow_call) → build mac+win (tests again) → GitHub release → ota-release.yml
  report:  commit status on the merge commit; PR comment on failure
```

## Not done

- CI on `main` still builds unpublished installers, so an app merge builds twice (CI's builds carry
  the old version and cannot be reused). Upgrade path: skip CI's build job on `main` pushes once
  this has run reliably for a while.
- The acceptance check "a running MasterDeck sees Update available" can only be made after the
  first merge with this workflow on `main`.

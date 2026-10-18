# CI/CD for a fast cycle (#178): plan

Spec: [../specs/2026-10-18-ci-cd-fast-cycle-design.md](../specs/2026-10-18-ci-cd-fast-cycle-design.md).
Each task ends with `actionlint` clean and the touched scripts' vitest files passing.

1. **`app/scripts/ci-changes.mjs`** (+ `ci-changes.test.ts`): `classify(files, {pkgBefore,
   pkgAfter, labels})` → `{code, workflows, package}`; CLI `ci-changes.mjs --base <sha> --head <sha>
   [--labels a,b]` reads `git diff --name-only` and both `app/package.json`s, prints
   `key=value` lines for `$GITHUB_OUTPUT`.
2. **Composite actions** `.github/actions/setup-app` (setup-node with the npm cache, `npm ci`
   without the Electron download unless asked) and `.github/actions/native-helpers` (cache, then
   `whisper.sh` / `mute.sh` for both arches on a miss).
3. **`ci.yml`**: `changes` → `python`, `app` (typecheck, vitest, the drift test when
   `BACKEND_DEPLOY_KEY` is set), `actionlint` → `ci` (name **CI**, the required check).
   `concurrency` per PR. `.github/requirements-ci.txt`.
4. **`remote.drift.test.ts`**: fail when `MASTERDECK_BACKEND` is set and the file is missing.
5. **`build.yml`** (reusable) and **`package.yml`** (PR packaging check: `changes` with the labels,
   then `build.yml`).
6. **`release.yml`**: `test` (ubuntu) → `build` (`build.yml`) → `release` → `ota`.
7. **`app/scripts/release-smoke.mjs`** (+ test): check, feed, download, sha512, size, signature;
   `ota-release.yml` runs it after the publish.
8. **`ota-main.yml`**: `announce` (PR comments with the release link; closing issues → Done
   with `BOARD_TOKEN` / `BOARD_PROJECT`), `report` after it.
9. **`web-deploy.yml`**: path filter, secrets gate, `build:web`, `wrangler deploy`, smoke, status
   and a PR comment on failure.
10. **Docs**: OPERATIONS § Release (flow, pause/yank first, secrets and variables, branch
    protection command), § Web app deploy, Troubleshooting; CLAUDE.md (Commands' CI line,
    Protocol copy rule, Current state); TODO (Recently done, open items); README if it names CI.
11. **Check**: actionlint, the full vitest, typecheck; push the branch, open the PR, read the CI
    run's timing (target under 5 minutes) and fix what Linux breaks.

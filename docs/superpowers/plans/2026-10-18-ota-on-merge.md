# Publish an OTA update on every merge to main (#166): plan

Spec: [2026-10-18-ota-on-merge-design.md](../specs/2026-10-18-ota-on-merge-design.md).

## Tasks

1. **Prerequisite: backend PR #12.** Check it is merged and deployed. Done: merged 2026-10-15
   (f91c17f), CI deploy green, `GET /v1/updates/check` answers 204.
2. **`app/scripts/auto-release.mjs` + `auto-release.test.ts`.** Pure functions `parseVersion`,
   `compareVersions` (semver, prereleases), `releaseTags`, `nextVersion` (patch + 1, package.json's
   higher core, `-beta.N`), `isAppFile` / `appChanged`, `releaseNotes`; CLI `next`, `latest`,
   `changed`, `notes` reading stdin or a file. Tests for each rule and the CLI.
3. **`release.yml` callable.** `workflow_call` with `tag`, `rollout`, the two secrets; the release
   text prepends `.github/releases/<tag>.md` when the tag has it; `rollout` passed to the `ota` call.
4. **`ota-release.yml`.** `rollout` input on `workflow_call` (the step already reads `inputs.rollout`).
5. **`ota-main.yml`.** `workflow_run` of CI on `main` (+ Run workflow with channel and rollout);
   concurrency `ota-main` for releasing runs only; `prepare` (status pending, plan, release commit,
   tag push), `release` (calls `release.yml`), `report` (status, PR comment on failure).
6. **Check.** vitest for the script, actionlint for every workflow, and the prepare job's two shell
   steps extracted from the YAML and run against a throwaway clone (pushes to a throwaway bare
   repository, stand-in `gh` and `curl`): first release, re-run unpublished and published, docs
   only, the next patch with notes from the app commits only, an older commit, beta, off, a bad
   rollout.
7. **Docs.** OPERATIONS § Release (automatic release, variables, failed runs, yank), the CI line and
   current state in CLAUDE.md, GUIDE (Settings → Updates), `.github/releases/README.md`, TODO (open
   points, Recently done).
8. **PR.** Self-review of the diff, then a PR that closes #166.

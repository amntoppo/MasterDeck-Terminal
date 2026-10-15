# In-app updates (#122): implementation plan

Design: [2026-10-16-in-app-updates-design.md](2026-10-16-in-app-updates-design.md) (approved
2026-10-16). Branches: MasterDeck `worktree-MasterDeck-Terminal-122-in-app-updates`, backend
`122-update-service` (the backend's copy of design and plan is in its `docs/superpowers/`).
Nothing is deployed, released, tagged or given secrets by this work.

Each task: write the failing test first, watch it fail, write the code, watch it pass, commit.

## Backend (masterdeck-backend)

1. **Releases table.** `migrations/0006_releases.sql`. Test: `test/updates.test.ts` inserts and
   reads a row. Verify: `npm test -- updates`.
2. **Release logic.** `src/releases.ts`: `compareVersions`, `bucket(id)`, `signedMessage`,
   `verifySignature` (WebCrypto Ed25519), candidate selection, YAML writer. Tests: the shared
   vector verifies, a tampered one fails; prerelease ordering; bucket of a known id.
   Verify: `npm test -- releases`.
3. **Public routes.** `src/updates.ts` + registration in `src/worker.ts` before the auth
   middleware: `/v1/updates/check`, feeds, files (Range). Tests: 204/200, channels, yank,
   rollout, mandatory, 400, 429, feeds, Range/416, `/v1/snapshot` still 401.
   Verify: `npm test`.
4. **Admin routes.** Multipart uploads, publish (object exists, size, signature, 409), PATCH,
   list; constant-time token, 503 unset. Tests for each rule. Verify: `npm test && npm run typecheck`.
5. **Docs.** ARCHITECTURE, OPERATIONS (bucket, secret, migration, yank/rollout), TODO.

## Desktop (MasterDeck-Terminal/app)

6. **Shared model.** `src/shared/updates.ts`, `src/shared/releaseKey.ts`. Tests:
   `updates.test.ts` (vector, versions, `statusLine`, `shouldPrompt`, `badge`).
   Verify: `npx vitest run src/shared/updates.test.ts`.
7. **mac helper script.** `src/shared/updateHelper.ts`. Tests against fake `.app` folders in a
   temp dir: swap + healthy, unhealthy twice → rollback, pid never exits → untouched,
   osascript refused → `permission`. Verify: `npx vitest run src/shared/updateHelper.test.ts`.
8. **Updater.** `src/main/updater.ts`, `updateMac.ts`, `updateWin.ts`. Tests with a fake
   server/fs: 204, offer, bad signature → `verify` and file deleted, offline, auto-download
   off, remind later, rolled-back result at launch. Verify: `npx vitest run src/main/update*`.
9. **Wiring.** IPC (`update:*` in `CH`/`DeckApi`, preload, `DECK_ACCESS` blocked), settings
   fields, app menu, `electron-updater` dependency, health marker. Verify:
   `npx vitest run src/shared/remoteDeck.test.ts src/shared/notify.test.ts && npm run typecheck`.
10. **Release pipeline.** `electron-builder.yml` (mac zip, generic publish),
    `scripts/release-publish.mjs` + test (vector, parts, publish body, `--dry-run`),
    `scripts/release-key.mjs`, `.github/workflows/release.yml`, `ci.yml` without the tag step.
    Verify: the script's vitest file; YAML parses.
11. **UI.** Settings → Updates, rail dot, required-update banner, ready prompt (Restart now /
    Remind me later), web preview fixture. Tests for the components' logic. Verify:
    `npm run typecheck && npm test`.
12. **Docs.** ARCHITECTURE "In-app updates", OPERATIONS § Release, GUIDE, TODO, CLAUDE.md.

## Checks and end to end

13. **Review** of each part; fix every important finding.
14. **Local end to end** (nothing deployed): `wrangler dev` with local D1/R2, a packaged v N in a
    temp folder, publish N+1 with the script and the test key → the app updates in place and is
    healthy; a broken N+1 → rollback.
15. **Full checks**: backend `npm run typecheck && npm test`; app `npm run typecheck && npm test`;
    Python `pytest skills/master/tests`. Then draft PRs (not merged).

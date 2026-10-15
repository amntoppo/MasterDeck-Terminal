# Admin dashboard (#127): plan

Design: [2026-10-16-admin-dashboard-design.md](2026-10-16-admin-dashboard-design.md). Three repositories: the
backend (B), the dashboard's own private repo (D), this repo (M). Each task: files, the test first, the check.

1. **B: migration 0007** (0006 is #122's `releases`). `migrations/0007_admin.sql` (admins, admin_audit, disabled_users, md_events,
   md_activity, download_counts, md_kv, devices columns). Check: `npx vitest run` applies it (test setup).
2. **B: events and activity.** `src/activity.ts`; hooks in `src/auth/options.ts` (sign_up, sign_in, user_deleted,
   disabled refusal), `src/auth.ts`, `src/auth/devices.ts`, `src/worker.ts` (pairings, browser socket).
   Test first: `test/admin.test.ts` "activity: sign-ups, sign-ins and pairings…", "disables a user…".
3. **B: hello fields and hub summary.** `src/protocol.ts` (`platform?`, `osVersion?`), `src/hub.ts`
   (`recordHello`, `adminSummary`, `disable`). Tests: "devices & versions…", "an old hello…", "the hub summary
   carries counts only".
4. **B: access.** `src/admin/access.ts`, `src/admin/routes.ts` middleware, `src/cors.ts` (`corsFor`,
   `authCors`, `adminCors`), `trustedOrigins`, `safeNext(next, ...origins)`, `src/env.ts`, `wrangler.jsonc`
   vars, `vitest.config.ts` bindings. Tests: "every endpoint refuses…", "refuses an admin from another origin…",
   "unverified", "CORS", "login page", "sign in from the dashboard origin".
5. **B: stats.** `src/admin/stats.ts` (`parseRange`, overview, users, user detail, devices, activity,
   downloads). Tests: "counts users…", "lists, searches and sorts users", "shows a user in detail… no secret",
   `parseRange`.
6. **B: downloads.** `src/admin/downloads.ts`, `scheduled` in `src/worker.ts`, cron in `wrangler.jsonc`. Tests:
   "names the platform…", "by version and platform, and per day…", "refresh: audited…".
7. **B: actions and admins.** Routes for disable/enable, revoke device/browser, admins add/remove, audit. Tests:
   "revokes a device and a browser…", "disables a user…", "will not disable yourself…", "lists config admins…",
   "refuses a bad email".
8. **B: docs.** `docs/ADMIN.md`, ARCHITECTURE, PROTOCOL, OPERATIONS (deploy), README, TODO, CLAUDE.md.
   Check: `npm run typecheck && npm test`.
9. **D: scaffold.** Vite + React + TS, `wrangler.jsonc` (assets, custom domain), `public/_headers` (CSP),
   `src/api.ts`. Check: `npm run build`.
10. **D: helpers.** `src/format.ts`; test first `src/format.test.ts` (ranges, ago, axes, platform and OS names).
    Check: `npm test`.
11. **D: shell and pages.** `src/App.tsx` (gate: sign in / not authorised), `src/ui.tsx`, `src/charts.tsx`,
    `src/pages/*`, `src/styles.css`. Check: typecheck, build, every page against a local backend
    (`wrangler dev --local-upstream`) in headless Chrome, light/dark, 390 px, no console errors.
12. **D: README, CLAUDE.md.** Check: build.
13. **M: hello sends platform / osVersion.** Sync `app/src/shared/remote.ts` (`scripts/sync-protocol.sh`), test
    first in `app/src/main/cloudSync.test.ts`, then `CloudSync` and `index.ts`. Check: `npx vitest run
    src/main/cloudSync.test.ts`, the drift test with `MASTERDECK_BACKEND` set to the backend branch.
14. **M: docs.** REMOTE.md, TODO.md, CLAUDE.md. Check: `npm run typecheck && npm test` in `app/`.

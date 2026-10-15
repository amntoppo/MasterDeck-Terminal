# Admin dashboard (#127): design

Goal: an admin dashboard at https://admin.masterdeck.dev showing who uses MasterDeck (users, downloads, devices,
activity), with a few admin actions, open to admins only. The user's instructions: implement end to end; put the
dashboard in a new private repository. The decisions below were made with that brief; the backend's
`docs/ADMIN.md` is the reference for the API as built.

## Where things go

| Part | Where | Why |
|---|---|---|
| Admin API, access checks, new tables | the backend, `/admin/*` on dev.masterdeck.dev | the data (D1, the UserHubs) is there; the session cookie is there |
| The dashboard page | a new private repository, a static-assets Worker on admin.masterdeck.dev | asked for; holds no data or secrets |
| The Mac's platform and OS | this repo: `CloudSync` adds `platform` / `osVersion` to `hello` | "app version per device, OS" needs the Mac to say it |

Approaches considered:
1. **Page on admin.masterdeck.dev calling the backend cross-origin with the backend's cookie (chosen).** The same
   model as the web app (app.masterdeck.dev): CORS with credentials for one exact origin, sign-in on the backend's
   `/login` (every sign-in method, `next` back to the dashboard). Cookies are same-site (masterdeck.dev), so no
   third-party-cookie trouble.
2. Route admin.masterdeck.dev to the backend Worker and serve the page from it. One origin and no CORS, but the
   page would live in the backend repo (not the new repo asked for), and sign-in would need its own host-only cookie
   and an email-only form (OAuth callbacks go to dev.masterdeck.dev).
3. Cloudflare Access in front of the dashboard. Strong, but admins would be managed in Cloudflare, not "without a
   code change" in the product, and the API would still need its own check.

## Access (server side, every request)

ADMIN_ORIGIN set → Origin equals it (reads too) → a session → a **cookie** session (no bearer, device, dev or
pairing token) → verified email → not disabled → admin. Admins: `ADMIN_EMAILS` var (the owner's email; never
removable in the dashboard) plus an `admins` table by lower-case email, read on every request. 401 / 403 otherwise;
the page shows "Not authorised".

## Data

Already there: `user`, `account`, `session` (time, IP, UA), `devices`, `browsers`, the hub (counts only:
desktop status, snapshot version and session count, commands and items by state, sockets).

Added (migration 0007): `md_events` (sign-up, sign-in with method, pairings, revokes, deletions), `md_activity`
(one row per user, UTC day and client: desktop, browser, web, api) for DAU/WAU/MAU over time, `download_counts`
(GitHub Release totals per asset per day; a daily cron; `source` leaves room for #122 / #89), the Mac's
version/protocol/platform/OS on `devices` (from `hello`), `admins`, `admin_audit`, `disabled_users`, `md_kv`.

DAU/WAU/MAU now: active if any activity day, a Mac's `last_used_at`, a browser's `last_seen_at` or a session's
`updatedAt` falls in the window. Per-day series only from deploy on.

## Actions

Revoke a Mac, revoke a browser (sockets closed), disable a user (sessions deleted, sockets closed, new sessions
refused in Better Auth's `session.create.before`, device tokens refused in `findDevice`; enable undoes it), add /
remove admins. Not yourself, not another admin. Every action → `admin_audit`.

## Privacy rule

Every query names its columns; no password hash, token, token hash, key, nonce or snapshot content leaves the API.
Tested per field.

## Pages

Overview (stat tiles, four charts, date range shared by all pages: 7 / 30 / 90 days, a year, custom), Users
(search, sort, pages of 50 → detail), Downloads (by platform tiles, per-day bars by platform, total line, by
version, installers table), Devices & versions, Activity (four charts, events feed), Admins (list, add, remove,
audit log). Charts: hand-made SVG, hover tooltips, a Table view on each, the dataviz reference palette's first
three slots (platforms keep fixed colours), light and dark, phone layout under 760 px.

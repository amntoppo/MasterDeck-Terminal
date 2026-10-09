# masterdeck.dev: the developer website (issue #89)

## Goal

A public, multi-page marketing site on https://masterdeck.dev that tells developers what MasterDeck
is and gets them to install it. Decisions taken with the user on 2026-10-10:

- **Stack:** Astro (static output), no UI framework. Motion is CSS plus a small vanilla script
  (IntersectionObserver reveals, scroll-linked progress, a typing hero terminal, an interactive
  workflow canvas). JavaScript is an enhancement: every page reads fine without it (only the playground needs it).
- **Visuals:** coded SVG mockups of the real screens (workflow canvas, board, sessions, costs),
  one file each in `site/public/screens/`, named by screen. Swapping one for a real screenshot is
  a file replacement plus the `src` in `site/src/data/screens.ts`.
- **Deploy:** the issue asked for Cloudflare Pages; it is a Workers static-assets project instead,
  because wrangler cannot attach a custom domain to a Pages project (only the dashboard or the API
  can), while a Worker's `custom_domain` route is created, with its certificate, by `wrangler
  deploy`. `app.masterdeck.dev` is deployed the same way. Two Workers: `masterdeck-site` on
  `masterdeck.dev` (assets only, no script) and `masterdeck-www` on `www.masterdeck.dev` (a 301 to
  the bare domain). One command: `npm run deploy` in `site/`.

## Pages

| Path | Content |
|---|---|
| `/` | Hero (pitch, install one-liner with Copy, Download / Get started), a live-typing terminal, benefits, product tour of the four screens with scroll reveals, "how it works" steps, trust (local-first, never merges, open source), final CTA |
| `/features/` | Sessions, Needs you, Board and tasks, Workflows (with **agent loops** marked *coming soon*, #82), Costs and hours, several GitHub accounts, Remote / web app, Notes, skills |
| `/docs/` | Requirements, install (macOS one-liner, DMG, Windows), first run (Setup's four steps), connecting GitHub and a board, the web app, links to the full guide on GitHub |
| `/download/` | Latest version with per-platform buttons (asset URLs from the release), install notes for unsigned builds, the changelog from GitHub releases |
| `/404` | Not found |

Shared layout: header nav (logo, the four pages, GitHub, theme toggle), footer (pages, GitHub,
releases, guide, web app, licence line). Light and dark themes: system by default, toggle remembered.

## Data

`site/scripts/releases.mjs` reads the GitHub releases API and writes `site/src/data/releases.json`
(tag, date, body as Markdown, asset names/URLs). It is committed, so a build without network still
works; `npm run deploy` refreshes it first. Download buttons fall back to `/releases/latest`.

## Quality bars

Lighthouse ≥ 90 for performance, accessibility and SEO on every page: static HTML, system-font
fallbacks with one self-hosted variable font, SVGs sized with `width`/`height`, no layout shift,
`prefers-reduced-motion` turns off all motion. Each page has a title, meta description, canonical
URL, Open Graph and Twitter tags with a 1200×630 image (`site/public/og/*.png`, rendered by `npm run og`
and committed), `sitemap.xml` and `robots.txt`.

## Deploy

`npm run deploy` = refresh releases → `astro build` → `wrangler deploy` (site) → `wrangler deploy -c
www/wrangler.jsonc` (redirect). Documented in `docs/OPERATIONS.md` (Website).

## Not in scope

The README rewrite (separate ticket, reuses these images and the pitch), analytics, a blog.

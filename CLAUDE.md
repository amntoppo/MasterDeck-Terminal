# CLAUDE.md

MasterDeck: an Electron app (macOS and Windows) that puts every Claude Code session in one window,
plus the Claude Code skills it works with. Open source, public: never add company names, private
repos, people, tokens or paths from a real machine (fixtures use the fictional org `acme`).

## Layout

- `app/` — the Electron app (electron-vite, React, xterm.js, node-pty).
  - `src/main/` — main process: `index.ts` (IPC, startup), `sources.ts` (sessions, GitHub, board,
    polling; builds `AppState`), `ptys.ts` (terminals), `hooks.ts` (hooks in `~/.claude/settings.json`),
    `skills.ts` (bundled skills → `~/.claude/skills`), `workflow.ts`, `tokens.ts`, `summary.ts`, `queue.ts`.
  - `src/shared/` — pure logic and types shared by both sides (`types.ts` has `AppState`, `ipc.ts` the
    IPC channels `CH` and the `Deck` API). Put testable logic here.
  - `src/preload/` — exposes `Deck` to the renderer. `src/renderer/src/` — React UI (`App.tsx`,
    `components/`, one `styles.css`).
- `skills/` — the skills shipped with the app (master, babysit-ticket, babysit-pr, babysit-worktree,
  kill-worktree, worktree-janitor, queue). `skills/master/` is also the `master` CLI (Python,
  `lib/master/`) that the app calls for the ledger, snapshot, board, config and spawning.
- `docs/GUIDE.md` — every feature, for users. `README.md` — install, first run, config fields.
- `install.sh` — the one-line macOS installer (downloads the latest release DMG).

## Commands

```bash
cd app
npm install
npm run dev          # the app with hot reload
npm run typecheck    # main + web tsconfigs; must be clean
npm test             # vitest (unit + integration); ~230 tests
npm run dist:mac -- --publish never   # DMGs in app/dist (needs ~1.5 GB free disk)
npm run dist:win -- --publish never
scripts/install-mac.sh                # copy the built app to /Applications (quit MasterDeck first)

cd ..
PYTHONPATH=skills/master/lib python3 -m pytest skills/master/tests -q   # master CLI, ~210 tests
```

After `dist:mac` (which also builds x64), run `npx electron-builder install-app-deps` so node-pty is
arm64 again for `npm test`/`dev`.

A packaged-app smoke test: `MASTERDECK_NO_SKILLS=1 MASTERDECK_SMOKE=1 MASTERDECK_USER_DATA=<tmp>
dist/mac-arm64/MasterDeck.app/Contents/MacOS/MasterDeck` prints `SMOKE OK sessions=… issues=…` and quits.

## Adding a feature

- New data for the UI: compute it in `sources.ts` (or a module it calls), add it to `AppState`
  (`shared/types.ts`), and to the `AppState` fixture in `shared/notify.test.ts`.
- New action: a channel in `CH` and a method on `Deck` (`shared/ipc.ts`), the handler in
  `main/index.ts`, the bridge in `preload/index.ts`. Validate IPC input in main.
- Anything written to the user's machine (settings.json, skills, config) keeps a backup and is
  written atomically (temp file + rename). Hooks MasterDeck installs carry a marker so they can be
  found, updated and removed again (`hooks.ts`, `shared/workflow.ts`).
- Update `docs/GUIDE.md` (and `README.md` when install/setup changes) with the feature.

## Testing without touching the real machine

Never run a test build against the real `~/.claude/settings.json` or skills: a click in its UI writes
there. Isolate with:

| Variable | Replaces |
|---|---|
| `MASTERDECK_CLAUDE_SETTINGS` | `~/.claude/settings.json` (point at a copy) |
| `MASTERDECK_HOME` | `~/.claude/masterdeck` (costs, tokens, summaries, workflow, restore list) |
| `MASTERDECK_SKILLS_DIR` | `~/.claude/skills` |
| `MASTER_HOME` | `~/.claude/master` (config.json, ledger) — empty folder = first-run Setup |
| `MASTERDECK_USER_DATA` | Electron user data (window state, localStorage) |
| `MASTERDECK_NO_SKILLS=1`, `MASTERDECK_NO_HOOK=1` | skip installing skills / the status line hook |

To look at or drive the UI, launch the packaged app with `--remote-debugging-port=<port>` and use the
Chrome DevTools Protocol (`Runtime.evaluate`, `Page.captureScreenshot`). DOM `click()` works for
buttons; it does not go through macOS window drag regions.

## Gotchas learned the hard way

- **Window drag regions**: headers use `-webkit-app-region: drag`. Electron applies drag/no-drag in
  DOM order, so an element floating over a header must come after it in the DOM to be clickable
  (the ★ Master button is the last child of `.app` for this reason).
- **Hooks that match a Bash command** must match a command that runs (start of line or after
  `; & | (`), with heredoc bodies stripped (`runsOrExit` in `shared/workflow.ts`); otherwise text
  written to a file that mentions `gh pr create` fires them.
- **Shell scripts run under macOS bash 3.2**: write `${var}` before non-ASCII text (`"$chip…"` breaks).
- **Claude session ids change on resume**; the background id (first 8 chars) does not. Key per-session
  data by `Session.key` where it must survive a resume.
- **Transcripts** repeat each assistant message on several lines (same `message.id`): count usage once
  per id. Claude Code writes a `pr-link` record for every PR a session creates.
- `claude --bg --resume <id>` on a session that is already running starts a copy: check `claude
  agents --json` first.
- An AskUserQuestion menu is not in the transcript until it is answered: read it from the screen
  (`claude logs <id>`, rendered with `@xterm/headless`; `shared/ask.ts` `parseMenuScreen`).
- The shared GitHub cache (`ghcache`) is not per `gh` account: reads right after an account switch
  (Setup) go straight to GitHub.
- Tests that spawn bash/jq/git get a 20 s timeout; the full suite runs files in parallel.
- `claude -p` for app features (summaries): run from an empty temp folder with
  `--no-session-persistence`, tell the model the writing style, and remove the empty
  `~/.claude/projects/<folder>` it leaves.

## Style

- Code reads like the surrounding code; comments say why, not what. UI text is plain, short, active.
- Commits: a clear subject, then a body that explains the change and why; no ticket noise.
- Releases: bump `app/package.json` `version`, commit, push, then tag `vX.Y.Z` and push the tag — CI
  builds macOS and Windows and publishes the release with `.github/release-notes.md` as its notes.

# Per-session tabs and the Diff tab: design (#113)

Issue: [#113](https://github.com/amntoppo/MasterDeck-Terminal/issues/113). Related: #103 (the
Details panel's Session / GitHub / Mods tabs).

## Goal

A session's pane gets its own row of tabs: the Terminal first, then files and diffs from the
session's folder. Details gets a **Diff** tab (changed files, live) and a **Files** tab (the
folder's tree). The leftover ⇧← / ⇧→ view cycling goes.

## Decisions (from the brainstorm, 2026-10-12)

| Question | Decision |
|---|---|
| Which "old tabs" go | ⇧← / ⇧→ view cycling only: `view-prev` / `view-next` in `shared/shortcuts.ts`, `MAIN_VIEWS` and its case in `App.tsx`, their rows in Settings → Keys and their tests. The open-terminal `tabs` state, ⇧↑ / ⇧↓, ⌘1–9, ⌘⇧W and ⌘\ stay (they pick panes, and the new tab rows live inside panes). |
| Where a file tab opens from | All four: the Diff list (**Open file** beside the diff), quick-open ⌘P over the session's files, ⌘-click on a path in the terminal, a **Files** tab in Details. |
| Web app | Yes, read only, inside the session's folder. |
| Diff look | Unified by default, with a **Split** toggle (old / new side by side) when the pane is wide enough; remembered. Phone width: unified only. |
| Diff base | A switch: **Uncommitted** (default: working tree and index against `HEAD`, untracked files as added) and **Branch** (since the merge base with the default branch, commits included: what a PR will hold). |
| Live updates | Approach 1, pull while visible (below). |
| Highlighting | `highlight.js` (`lib/common`): synchronous, ~40 KB gzipped, works in the web build. |

## Approach: pull while visible

Nothing new enters `AppState` (the bridge drops a state over ~1.05 MB). The renderer asks main
for a session's changed files every 3 s, only while that session's Diff tab, or one of its diff
tabs, is on screen and the window is visible, and once more when the session's `state` changes (a
turn ended). File and diff tabs reload on the same tick when their file's entry changed (its
numstat or mtime).

Rejected: computing changes for every session in `Sources.build()` (git for every session all
the time, and state size), and an `fs.watch` watcher (recursive watching of large repos and
`node_modules`, platform differences).

## Parts

### Shared (pure, tested)

- `shared/sessionTabs.ts`: the per-session tab model. `SessionTab = {kind: "terminal"} | {kind:
  "file", path} | {kind: "diff", path, base}`; ids `terminal`, `file:<path>`, `diff:<base>:<path>`.
  `openTab` (focus if open, else add after the active one), `closeTab` (never the terminal; the
  active one moves to its right neighbour, else its left), `cleanTabs` (drops unknown shapes from
  storage). Saved per `Session.key` in localStorage (`session-tabs`), so a resume (new session
  id) keeps them; keys of sessions no longer listed are pruned when the list loads.
- `shared/diff.ts`: parse `git status --porcelain=v2 -z` + `git diff --numstat -z` into
  `ChangedFile = {path, oldPath?, status: "added" | "modified" | "deleted" | "renamed", add, del,
  binary}`; parse a unified diff into hunks and lines (`kind`, old / new line numbers, text) and
  pair them for the split view.
- `shared/fileView.ts`: what to show for a file: `markdown` (`.md`, `.markdown`), `code` with a
  highlight.js language from the extension / name (`Makefile`, `Dockerfile`), `text`, or a
  message: `binary` (a NUL in the first 8 KB), `too-large` (over 1 MB, or over 20 000 lines),
  `missing`, `outside`. A diff over 5 000 lines says so and offers the first 5 000.
- `shared/filePath.ts`: path guard (`insideRoot`: relative, normalised, no `..`, no absolute,
  no NUL) and terminal path detection for the link provider (`path:line:col`, `./x`, `src/x.ts`).

### Main

- `main/sessionFiles.ts`: `list(root)` (`git ls-files -co --exclude-standard -z`, capped at
  50 000 paths; not a repository: a walk to depth 6 skipping dot-folders and `node_modules`),
  `read(root, path)` (realpath must stay under realpath(root): no symlink escape; size checked
  before reading), `changes(root, base)`, `fileDiff(root, path, base)`. Git runs with
  `execFile`, a timeout, `GIT_OPTIONAL_LOCKS=0` (no index lock against Claude's own git), and
  no shell.
- The root is always the session's `cwd` looked up in main by `Session.key`; a caller never
  passes a folder. The merge base for **Branch** uses `origin/HEAD`, else `main` / `master`;
  none found: the switch says "No default branch found".
- Channels (`shared/ipc.ts` `CH` + `DeckApi`, `preload`, handlers through `reg.handle`):
  `files:list`, `files:read`, `diff:list`, `diff:file`, all `remote` in `DECK_ACCESS`. Input is
  validated in main (session key known, path through `insideRoot`). A web answer is capped
  (file text 1 MB, list 50 000 paths, diff 5 000 lines), so no answer nears the bridge limit.

### Renderer

- `SessionPane` gets a tab row above the terminal (`SessionTabs.tsx`). The terminal stays
  mounted and is only hidden while another tab is active (xterm keeps its buffer and size; it
  refits when shown). × and middle-click close; the Terminal tab has neither and cannot be
  dragged. Shell panes keep a single terminal (no row).
- `FileTab.tsx`: Markdown through `MarkdownView html={false}`; code through highlight.js into
  escaped HTML with line numbers; the messages above as a readable note with **Open in editor**
  (desktop only).
- `DiffTab.tsx`: unified view, **Split** toggle (remembered), added / removed colours from the
  theme tokens (light and dark), hunk headers, line numbers, **Open file**.
- Details (`SessionDetails.tsx`) gets **Diff** and **Files** tabs beside Session / GitHub / Mods.
  Diff: the Uncommitted / Branch switch, rows with a status letter (A / M / D / R), the path and
  `+n −m`, a count on the tab; a click opens or focuses the diff tab. Files: a filter box and a
  collapsible tree from `files:list`.
- ⌘P: quick-open over the active session's files (fuzzy, reuses the palette's matching). Added
  to `shared/shortcuts.ts` and the Settings list.
- Terminal paths: an xterm link provider in `TerminalView.tsx` for session panes; ⌘-click (Ctrl
  elsewhere) on a path that resolves inside the session's folder opens a file tab.

## Errors and limits

- Not a git repository: Diff says so; Files falls back to the walk.
- git missing or slow (timeout 10 s): the Diff tab shows the error and keeps the last list.
- A file deleted while its tab is open: the tab stays and says the file is gone.
- Binary or too large: a message, never a freeze. A diff tab of a binary file says "Binary file
  changed".

## Testing

- Vitest for `sessionTabs`, `diff`, `fileView`, `filePath`, `sessionFiles` (temp git repos:
  added, modified, deleted, renamed, untracked, binary, a symlink out of the root, a large
  file, not a repository), the guards in `remoteGuards.test.ts`, `remoteDeck.test.ts` for the
  new entries, `shortcuts.test.ts` without the view keys.
- The isolated app and the web preview (`/?preview`) at 1400 px and 390 px: tab row, open /
  focus / close, middle-click, restart keeps tabs, Diff live update, split toggle, light and
  dark.

## Docs

`docs/GUIDE.md` (tabs, Diff, Files, ⌘P, ⌘-click), `docs/ARCHITECTURE.md` (the channels, the
guard, pull while visible), `docs/TODO.md`, and CLAUDE.md's "Where things live" and "Current
state".

# Per-session tabs and the Diff tab: plan (#113)

Design: [2026-10-12-session-tabs-design.md](2026-10-12-session-tabs-design.md).
Branch `113-session-tabs`. Commands run from `app/` unless said otherwise.

Each task: write the failing test, run it and watch it fail, write the code, run it and watch
it pass, commit (subject + why, `Co-Authored-By` line). Full checks at the end of each round:
`npm run typecheck && npm test` (and `npm run build:web` from Task 11 on).

## Task 1: Remove ⇧← / ⇧→ view cycling

Files: `src/shared/shortcuts.ts`, `src/shared/shortcuts.test.ts`, `src/renderer/src/App.tsx`
(`MAIN_VIEWS` and the `view-prev` / `view-next` case), `src/renderer/src/web.ts`
(`SHORTCUT_NEEDS` entries), `src/renderer/src/components/Rail.tsx` (the `⇧← ⇧→` hint),
`docs/GUIDE.md` (Keyboard table and the Shift+arrows note).

Test first (`shortcuts.test.ts`): Shift+ArrowLeft / ArrowRight match nothing; Shift+ArrowUp /
Down still match `tab-prev` / `tab-next`; `SHORTCUTS` has no `view-*` id.

Code: drop `view-prev` / `view-next` from `ShortcutId`, `SHORTCUTS` and the arrows table;
remove `MAIN_VIEWS` and its switch case; remove the web needs and the Rail hint. `cycle` stays
(⇧↑ / ⇧↓ use it). Check with `grep -rn "view-prev\|view-next\|MAIN_VIEWS\|⇧←" src ../docs/GUIDE.md`
→ nothing.

Verify: `npx vitest run src/shared/shortcuts.test.ts && npm run typecheck`.

## Task 2: The per-session tab model

Files: `src/shared/sessionTabs.ts`, `src/shared/sessionTabs.test.ts`.

Test first: `openTab` adds after the active tab and makes it active; opening one already open
only focuses it; `closeTab('terminal')` is a no-op; closing the active tab activates the right
neighbour, else the left; closing an inactive tab keeps the active one; `tabId` gives
`terminal`, `file:<path>`, `diff:<base>:<path>`; `cleanTabs` drops bad shapes, duplicates and
paths failing `insideRoot`, always puts the terminal first; `pruneSessions(store, liveKeys)`
drops keys not live.

Code:
```ts
export type DiffBase = 'uncommitted' | 'branch'
export type SessionTab = { kind: 'terminal' } | { kind: 'file'; path: string } | { kind: 'diff'; path: string; base: DiffBase }
export interface SessionTabsState { tabs: SessionTab[]; active: string }
export const TERMINAL: SessionTab = { kind: 'terminal' }
export function tabId(t: SessionTab): string
export function openTab(s: SessionTabsState, t: SessionTab): SessionTabsState
export function closeTab(s: SessionTabsState, id: string): SessionTabsState
export function cleanTabs(v: unknown): SessionTabsState
export function pruneSessions(store: Record<string, SessionTabsState>, live: Set<string>): Record<string, SessionTabsState>
```

Verify: `npx vitest run src/shared/sessionTabs.test.ts`.

## Task 3: Path guard and terminal paths

Files: `src/shared/filePath.ts`, `src/shared/filePath.test.ts`.

Test first: `insideRoot` accepts `src/a.ts`, `./a.md`, `a/../b`; refuses `../x`, `/etc/passwd`,
`a/../../x`, `""`, `a\0b`, non-strings, and on Windows-style `C:\x`; returns the normalised
relative path. `findPaths(line)` finds `src/a.ts`, `src/a.ts:12`, `src/a.ts:12:3`, `./x.md`,
`app/src/main/index.ts(40)` with start / end columns and the line number; ignores URLs and
bare words without a slash or extension.

Code: `insideRoot(p: unknown): string | null` (posix normalise, refuse absolute / `..` / NUL /
backslash drive); `findPaths(text): {path, line?, start, end}[]`.

Verify: `npx vitest run src/shared/filePath.test.ts`.

## Task 4: What a file shows as

Files: `src/shared/fileView.ts`, `src/shared/fileView.test.ts`.

Test first: `viewKind('README.md')` → markdown; `x.ts` → code `typescript`; `Makefile` → code
`makefile`; `Dockerfile` → `dockerfile`; `x.unknownext` → text; `limitsOf({bytes, lines,
binary})` → `binary`, `too-large` (> 1 MB or > 20 000 lines) or ok; `messageFor(kind)` gives
the plain sentence the tab shows.

Code: an extension → highlight.js language table (only languages in `highlight.js/lib/common`
plus `dockerfile`, `makefile`), `FILE_MAX_BYTES = 1_000_000`, `FILE_MAX_LINES = 20_000`,
`DIFF_MAX_LINES = 5_000`.

Verify: `npx vitest run src/shared/fileView.test.ts`.

## Task 5: Parse git's changes and diffs

Files: `src/shared/diff.ts`, `src/shared/diff.test.ts`.

Test first, on literal git output: `parseChanges(statusZ, numstatZ, untrackedCounts)` gives
added / modified / deleted / renamed (with `oldPath`), `+add −del`, `binary` for `-\t-`,
untracked as added, sorted by path; `parseDiff(text)` gives hunks with header, lines (`ctx` /
`add` / `del`, old / new numbers), `binary: true` for "Binary files … differ", `noNewline`
markers, and `truncated` past `DIFF_MAX_LINES`; `splitRows(hunk)` pairs dels with adds for
the split view (blank cells where one side has none).

Code: pure parsers; types `ChangedFile`, `FileDiff`, `Hunk`, `DiffLine`, `SplitRow`.

Verify: `npx vitest run src/shared/diff.test.ts`.

## Task 6: Main: reading the session's folder

Files: `src/main/sessionFiles.ts`, `src/main/sessionFiles.test.ts` (temp git repos made with
real git; 20 s timeout).

Test first: `list(root)` in a repo gives tracked + untracked, not ignored; outside a repo the
walk skips `node_modules` and dot-folders, depth 6, capped; `read(root, p)` returns text,
`binary`, `too-large` (stat before read), `missing`, `outside` for `../x` and for a symlink
pointing out of the root; `changes(root, 'uncommitted')` for added / modified / deleted /
renamed / untracked / binary; `changes(root, 'branch')` includes a committed change since the
merge base with `main`; no default branch → `{error: 'No default branch found'}`; not a repo →
`{error: 'Not a git repository'}`; `fileDiff` for a modified, an untracked (diff against
`/dev/null` via `--no-index`), a deleted and a binary file.

Code: class `SessionFiles(run: Runner)`; git through `run('git', [...], {cwd, timeoutMs:
10_000, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}})`; `-z` output; merge base via
`defaultBranch` (`main/defaultBranch.ts`) then `git merge-base HEAD <b>`; realpath check with
`fs.realpath` on root and target.

Verify: `npx vitest run src/main/sessionFiles.test.ts`.

## Task 7: Channels, guards and web access

Files: `src/shared/ipc.ts` (`CH.filesList`, `filesRead`, `diffList`, `diffFile`; `DeckApi`
methods), `src/shared/remoteDeck.ts` (all four `invoke`), `src/preload/index.ts`,
`src/main/remoteGuards.ts` (`sessionFileCall(input, sessions)`), its test,
`src/main/index.ts` (handlers through `reg.handle`), `src/shared/remoteDeck.test.ts`.

Test first (`remoteGuards.test.ts`): `sessionFileCall` refuses an unknown session key, a
non-string path, a path failing `insideRoot`, a bad base; returns `{root: session.cwd, path,
base}` for a good one; a session with no `cwd` is refused. `remoteDeck.test.ts` passes with the
four entries (fails before).

Code: handlers look the session up in the latest state by key and call `SessionFiles`; answers
are `{ok: true, …} | {ok: false, message}`; web answers capped as in the design.

Verify: `npx vitest run src/main/remoteGuards.test.ts src/shared/remoteDeck.test.ts && npm run typecheck`.

## Task 8: The tab row in the session pane

Files: `src/renderer/src/sessionTabsStore.ts` (localStorage `session-tabs`, `useSessionTabs(key)`,
prune on state load), `src/renderer/src/components/SessionTabs.tsx`, `App.tsx` (`SessionPane`),
`src/renderer/src/styles.css`.

Test first (`sessionTabsStore.test.ts`, jsdom-free: the store's read / write functions over a
fake storage): saved per key, survives a reload, bad JSON gives the terminal only, pruning drops
keys of sessions not listed.

Code: the row (role `tablist`), Terminal first with no × and no drag, × and middle-click
(`onAuxClick`, button 1) on others, active tab per session; the terminal stays mounted and gets
`hidden` while another tab is active, refit on show. Placeholder bodies for file / diff tabs
until Tasks 9 and 10.

Verify: `npx vitest run src/renderer/src/sessionTabsStore.test.ts && npm run typecheck`.

## Task 9: File tabs (Markdown and highlighting)

Files: `package.json` (`highlight.js`), `src/renderer/src/highlight.ts` (register languages,
`highlightLines(text, lang): string[]` escaped HTML per line), its test,
`src/renderer/src/components/FileTab.tsx`, `styles.css` (hljs token colours from theme tokens,
light and dark).

Test first (`highlight.test.ts`): `<script>` in code comes out escaped; a known language gets
`hljs-` spans; an unknown one falls back to escaped plain text; line count equals the input's.

Code: `FileTab` loads through `deck().filesRead`, shows `MarkdownView html={false}` for
markdown, a numbered highlighted `<pre>` for code / text, `messageFor` for binary / too-large /
missing / outside, with **Open in editor** when `canOpenEditor`. Reloads on the pull tick when
the file's mtime changed.

Verify: `npx vitest run src/renderer/src/highlight.test.ts && npm run typecheck`.

## Task 10: Diff tabs

Files: `src/renderer/src/components/DiffTab.tsx`, `styles.css`.

Test first: covered by `diff.test.ts` (`splitRows`); add a case for a hunk with only adds and
one with only dels if not there yet.

Code: unified view (line numbers, `+` / `−` colours from tokens), a **Split** toggle (remembered
in localStorage, hidden under 760 px), hunk headers, "Binary file changed", truncated note,
**Open file** (opens / focuses the file tab). Reloads on the pull tick when the file's
`+/−` changed.

Verify: `npm run typecheck && npx vitest run src/shared/diff.test.ts`.

## Task 11: Diff and Files tabs in Details

Files: `src/renderer/src/components/SessionDetails.tsx` (`DetailsTab` gains `diff` and `files`),
`src/renderer/src/components/DiffList.tsx`, `src/renderer/src/components/FileTree.tsx`,
`src/renderer/src/usePull.ts` (3 s while visible and `document.visibilityState === 'visible'`,
plus on the session's `state` change), its test with fake timers,
`src/shared/fileTree.ts` (paths → tree, filter) and its test.

Test first: `usePull`'s scheduler (pure part `pullDue(now, last, visible)`) fires every 3 s only
while visible and at once on a state change; `buildTree(paths)` nests and sorts folders first;
`filterTree(tree, q)` keeps matching files and their folders.

Code: Diff: Uncommitted / Branch switch, rows with A / M / D / R, path, `+n −m`, count on the
tab, click opens or focuses the diff tab (and **Open file**); errors shown, last list kept.
Files: filter box and collapsible tree; click opens a file tab.

Verify: `npx vitest run src/shared/fileTree.test.ts src/renderer/src/usePull.test.ts && npm run typecheck && npm run build:web`.

## Task 12: ⌘P quick-open

Files: `src/shared/shortcuts.ts` (`quick-open`, `Mod P`, group Sessions), its test,
`src/renderer/src/components/QuickOpen.tsx`, `App.tsx` (the case), `web.ts` (needs
`filesList`).

Test first: `matchShortcut(⌘P)` → `quick-open` on macOS, Ctrl+P elsewhere.

Code: a palette-like dialog over the active session's `filesList`, ranked with `rank` from
`shared/fuzzy.ts`, Enter opens a file tab; no session open: "Open a session tab first".

Verify: `npx vitest run src/shared/shortcuts.test.ts && npm run typecheck`.

## Task 13: ⌘-click paths in the terminal

Files: `src/renderer/src/components/TerminalView.tsx` (a link provider when the pane is a
session's), `App.tsx` (pass `onOpenPath`).

Test first: `findPaths` cases from Task 3 cover detection; add a case for a path wrapped at the
line end being ignored (a known limit, `ponytail:` comment).

Code: `term.registerLinkProvider` over `findPaths`, activate only with ⌘ (Ctrl elsewhere),
open the file tab; main's `filesRead` decides whether it exists / is inside.

Verify: `npm run typecheck && npx vitest run src/shared/filePath.test.ts`.

## Task 14: Web preview fixture, docs, final checks

Files: `src/web` preview fixture (a session with changes and files for `/?preview`),
`docs/GUIDE.md`, `docs/ARCHITECTURE.md`, `docs/TODO.md`, `CLAUDE.md` ("Where things live",
"Current state").

Verify: `npm run typecheck && npm test && npm run build:web`; then the isolated app and the
web preview at 1400 px and 390 px, light and dark (tab row, open / focus / close, middle-click,
restart keeps tabs, Diff live, split toggle, large and binary files).

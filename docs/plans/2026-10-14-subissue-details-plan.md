# Expandable sub-issues: plan (#112)

Design: [2026-10-14-subissue-details-design.md](2026-10-14-subissue-details-design.md).
Branch `112-subissue-details`. Commands run from `app/` unless said otherwise.

Each task: write the failing test, run it and watch it fail, write the code, run it and watch it
pass, commit (subject + why, `Co-Authored-By` line). Full checks at the end of each round:
`npm run typecheck && npm test && npm run build:web`.

## Task 1: Keep body, assignees and labels in the sub-issues read

Files: `src/shared/subIssues.ts`, `src/shared/subIssues.test.ts`.

Test first: `parseSubIssues` returns `body`, `bodyCut`, `assignees`, `labels` from a line that has
them; `\r\n` becomes `\n`; a bad login / non-hex colour / non-array field becomes empty (`[]`,
`null` colour, `''` body) without dropping the row; a line without the new fields still parses
(old cache) with empty values. `SUB_ISSUES_JQ` contains `SUB_BODY_MAX` and `bodyCut`.
Update the existing `toEqual` expectations and the `sub()` helper.

Code: extend `SubIssue`, `SUB_ISSUES_JQ` (`body: ((.body // "") | .[0:SUB_BODY_MAX])`,
`bodyCut: ((.body // "") | length > SUB_BODY_MAX)`, `assignees: [.assignees[]?.login]`,
`labels: [.labels[]? | {name, color}]`), `SUB_BODY_MAX = 10000`, the checks in `parseSubIssues`.
Fix every other `SubIssue` literal (`src/web/preview/preview.tsx`, tests) so typecheck passes;
give the preview fixture bodies (headings, a checklist, code, a link, a long one), assignees and
labels.

Verify: `npx vitest run src/shared/subIssues.test.ts && npm run typecheck`.

## Task 2: `SubIssueDetail`

Files: `src/renderer/src/components/SubIssues.tsx`, new
`src/renderer/src/components/subIssues.test.ts`, `src/renderer/src/styles.css`.

Test first (static markup, as `loopProgress.test.ts`): `SubIssueDetail` for a row with a Markdown
body renders the heading / list / checklist / code / link through `MarkdownView`, the status,
`@login`s, label names, and an "Open on GitHub" control; an empty body says "No description.";
`bodyCut` shows the cut note.

Code: `SubIssueDetail({ row, id })` (status badge, assignees, label chips with
`--label-color` set from the hex, `MarkdownView` in `.sub-body`, the link button). CSS: `.sub-detail`,
`.sub-meta`, `.sub-label`, `.sub-body` (`max-height: 40vh; overflow: auto`), theme tokens only
(`themes.lint.test.ts`).

Verify: `npx vitest run src/renderer/src/components/subIssues.test.ts src/shared/themes.lint.test.ts`.

## Task 3: Expandable rows in the Start dialog and the Assign popup

Files: `SubIssues.tsx`, `subIssues.test.ts`, `styles.css`.

Test first: `SubIssues` rendered with a stubbed `deck().issueSubIssues` is hard statically (it
loads in an effect), so split the list into `SubIssueList({ rows, open, onToggle })` and test it:
rows have `aria-expanded="false"` and a ▸; with a key in `open`, `aria-expanded="true"`,
`aria-controls` matching the detail's id, the detail rendered, ▾; two keys open → two details.

Code: `SubIssueList`; `SubIssues` keeps a `Set<string>` of `ticketKey`s and toggles on click
(button: Enter / Space for free). The row no longer opens GitHub (the detail's link does).

Verify: `npx vitest run src/renderer/src/components/subIssues.test.ts && npm run typecheck`.

## Task 4: Expandable rows in Details → GitHub

Files: `src/renderer/src/components/GitHubDetails.tsx`, `subIssues.test.ts` (or a
`gitHubDetails` test if one fits), `styles.css`.

Test first: export the item as `SubIssueItem({ row, open, onToggle })` and test closed / open
markup (button with `aria-expanded`, the ↗ still there, `SubIssueDetail` when open).

Code: `SubIssuesRow` keeps its own open `Set`; each `gh-item` gets a toggle button over its lead
and the detail below.

Verify: `npx vitest run src/renderer/src/components/subIssues.test.ts && npm run typecheck`.

## Task 5: Look at it, then docs

By hand: `npm run dev:web` → `/?preview`, a Start dialog and Details → GitHub at 1280 and 390 px,
light and dark; Tab to a row, Enter and Space toggle; two open; a long body scrolls in its box.

Docs: `docs/GUIDE.md` (the popups' sub-issues paragraph, Details → GitHub), `docs/ARCHITECTURE.md`
(the sub-issues line: the new fields, the cut), `docs/TODO.md` (Recently done, any open point),
`CLAUDE.md` current state.

Verify: `npm run typecheck && npm test && npm run build:web`.

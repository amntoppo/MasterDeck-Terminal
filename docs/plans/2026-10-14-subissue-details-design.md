# Expandable sub-issues: design (#112)

Issue: [#112](https://github.com/amntoppo/MasterDeck-Terminal/issues/112). Related: #81 (sub-issues in
the popups), #103 (Details → GitHub). Branch `112-subissue-details`.

## Goal

A sub-issue row in the Start dialog, the Board's Assign popup and Details → GitHub opens in place
to show the sub-issue's description (rendered Markdown), status, assignees, labels and a link to
GitHub; a second click (or Enter / Space) closes it. Several can be open at once.

## Decision: the same read keeps more

`GitHub.subIssues` already reads `repos/<repo>/issues/<n>/sub_issues?per_page=100`, whose answer
carries each sub-issue's `body`, `assignees` and `labels`; `SUB_ISSUES_JQ` drops them today. We keep
them. Expanding is then instant, and there is no new channel, `DECK_ACCESS` entry or gh call.
Rejected: a new per-sub-issue read on expand (one more channel and call per click), and a hybrid
that fetches only the body through `issue:body` (a loading state per row for little gain).

## Data (`shared/subIssues.ts`)

- `SUB_ISSUES_JQ` adds `body` (cut in jq to `SUB_BODY_MAX` = 10 000 characters, with
  `bodyCut: true` when cut), `assignees: [.assignees[]?.login]`, `labels: [.labels[]? | {name, color}]`.
  The cut bounds the answer (100 sub-issues × 10 000 characters ≈ 1 MB at most), which also
  travels to the web app over the bridge.
- `SubIssue` gains `body: string`, `bodyCut: boolean`, `assignees: string[]`,
  `labels: { name: string; color: string | null }[]`.
- `parseSubIssues` checks each field: `\r\n` → `\n`, a login must match GitHub's login shape, a
  colour must be six hex digits (else null), anything malformed becomes empty rather than dropping
  the row.

## UI

- One component, `SubIssueDetail` (in `SubIssues.tsx`): a line with the status badge, assignees
  (`@login`) and label chips (the label's colour as a border/dot through a CSS variable, text in
  theme tokens: no colour literal), then the description in `MarkdownView` (`html` as for issue
  bodies) inside a box that scrolls past about 40vh, "No description." when empty, a note when
  `bodyCut`, and **Open on GitHub ↗** (`deck().openExternal`).
- `SubIssues` (Start dialog, Assign popup): a click on a row toggles it instead of opening GitHub;
  a ▸ / ▾ chevron; the row stays a `<button>` with `aria-expanded` and `aria-controls`, so Enter
  and Space work natively. Open rows are a `Set` of `ticketKey`s in component state.
- `SubIssuesRow` (Details → GitHub): the `gh-item` gets the same toggle (a button over its lead,
  chevron, `aria-expanded`); its ↗ stays. Same `SubIssueDetail` below it.
- Loading and failure: the list's existing "Loading…" / "Could not load…" messages (the details
  arrive with the list). Empty description: "No description."
- Long descriptions scroll in their own box; the list's own `max-height` stays, so the dialog
  never grows past the screen. Which rows are open is not remembered.

## Tests

- `shared/subIssues.test.ts`: the new fields read, malformed fields emptied, `bodyCut`, `\r\n`.
- `renderer/.../subIssues.test.ts` (static markup as in `loopProgress.test.ts`): a closed row has
  `aria-expanded="false"` and no detail; an open one shows the rendered Markdown, assignees,
  labels, the link; empty and cut descriptions.
- By hand: the web preview (`/?preview`) at 1280 and 390 px, light and dark; keyboard toggling.

## Docs

GUIDE (the popups' and Details' sub-issues), ARCHITECTURE (the sub-issues line), TODO, CLAUDE.md's
current state.

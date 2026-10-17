# Plan: Review with Claude in the Pull requests view (#149)

Spec: `docs/superpowers/specs/2026-10-17-pr-review-panel-design.md`. Branch
`worktree-MasterDeck-Terminal-149-pr-review-panel`. Run from `app/`.

## Task 1: `shared/prReview.ts` (pure)

- `PR_REVIEW_NAME = "md-pr-review"`, `prReviewName(tab)`.
- `prRef(url)` → `{owner, repo, number}` or null (github.com PR URLs only).
- `PrReviewRequest` (`tabId`, `tab`, `account?`, `filters`, `url?`), `prReviewContext(req, teamPrs,
  now)` → the context.json object (`selected` from the list, owner from the URL).
- `prReviewBriefing(me)` → CLAUDE.md; `reviewPrompt(sel)` → the message the row button types.
- `ticketSpecError` gains a `what` argument for its messages.
- Tests: `shared/prReview.test.ts`.

## Task 2: `main/prReviewDirs.ts`

- `prReviewDir(home, tab)`, `prReviewDirOk(home, dir)`, `prReviewFolderAccount(home, tab)`,
  `prReviewPane(home, multi, spec, settingsArgs)`, `isPrReviewSession(s, home)`,
  `prReviewScript(dir)` (post-review.sh), `writePrReviewDir(dir, ctx, briefing)` (CLAUDE.md,
  context.json, script, `.claude/settings.json`, atomically).
- Tests: `main/prReviewDirs.test.ts`, the script run with a stand-in `gh` (bash, jq; 20 s timeout).

## Task 3: wiring

- `PaneSpec` `{kind: "pr-review", resume, tab, account?, prompt?}`; `paneCommand`; `PtyManager`
  gets a `prReviewPane` resolver (last constructor argument).
- `CH.prReviewPrepare = "pr:reviewPrepare"`, `DeckApi.prReviewPrepare(req)`, preload,
  `DECK_ACCESS` remote; the handler in `main/index.ts` (validate, look up `latest.teamPrs`, write,
  `canContinue`).
- `browserBridge.ts`: `pr-review` in `WEB_PANES`, spec checked with `ticketSpecError(…, 'PR review')`
  and a `prReviewAccount` dep.
- `sources.ts`: hide `isPrReviewSession` sessions.
- Tests: `paneCommand.test.ts`, `browserBridge.test.ts`.

## Task 4: UI

- `PrsView.tsx`: `selected` per tab (saved, `parseSavedPrTabs` keeps it), row click selects, row
  highlight, `ClaudeMark` row button, header **Review with Claude**, the panel (`ticket-panel`
  classes, own width key `prReviewPanelW`), sessions kept per tab in a module map while other views
  show, context rewritten on selection/filter change, hide/close/new chat, account change / tab
  close / mode switch end the session.
- `PrPopup.tsx`: optional `onReviewWithClaude`; `App.tsx` passes it when the popup was opened from
  the PRs view (a request handed to `PrsView` as a prop).
- CSS: selected row; phone panel full width.
- Web preview: `prReviewPrepare` stub.

## Task 5: checks and docs

- `npm run typecheck`, `npm test`, `npm run build:web`; the web preview at 1400 and 390 px; the
  isolated app with a stand-in `claude`.
- ARCHITECTURE (the panel, its folder, the script), GUIDE (Pull requests → Review with Claude),
  TODO (done + open points), CLAUDE.md (Where things live, Current state).

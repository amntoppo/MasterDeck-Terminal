# Automate Review and Merge automatically (#157)

Issue: amntoppo/MasterDeck-Terminal#157. Builds on #149 (the **Review with Claude** panel, PR #151,
not merged: this branch is stacked on it). Related: #142, #135.

## Problem

The Review with Claude panel reviews a PR only when the user asks. Review requests pile up on
GitHub, and a PR that got its approvals and green checks waits for someone to press Merge.

## Decisions taken (the user asked for the recommended ones)

1. **Where it runs.** A MasterDeck poller in main (`main/autoReview.ts`, like the PR watch), not a
   bash monitor script: it needs GitHub as each account, a state machine per PR, and the pane.
   It is listed in `state.watches` as `review:<tabId>` ("Automate Review · <tab>"), so every place
   that lists monitors (Stop, events newest first) shows it. The review session is hidden from the
   session list (#149), so it has no Session details: the widget shows that same monitor row.
2. **What counts as a request.** GitHub search `is:pr is:open review-requested:@me archived:false`
   (a request to the user or to one of their teams), as the tab's account, scoped like the tab:
   `repo:<owner>/<repo>` when the tab's Repo filter is set, else `org:` / `user:` the account's
   owner. Drafts are skipped. At most 30 per poll. Every 2 minutes, and at once when switched on.
3. **One reviewer per PR.** Tracks are keyed by account and URL: two tabs of the same account
   never review the same PR twice. A PR is sent again only when its head commit differs from the
   one last sent (new commits pushed after the review).
4. **Delivery.** One PR at a time per tab. MasterDeck types one line into the tab's review pane
   when Claude's turn is over and the user has not typed into it for 30 s. The turn is known from
   hooks in the folder's own `.claude/settings.json` (SessionStart / Stop → idle,
   UserPromptSubmit / PreToolUse / PostToolUse → busy, a permission prompt → asking), written to
   `<home>/pr-review-guard/tab-<id>.turn`. No pane running: MasterDeck starts one with the line as
   its first message, and the panel adopts it (`autoReview.tabs[id].pane`).
5. **Posting without asking, but only what MasterDeck queued.** The post script's `--auto` form
   (by its absolute path, `pr-review-guard/post-review-<tab>.sh`: #149 moved it out of the folder) is allowed
   in the folder's settings; the script accepts it only for a URL in
   `<home>/pr-review-guard/tab-<id>.auto.json` (written by main only, outside the folder), and only
   as a **comment** review. An automated review never approves or requests changes: approval stays
   a person's. The user's own reviews still go through the asked path.
6. **States.** `queued` → `reviewing` (sent) → `commented` (a review by the account at or after
   the sent commit) → `changes-pushed` (new head; queued again) → `approved` (review decision
   APPROVED) → `ready` → `merging` → `merged`; also `closed`, `merge-failed`. Kept in
   `<home>/auto-review.json` (atomic), merged/closed tracks for a day.
7. **Ready to merge** (`readyToMerge`, pure): open, not a draft, `mergeable: MERGEABLE`,
   `mergeStateStatus: CLEAN` (GitHub's own answer for required checks, approvals and branch
   protection), review decision APPROVED, the checks rollup SUCCESS (or no checks), and the head
   is the commit MasterDeck's review was sent for. Anything failing, pending, blocked, behind,
   unknown or unstable is not ready.
8. **The merge guard** (`mergeGuard`, pure): Merge automatically on for the tab, the PR ready (7),
   tracked by this tab, not tried for this head before. Then `gh pr merge <url> --squash|--merge|
   --rebase --match-head-commit <oid>` as the account: the method is the repository's
   `viewerDefaultMergeMethod`, never `--admin` or `--auto`, so branch protection decides. A failure
   is reported once per head and not retried.
9. **Needs you.** A new notification type **Automated review** (#135 registry; System and Needs
   you on by default): "Review comments sent on owner/repo#123" (n comments, link), "owner/repo#123
   is ready to merge", "Merged owner/repo#123", "Could not merge owner/repo#123". A notice can carry
   a GitHub link (**View on GitHub**).
10. **Switches.** Per PR tab, saved in main's file (they drive main). Merge automatically is off by
    default, needs Automate Review on, and turning it on asks first (`webConfirm`, which is the
    native-looking dialog in the window too). A browser may turn either off and Automate Review on,
    but never Merge automatically on (the Mac's window only). Closing a tab, or its account
    changing, turns both off for it.
11. **The widget.** A small card attached to the panel's left edge, outside the chat, with its top
    and bottom on the top and bottom of Claude's input box (found in the terminal's buffer: the
    rule lines around the `>` prompt; fallback the last rows). A toggle at the chat's bottom left
    shows or hides it (remembered, `prReviewWidget`). It holds the two switches, the status line
    ("Watching · 2 in progress · last check 1 min ago"), the monitor row and the tracked PRs. On a
    phone it sits above the tip line instead.

## Not in scope

Reviewing PRs the user did not get a request for; approving automatically; a merge queue's own
settings; Linux/Windows specifics (nothing platform-specific here).

## Tests

- `shared/autoReview.test.ts`: the search query and its scope, parsing the answer, request
  detection (drafts and closed skipped), de-duplication across tabs and polls, the re-review on a
  new head only, `commented` detection and its count/link, `readyToMerge` (each blocker), the
  merge guard (off, not ready, another head, already tried, not this tab's), the prompt line
  (control characters, a leading slash), the turn file reader.
- `main/autoReview.test.ts`: the poller with a fake gh and fake panes: switch on → monitor listed;
  off → gone; a request queued, sent once when idle, not while busy or while the user types, a pane
  started when none runs; the auto list written; a merge only when ready and on, its notice.
- `main/prReviewDirs.test.ts`: `--auto` posts a comment for a queued URL only, refuses another
  URL and any other event; the settings' hooks and the allow rule.

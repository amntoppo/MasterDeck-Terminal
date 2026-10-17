# Review with Claude: a Claude panel in the Pull requests view (#149)

Issue: amntoppo/MasterDeck-Terminal#149. Related: #142 (a full review tab with inline comments; this
is the conversational half, not that).

## Problem

The Board has **Tickets with Claude** on the right: a Claude session in a folder MasterDeck briefs
(`CLAUDE.md`), keeps current (`context.json`) and gives one command it may run
(`create-ticket.sh`). The Pull requests view has nothing like it. Reviewing a PR with Claude means
starting a separate session and handing it the PR by hand.

## What changes

The Pull requests view gets a right-hand panel, **Review with Claude**, built like Tickets with
Claude: docked on the right, resizable (drag the split, double-click to reset, width remembered),
`ClaudeMark` + title, the session's account (`SessionAccount`) with two or more accounts.

### One session per PR tab

Every PR tab has its own session and folder, `<home>/pr-review/tab-<tabId>/` (unlike the Board,
also with one account: the issue asks for one per tab, and a review is about the tab's PR, so two
tabs never share a conversation). The session is named `md-pr-review-<tabId>` and is hidden from
the session list like the ticket builder. With two or more accounts it runs as the tab's account
(`--settings` of that account, so `gh` in it is that account); with one account it runs as gh's
active account, as the ticket builder does. A tab whose account changes, a closed tab, or a switch
between one and several accounts ends that tab's session (the folder stays, so **Review with
Claude** later continues the conversation, `--continue`).

### The selected PR

Clicking a row of the list selects that PR (the row is highlighted; the selection is kept per tab
in the saved tabs). Clicking its `#number` still opens the PR popup on the Mac, and selects it too.
The panel's head says **Reviewing owner/repo#123** (or "No PR selected").

### context.json, written by MasterDeck

`CH.prReviewPrepare(req)` with `{tabId, tab, account?, filters, url?}`. Main does not take the PR's
facts from the caller: it looks the URL up in `state.teamPrs` and writes:

```json
{
  "tab": "Mine", "account": "alice",
  "filters": { "state": "open", "author": "@me", "...": "..." },
  "selected": {
    "url": "https://github.com/acme/web/pull/123", "repo": "acme/web", "number": 123,
    "title": "...", "author": "bob", "state": "open", "draft": false,
    "branch": "fix-x", "base": "main", "ci": "failure", "reviewDecision": "REVIEW_REQUIRED",
    "reviews": [{ "login": "carol", "state": "APPROVED" }], "requested": ["alice"],
    "labels": ["bug"], "additions": 10, "deletions": 2, "files": 3, "unresolvedThreads": 1,
    "issues": ["acme/web#45"]
  },
  "selectedAt": "2026-10-17T10:00:00.000Z"
}
```

`selected` is null when nothing is picked or the URL is not in the list. Filters are normalised
(`normalizePrFilters`). It is rewritten whenever the selection or the filters change while the
panel is open (filters debounced), so the session re-reads it at each turn.

The tab id is checked (`TICKET_TAB`), the account must be a connected login, and the folder must be
a real folder directly inside `<home>/pr-review` (no links), as for the ticket folders.

### CLAUDE.md: how to review

Written by MasterDeck at each prepare (`prReviewBriefing`): re-read `context.json` at every turn;
read the PR with `gh pr view <url> --comments`, `gh pr diff <url>`, `gh pr checks <url>`, `gh run
view --log-failed` for a failing check; whole files at the head only when the diff is not enough
(`gh api repos/<o>/<r>/contents/<path>?ref=<branch>` or a shallow clone inside the folder, never
the user's checkouts, never a push); what to look at (correctness, security, tests, the PR's own
description and linked issue); how to answer the usual asks (review, summarise, safe to merge, what
a CI failure means); file:line references.

### Posting a review, only after the user agrees

`<home>/pr-review-guard/post-review-<tabId>.sh --pr <url> --event comment|approve|request-changes
--body-file <f.md> [--comments-file <f.json>] [--dry-run]`, written outside the folder (the
briefing names it by its absolute path). It:

- posts only to the PR `context.json` has selected (`--pr` must equal it), so a review drafted for
  one PR never lands on another the user clicked meanwhile;
- reads the body and comments files only from inside the folder;
- with an account in `context.json`, checks `gh api user` is that account (else refuses);
- posts one review (`POST repos/<o>/<r>/pulls/<n>/reviews`, JSON built with `jq`, inline comments
  `{path, line, side?, start_line?, body}`) and prints `{ok, url, state}`; `--dry-run` prints the
  payload and posts nothing.

Both checks read a guard file MasterDeck writes outside the folder,
`<home>/pr-review-guard/tab-<tabId>.json` (`{url, account}`), and the script itself sits beside it:
the session runs with `acceptEdits`, which lets it change files in its folder without asking (with
Edit, but also `cp` or `sed -i`), so neither the checks nor the script the user approves may live
there. The folder's account for the bridge's pane check is read from the guard too. Its settings
also deny `Edit` of `context.json`, `CLAUDE.md` and `.claude/**`, and a `.claude` that is a link is
refused. A trailing
option ends in the usage error. A browser's prepare may not change the account a tab folder names.

The user's agreement is enforced twice: `CLAUDE.md` says to show the exact text (and event) and
wait for a yes, and `.claude/settings.json` does **not** allow the script, so Claude Code asks the
user before every run (the permission prompt shows the command). `gh pr review`, `gh pr comment`,
`gh pr merge`, `gh pr close`, `gh pr edit`, `gh pr ready`, `gh issue comment` are denied, so the
script is the only way to write. Allowed without asking: `gh pr view`, `gh pr diff`, `gh pr
checks`, `gh pr list`, `gh run view`, `gh run list`, `--dry-run` of the script (prompted anyway:
the allow list does not separate flags; fine).

### Opening the panel

- The header's **Review with Claude** button opens (or shows) the panel for the tab.
- Each row has a `ClaudeMark` button: selects the PR, opens the panel, and asks Claude to review it
  ("Review the selected PR, acme/web#123."), typed into an open session, or as the first message of
  a new one.
- The PR popup (desktop, opened from the PRs view) has **Review with Claude**: the same, then the
  popup closes. From the Board the popup has no such button (no panel there).
- **Hide** (`›`) collapses the panel and keeps the session running (the header button brings it
  back); **×** ends it; **New chat** starts a new conversation.

### Web app

`pr-review` joins `WEB_PANES`; its spec is checked like the ticket builder's (`ticketSpecError`,
now also used for this pane: a bad tab id, an account not connected, an account other than the one
the tab's folder names are refused). `prReviewPrepare` is `remote` in `DECK_ACCESS`. The row button
works the same in the browser; the popup is Mac-only already. On a phone the panel covers the view
at full width.

## Not in scope

Inline comment UI, threads, viewed files (#142). Sending a review to the PR's own session (#142).

## Tests

- `shared/prReview.test.ts`: `prRef`, `prReviewContext` (lookup, owner from URL, null selection,
  filters normalised), the briefing names the script and the confirm rule, `reviewPrompt`.
- `main/prReviewDirs.test.ts`: folder per tab, bad tab, links refused, `prReviewPane` (one account
  vs several), `isPrReviewSession`, `writePrReviewDir` (files, settings allow/deny), and the script
  run for real with a stand-in `gh` on the PATH: refuses another PR, a body outside the folder, the
  wrong account; `--dry-run` prints the payload; a post calls `gh api -X POST …/reviews`.
- `shared/paneCommand.test.ts`, `main/browserBridge.test.ts` (pane allowed, spec checks),
  `shared/remoteDeck.test.ts` (entry present).

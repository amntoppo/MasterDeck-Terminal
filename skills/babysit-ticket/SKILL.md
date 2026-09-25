---
name: babysit-ticket
description: Use when the user types /babysit-ticket, asks which ticket/task this session is for, asks to link the session to a GitHub issue or the configured project board, or asks to move a ticket's board status (e.g. In Dev, PR Raised, Dev Done). Also use when a babysit-ticket hook message says the session is not linked.
---

# babysit-ticket

Links this Claude Code session to one issue in the configured **issue repo**
(`<owner>/<issueRepo>`) and, when a project board is configured, moves its
**Status** on that board as the work progresses. Hooks do the moves; this skill does the linking.

All values come from `~/.claude/master/config.json` (created by MasterDeck's Setup screen or
`~/.claude/skills/master/master config save`; `master config show` prints it):
`owner`, `issueRepo`, `project` (GitHub Projects v2 number; `0` = no board, so no status moves),
`columns` (the board's statuses, in order), and `statuses.*` (which column each event moves to).

All commands: `~/.claude/skills/babysit-ticket/scripts/tt.sh <cmd>` (call it `tt` below).

## Lifecycle

| Event | Status | Who moves it |
|---|---|---|
| Session linked to the ticket | the in-progress status (`statuses.inProgress`, e.g. **In Dev**) | `tt link` |
| `tt branch <name>` creates the feature branch | — (links it under Development) | `tt branch` |
| `gh pr create` succeeds | the PR-raised status (`statuses.prRaised`, e.g. **PR Raised**) | PostToolUse hook |
| `gh pr merge` succeeds, or `tt sync` sees every recorded PR merged | the dev-done status (`statuses.devDone`, e.g. **Dev Done**) | hook / `tt sync` |
| Session resumes or starts on a linked feature branch | re-syncs PR state | SessionStart hook |

Moves are **forward-only**, following the order of `columns`. A ticket already past the target
stays put (e.g. QA Done is never dragged back to In Dev). Board moves work on closed issues too,
so a merged, closed ticket still moves through the later columns. Only an explicit user request
uses `tt set "<Status>" --force`. Nothing here closes an issue, and statuses after the dev-done
status (QA-side columns such as In QA) are never set automatically.

## Linking the session (run on /babysit-ticket)

1. `tt show`: if it's already linked, report the ticket and board status, run `tt sync`, and stop.
2. Gather evidence:
   - `tt hints`, run in the repo being worked on (branch name `feat/879-…`, `<issueRepo>#879` in commits)
   - `tt candidates` (open tickets assigned to the user; `CURRENT` = this sprint)
   - what this conversation is actually doing
3. Decide:
   - **Confident** means one candidate clearly matches: a hint number appears in candidates, or
     the work obviously matches one title. Say which one and why in one line, then link.
   - **Otherwise, ask.** Use AskUserQuestion with the 2–4 likeliest candidates as options
     (label `#N short title`, description = status + sprint). "Other" covers a number not
     listed. Never guess between two plausible tickets.
4. `tt link <N>`. It records the session and the feature branch, then moves the ticket to the
   in-progress status.
5. Start the feature branch with **`tt branch <name>`** (not `git checkout -b`) so it appears
   in the ticket's **Development** box. It creates the branch on the remote via GitHub's API,
   then fetches and checks it out — works even when the ticket lives in the issue repo and the
   code in another repo.
6. When opening a PR, put `Refs <owner>/<issueRepo>#N` in the body — **no closing keyword**.
   `tt pr` (and the `gh pr create` hook) links the PR under Development for you.

## The Development box, and why the ticket closes on merge

`tt` fills the **Development** section on the issue: linked branches from `tt branch`, and
linked PRs from `tt pr`. Both work **cross-repo**, which matters when the issues live in one
repo and the code in several others.

⚠ **GitHub has no non-closing PR link.** The only API is `addCloseIssueReferences` /
`removeCloseIssueReferences`, so any PR shown under Development closes the issue when it
merges; removing the closing behaviour removes the link itself. Opening a PR from a linked
branch also *converts* that branch link into a closing PR reference.

**A closed ticket is fine, and nothing reopens it.** The board — not the issue's open/closed
state — drives the workflow, and a closed issue's board item still moves: the dev-done status
and every column after it apply normally. So after the merge the ticket reads CLOSED on GitHub
and sits at the dev-done status on the board, waiting for QA.

⚠ **`tt branch` cannot link a branch that already exists.** `createLinkedBranch` silently
returns `null` for an existing ref — no error, no link. Already branched with plain git? The
branch cannot be linked at all; the PR link is the fallback, and it arrives automatically.

## Other commands

`tt set "<Status>"` · `tt branch <name>` (create + link the feature branch) ·
`tt pr <url>` (record and link a PR the hook missed, e.g. one opened on the web) ·
`tt sync` (merged-on-GitHub check) · `tt unlink`.
Valid statuses: the board's `columns` from config (`master config show`), for example
To Do, Ready For Dev, In Dev, PR Raised, Dev Done, In QA, QA Done.

## How the link survives

State lives in `~/.claude/babysit-ticket/state.json`, keyed by session id **and** by
`owner/repo@branch`. A `/branch`, a resume, or a new session on the same feature branch
adopts the link automatically. Long-lived branches (main, master, dev, dev2, develop,
stage, staging, prod, production, the remote default) are never keyed, so linking on `main` doesn't leak the ticket to every
other session there. The branch gets keyed when the PR is recorded instead.

## Common mistakes

- A PR merged on github.com fires no hook. Run `tt sync`, or it catches up at the next SessionStart.
- A ticket reading CLOSED after its PR merged is expected, not a bug to "fix" by reopening it.
  Only move it back to open if a human asks.
- `git checkout -b` skips the Development link and it cannot be added afterwards. Use `tt branch`.
- A ticket with PRs in several repos (e.g. web + backend) reaches the dev-done status only when
  **all** of them are merged.
- `tt hints` ignores plain `#34` in a code repo's commits (when it isn't the issue repo), because
  that's the repo's own issue, not a board ticket.

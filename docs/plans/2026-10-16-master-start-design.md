# Master starts sessions on demand (#126): design

The user's first instruction was "implement this end to end"; the design below is what was built,
written down after the fact (no separate brainstorm round).

## Goal

From a chat with master (terminal or the MasterBar app), start real `claude --bg` sessions:

1. **From scratch**: a task, and optionally name, repository or folder, worktree, model, permission
   mode, account.
2. **For board tickets**: by reference (`#N`, `name#N`, `owner/name#N`) or by board filter
   (column, assignee, label, sprint). Each starts in the ticket's repository checkout, is linked to
   the ticket, gets its title, description and sub-issues as the first prompt, moves to In Dev and
   is assigned to the user.

Nothing starts without the user's yes; a batch is one list to approve or trim.

## Approaches considered

- **A. One new kind `START` for both modes.** Literal to the issue, but every app path that knows
  ASSIGN (auto-link, In Dev move, Start…, trust retry, card badge) would need to learn START too.
- **B. Ticket starts as ASSIGN (source `start:…`), scratch starts as `START` (issue 0).** Chosen.
  Ticket sessions get linking, the board move, the trust retry and the badge from code that
  already works; START needs only a label and a colour in the app.
- **C. The app does the starting (a new IPC, master calls into MasterDeck).** Rejected: master's
  ledger and approval rule would be split across two writers.

## Design (B)

- `master start` (`cli.cmd_start`, `start.py`) builds proposals, adds them under the ledger lock
  and prints the plan: id, ticket, name, folder, model, mode, account, warnings, and what it
  refused. `--dry-run` adds nothing (a read); `--yes` approves and spawns at once (the user said
  "start it now").
- **Tickets**: read from GitHub as their repository's account (`Live.issue`, `Live.sub_issues`);
  `rules._assign` gives name, folder and account (the sweep's rules); the prompt is the ASSIGN
  prompt plus description (cut at 20 000 characters), up to 50 sub-issues and the user's
  instructions. After review: the description is context only (the user approved a one-line plan and
  never read it), so the session still stops and asks unless the user gave instructions.
  `assignMe: true` unless `--no-assign`.
- **Refused** (never added): not found, closed, a PR, a repository not selected in Setup, a running
  owner session, an approved ASSIGN for it. A waiting (proposed) or held ASSIGN is replaced. **Warnings**:
  no checkout, a folder Claude Code does not trust, a stopped owner. A name in use gets `-2`.
- **Spawn target**: optional `worktree` (→ `claude --bg --worktree <name>`) and `assignMe`.
- **App**: `BoardFlow` links by the newest ASSIGN of the session's name and then, if `assignMe`,
  assigns the ticket once (master itself never writes to GitHub); `Sources.readLedger` reads
  `claude agents` at once when a spawn proposal turns `sent`; proposals without a ticket are named
  by their session (`proposalLabel`).
- **Skill**: `SKILL.md` gains "Start sessions on demand" and how START sessions report.

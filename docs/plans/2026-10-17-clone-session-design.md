# Clone a session: design (#136)

Issue: [#136](https://github.com/amntoppo/MasterDeck-Terminal/issues/136). Related: #33 (a copy's
model and permission mode), #133 (a resume opens its terminal). Branch
`worktree-MasterDeck-Terminal-136-clone-session`.

## Goal

Right-click a session → **Clone…** → a small dialog (name, optional first message, **Keep ticket
link**) → a new background session that continues from a copy of the original's conversation, in
the same folder, as the same GitHub account, with the same model and permission mode when they can
be validated. The original is untouched and keeps running. The UI always says "Clone"; "fork" is
only the CLI's word (`--fork-session`).

## What Claude Code does (probed 2026-10-17, claude 2.1.302)

A throwaway haiku session (`claude --bg -n …` in a plain folder inside a trusted checkout), then
`claude --bg --resume <id> --fork-session -n <name> --model haiku --permission-mode plan "<msg>"`
while the original was still alive:

- prints `backgrounded · <new bg id> · <name>` (no "started a copy" note: nothing is superseded);
- both sessions are listed and running; the original's ids, name and transcript are unchanged;
- the clone's transcript (`<new session id>.jsonl`) holds a copy of every earlier line **with the
  original's timestamps and uuids** (only `sessionId` is rewritten), then the clone's own lines;
- the positional message is the clone's first turn (it answered from the copied conversation);
- `--permission-mode` is written as the clone's `permission-mode` record.
- assistant records carry `requestedModel` (e.g. `claude-opus-5-5[1m]`, alias resolved, `[1m]`
  kept), while `message.model` drops the `[1m]`.

## Decisions

1. **Start**: `claude --bg [--settings <account>] --resume <sessionId> --fork-session -n <name>
   [--model <m>] [--permission-mode <p>] [<first message>]` in the original's `cwd` (the folder its
   transcript belongs to). The first message goes as the positional prompt (no typing into the
   session afterwards: nothing to wait for, nothing to race).
2. **Name**: default `<name> (clone)`, then `<name> (clone 2)`, … while a live session has the name;
   cloning `x (clone)` gives `x (clone 2)`, not `x (clone) (clone)`. Allowed: letters, digits,
   space, `. _ - ( )`, starting with a letter or digit, up to 100 characters (the resume rule plus
   parentheses: the name is an argv element, never a shell word).
3. **Account**: the original's (`Session.account`, else its folder's, as `resumeAs` resolves it),
   through `settingsFor`; recorded for the clone's bg id (`sessionAccounts.set`) and by name
   (`expect`). One account: no `--settings`, as everywhere.
4. **Model and permission mode (#33's rule)**: read from the end of the original's transcript
   (`cloneOptions`): the newest assistant `requestedModel`, else its `message.model`, passed only
   when it matches the model-name shape (as `btwModel`; never `<synthetic>`); the newest
   `permission-mode` record, passed only when it is one the Start dialog offers (`plan`,
   `acceptEdits`, `auto`). `default` passes nothing; `bypassPermissions` and anything unknown are
   never carried. Otherwise Claude Code's defaults.
5. **Not a copy**: no `superseded.add`, no `noteCopy`; the original keeps its name, link and PRs.
6. **What the clone does not take over** (found by tracing `Sources`):
   - *transcript-derived PRs, worktrees and workflow progress*: `followPrs` reads a new transcript
     from its start, so the copied lines would give the clone the original's PRs (`createdPrs`,
     `openedPrs` → `sessionPrs` → PR watch), worktrees and flow triggers. For a clone, lines with a
     timestamp before the clone time are skipped (`clonedLine`): the copied lines keep the
     original's timestamps, so only the clone's own work counts.
   - *the folder branch's PR*: both sessions share the folder, and `branchDir` gives any session its
     folder's branch PR. A clone owns its folder's branch only once the branch differs from the one
     recorded when it was cloned (`cloneOwnsBranch`).
   - *the ticket link*: links are keyed by session id and a clone's ids are new, so it is unlinked
     unless **Keep ticket link** is ticked. Proposal auto-link matches by name, and the clone's name
     differs.
7. **Keep ticket link** (off by default): the record carries the ticket; once the clone is listed,
   `Sources` links it through the same linker as a resume's carried link (once; a failure is shown
   in the health errors and retried at most every ten minutes, like `carryLinks`).
8. **Record** `<home>/session-clones.json`: `{ [clone bg id]: { from: {key, name}, at, branch,
   ticket?, linked? } }`, written atomically, the newest 500 kept. A clone whose bg id was not
   printed is held by name for ten minutes and claimed when it shows up (as `SessionAccounts`).
9. **Shown**: `Session.clonedFrom = {key, name}` (Details → Session: "Cloned from <name>", the name
   opens the original when it is listed). The dialog's start goes through App like the + menu's
   New Claude session: a "Starting…" tab in Terminals that becomes the clone's terminal tab as soon
   as it is listed (#133's behaviour), with **Try again** on a failure.
10. **When Clone is disabled** (`cloneBlock`, the same rule in the menu and in main):
    - no conversation yet: the session id is not a UUID, or no transcript file exists
      (`Session.noConversation`, set by `Sources` from its transcript index);
    - needs input (`needs-input`, or a menu on screen): "Answer it first: a clone would copy a
      half-finished question."
    The menu item is greyed with the reason as its tooltip and a line under it.
11. **Web app**: `cloneSession` is `remote` in `DECK_ACCESS`; main takes the folder and ids from its
    own session list (the request carries only the session key), and a browser's first message
    must pass `noEscape` (no leading `/` or `!`, no control characters).

## Not done

- Picking a different model, mode, folder or account for the clone (the dialog stays small).
- `master` proposals or the CLI cloning sessions.

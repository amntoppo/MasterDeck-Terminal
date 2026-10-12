[masterdeck.dev](https://masterdeck.dev) · [Get started](https://masterdeck.dev/docs/) · [All downloads](https://masterdeck.dev/download/)

## What's new in 0.9.0

- **Agent loops in workflows.** Put a **Loop** frame on the Workflow canvas: the session repeats
  its blocks until a check passes (`npm test`, or any command), Claude says it's done, or both,
  with limits on rounds, time and rounds without progress. Details shows the round and its
  history, the session row gets a `↻ 3/10` badge, and Needs you asks at the limit (**Run 5 more**).
- **Notes.** A Notes panel on the rail for your own notes and one note per ticket, in Markdown
  with a preview; sessions can add to them.
- **A better Start dialog.** Create a worktree before the session starts, pick the permission mode,
  remember your choices per repository, and see the ticket's description and sub-issues. From the
  web app too, with **Choose folder…**.
- **Create with Claude settings bar.** Fix the repository, people, column, sprint, labels and
  milestone below the chat; every ticket Claude creates follows them.
- **Linked sessions.** Link running sessions so each knows what the others are doing.
- **Sessions column.** Star sessions to keep them at the top, filter by status, account, repo or
  name, and the session name always shows.
- **Working hours.** Costs → Hours estimates time per GitHub account, day and ticket, with CSV export.
- **Claude Code mods.** MasterDeck's mods show a session's ticket, alerts, board and an `/md-loop`
  command inside Claude Code, each switched per session.
- **Fixes.** Sessions move to Merged when their PR merges (not Rework); Remote says why it is
  waiting and no longer waits for ever for the session list.
- **MasterDeck's own icon**, in the app and on the web.

## In 0.8.2

- **Windows build.** 0.8.0 and 0.8.1 shipped without the Windows installer; 0.8.2 has both. A
  session's account written by master in the same instant as the app's own write is no longer
  missed.

## In 0.8.0

- **Several GitHub accounts.** Connect more than one account in Setup. Each session runs as the
  account you pick (commits, pushes and PRs are that account's), the Board and PRs get a tab per
  account, and each account can have its own workspace folder.
- **Board without a GitHub project.** An account with repositories and no project board gets a Board
  from its issues, in Todo / In Dev / PR Raised / Done. **Create a GitHub board** makes a real one.
- **Repository view.** Pick repositories in a Board tab's Repos filter to see every issue of them,
  on a board or not, and start or open a session from any card.
- **Assign to the right people.** The Assign popup lists who can be assigned in the card's own
  repository, read as the account that owns it.
- **Sessions start in the right folder.** A ticket's session starts in your checkout of its
  repository when there is one; the Start dialog says where, and lets you choose a folder when
  there is none.
- **Reports reach only master.** A session's `#N: done|blocked|question` report can no longer land
  in another session, and resuming a session no longer makes a copy of it.

## In 0.7.1

- **Windows build.** 0.7.0 shipped without the Windows installer (tests that assumed macOS failed on
  the Windows runner); 0.7.1 has both.
- **Phone: Filters button.** On a phone, Board and PRs show **Filters (n)** next to the search box;
  it opens a sheet with every filter, Reset and Done, so the board and the PR list get the screen.

## In 0.7.0

- **Web app on your phone.** app.masterdeck.dev has a phone layout: a tab bar, one screen at a time,
  and a quick-key bar (Esc, Tab, ^C, arrows, Enter, y/n) under the terminal.
- **Instant typing in the web terminal.** Keystrokes show at once instead of after the round trip
  (Settings → General → Instant typing).
- **Remote connection indicator.** A blinking amber dot in the rail while a browser or phone is
  connected; hover for who, which device and since when.
- **No skill dependencies.** MasterDeck now links sessions to issues and moves board cards, watches
  your sessions' PRs (review comments, conflicts, merge), stops the first `gh pr create` on each
  branch for a self-review, and runs `/queue` with its own hook. On first launch it removes the
  babysit-ticket, babysit-pr and queue hooks it installed earlier (a backup of
  `~/.claude/settings.json` is kept); the skills stay for use by hand. Settings → Sessions →
  **Watch new PRs** turns the PR watch off.
- **Less upload.** The Mac sends only the changes of its snapshot, and the web app gets state
  patches instead of the full state.

## Install

**macOS** (Apple silicon and Intel): run this in Terminal. It downloads the right build, installs it in
`/Applications` and opens it, with no Privacy & Security step:

```bash
curl -fsSL https://raw.githubusercontent.com/amntoppo/MasterDeck-Terminal/main/install.sh | bash
```

Or download the DMG below (`MasterDeck-<version>-arm64.dmg` for Apple silicon, `MasterDeck-<version>.dmg`
for Intel). The app is not signed by Apple, so macOS blocks it the first time: open **System Settings →
Privacy & Security** and choose **Open Anyway**.

**Windows:** `MasterDeck Setup <version>.exe` below. It is not signed, so SmartScreen asks you to
confirm: **More info**, then **Run anyway**.

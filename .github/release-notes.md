## What's new in 0.7.0

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

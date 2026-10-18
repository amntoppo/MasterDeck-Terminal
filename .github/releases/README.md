# Update notes, per version

The notes MasterDeck shows in Settings → Updates (and in the "ready to install" prompt) come from
here. For a release `vX.Y.Z`, the OTA workflow (`.github/workflows/ota-release.yml`) takes:

1. `.github/releases/vX.Y.Z.md` at the tag when it exists (beta tags too: `v0.10.0-beta.1.md`),
2. else the GitHub release's text (for a tagged build, `.github/release-notes.md`: its
   "What's new" section),
3. else `MasterDeck X.Y.Z`.

**A merge to `main`** (`.github/workflows/ota-main.yml`) writes this file itself, on the release
commit only its tag holds (never on `main`): one line per merged PR since the last release. A file
already on `main` for the version it picks is used as written instead.

Write the file in Markdown, for users: what is new and what was fixed, short. The app draws it as
Markdown with HTML turned off (every tag shows as text), so plain Markdown only: headings, lists,
links, **bold**, `code`. Commit it with the version bump, before the tag.

Notes can be changed after publishing with the backend's `PATCH /v1/admin/releases/<version>`
(`notes`); see docs/OPERATIONS.md § Release.

Without a file here the update shows the GitHub release's whole text, install links included.
Add the file when the update should say only what changed.

# Update notes, per version

The notes MasterDeck shows in Settings → Updates (and in the "ready to install" prompt) come from
here. For a release `vX.Y.Z`, the release workflow (`.github/workflows/release.yml`) takes:

1. `.github/releases/vX.Y.Z.md` when it exists (beta tags too: `v0.10.0-beta.1.md`),
2. else the annotated tag's message (`git tag -a vX.Y.Z -m "…"`),
3. else `MasterDeck X.Y.Z`.

Write the file in Markdown, for users: what is new and what was fixed, short. The app draws it as
Markdown with HTML turned off (every tag shows as text), so plain Markdown only: headings, lists,
links, **bold**, `code`. Commit it with the version bump, before the tag.

Notes can be changed after publishing with the backend's `PATCH /v1/admin/releases/<version>`
(`notes`); see docs/OPERATIONS.md § Release.

This is not the GitHub release's body: that is `.github/release-notes.md`, the install page shown
on every GitHub release.
